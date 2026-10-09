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

test('BB 방어 폭(솔버 자료 + 레이크 보정): 여는 자리가 뒤일수록 넓고, 3벳도 넓어진다', () => {
    const want = { UTG: [28, 36, 5, 8], HJ: [31, 39, 6, 10], CO: [35, 44, 8, 12], BTN: [47, 57, 12, 17], SB: [62, 75, 16, 22] };
    let prev = 0, prevR = 0;
    Object.keys(want).forEach(o => {
        const w = R.width({ heroPos: 'BB', openerPos: o }), [lo, hi, rlo, rhi] = want[o];
        assert.ok(w.total >= lo && w.total <= hi, `BB vs ${o} 방어 ${w.total}%`);
        assert.ok(w.raise >= rlo && w.raise <= rhi, `BB vs ${o} 3벳 ${w.raise}%`);
        assert.ok(w.total > prev && w.raise > prevR); prev = w.total; prevR = w.raise;
    });
    // 보정은 콜만 넓힌다: 자료를 그대로 쓰면(noData 아님, 열쇠 직접) 3벳은 같고 콜이 더 좁다
    const raw = R.preData().tables['BTN:R>BB']; let c = 0; R.ALL.forEach(h => { if (raw[h]) c += raw[h][1] / 100 * R.combos(h); });
    assert.ok(R.width({ heroPos: 'BB', openerPos: 'BTN' }).call > c / 13.26 + 5);
});

test('SB · HJ · CO 는 3벳 아니면 폴드(콜 없음), 버튼만 콜이 있다 — 솔버 자료', () => {
    ['UTG', 'HJ', 'CO', 'BTN'].forEach(o => { const w = R.width({ heroPos: 'SB', openerPos: o }); assert.strictEqual(w.call, 0); assert.ok(w.raise >= 6 && w.raise <= 17, `SB vs ${o} ${w.raise}`); });
    assert.strictEqual(R.width({ heroPos: 'HJ', openerPos: 'UTG' }).call, 0);
    assert.strictEqual(R.width({ heroPos: 'CO', openerPos: 'HJ' }).call, 0);
    const btn = R.width({ heroPos: 'BTN', openerPos: 'CO' });
    assert.ok(btn.call >= 3 && btn.raise >= 9 && btn.total >= 13 && btn.total <= 20, JSON.stringify(btn));
});

test('3벳 범위에는 AA 와 함께 A5s 같은 블러프가 섞여 있고, KQo·99 는 주로 콜, 72o 는 폴드', () => {
    const f = c => R.lookup({ heroPos: 'BB', openerPos: 'UTG' }, c);
    assert.strictEqual(f('AA').raise, 100);
    assert.ok(f('A5s').raise >= 25 && f('A5s').raise > f('KQo').raise);
    assert.ok(f('KQo').call >= 80); assert.ok(f('99').call >= 80);
    assert.strictEqual(f('72o').fold, 100);
    assert.strictEqual(R.lookup({ heroPos: 'BB', openerPos: 'BTN' }, 'A5s').raise, 100);
    assert.match(f('AA').name, /솔버/);
});

test('먼저 여는 범위(솔버 자료): 앞자리일수록 좁다 · 자료에 없는 자리는 null', () => {
    const w = p => { let n = 0; R.ALL.forEach(h => { n += (R.openFreq(p, h) || 0) / 100 * R.combos(h); }); return n / 13.26; };
    const u = w('UTG'), h = w('HJ'), c = w('CO'), b = w('BTN');
    assert.ok(u > 14 && u < 21 && u < h && h < c && c < b && b > 38 && b < 48, [u, h, c, b].map(x => x.toFixed(1)).join(' '));
    assert.strictEqual(R.openFreq('UTG', 'AA'), 100); assert.strictEqual(R.openFreq('BTN', '72o'), 0);
    assert.strictEqual(R.openFreq('BB', 'AA'), null);
    assert.strictEqual(R.openFreq('UTG+1', 'AA'), 100);       // 9인 테이블의 자리 이름도 받는다
});

test('행동 기록 열쇠: 스퀴즈 · 3벳 받기 · 4벳 받기 표를 찾고, 자료에 없으면 손으로 적은 표로 넘어간다', () => {
    assert.ok(R.width({ seq: 'CO:R,BTN:C>BB' }).total > 15);                                   // 오픈 + 콜 뒤의 BB(스퀴즈 자리)
    assert.strictEqual(R.lookup({ seq: 'BTN:R,BB:R>BTN' }, 'AA').raise, 100);                    // 내 오픈에 3벳
    assert.strictEqual(R.lookup({ seq: 'UTG:R,BB:R>UTG' }, '76s').raise, 0);
    assert.match(R.keyName('CO:R,BTN:C>BB'), /CO 오픈 · BTN 콜 → BB/);
    assert.strictEqual(R.keyName('MP:R>BB'), 'BB vs HJ 오픈');
    // 림프가 낀 판은 자료에 없다 → 예전 표
    const x = R.lookup({ seq: 'CO:C,BTN:R>BB', heroPos: 'BB', openerPos: 'BTN', raises: 1 }, 'AA');
    assert.ok(x && !x.data && x.raise === 100);
    assert.ok(R.lookup({ headsUp: true, heroPos: 'BB' }, 'AA') && !R.lookup({ headsUp: true, heroPos: 'BB' }, 'AA').data);
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
    const on = PF.preflopRangeTier('AA', 'BB', true, { chart: true, openerPos: 'UTG', closing: true });
    assert.strictEqual(on.tier, 'raise'); assert.strictEqual(on.freq.raise, 100); assert.ok(on.gap > 0);
    const off = PF.preflopRangeTier('A5s', 'BB', true, { openerPos: 'UTG', closing: true });
    assert.strictEqual(off.freq, undefined);
    assert.ok(PF.preflopRangeTier('72o', 'BB', true, { chart: true, openerPos: 'BTN', closing: true }).gap < 0);
    // 먼저 여는 자리도 솔버 빈도
    const open = PF.preflopRangeTier('AJo', 'UTG', false, { chart: true });
    assert.strictEqual(open.tier, 'raise'); assert.strictEqual(open.freq.raise, 100);
    assert.strictEqual(PF.preflopRangeTier('AJo', 'UTG', false).freq, undefined);
});

test('가격: 오픈이 작으면 넓게, 크면 좁게 — 3벳 범위는 그대로', () => {
    const w = po => { let r = 0, c = 0; R.ALL.forEach(x => { const f = PF.preflopRangeTier(x, 'BB', true, { chart: true, headsUp: true, closing: true, potOdds: po }).freq; r += f.raise / 100 * R.combos(x); c += f.call / 100 * R.combos(x); }); return [r / 13.26, (r + c) / 13.26]; };
    const a = w(1 / 4), b = w(1.5 / 5), c = w(2 / 6);
    assert.ok(a[1] > b[1] + 10 && b[1] > c[1] + 10, [a[1], b[1], c[1]].join(' '));
    assert.ok(Math.abs(a[0] - c[0]) < 0.01);
    assert.ok(b[1] > 60 && b[1] < 72);
});
