const test = require('node:test');
const assert = require('node:assert');
const Jam = require('../lib/jam');
const Ranges = require('../lib/ranges');
const ix = c => Jam.load().idx[c];

test('승률표: 널리 알려진 값과 맞는다', () => {
    const near = (a, b, v, e = 0.012) => assert.ok(Math.abs(Jam.equity(a, b) - v) < e, `${a} vs ${b} = ${Jam.equity(a, b)}`);
    near('AA', 'KK', 0.82); near('AKs', 'QQ', 0.46); near('AKo', '22', 0.475); near('AA', '72o', 0.88); near('JTs', 'AKo', 0.405); near('KK', 'AKo', 0.70);
    Ranges.ALL.slice(0, 40).forEach(a => Ranges.ALL.slice(40, 80).forEach(b => assert.ok(Math.abs(Jam.equity(a, b) + Jam.equity(b, a) - 1) < 1e-3)));
});

test('헤즈업 푸시/폴드: 알려진 균형(10bb 에서 푸시 약 58% · 콜 약 37%)과 맞는다', () => {
    const r = Jam.solve({ pot: 1.5, hero: { stack: 10, posted: 0.5 }, callers: [{ stack: 10, posted: 1 }], iters: 300 });
    assert.ok(Math.abs(r.jamPct - 0.583) < 0.03, 'push ' + r.jamPct);
    assert.ok(Math.abs(r.callPct[0] - 0.374) < 0.03, 'call ' + r.callPct[0]);
    assert.ok(r.jam[ix('AA')] > 0.99 && r.jam[ix('72o')] < 0.5 && r.jam[ix('A2o')] > 0.9);
    assert.ok(r.call[0][ix('AA')] > 0.99 && r.call[0][ix('32o')] < 0.01);
});

test('스택이 깊을수록 · 뒤에 사람이 많을수록 좁게 민다', () => {
    const hu = s => Jam.solve({ pot: 1.5, hero: { stack: s, posted: 0.5 }, callers: [{ stack: s, posted: 1 }] }).jamPct;
    assert.ok(hu(6) > hu(10) && hu(10) > hu(15) && hu(15) > hu(25));
    const at = k => { const cs = []; for (let i = 0; i < k - 2; i++) cs.push({ stack: 10, posted: 0 }); cs.push({ stack: 10, posted: 0.5 }, { stack: 10, posted: 1 }); return Jam.solve({ pot: 1.5, hero: { stack: 10, posted: 0 }, callers: cs }).jamPct; };
    assert.ok(at(2) > at(3) && at(3) > at(5));
    assert.ok(at(2) > 0.26 && at(2) < 0.40, 'BTN 10bb ' + at(2));     // 알려진 값 약 33~36%
    assert.ok(at(5) > 0.12 && at(5) < 0.22, 'UTG 10bb ' + at(5));     // 알려진 값 약 15~17%
});

test('앤티가 있으면 더 넓게 민다', () => {
    const f = pot => Jam.solve({ pot, hero: { stack: 10, posted: 0 }, callers: [{ stack: 10, posted: 0.5 }, { stack: 10, posted: 1 }] }).jamPct;
    assert.ok(f(2.5) > f(1.5) + 0.03);
});

test('리쉬브: 넓게 여는 자리 상대로 더 넓게, 좁게 여는 자리 상대로 더 좁게', () => {
    const prior = x => Float64Array.from(Ranges.ALL.map(c => (require('../lib/shortstack').handPercentile(c) <= x ? 1 : 0)));
    const f = x => Jam.fracAbove(Jam.solve({ pot: 4.7, hero: { stack: 15, posted: 1 }, callers: [{ stack: 15, posted: 2.2, prior: prior(x) }] }), 0);
    assert.ok(f(0.45) > f(0.15) + 0.05, f(0.45) + ' vs ' + f(0.15));
    const r = Jam.solve({ pot: 4.7, hero: { stack: 15, posted: 1 }, callers: [{ stack: 15, posted: 2.2, prior: prior(0.15) }] });
    assert.ok(r.ev[ix('AA')] > r.ev[ix('AKo')] && r.ev[ix('AKo')] > r.ev[ix('KQo')] && r.ev[ix('72o')] < 0);
});

test('순위 · 캐시', () => {
    const o = { pot: 2.5, hero: { stack: 9.6, posted: 0 }, callers: [{ stack: 22.3, posted: 0.5 }, { stack: 14.2, posted: 1 }] };
    const a = Jam.solveCached(o), b = Jam.solveCached({ pot: 2.6, hero: { stack: 10.2, posted: 0 }, callers: [{ stack: 21.9, posted: 0.5 }, { stack: 14.4, posted: 1 }] });
    assert.strictEqual(a, b);
    assert.ok(Jam.rankOf(a, 'AA') < 0.01 && Jam.rankOf(a, '72o') > 0.9 && Jam.rankOf(a, 'A9s') < Jam.rankOf(a, 'T8o'));
});
