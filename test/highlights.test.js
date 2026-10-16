const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
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

test('명장면 저장소: 넣고 · 꺼내고 · 목록에는 리플레이를 빼고 · 다시 열어도 남는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-'));
    const s = HL.createStore(dir, 3);
    const ids = [1, 2, 3, 4].map(i => s.add({ title: 't' + i, replay: { handNo: i } }));
    assert.strictEqual(s.get(ids[0]), null, '가장 오래된 것은 밀려난다');
    assert.strictEqual(s.get(ids[3]).replay.handNo, 4);
    const l = s.list(); assert.strictEqual(l.length, 3); assert.strictEqual(l[0].title, 't4'); assert.strictEqual(l[0].replay, undefined);
    s.flush();
    assert.strictEqual(HL.createStore(dir, 3).get(ids[3]).title, 't4');
    fs.rmSync(dir, { recursive: true, force: true });
});
