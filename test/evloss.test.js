const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/evloss');

const adv = (mix, best, extra) => Object.assign({ mix, bestAction: best, street: 'flop', equity: 50, potOdds: 25 }, extra || {});
const ctx = extra => Object.assign({ bb: 100, pot: 900, toCall: 300, putIn: 0, equity: 0.5, street: 'flop', opponents: 1 }, extra || {});

test('EV 손실: 권장 액션과 섞어 치는 범위(25% 이상)는 손실 0', () => {
    const a = adv({ fold: 5, call: 65, raise: 30 }, 'call');
    assert.deepStrictEqual(E.of(a, 'call', ctx({ putIn: 300 })), { lossBB: 0, grade: 'best', kind: null });
    assert.deepStrictEqual(E.of(a, 'raise', ctx({ putIn: 900 })), { lossBB: 0, grade: 'good', kind: null });
});

test('EV 손실: 콜의 기대값이 양수인데 접으면 그만큼 잃는다 (오차 폭은 뺀다)', () => {
    // 팟 900(상대 벳 포함)에 300 콜, 승률 50% → EV(콜) = 0.5×1200 − 300 = 300. 오차 폭 8% × 1200 = 96 → 손실 204칩 = 2.04bb
    const r = E.of(adv({ fold: 5, call: 90, raise: 5 }, 'call'), 'fold', ctx());
    assert.strictEqual(r.kind, 'overfold');
    assert.strictEqual(r.lossBB, 2.04);
    assert.strictEqual(r.grade, 'blunder');
});

test('EV 손실: 콜의 기대값이 음수인데 콜하면 그만큼 잃는다', () => {
    // 승률 10% → EV(콜) = 0.1×1200 − 300 = −180. 오차 폭 96 → 손실 84칩 = 0.84bb
    const r = E.of(adv({ fold: 92, call: 8 }, 'fold'), 'call', ctx({ equity: 0.1, putIn: 300 }));
    assert.strictEqual(r.kind, 'overcall');
    assert.strictEqual(r.lossBB, 0.84);
    assert.strictEqual(r.grade, 'mistake');
});

test('EV 손실: 조언이 넘겨준 콜의 기대값(ev.call)을 우선 쓴다 — 프리플랍', () => {
    const a = adv({ fold: 90, call: 9, raise: 1 }, 'fold', { street: 'preflop', ev: { call: -150 } });
    const r = E.of(a, 'call', ctx({ street: 'preflop', pot: 400, toCall: 150, putIn: 150 }));
    assert.strictEqual(r.lossBB, 1.5);
    assert.strictEqual(r.kind, 'overcall');
});

test('EV 손실: 오픈할 패를 접으면 오픈의 기대값을 잃고, 오픈 범위 밖 패로 열면 음수만큼 잃는다', () => {
    const open = adv({ fold: 6, raise: 94 }, 'raise', { street: 'preflop', ev: { open: 250 } });
    assert.strictEqual(E.of(open, 'fold', ctx({ street: 'preflop', pot: 150, toCall: 100 })).lossBB, 2.5);
    const junk = adv({ fold: 92, raise: 8 }, 'fold', { street: 'preflop', ev: { open: -120 } });
    const r = E.of(junk, 'raise', ctx({ street: 'preflop', pot: 150, toCall: 100, putIn: 250 }));
    assert.strictEqual(r.kind, 'spew');
    assert.strictEqual(r.lossBB, 1.2);
});

test('EV 손실: 권장 빈도 15~25% 는 절반만, 한 결정은 최대 10bb', () => {
    const half = E.of(adv({ fold: 20, call: 75, raise: 5 }, 'call'), 'fold', ctx());
    assert.strictEqual(half.lossBB, 1.02);
    const huge = E.of(adv({ fold: 2, call: 98 }, 'call'), 'fold', ctx({ pot: 20000, toCall: 5000, equity: 0.8 }));
    assert.strictEqual(huge.lossBB, E.MAX_LOSS);
});

test('EV 손실: 권장이 레이즈여도 팟의 3배를 훌쩍 넘는 올인은 손실로 센다 (올인이 기준인 자리는 예외)', () => {
    const a = adv({ fold: 6, raise: 94 }, 'raise', { street: 'preflop', ev: { open: 300 } });
    const r = E.of(a, 'allin', ctx({ street: 'preflop', pot: 150, toCall: 100, putIn: 10000 }));
    assert.strictEqual(r.kind, 'overraise');
    assert.ok(r.lossBB > 3 && r.lossBB < 4.5, String(r.lossBB));
    const jam = Object.assign({}, a, { sizeHint: '올인' });
    assert.strictEqual(E.of(jam, 'allin', ctx({ street: 'preflop', pot: 150, toCall: 100, putIn: 1000 })).lossBB, 0);
});

test('EV 손실: 콜이 곧 올인인 자리에서 올인 버튼은 콜로 본다', () => {
    const a = adv({ fold: 8, call: 92 }, 'call', { allinIsCall: true });
    assert.strictEqual(E.of(a, 'allin', ctx({ putIn: 300 })).grade, 'best');
});

test('점수 환산: 손실 0 = 100점, L0 = 50점, 손실이 클수록 낮다', () => {
    assert.strictEqual(E.scoreFromLoss(0), 100);
    assert.strictEqual(E.scoreFromLoss(E.L0), 50);
    assert.ok(E.scoreFromLoss(10) > E.scoreFromLoss(20));
    assert.ok(E.scoreFromLoss(2000) <= 2);
});

test('집계: 판 수가 늘면 오차(±)가 줄고, 구간은 점수를 감싼다', () => {
    const mk = n => { let l = 0, q = 0; for (let i = 0; i < n; i++) { const x = i % 10 === 0 ? 2 : 0; l += x; q += x * x; } return E.index({ evLoss: l, evLossSq: q, evHands: n }); };
    const a = mk(100), b = mk(2000);
    assert.strictEqual(a.loss100, 20);
    assert.strictEqual(b.loss100, 20);
    assert.ok(a.pm > b.pm, `${a.pm} > ${b.pm}`);
    assert.ok(a.lo <= a.score && a.score <= a.hi);
    assert.strictEqual(E.index({ evHands: 0 }), null);
});
