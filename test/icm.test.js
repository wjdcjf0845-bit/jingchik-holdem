const test = require('node:test');
const assert = require('node:assert');
const Icm = require('../lib/icm');

// 따로 만든 검산기: 순위를 전부 나열해서(순열) 같은 모델의 값을 낸다 — 본 구현(재귀)과 다른 길로 계산한다
function brute(stacks, payouts) {
    const n = stacks.length, out = new Array(n).fill(0);
    const rec = (order, left, prob) => {
        if (order.length === Math.min(n, payouts.length)) { order.forEach((p, i) => { out[p] += prob * payouts[i]; }); return; }
        const tot = left.reduce((a, i) => a + stacks[i], 0);
        left.forEach(i => rec(order.concat([i]), left.filter(x => x !== i), prob * stacks[i] / tot));
    };
    rec([], stacks.map((_, i) => i), 1);
    return out;
}
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test('상금 기대값의 합은 상금 합과 같다', () => {
    const e = Icm.equities([5000, 3000, 1500, 500], [50, 30, 20]);
    near(e.reduce((a, b) => a + b, 0), 100);
});

test('순열 전수 계산과 일치한다', () => {
    [[[5000, 3000, 2000], [50, 30, 20]], [[9000, 400, 300, 200, 100], [50, 30, 20]], [[1, 1, 1, 1, 1, 1], [40, 30, 20, 10]], [[700, 300], [65, 35]], [[10, 20, 30, 40, 50, 60, 70], [50, 30, 20]]]
        .forEach(([s, p]) => { const a = Icm.equities(s, p), b = brute(s, p); a.forEach((x, i) => near(x, b[i], 1e-7)); });
});

test('널리 알려진 값: 50/30/20 스택 · 50/30/20 상금', () => {
    // 1등 확률은 칩 비율 그대로, 칩 1위의 기대값은 칩 비율(50%)보다 낮고 꼴찌는 칩 비율(20%)보다 높다
    const e = Icm.equities([5000, 3000, 2000], [50, 30, 20]);
    assert.ok(e[0] < 50 && e[0] > 33.3); assert.ok(e[2] > 20 && e[2] < 33.3);
    near(e[0], 50 * 0.5 + 30 * (0.3 * 5 / 7 + 0.2 * 5 / 8) + 20 * (1 - 0.5 - (0.3 * 5 / 7 + 0.2 * 5 / 8)), 1e-9);
});

test('같은 칩이면 똑같이 나눈다 · 승자 독식이면 칩 비율 그대로', () => {
    Icm.equities([100, 100, 100, 100], [50, 30, 20]).forEach(x => near(x, 25));
    const e = Icm.equities([600, 300, 100], [100]); near(e[0], 60); near(e[1], 30); near(e[2], 10);
});

test('칩을 두 배로 불려도 상금 기대값은 두 배가 안 된다', () => {
    const a = Icm.equity([1000, 1000, 1000, 1000], 0, [50, 30, 20]), b = Icm.equity([2000, 1000, 1000], 0, [50, 30, 20]);
    assert.ok(b < 2 * a && b > a);
});

test('탈락하면 그 순위의 상금(입상권 밖이면 0)', () => {
    near(Icm.evOf(0, [100, 100, 100], [50, 30, 20]), 0);     // 4명 중 탈락 = 4등 = 0
    near(Icm.evOf(0, [100, 100], [50, 30, 20]), 20);         // 3명 중 탈락 = 3등
    near(Icm.evOf(0, [100, 0, 0], [50, 30, 20]), 30);        // 칩 0 인 사람은 이미 없는 사람
});

test('버블에서는 칩 기준보다 높은 승률이 필요하다', () => {
    // 4명 남음 · 입상 3명 · 같은 스택끼리 올인 승부: 칩으로는 50% 면 되지만 상금으로는 훨씬 더 필요
    const r = Icm.callReq({ hero: 1000, vill: 0, toCall: 1000, potAfter: 2000, others: [1000, 1000], payouts: [50, 30, 20] });
    near(r.chip, 0.5);
    assert.ok(r.req > 0.6 && r.req < 0.8, 'req ' + r.req);
    assert.ok(r.tax > 0.1);
});

test('헤즈업·승자 독식에서는 차이가 없다', () => {
    const hu = Icm.callReq({ hero: 800, vill: 0, toCall: 500, potAfter: 1200, others: [], payouts: [65, 35] });
    near(hu.tax, 0, 1e-9);
    const wta = Icm.callReq({ hero: 800, vill: 0, toCall: 500, potAfter: 1200, others: [900, 300], payouts: [100] });
    near(wta.tax, 0, 1e-9);
});

test('대회 초반(20명 · 입상 3명)에는 차이가 아주 작다', () => {
    const others = new Array(18).fill(30000);
    const r = Icm.callReq({ hero: 30000, vill: 0, toCall: 30000, potAfter: 60000, others, payouts: [50, 30, 20] });
    assert.ok(r.tax >= 0 && r.tax < 0.03, 'tax ' + r.tax);
});

test('짧은 스택이 곧 탈락할 것 같으면 더 조심한다', () => {
    const base = { hero: 3000, vill: 0, toCall: 3000, potAfter: 6000, payouts: [50, 30, 20] };
    const even = Icm.callReq(Object.assign({ others: [3000, 3000] }, base));
    const shorty = Icm.callReq(Object.assign({ others: [5700, 300] }, base));
    assert.ok(shorty.req > even.req);
});

test('상금 비율의 합은 100', () => {
    [1, 2, 3, 4, 5, 8].forEach(n => near(Icm.payoutsFor(n).reduce((a, b) => a + b, 0), 100));
});
