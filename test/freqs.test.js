const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/freqs');

test('상황 분류: 프리플랍 오픈 · BB 방어 · 3벳 · 3벳 받기', () => {
    assert.deepStrictEqual(F.spotOf({ street: 'preflop', mix: { fold: 6, raise: 94 }, type: 'raise', isRaise: true, pos: 'BTN', raisesBefore: 0 }), { id: 'open_BTN', did: true, exp: 0.94 });
    assert.strictEqual(F.spotOf({ street: 'preflop', mix: { fold: 92, raise: 8 }, type: 'fold', pos: 'UTG+1', raisesBefore: 0 }).id, 'open_UTG');
    assert.strictEqual(F.spotOf({ street: 'preflop', mix: { check: 100 }, type: 'check', pos: 'BB', isBB: true, raisesBefore: 0 }), null);
    assert.strictEqual(F.spotOf({ street: 'preflop', mix: { fold: 50, raise: 50 }, type: 'raise', isRaise: true, pos: 'CO', raisesBefore: 0, limpers: 1 }), null);
    const bb = F.spotOf({ street: 'preflop', mix: { fold: 20, call: 70, raise: 10 }, type: 'call', pos: 'BB', isBB: true, raisesBefore: 1 });
    assert.deepStrictEqual(bb.map(x => [x.id, x.did]), [['threebet', false], ['bbdef', true]]);
    assert.ok(Math.abs(bb[1].exp - 0.8) < 1e-9);
    assert.strictEqual(F.spotOf({ street: 'preflop', mix: { fold: 60, call: 30, raise: 10 }, type: 'fold', pos: 'CO', raisesBefore: 2, iRaised: true }).id, 'vs3bet');
    assert.strictEqual(F.spotOf({ street: 'preflop', mix: { fold: 95, raise: 5 }, type: 'fold', pos: 'BTN', raisesBefore: 2 }), null);
});

test('상황 분류: 플랍 c벳은 프리플랍에 올린 사람만, 리버는 벳과 콜을 따로', () => {
    assert.strictEqual(F.spotOf({ street: 'flop', mix: { check: 40, bet: 60 }, type: 'check', toCall: 0, pfAggressor: true }).id, 'cbet');
    assert.strictEqual(F.spotOf({ street: 'flop', mix: { check: 40, bet: 60 }, type: 'check', toCall: 0 }), null);
    assert.deepStrictEqual(F.spotOf({ street: 'flop', mix: { fold: 70, call: 30 }, type: 'fold', toCall: 300 }), { id: 'vsflopbet', did: true, exp: 0.7 });
    assert.strictEqual(F.spotOf({ street: 'turn', mix: { check: 50, bet: 50 }, type: 'raise', isRaise: true, toCall: 0, pfAggressor: true }).id, 'barrel');
    assert.strictEqual(F.spotOf({ street: 'river', mix: { check: 50, bet: 50 }, type: 'check', toCall: 0 }).id, 'riverbet');
    assert.strictEqual(F.spotOf({ street: 'river', mix: { fold: 80, call: 20 }, type: 'call', toCall: 500 }).did, true);
    // 콜이 곧 올인인 자리의 올인은 레이즈가 아니다
    assert.strictEqual(F.spotOf({ street: 'preflop', mix: { fold: 10, call: 90 }, type: 'allin', isRaise: true, allinIsCall: true, pos: 'CO', raisesBefore: 1 })[0].did, false);
});

test('요약: 기회가 적으면 빼고, 차이가 크고 표본도 충분할 때만 치우침으로 본다', () => {
    const add = (o, spot, n) => { for (let i = 0; i < n; i++) { const f = F.fields(spot); Object.keys(f).forEach(k => { o[k] = (o[k] || 0) + f[k]; }); } };
    const a = {};
    add(a, { id: 'cbet', did: true, exp: 0.6 }, 45); add(a, { id: 'cbet', did: false, exp: 0.6 }, 5);        // 90% (기준 60%)
    add(a, { id: 'bbdef', did: true, exp: 0.5 }, 10); add(a, { id: 'bbdef', did: false, exp: 0.5 }, 30);     // 25% (기준 50%)
    add(a, { id: 'riverbet', did: true, exp: 0.4 }, 9); add(a, { id: 'riverbet', did: false, exp: 0.4 }, 11);   // 45% (기준 40%)
    add(a, { id: 'barrel', did: true, exp: 0.5 }, 5);                                                         // 기회 5번 — 표에서 빠짐
    const rows = F.summarize(a), by = Object.fromEntries(rows.map(r => [r.id, r]));
    assert.deepStrictEqual(rows.map(r => r.id), ['bbdef', 'cbet', 'riverbet']);
    assert.strictEqual(by.cbet.actual, 90); assert.strictEqual(by.cbet.ref, 60); assert.strictEqual(by.cbet.verdict, 'high'); assert.ok(by.cbet.tip.length > 5);
    assert.strictEqual(by.bbdef.verdict, 'low');
    assert.strictEqual(by.riverbet.verdict, 'ok'); assert.strictEqual(by.riverbet.tip, '');
    assert.deepStrictEqual(F.summarize(null), []);
});
