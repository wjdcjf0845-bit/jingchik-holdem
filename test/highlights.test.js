const test = require('node:test');
const assert = require('node:assert');
const HL = require('../lib/highlights');

const C = (nick, rank, human = true) => ({ nick, rank, human });

test('명장면: 배드비트 · 쿨러 · 리버 역전 · 큰 팟 · 포카드를 알아보고, 봇끼리 판이나 평범한 판은 넘긴다', () => {
    const bad = HL.detect({ winners: ['봇'], contenders: [C('철수', 'Two Pair'), C('봇', 'Straight', false)], potBB: 80, allinEq: { 철수: 88, 봇: 12 } });
    assert.strictEqual(bad.kind, 'badbeat'); assert.match(bad.sub, /철수 88%/);
    assert.strictEqual(HL.detect({ winners: ['a'], contenders: [C('a', 'Four of a Kind'), C('b', 'Full House')], potBB: 40 }).kind, 'quads');
    assert.strictEqual(HL.detect({ winners: ['a'], contenders: [C('a', 'Full House'), C('b', 'Full House')], potBB: 40 }).kind, 'cooler');
    assert.strictEqual(HL.detect({ winners: ['a'], contenders: [C('a', 'Pair'), C('b', 'High Card')], potBB: 40, riverFlip: { loser: 'b', eq: 86 } }).kind, 'river');
    assert.strictEqual(HL.detect({ winners: ['a'], contenders: [C('a', 'Pair'), C('b', 'High Card')], potBB: 220 }).kind, 'bigpot');
    assert.strictEqual(HL.detect({ winners: ['a'], contenders: [C('a', 'Pair'), C('b', 'High Card')], potBB: 20 }), null, '평범한 판');
    assert.strictEqual(HL.detect({ winners: ['a'], contenders: [C('a', 'Royal Flush', false), C('b', 'Flush', false)], potBB: 300 }), null, '봇끼리');
    assert.strictEqual(HL.detect({ winners: ['a'], contenders: [C('a', 'Royal Flush'), C('b', 'Flush')], potBB: 300 }).kind, 'royal', '로얄이 가장 우선');
});

