const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/challenge');

test('단계표: 10단계, 봇은 1~5명(6인 테이블), 보상은 단계가 오를수록 커진다', () => {
    assert.strictEqual(C.STAGES.length, 10);
    let prev = 0;
    C.STAGES.forEach((s, i) => {
        assert.ok(s.bots.length >= 1 && s.bots.length <= 5, `${i + 1}단계 봇 수`);
        s.bots.forEach(d => assert.ok(['easy', 'normal', 'hard'].includes(d)));
        assert.ok(s.reward > prev, `${i + 1}단계 보상이 앞 단계보다 작다`);
        prev = s.reward;
    });
});

test('잠금 없음 — 새 계정도 1~10단계 아무거나 바로 들어갈 수 있다', () => {
    const u = {};
    for (let s = 1; s <= 10; s++) assert.strictEqual(C.canPlay(u, s), true, s + '단계');
});

test('이상한 단계 번호는 전부 거절', () => {
    const u = { challenge: { best: 10, clears: 10, tries: 10 } };
    [0, -1, 11, 1.5, NaN, '1', null, undefined, {}].forEach(s => assert.strictEqual(C.canPlay(u, s), false, String(s)));
});

test('깨면 다음 단계가 열리고, 첫 클리어는 보상 전액', () => {
    const u = {};
    const r = C.applyClear(u, 1);
    assert.deepStrictEqual({ first: r.first, reward: r.reward, best: r.best, next: r.next }, { first: true, reward: C.STAGES[0].reward, best: 1, next: 2 });
    assert.deepStrictEqual(u.challenge.cleared, [1]);
});

test('이미 깬 단계를 다시 깨면 보상은 20%만 — 반복으로 뱅크롤을 찍어내지 못하게', () => {
    const u = {};
    C.applyClear(u, 1); C.applyClear(u, 2);
    const again = C.applyClear(u, 1);
    assert.strictEqual(again.first, false);
    assert.strictEqual(again.reward, Math.floor(C.STAGES[0].reward * 0.2));
    assert.strictEqual(u.challenge.best, 2, '다시 깼다고 진행도가 내려가면 안 된다');
    assert.strictEqual(u.challenge.clears, 3);
});

test('높은 단계를 먼저 깨도 낮은 단계의 첫 클리어 보상은 살아 있다 (단계별로 따로 기록)', () => {
    const u = {};
    const boss = C.applyClear(u, 10);
    assert.strictEqual(boss.first, true);
    assert.strictEqual(boss.reward, C.STAGES[9].reward);
    assert.strictEqual(boss.allClear, true);
    const one = C.applyClear(u, 1);
    assert.strictEqual(one.first, true, '10단계를 먼저 깼다고 1단계가 깬 걸로 쳐지면 안 된다');
    assert.strictEqual(one.reward, C.STAGES[0].reward);
    assert.deepStrictEqual(u.challenge.cleared, [1, 10]);
    assert.strictEqual(C.progressOf(u).count, 2);
    assert.strictEqual(C.applyClear(u, 10).first, false);
});

test('없는 단계는 클리어 처리 자체가 안 된다', () => {
    const u = {};
    assert.strictEqual(C.applyClear(u, 11), null);
    assert.strictEqual(C.applyClear(u, 0), null);
    assert.strictEqual(C.progressOf(u).count, 0);
});

test('예전 기록(best 만 있는 계정)은 1~best 를 깬 것으로 읽는다', () => {
    const p = C.progressOf({ challenge: { best: 3, clears: 4, tries: 9 } });
    assert.deepStrictEqual(p.cleared, [1, 2, 3]);
    assert.strictEqual(p.count, 3);
    const u = { challenge: { best: 3, clears: 4, tries: 9 } };
    assert.strictEqual(C.applyClear(u, 2).first, false);   // 이미 깬 단계
    assert.strictEqual(C.applyClear(u, 5).first, true);
    assert.deepStrictEqual(u.challenge.cleared, [1, 2, 3, 5]);
});

test('10단계를 처음 깨면 allClear, 그 뒤로는 아니다', () => {
    const u = {};
    for (let s = 1; s <= 9; s++) assert.strictEqual(C.applyClear(u, s).allClear, false);
    const last = C.applyClear(u, 10);
    assert.strictEqual(last.allClear, true);
    assert.strictEqual(last.next, null);
    assert.strictEqual(C.applyClear(u, 10).allClear, false);
});

test('손상된 진행 값이 들어와도 안전한 값으로 읽는다', () => {
    assert.deepStrictEqual(C.progressOf(null), { cleared: [], best: 0, count: 0, clears: 0, tries: 0 });
    assert.deepStrictEqual(C.progressOf({ challenge: 'x' }), { cleared: [], best: 0, count: 0, clears: 0, tries: 0 });
    assert.strictEqual(C.progressOf({ challenge: { best: 999 } }).best, 10);
    assert.strictEqual(C.progressOf({ challenge: { best: -3, clears: -1, tries: 1.5 } }).best, 0);
    assert.deepStrictEqual(C.progressOf({ challenge: { cleared: [3, 3, 'x', 99, 0, 7] } }).cleared, [3, 7]);
});

test('단계표 화면 데이터: 깬 것/열린 것/잠긴 것이 구분된다', () => {
    const u = {}; C.applyClear(u, 1); C.applyClear(u, 2);
    const l = C.ladder(u);
    assert.strictEqual(l.length, 10);
    assert.deepStrictEqual(l.slice(0, 4).map(x => [x.cleared, x.open]), [[true, true], [true, true], [false, true], [false, true]]);
    assert.ok(l.every(x => x.open), '전 단계가 열려 있어야 한다');
});

// ══════════════ 코어(컴까기 전용 재화) ══════════════

test('코어: 첫 클리어는 단계 번호만큼, 다시 깨면 1~3개', () => {
    const u = {};
    assert.strictEqual(C.applyClear(u, 1).cores, 1);
    assert.strictEqual(C.applyClear(u, 2).cores, 2);
    assert.strictEqual(u.cores, 3);
    assert.strictEqual(C.applyClear(u, 1).cores, 1);       // 재클리어
    assert.strictEqual(C.coresFor(10, false), 3);
    assert.strictEqual(C.coresFor(10, true), 10);
    assert.strictEqual(u.cores, 4);
});

test('코어는 열리지 않은 단계로는 못 번다 / 손상된 값에서도 음수·NaN 이 안 된다', () => {
    const u = { cores: 'abc' };
    assert.strictEqual(C.applyClear(u, 44), null);
    assert.strictEqual(u.cores, 'abc');                    // 거절이면 건드리지 않는다
    C.applyClear(u, 1);
    assert.strictEqual(u.cores, 1);
    const v = { cores: -5 }; C.applyClear(v, 1);
    assert.strictEqual(v.cores, 1);
});

// ══════════════ 협동 ══════════════

test('협동: 사람 + 봇이 6자리를 넘지 않는다', () => {
    for (let st = 1; st <= 10; st++) for (let h = 1; h <= 3; h++) {
        const s = C.coopSetup(st, h);
        assert.ok(s.bots.length >= 1 && s.bots.length + h <= 6, `단계 ${st} 사람 ${h}`);
    }
});

test('협동: 사람이 늘면 봇이 늘거나(자리 될 때) 봇 칩이 늘어 — 쉬워지지 않게', () => {
    for (let st = 1; st <= 10; st++) {
        const solo = C.coopSetup(st, 1);
        for (let h = 2; h <= 3; h++) {
            const co = C.coopSetup(st, h);
            const power = x => x.bots.length * x.mult;
            assert.ok(co.mult > solo.mult, `단계 ${st} 사람 ${h}: 칩 배율이 안 올랐다`);
            assert.ok(co.bots.length >= Math.min(solo.bots.length, 6 - h));
            assert.ok(power(co) > power(solo) * 0.75, `단계 ${st} 사람 ${h}: 봇 총전력이 너무 줄었다`);
        }
        assert.strictEqual(solo.mult, C.STAGES[st - 1].botChipsMult || 1);   // 혼자면 원래 규칙 그대로
    }
});

test('협동: 인원 범위를 벗어나도 안전하게 1~3명으로 본다', () => {
    assert.deepStrictEqual(C.coopSetup(3, 0), C.coopSetup(3, 1));
    assert.deepStrictEqual(C.coopSetup(3, 99), C.coopSetup(3, 3));
});

test('협동도 잠금 없이 전 단계를 고를 수 있다', () => {
    assert.strictEqual(C.partyMaxStage([{ challenge: { best: 7 } }, {}]), 10);
    assert.strictEqual(C.partyMaxStage([]), 10);
});
