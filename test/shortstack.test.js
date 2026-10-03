const test = require('node:test');
const assert = require('node:assert');
const SS = require('../lib/shortstack');
const OM = require('../lib/oppmodel');

// ══════════════ 숏스택 푸시/폴드 ══════════════

test('핸드 순위: AA 가 최상위, 72o 는 바닥권, 0~1 사이', () => {
    assert.ok(SS.handPercentile('AA') < 0.01);
    assert.ok(SS.handPercentile('KK') < SS.handPercentile('QQ'));
    assert.ok(SS.handPercentile('AKs') < SS.handPercentile('AKo'));
    assert.ok(SS.handPercentile('72o') > 0.85);
    assert.strictEqual(SS.handPercentile('없는패'), 1);
});

test('169칸 전부 순위가 있고, 누적 비율의 끝은 정확히 1', () => {
    const R = '23456789TJQKA'; let max = 0, n = 0;
    for (let i = 0; i < 13; i++) for (let j = 0; j <= i; j++) {
        const codes = i === j ? [R[i] + R[j]] : [R[i] + R[j] + 's', R[i] + R[j] + 'o'];
        codes.forEach(c => { const p = SS.handPercentile(c); assert.ok(p > 0 && p <= 1, c); max = Math.max(max, p); n++; });
    }
    assert.strictEqual(n, 169);
    assert.ok(Math.abs(max - 1) < 1e-9);
});

test('스택이 짧을수록 푸시 레인지가 넓어진다 (단조)', () => {
    for (const b of [1, 2, 3, 5]) {
        let prev = 0;
        for (let s = 20; s >= 2; s--) { const v = SS.pushPct(s, b); assert.ok(v >= prev - 1e-9, `스택 ${s} behind ${b}`); prev = v; }
    }
});

test('뒤에 남은 사람이 많을수록 푸시 레인지가 좁아진다 (단조)', () => {
    for (const s of [4, 8, 10, 12]) {
        let prev = 1;
        for (let b = 1; b <= 6; b++) { const v = SS.pushPct(s, b); assert.ok(v <= prev + 1e-9, `스택 ${s} behind ${b}`); prev = v; }
    }
});

test('푸시 레인지가 상식 범위 — 10bb SB 는 절반 넘게, 10bb UTG 는 5장 중 1장 이하', () => {
    assert.ok(SS.pushPct(10, 1) > 0.5);
    assert.ok(SS.pushPct(10, 5) < 0.20);
    assert.ok(SS.pushPct(3, 1) >= 0.8);     // 3bb 는 거의 아무거나
    assert.ok(SS.pushPct(12, 5) > 0.08);    // 그래도 프리미엄은 민다
});

test('리쉬브: 넓게 여는 상대(버튼)에겐 넓게, 타이트한 상대(UTG)에겐 좁게', () => {
    assert.ok(SS.reshovePct(SS.openPct('BTN'), 10) > SS.reshovePct(SS.openPct('UTG'), 10));
    assert.ok(SS.reshovePct(0.3, 8) > SS.reshovePct(0.3, 18));   // 스택이 길면 좁게
});

test('올인한 사람의 레인지: 4벳 올인 < 3벳 올인 < 숏스택 오픈 푸시', () => {
    const open = SS.shoverPct(8, 2, 1), three = SS.shoverPct(30, 2, 2), four = SS.shoverPct(60, 2, 3);
    assert.ok(four < three && three < open);
    assert.ok(SS.shoverPct(40, 2, 1) <= 0.06, '딥스택 오픈 올인은 강한 레인지로 봐야 한다');
});

test('승률표: 실제 값과 맞는 방향 — AA 는 어떤 레인지에도 80% 이상', () => {
    for (const x of [0.03, 0.1, 0.3, 1]) assert.ok(SS.equityVs('AA', x) > 0.8, 'x=' + x);
});

test('승률표: 상대 레인지가 좁을수록 내 승률이 떨어진다 (K9o)', () => {
    const wide = SS.equityVs('K9o', 1), mid = SS.equityVs('K9o', 0.3), tight = SS.equityVs('K9o', 0.05);
    assert.ok(wide > mid && mid > tight, `${wide} ${mid} ${tight}`);
    assert.ok(wide > 0.5 && tight < 0.32);   // 랜덤엔 유리, 프리미엄 레인지엔 지배당함
});

test('승률표 보간: 표 사이 값은 양 끝 사이에 있다', () => {
    const a = SS.equityVs('QJs', 0.10), b = SS.equityVs('QJs', 0.15), m = SS.equityVs('QJs', 0.125);
    assert.ok(m >= Math.min(a, b) - 1e-9 && m <= Math.max(a, b) + 1e-9);
});

test('올인 콜 — "랜덤 상대 승률"로 받으면 안 되는 패를 접는다 (회귀 방어)', () => {
    // K7o: 랜덤 상대로는 55% 지만 상위 12% 푸시 레인지 상대로는 30%대 → 팟오즈 42% 로는 폴드
    assert.strictEqual(SS.shouldCallShove('K7o', 0.12, 0.42, 0.02).call, false);
    // 같은 패라도 상대가 아무거나 미는 상황(3bb SB 푸시)이고 오즈가 좋으면 콜
    assert.strictEqual(SS.shouldCallShove('K7o', 0.85, 0.36, 0.02).call, true);
    // 프리미엄은 언제나 콜
    assert.strictEqual(SS.shouldCallShove('QQ', 0.05, 0.45, 0.03).call, true);
    assert.strictEqual(SS.shouldCallShove('72o', 0.5, 0.40, 0).call, false);
});

// ══════════════ 상대 읽기 ══════════════

test('누적 전적이 모자라면 읽지 않는다', () => {
    assert.strictEqual(OM.lifetimeRead(null), null);
    assert.strictEqual(OM.lifetimeRead({ handsPlayed: 5, faceBet: 3, foldToBet: 3 }), null);
});

test('누적 전적 → 읽기: 비율 계산, 표본 모자란 항목은 null', () => {
    const r = OM.lifetimeRead({ handsPlayed: 200, faceBet: 50, foldToBet: 40, aggrBets: 10, aggrCalls: 30, vpipHands: 30, preflopOpps: 100 });
    assert.ok(Math.abs(r.foldToBet - 0.8) < 1e-9);
    assert.ok(Math.abs(r.loose - 0.3) < 1e-9);
    assert.ok(r.aggression > 0.15 && r.aggression < 0.25);
    const thin = OM.lifetimeRead({ handsPlayed: 40, faceBet: 4, foldToBet: 4 });
    assert.strictEqual(thin.foldToBet, null);
});

test('세션 표본이 없으면 누적 전적이 그대로, 많으면 세션이 지배한다', () => {
    const life = { foldToBet: 0.8, aggression: 0.2, loose: 0.3, samples: 0 };
    assert.strictEqual(OM.blendRead(null, null), null);
    assert.strictEqual(OM.blendRead(null, life).foldToBet, 0.8);
    const few = OM.blendRead({ foldToBet: 0.2, aggression: 0.5, loose: 0.6, samples: 6 }, life);
    const many = OM.blendRead({ foldToBet: 0.2, aggression: 0.5, loose: 0.6, samples: 40 }, life);
    assert.ok(few.foldToBet > 0.5, '표본 6개로는 누적 쪽에 가까워야 한다');
    assert.ok(Math.abs(many.foldToBet - 0.2) < 1e-9, '표본이 충분하면 세션 값 그대로');
});

test('한쪽에만 값이 있으면 그 값을 쓴다 (null 이 섞여도 NaN 이 안 된다)', () => {
    const r = OM.blendRead({ foldToBet: null, aggression: 0.4, loose: null, samples: 8 }, { foldToBet: 0.7, aggression: null, loose: 0.25, samples: 0 });
    assert.strictEqual(r.foldToBet, 0.7);
    assert.strictEqual(r.aggression, 0.4);
    assert.strictEqual(r.loose, 0.25);
    Object.values(r).forEach(v => assert.ok(v === null || Number.isFinite(v)));
});
