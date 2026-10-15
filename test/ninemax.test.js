const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/ranges');
const J = require('../lib/jam');

const pct = f => { const m = J.load(); let a = 0, b = 0; R.ALL.forEach((c, i) => { b += m.combos[i]; const v = f(c); if (v != null) a += m.combos[i] * v / 100; }); return a / b * 100; };

test('9인: LJ 는 6인 UTG 와 같은 자리 · 앞자리는 한 칸 앞으로 갈수록 좁게 연다(대회용 자료 · 100bb 모두)', () => {
    assert.strictEqual(R.posKey('LJ'), 'UTG');
    assert.strictEqual(R.posKey('UTG+2'), 'UTG');
    assert.strictEqual(R.dataPos('HJ'), 'MP');
    for (const d of [15, 25, 40]) {
        const w = [0, 1, 2, 3].map(e => pct(c => { const o = R.mttOpen('UTG', c, d, 9, false, e); return o ? o.raise : null; }));
        assert.ok(w[0] > w[1] && w[1] > w[2] && w[2] > w[3], `${d}bb: ${w.map(x => x.toFixed(1)).join(' > ')}`);
        assert.ok(w[3] > 8 && w[3] < w[0] * 0.8, `${d}bb 가장 앞자리 ${w[3].toFixed(1)}%`);
        // 앞자리에서도 AA 는 늘 열고, 6인 UTG 가 안 여는 패는 앞자리도 안 연다
        assert.strictEqual(R.mttOpen('UTG', 'AA', d, 9, false, 3).raise, R.mttOpen('UTG', 'AA', d, 9, false, 0).raise);
        R.ALL.forEach(c => { const o0 = R.mttOpen('UTG', c, d, 9, false, 0), o3 = R.mttOpen('UTG', c, d, 9, false, 3); assert.ok(o3.raise <= o0.raise + 1e-9, c); });
    }
    const w100 = [0, 1, 2, 3].map(e => pct(c => R.openFreq('UTG', c, e)));
    assert.ok(w100[0] > w100[1] && w100[1] > w100[2] && w100[2] > w100[3], '100bb: ' + w100.map(x => x.toFixed(1)).join(' > '));
});

test('9인: 앞자리에서 먼저 여는 조언(lookup)도 좁힌 범위를 쓴다', () => {
    const f0 = R.lookup({ heroPos: 'UTG', raises: 1, depth: 25, players: 9, extra: 0, seqA: '>UTG' }, 'A5s');
    const f3 = R.lookup({ heroPos: 'UTG', raises: 1, depth: 25, players: 9, extra: 3, seqA: '>UTG' }, 'A5s');
    assert.ok(f0 && f3);
    assert.ok(f3.raise < f0.raise || f0.raise === 0, `A5s 6인 UTG ${f0.raise}% → 9인 UTG ${f3.raise}%`);
    assert.match(f3.name, /9인 앞자리/);
});
