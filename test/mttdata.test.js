const test = require('node:test');
const assert = require('node:assert');
const Ranges = require('../lib/ranges');
const PF = require('../lib/preflop');

// HRC 로 직접 푼 대회용 프리플랍 자료(lib/preflop_mtt.json.gz)를 인원·깊이에 맞게 고르는가
test('자료가 있고, 6인 자료는 오픈·방어 표를 갖고 있다', () => {
    const D = Ranges.mttData();
    assert.ok(D && D['25'] && D['25'].tables['>BTN'] && D['25'].tables['BTN:R>BB']);
    Object.keys(D).forEach(k => {
        assert.match(k, /^(\d+|p[2-5]_\d+|i[3-6]_\d+|[nbf][3-9]_\d+)$/);
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

// 🏆 결승 테이블 상금(ICM) 표: icm 을 주면 그 인원의 i<인원>_<깊이> 를 먼저 쓰고, 없으면 칩 기준 표로 돌아간다
test('결승 상금 표: icm 이면 상금 반영 표 · 아니면 칩 기준 표', () => {
    const D = Ranges.mttData();
    if (!D['i4_20']) return;
    assert.strictEqual(Ranges.mttDepth(20, 4, true), 'i4_20');
    assert.strictEqual(Ranges.mttDepth(20, 4, false), 'p4_20');
    assert.strictEqual(Ranges.mttDepth(20, 2, true), 'p2_20');             // 헤즈업은 상금 차이가 없다
    assert.strictEqual(Ranges.mttDepth(45, 4, true), 'p4_40');             // 상금 표의 깊이 밖이면 칩 기준
    const f = Ranges.lookup({ seqA: '>CO', depth: 20, players: 4, icm: true, heroPos: 'CO', raises: 1 }, 'AKs');
    assert.ok(f && f.mtt && f.icm && /상금 반영/.test(f.name));
    // 버블에서는 올인을 받는 범위가 칩 기준보다 좁다
    const w = (d, k) => Ranges.ALL.reduce((a, c) => a + ((D[d].tables[k] || {})[c] || [0, 0])[1] * Ranges.combos(c), 0);
    const key = Object.keys(D['i4_20'].tables).find(k => /^[A-Z]+:A>BB$/.test(k) && D['p4_20'].tables[k]);
    if (key) assert.ok(w('i4_20', key) < w('p4_20', key), key);
});

// 🪑 9인 표: 자리를 나눠 적은 열쇠(UTG1·UTG2·LJ·HJ)로 찾고, 6인 표로 돌아갈 때는 예전 이름으로 바꿔 찾는다
test('9인 자리 열쇠: 9인 표는 그대로 · 6인 표는 collapseKey', () => {
    assert.strictEqual(Ranges.collapseKey('UTG1:R,LJ:C>HJ'), 'UTG:R,UTG:C>MP');
    assert.strictEqual(Ranges.collapseKey('BTN:R>BB'), 'BTN:R>BB');
    assert.strictEqual(Ranges.seqPos('UTG+2'), 'UTG2');
    const D = Ranges.mttData();
    if (!D['n9_15']) return;
    assert.strictEqual(Ranges.mttDepth(15, 9), 'n9_15');
    assert.ok(/^\d+$/.test(Ranges.mttDepth(15, 6)));
    // 9인 표에서는 앞자리일수록 좁게 연다
    const open = k => Ranges.ALL.reduce((a, c) => a + ((D['n9_15'].tables[k] || {})[c] || [0])[0] * Ranges.combos(c), 0);
    assert.ok(open('>UTG') < open('>LJ') && open('>LJ') < open('>CO') && open('>CO') < open('>BTN'));
    const f = Ranges.lookup({ seqA: 'UTG1:R>BB', depth: 15, players: 9, heroPos: 'BB', raises: 1 }, 'KJo');
    assert.ok(f && f.mtt && /9명/.test(f.name) && /UTG\+1/.test(f.name));
    // 9인 자료가 없는 인원(8명)은 6인 표를 예전 이름으로 찾는다
    const g = Ranges.lookup({ seqA: 'UTG1:R>BB', depth: 15, players: 8, heroPos: 'BB', raises: 1 }, 'KJo');
    assert.ok(g && g.mtt && !/9명/.test(g.name));
});
// 🏆 딥스택 결승(6위 입상 · 실제 상금): icm 'f' 면 7명은 b7_, 나머지는 f<인원>_ — 없으면 칩 기준 표
test("결승 상금 표 'f': b7 · f<인원> 을 먼저, 없으면 칩 기준", () => {
    const D = Ranges.mttData();
    const has = k => Object.keys(D).some(x => x.indexOf(k) === 0);
    if (has('b7_')) assert.ok(/^b7_/.test(Ranges.mttDepth(20, 7, 'f')));
    if (has('f5_')) assert.ok(/^f5_/.test(Ranges.mttDepth(20, 5, 'f')));
    if (!has('f4_')) assert.ok(!/^f/.test(String(Ranges.mttDepth(20, 4, 'f'))));
    assert.ok(Ranges.isIcmDepth('b7_20') && Ranges.isIcmDepth('f5_20') && Ranges.isIcmDepth('i3_20') && !Ranges.isIcmDepth('n9_20'));
});
