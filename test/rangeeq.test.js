'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/rangeeq');
const Hand = require('pokersolver').Hand;

const ORDER = '23456789TJQKA';
const scoreOf = cards => {
    const h = Hand.solve(cards);
    return R.handScore(h.rank, h.cards.map(c => ORDER.indexOf(c.value === '10' ? 'T' : c.value)));
};

// ── 점수 매기기가 pokersolver 판정과 일치하는가 ────────────────
test('handScore 순서가 pokersolver 승패와 일치한다 (무작위 300쌍)', () => {
    const FULL = [];
    for (const s of 'shdc') for (const v of ORDER) FULL.push(v + s);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
        const d = FULL.slice();
        for (let j = d.length - 1; j > 0; j--) { const k = Math.floor(Math.random() * (j + 1)); [d[j], d[k]] = [d[k], d[j]]; }
        const board = d.slice(0, 5), a = d.slice(5, 7), b = d.slice(7, 9);
        const ha = Hand.solve(a.concat(board)), hb = Hand.solve(b.concat(board));
        const sa = scoreOf(a.concat(board)), sb = scoreOf(b.concat(board));
        const w = Hand.winners([ha, hb]);
        if (w.length === 2) { assert.strictEqual(sa, sb, '무승부인데 점수가 다름'); }
        else if (w[0] === ha) { assert.ok(sa > sb, 'A가 이겼는데 점수가 낮음'); }
        else { assert.ok(sb > sa, 'B가 이겼는데 점수가 낮음'); }
        checked++;
    }
    assert.strictEqual(checked, 300);
});

test('족보 등급이 높으면 킥커와 무관하게 점수가 높다', () => {
    const pair = scoreOf(['2h', '2d', '7s', '8c', 'Kd']);      // 원페어
    const highA = scoreOf(['Ah', 'Kd', 'Qs', 'Jc', '9d']);     // A 하이
    assert.ok(pair > highA);
});

// ── 벳 레인지 폭 ─────────────────────────────────────────────
test('플랍 C벳 레인지는 넓고 리버 벳 레인지는 좁다', () => {
    const flop = R.bettingRangeTop({ street: 2, betFrac: 0.5 });
    const river = R.bettingRangeTop({ street: 4, betFrac: 0.5 });
    assert.ok(flop > river, `플랍 ${flop} > 리버 ${river}`);
    assert.ok(flop >= 0.45 && flop <= 0.7, '플랍 ' + flop);
});

test('벳이 클수록 레인지가 좁다', () => {
    assert.ok(R.bettingRangeTop({ street: 2, betFrac: 1.2 }) < R.bettingRangeTop({ street: 2, betFrac: 0.3 }));
});

test('여러 스트리트를 연속 공격하면 레인지가 더 좁다', () => {
    const one = R.bettingRangeTop({ street: 4, betFrac: 0.7, aggroStreets: 1 });
    const three = R.bettingRangeTop({ street: 4, betFrac: 0.7, aggroStreets: 3 });
    assert.ok(three < one * 0.8, `1스트리트 ${one} vs 3스트리트 ${three}`);
});

test('레인지 폭은 항상 0.10~0.85', () => {
    for (const st of [2, 3, 4]) for (const bf of [0, 0.3, 1, 3]) for (const ag of [0, 1, 2, 3]) {
        const t = R.bettingRangeTop({ street: st, betFrac: bf, aggroStreets: ag });
        assert.ok(t >= 0.10 && t <= 0.85, `${st}/${bf}/${ag} → ${t}`);
    }
});

// ── 레인지 대비 강도 ─────────────────────────────────────────
test('상위 레인지만 상대하면 약한 패의 승률이 급감한다', () => {
    const opp = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const me = 45;
    const vsAll = R.shareBeaten(me, opp, 1.0);     // 전체 상대
    const vsTop = R.shareBeaten(me, opp, 0.3);     // 상위 30%만 상대
    assert.ok(vsAll > vsTop, `전체 ${vsAll} > 상위30% ${vsTop}`);
    assert.strictEqual(vsTop, 0, '상위 30%(80,90,100)는 하나도 못 이김');
});

test('동점은 절반으로 센다', () => {
    assert.strictEqual(R.shareBeaten(50, [50, 50], 1), 0.5);
});

test('최강 패는 레인지 전체를 이긴다', () => {
    assert.strictEqual(R.shareBeaten(999, [10, 20, 30], 1), 1);
});

test('후보가 없으면 중립값 0.5', () => {
    assert.strictEqual(R.shareBeaten(50, [], 1), 0.5);
});

test('실제 카드로 — 7-8-2 보드에서 AK 하이는 벳 레인지에 크게 밀린다', () => {
    const board = ['7h', '8d', '2c'];
    const FULL = [];
    for (const s of 'shdc') for (const v of ORDER) FULL.push(v + s);
    const known = new Set([...board, 'Ah', 'Kd']);
    const pool = FULL.filter(c => !known.has(c));
    const opp = [];
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) opp.push(scoreOf([pool[i], pool[j]].concat(board)));
    const me = scoreOf(['Ah', 'Kd'].concat(board));
    const vsRandom = R.shareBeaten(me, opp, 1.0);
    const vsBetting = R.shareBeaten(me, opp, R.bettingRangeTop({ street: 2, betFrac: 0.5 }));
    assert.ok(vsRandom > 0.4, '랜덤 상대로는 절반 가까이 이김: ' + vsRandom);
    // 플랍 C벳 레인지는 넓어서(상위 60%) 0이 되진 않지만, 랜덤 대비 절반 이하로 떨어져야 한다
    assert.ok(vsBetting < vsRandom * 0.55, `랜덤 ${vsRandom} → 벳레인지 ${vsBetting}`);
    assert.ok(vsBetting < 0.30, '벳 레인지 상대 승률: ' + vsBetting);

    // 리버 큰 벳(좁은 레인지)이면 더 크게 밀린다
    const vsRiver = R.shareBeaten(me, opp, R.bettingRangeTop({ street: 4, betFrac: 1.0, aggroStreets: 3 }));
    assert.ok(vsRiver < vsBetting * 0.6, `플랍 ${vsBetting} → 리버3배럴 ${vsRiver}`);
});

// ── 드로우 블렌드 ────────────────────────────────────────────
test('리버는 레인지 강도를 그대로 쓴다 (남은 카드가 없다)', () => {
    assert.strictEqual(R.blendWithDraws(0.2, 0.6, 4), 0.2);
});

test('플랍은 드로우 가치를 남겨 리버보다 후하게 평가한다', () => {
    const flop = R.blendWithDraws(0.2, 0.6, 2);
    const turn = R.blendWithDraws(0.2, 0.6, 3);
    assert.ok(flop > turn, `플랍 ${flop} > 턴 ${turn}`);
    assert.ok(turn > 0.2, '턴도 드로우 몫이 조금은 남는다');
});

test('블렌드 결과는 두 입력 사이에 있다', () => {
    for (const st of [2, 3]) {
        const v = R.blendWithDraws(0.15, 0.55, st);
        assert.ok(v >= 0.15 && v <= 0.55, `${st} → ${v}`);
    }
});
