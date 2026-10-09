const test = require('node:test');
const assert = require('node:assert');
const V = require('../lib/vrange');

const log = rows => rows.map(r => ({ nick: r[0], type: r[1], amount: r[2] }));
const POS = { u: 'UTG', c: 'CO', b: 'BTN', s: 'SB', B: 'BB' };
const posOf = n => POS[n];

test('행동 줄: 누가 열었고 몇 번째 레이즈였는지를 따라간다', () => {
    const l = log([['s', 'sb', 50], ['B', 'bb', 100], ['u', 'raise', 250], ['c', 'fold', 0], ['b', 'call', 250], ['s', 'fold', 0], ['B', 'raise', 1100], ['u', 'call', 1100], ['b', 'fold', 0]]);
    assert.deepStrictEqual(V.lineFromLog(l, 'u', 100, posOf), [{ kind: 'raise', raisesBefore: 0, openerPos: '', iRaised: false }, { kind: 'call', raisesBefore: 2, openerPos: 'BB', iRaised: true }]);
    assert.deepStrictEqual(V.lineFromLog(l, 'b', 100, posOf), [{ kind: 'call', raisesBefore: 1, openerPos: 'UTG', iRaised: false }]);
    assert.deepStrictEqual(V.lineFromLog(l, 'B', 100, posOf), [{ kind: 'raise', raisesBefore: 1, openerPos: 'UTG', iRaised: false }]);
    assert.deepStrictEqual(V.lineFromLog(l, 'c', 100, posOf), []);
});

test('UTG 오픈 범위에는 72o 가 거의 없고 AA 는 그대로 — 버튼 오픈은 훨씬 넓다', () => {
    const utg = V.weightFn({ pos: 'UTG', acts: [{ kind: 'raise', raisesBefore: 0 }] });
    const btn = V.weightFn({ pos: 'BTN', acts: [{ kind: 'raise', raisesBefore: 0 }] });
    assert.strictEqual(utg('AA'), 1);
    assert.strictEqual(utg('72o'), V.FLOOR);
    assert.strictEqual(btn('K8o'), 1); assert.strictEqual(utg('K8o'), V.FLOOR);
    assert.ok(V.widthOf(utg) < 25 && V.widthOf(btn) > 40 && V.widthOf(btn) < 55, `${V.widthOf(utg)} ${V.widthOf(btn)}`);
});

test('BB 콜 범위에는 3벳했을 AA 가 적고 약한 수딧 패가 많다 / 3벳 범위는 그 반대', () => {
    const call = V.weightFn({ pos: 'BB', acts: [{ kind: 'call', raisesBefore: 1, openerPos: 'BTN' }] });
    const three = V.weightFn({ pos: 'BB', acts: [{ kind: 'raise', raisesBefore: 1, openerPos: 'BTN' }] });
    assert.strictEqual(call('AA'), V.FLOOR); assert.strictEqual(three('AA'), 1);
    assert.strictEqual(call('Q2s'), 1); assert.strictEqual(three('Q2s'), V.FLOOR);
    assert.ok(three('A5s') > 0.9);
    assert.ok(V.widthOf(three) < 25);
});

test('오픈하고 3벳에 콜한 줄: 두 범위의 겹침 — AA(4벳했을 패)와 72o 가 모두 빠진다', () => {
    const f = V.weightFn({ pos: 'CO', inPosition: true, acts: [{ kind: 'raise', raisesBefore: 0 }, { kind: 'call', raisesBefore: 2, openerPos: 'BB', iRaised: true }] });
    assert.strictEqual(f('AA'), V.FLOOR); assert.strictEqual(f('72o'), V.FLOOR);
    assert.strictEqual(f('JJ') > 0.5, true); assert.strictEqual(f('KQs'), 1);
});

test('기록이 없으면 무게 함수도 없다(예전처럼 아무 패)', () => {
    assert.strictEqual(V.weightFn({ pos: 'BTN', acts: [] }), null);
    assert.strictEqual(V.weightFn(null), null);
    assert.strictEqual(V.widthOf(null), 100);
});
