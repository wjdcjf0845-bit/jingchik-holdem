const test = require('node:test');
const assert = require('node:assert');
const { Capacity, HOLD_MS } = require('../lib/capacity');

test('정원: 빈자리가 있으면 들어오고, 차면 줄을 선다 · 0이면 제한 없음', () => {
    const c = new Capacity(2);
    const on = new Set(['a']);
    assert.strictEqual(c.canEnter('b', on, 0, false), true);
    on.add('b');
    assert.strictEqual(c.canEnter('c', on, 0, false), false);
    assert.strictEqual(c.enqueue('c', 's1', 0), 1);
    assert.strictEqual(c.enqueue('d', 's2', 0), 2);
    assert.strictEqual(c.enqueue('c', 's9', 0), 1, '다시 요청해도 순서는 그대로');
    assert.strictEqual(new Capacity(0).canEnter('x', new Set(['a', 'b', 'c']), 0, false), true);
    assert.strictEqual(new Capacity('abc').max, 0);
});

test('정원: 게임 중이던 사람의 재접속과 같은 계정의 다른 기기는 정원과 무관하게 받는다', () => {
    const c = new Capacity(1);
    const on = new Set(['a']);
    assert.strictEqual(c.canEnter('b', on, 0, true), true);
    assert.strictEqual(c.canEnter('a', on, 0, false), true);
    assert.strictEqual(c.canEnter('b', on, 0, false), false);
});

test('정원: 자리가 나면 먼저 온 순서대로, 새로 온 사람은 줄 뒤로', () => {
    const c = new Capacity(2);
    const on = new Set(['a', 'b']);
    c.enqueue('c', 's1', 0); c.enqueue('d', 's2', 0);
    assert.deepStrictEqual(c.drain(on, 0), []);
    on.delete('a');
    const out = c.drain(on, 100);
    assert.deepStrictEqual(out.map(q => q.nick), ['c']);
    assert.strictEqual(c.position('d'), 1);
    // c 가 아직 다시 로그인하기 전: 자리는 c 몫으로 맡아 둔다 — 새로 온 e 는 못 들어온다
    assert.strictEqual(c.canEnter('e', on, 200, false), false);
    assert.strictEqual(c.canEnter('c', on, 200, false), true);
    c.entered('c'); on.add('c');
    assert.strictEqual(c.used(on, 300), 2);
    // 줄이 남아 있으면 빈자리가 생겨도 새치기 금지
    on.delete('b');
    assert.strictEqual(c.canEnter('e', on, 400, false), false);
    assert.strictEqual(c.canEnter('d', on, 400, false), true);
});

test('정원: 차례가 왔는데 안 들어오면 맡아 둔 자리가 풀려 다음 사람에게 간다 · 줄에서 나가기', () => {
    const c = new Capacity(1);
    const on = new Set(['a']);
    c.enqueue('b', 's1', 0); c.enqueue('c', 's2', 0);
    on.delete('a');
    assert.deepStrictEqual(c.drain(on, 0).map(q => q.nick), ['b']);
    assert.deepStrictEqual(c.drain(on, 1000), [], 'b 몫으로 맡아 둔 동안은 다음 사람을 안 부른다');
    assert.deepStrictEqual(c.drain(on, HOLD_MS + 1).map(q => q.nick), ['c']);
    const d = new Capacity(1);
    d.enqueue('x', 'sx', 0); d.enqueue('y', 'sy', 0);
    assert.strictEqual(d.leave('sx'), true);
    assert.strictEqual(d.position('y'), 1);
    assert.strictEqual(d.leave('nope'), false);
    // 정원을 늘리면 그만큼 들어온다
    const e = new Capacity(1); const on2 = new Set(['a']);
    e.enqueue('b', 's1', 0); e.enqueue('c', 's2', 0); e.setMax(3);
    assert.deepStrictEqual(e.drain(on2, 0).map(q => q.nick), ['b', 'c']);
});
