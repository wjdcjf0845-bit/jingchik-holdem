'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { chipChop } = require('../lib/chop');

const sum = rows => rows.reduce((s, r) => s + r.share, 0);
const shareOf = (rows, nick) => rows.find(r => r.nick === nick).share;

test('풀 == 총칩(일반적인 경우)이면 각자 가진 칩만큼 받는다', () => {
    const rows = chipChop(30000, [
        { nick: 'A', chips: 18000 }, { nick: 'B', chips: 9000 }, { nick: 'C', chips: 3000 }
    ]);
    assert.strictEqual(shareOf(rows, 'A'), 18000);
    assert.strictEqual(shareOf(rows, 'B'), 9000);
    assert.strictEqual(shareOf(rows, 'C'), 3000);
});

test('칩이 같으면 똑같이 나눈다', () => {
    const rows = chipChop(20000, [{ nick: 'A', chips: 5000 }, { nick: 'B', chips: 5000 }]);
    assert.deepStrictEqual(rows.map(r => r.share), [10000, 10000]);
});

test('풀과 총칩이 달라도(누가 칩 들고 나감) 비율대로 풀 전액을 나눈다', () => {
    // 총칩 20,000인데 풀은 30,000 → 1.5배씩
    const rows = chipChop(30000, [{ nick: 'A', chips: 15000 }, { nick: 'B', chips: 5000 }]);
    assert.strictEqual(shareOf(rows, 'A'), 22500);
    assert.strictEqual(shareOf(rows, 'B'), 7500);
    assert.strictEqual(sum(rows), 30000);
});

test('핵심 — 봇도 비율 분모에 들어간다 (봇에게 지는 사람이 원금을 다 가져가지 못함)', () => {
    const rows = chipChop(20000, [
        { nick: '나', chips: 5000 },
        { nick: '🤖봇', chips: 15000, isBot: true }
    ]);
    assert.strictEqual(shareOf(rows, '나'), 5000, '사람은 자기 칩 비율만큼만');
    assert.strictEqual(shareOf(rows, '🤖봇'), 15000, '봇 몫도 계산은 됨(지급은 호출측이 막음)');
    assert.strictEqual(rows.find(r => r.nick === '🤖봇').isBot, true);
});

test('끝전: 합이 풀과 정확히 같고 몫 차이는 최대 1칩', () => {
    const rows = chipChop(100, [{ nick: 'A', chips: 1 }, { nick: 'B', chips: 1 }, { nick: 'C', chips: 1 }]);
    assert.strictEqual(sum(rows), 100);
    const shares = rows.map(r => r.share);
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1, `몫 편차 과다: ${shares}`);
});

test('끝전은 칩이 많은 사람부터 받는다', () => {
    // 10 × 2/3 = 6.67, 10 × 1/3 = 3.33 → 내림 6/3, 끝전 1은 칩 많은 A에게
    const rows = chipChop(10, [{ nick: 'B', chips: 1 }, { nick: 'A', chips: 2 }]);
    assert.strictEqual(shareOf(rows, 'A'), 7);
    assert.strictEqual(shareOf(rows, 'B'), 3);
});

test('칩 0인 참가자(탈락자)는 결과에서 제외된다', () => {
    const rows = chipChop(10000, [{ nick: 'A', chips: 10000 }, { nick: '탈락', chips: 0 }]);
    assert.deepStrictEqual(rows.map(r => r.nick), ['A']);
    assert.strictEqual(shareOf(rows, 'A'), 10000);
});

test('한 명만 남으면 풀 전액 — 기존 우승자 독식과 같은 결과', () => {
    const rows = chipChop(40000, [{ nick: 'A', chips: 40000 }]);
    assert.strictEqual(shareOf(rows, 'A'), 40000);
});

test('풀 0 / 칩 0 / 빈 입력은 안전하게 0', () => {
    assert.deepStrictEqual(chipChop(0, [{ nick: 'A', chips: 100 }]).map(r => r.share), [0]);
    assert.deepStrictEqual(chipChop(1000, []), []);
    assert.deepStrictEqual(chipChop(1000, [{ nick: 'A', chips: 0 }]), []);
    assert.deepStrictEqual(chipChop(1000, null), []);
});

test('프로퍼티: 무작위 500건에서 분배합 == 풀, 음수 없음, 비율 역전 없음', () => {
    let seed = 20260911;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 500; i++) {
        const n = 1 + Math.floor(rand() * 6);
        const stacks = Array.from({ length: n }, (_, k) => ({
            nick: 'P' + k, chips: Math.floor(rand() * 60000), isBot: rand() < 0.4
        }));
        const pool = Math.floor(rand() * 200000);
        const rows = chipChop(pool, stacks);
        const live = stacks.filter(s => s.chips > 0);
        if (live.length === 0 || pool === 0) { assert.strictEqual(sum(rows), 0); continue; }
        assert.strictEqual(sum(rows), pool, `#${i}: 분배합 ${sum(rows)} ≠ 풀 ${pool}`);
        for (const r of rows) assert.ok(r.share >= 0, `#${i}: 음수 몫`);
        // 칩이 더 많은 사람이 더 적게 받는 역전은 없어야 함
        for (const a of rows) for (const b of rows)
            if (a.chips > b.chips) assert.ok(a.share >= b.share, `#${i}: 역전 ${a.nick}(${a.chips}→${a.share}) < ${b.nick}(${b.chips}→${b.share})`);
    }
});
