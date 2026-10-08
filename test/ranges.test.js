const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/ranges');
const PF = require('../lib/preflop');

test('범위 표기: +, 구간, 빈도', () => {
    assert.deepStrictEqual(R.expand('QQ+'), ['AA', 'KK', 'QQ']);
    assert.deepStrictEqual(R.expand('99-77'), ['99', '88', '77']);
    assert.deepStrictEqual(R.expand('ATs+'), ['AKs', 'AQs', 'AJs', 'ATs']);
    assert.deepStrictEqual(R.expand('A5s-A2s'), ['A5s', 'A4s', 'A3s', 'A2s']);
    assert.deepStrictEqual(R.expand('KQo'), ['KQo']);
    assert.deepStrictEqual(R.parse('AA,A5s:50'), { AA: 100, A5s: 50 });
    assert.throws(() => R.expand('AK'));
    assert.strictEqual(R.ALL.length, 169);
    assert.strictEqual(R.ALL.reduce((a, c) => a + R.combos(c), 0), 1326);
});

test('한 패의 빈도는 합이 100이고, 레이즈 몫을 먼저 채운 뒤 남은 만큼이 콜', () => {
    const t = R.build({ r: 'JJ:30,AA', c: 'JJ,AA,22' });
    assert.deepStrictEqual(t.JJ, { raise: 30, call: 70, fold: 0 });
    assert.deepStrictEqual(t.AA, { raise: 100, call: 0, fold: 0 });
    assert.deepStrictEqual(t['22'], { raise: 0, call: 100, fold: 0 });
    R.ALL.forEach(c => ['UTG', 'HJ', 'CO', 'BTN', 'SB'].forEach(o => { const f = R.lookup({ heroPos: 'BB', openerPos: o }, c); assert.strictEqual(f.raise + f.call + f.fold, 100, c + o); }));
});

test('BB 방어 폭: 공개된 솔버 범위 안 — 여는 자리가 뒤일수록 넓다', () => {
    const want = { UTG: [24, 31, 3.5, 6.5], HJ: [31, 39, 4.5, 8.5], CO: [39, 49, 6.5, 10.5], BTN: [51, 59, 10, 14], SB: [55, 64, 12.5, 16.5] };
    let prev = 0;
    Object.keys(want).forEach(o => {
        const w = R.width({ heroPos: 'BB', openerPos: o }), [lo, hi, rlo, rhi] = want[o];
        assert.ok(w.total >= lo && w.total <= hi, `BB vs ${o} 방어 ${w.total}%`);
        assert.ok(w.raise >= rlo && w.raise <= rhi, `BB vs ${o} 3벳 ${w.raise}%`);
        assert.ok(w.total > prev); prev = w.total;
    });
});

test('SB 는 3벳 아니면 폴드(콜 없음), 버튼만 콜이 꽤 있다', () => {
    ['UTG', 'HJ', 'CO', 'BTN'].forEach(o => { const w = R.width({ heroPos: 'SB', openerPos: o }); assert.strictEqual(w.call, 0); assert.ok(w.raise >= 4 && w.raise <= 16, `SB vs ${o} ${w.raise}`); });
    const btn = R.width({ heroPos: 'BTN', openerPos: 'CO' }), hj = R.width({ heroPos: 'HJ', openerPos: 'UTG' });
    assert.ok(btn.call > hj.call * 3, `${btn.call} > ${hj.call}`);
    assert.ok(btn.total >= 10 && btn.total <= 16);
});

test('3벳 범위는 양쪽 끝: AA·KK 와 함께 A5s 같은 블러프가 들어 있고, 그 사이 패(KQo·99)는 콜', () => {
    const f = c => R.lookup({ heroPos: 'BB', openerPos: 'UTG' }, c);
    assert.strictEqual(f('AA').raise, 100);
    assert.ok(f('A5s').raise >= 50);
    assert.strictEqual(f('KQo').raise, 0); assert.strictEqual(f('KQo').call, 100);
    assert.strictEqual(f('99').call, 100);
    assert.strictEqual(f('72o').fold, 100);
});

test('3벳·4벳 받기: 앞자리 오픈일수록 강한 패로만, AA 는 언제나 다시 올린다', () => {
    const early = R.lookup({ heroPos: 'UTG', raises: 2, iRaised: true }, 'AA'), four = R.lookup({ raises: 3 }, 'AA');
    assert.strictEqual(early.raise, 100); assert.strictEqual(four.raise, 100);
    assert.strictEqual(R.lookup({ heroPos: 'UTG', raises: 2, iRaised: true }, '76s').fold, 100);
    assert.ok(R.lookup({ heroPos: 'BTN', raises: 2, iRaised: true, inPosition: true }, '76s').call >= 50);
    assert.strictEqual(R.lookup({ raises: 3 }, 'TT').raise, 0);
    assert.ok(R.width({ raises: 3 }).total < 5);
    // 내가 올린 적 없이 오픈과 3벳을 만나면 훨씬 좁다
    assert.ok(R.width({ heroPos: 'BTN', raises: 2 }).total < 4);
});

test('조언 연결: 범위표를 켜면 빈도가 그대로 나오고, 끄면(봇) 예전 기준', () => {
    const on = PF.preflopRangeTier('A5s', 'BB', true, { chart: true, openerPos: 'UTG', closing: true });
    assert.strictEqual(on.tier, 'raise'); assert.ok(on.freq.raise >= 50); assert.ok(on.gap > 0);
    const off = PF.preflopRangeTier('A5s', 'BB', true, { openerPos: 'UTG', closing: true });
    assert.strictEqual(off.freq, undefined);
    assert.ok(PF.preflopRangeTier('72o', 'BB', true, { chart: true, openerPos: 'BTN', closing: true }).gap < 0);
});

test('가격: 오픈이 작으면 넓게, 크면 좁게 — 3벳 범위는 그대로', () => {
    const w = po => { let r = 0, c = 0; R.ALL.forEach(x => { const f = PF.preflopRangeTier(x, 'BB', true, { chart: true, headsUp: true, closing: true, potOdds: po }).freq; r += f.raise / 100 * R.combos(x); c += f.call / 100 * R.combos(x); }); return [r / 13.26, (r + c) / 13.26]; };
    const a = w(1 / 4), b = w(1.5 / 5), c = w(2 / 6);
    assert.ok(a[1] > b[1] + 10 && b[1] > c[1] + 10, [a[1], b[1], c[1]].join(' '));
    assert.ok(Math.abs(a[0] - c[0]) < 0.01);
    assert.ok(b[1] > 60 && b[1] < 72);
});
