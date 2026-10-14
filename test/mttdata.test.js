const test = require('node:test');
const assert = require('node:assert');
const Ranges = require('../lib/ranges');
const PF = require('../lib/preflop');

// HRC 로 직접 푼 대회용 프리플랍 자료(lib/preflop_mtt.json.gz)를 인원·깊이에 맞게 고르는가
test('자료가 있고, 6인 자료는 오픈·방어 표를 갖고 있다', () => {
    const D = Ranges.mttData();
    assert.ok(D && D['25'] && D['25'].tables['>BTN'] && D['25'].tables['BTN:R>BB']);
    Object.keys(D).forEach(k => {
        assert.match(k, /^(\d+|p[2-5]_\d+)$/);
        Object.values(D[k].tables).forEach(T => Object.values(T).forEach(r => {
            assert.ok(r[0] >= 0 && r[1] >= 0 && r[0] + r[1] <= 100, k + ' ' + JSON.stringify(r));
            if (r[2] != null) assert.ok(r[2] <= r[0]);
        }));
    });
});

test('깊이 고르기: 가장 가까운 깊이, 범위 밖이면 없음, 인원별로 따로', () => {
    assert.strictEqual(Ranges.mttDepth(24, 6), '25');
    assert.strictEqual(Ranges.mttDepth(29, 6), '30');
    assert.strictEqual(Ranges.mttDepth(200, 6), null);
    assert.strictEqual(Ranges.mttDepth(0, 6), null);
    assert.strictEqual(Ranges.mttDepth(21, 2), 'p2_20');
    assert.ok(/^p3_/.test(Ranges.mttDepth(22, 3)));
    assert.strictEqual(Ranges.mttDepth(25), Ranges.mttDepth(25, 6));     // 인원을 안 주면 6인
});

test('오픈 빈도: 강한 패는 열고 약한 패는 접는다 · 버튼이 UTG 보다 넓다', () => {
    const o = (pos, c, d, n) => Ranges.mttOpen(pos, c, d, n);
    assert.strictEqual(o('UTG', 'AA', 25, 6).raise, 100);
    assert.strictEqual(o('UTG', '72o', 25, 6).raise, 0);
    const w = pos => Ranges.ALL.reduce((a, c) => a + (o(pos, c, 25, 6).raise / 100) * Ranges.combos(c), 0);
    assert.ok(w('BTN') > w('CO') && w('CO') > w('UTG'));
});

test('범위표 판단(preflopRangeTier)이 대회용 자료를 쓰고 이름에 깊이를 단다', () => {
    const r = PF.preflopRangeTier('AKo', 'BTN', false, { chart: true, depth: 22, players: 6 });
    assert.ok(r.freq && r.freq.mtt && /직접 푼 대회용/.test(r.chartName));
    const d = PF.preflopRangeTier('KJo', 'BB', true, { chart: true, depth: 25, players: 6, raises: 1, openerPos: 'BTN', closing: true, seqA: 'BTN:R>BB', seq: 'BTN:R>BB' });
    assert.ok(d.freq && d.freq.mtt && d.freq.raise + d.freq.call + d.freq.fold === 100);
    const deep = PF.preflopRangeTier('KJo', 'BB', true, { chart: true, depth: 100, players: 6, raises: 1, openerPos: 'BTN', closing: true, seq: 'BTN:R>BB' });
    assert.ok(!(deep.freq && deep.freq.mtt));              // 깊으면 100bb 표
    const hu = PF.preflopRangeTier('K7o', 'BTN', false, { chart: true, depth: 20, players: 2, headsUp: true });
    assert.ok(hu.freq && hu.freq.mtt);                     // 헤즈업도 그 인원 자료
});
