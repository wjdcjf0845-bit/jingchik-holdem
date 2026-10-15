const test = require('node:test');
const assert = require('node:assert');
const { mcEquity, preflopStrength } = require('../lib/equitymc');
const EqPool = require('../lib/eqpool');

test('승률(몬테카를로): 넛에 가까운 패는 높고 · 상대가 많을수록 낮고 · 정밀하게 돌리면 두 번 값이 가깝다', () => {
    const set = mcEquity({ hand: ['As', 'Ad'], board: ['Ah', '7c', '2d'], oppMin: [0], iters: 2000 });
    assert.ok(set > 0.9, '탑셋은 아무 패 상대로 90% 넘게: ' + set);
    const air = mcEquity({ hand: ['3s', '4d'], board: ['Ah', 'Kc', 'Qd', '9s', '8h'], oppMin: [0], iters: 2000 });
    assert.ok(air < 0.15, '리버에 아무것도 없는 패: ' + air);
    const one = mcEquity({ hand: ['Ks', 'Kd'], board: ['2h', '7c', '9d'], oppMin: [0], iters: 3000 });
    const three = mcEquity({ hand: ['Ks', 'Kd'], board: ['2h', '7c', '9d'], oppMin: [0, 0, 0], iters: 3000 });
    assert.ok(three < one - 0.1, `상대 셋이면 더 낮다: ${one} → ${three}`);
    const a = mcEquity({ hand: ['Jh', 'Th'], board: ['9h', '8c', '2h'], oppMin: [0], iters: 4000 });
    const b = mcEquity({ hand: ['Jh', 'Th'], board: ['9h', '8c', '2h'], oppMin: [0], iters: 4000 });
    assert.ok(Math.abs(a - b) < 0.05, `4000번이면 두 번 돌린 값이 가깝다: ${a} / ${b}`);
    assert.ok(preflopStrength(['As', 'Ah']) > preflopStrength(['7c', '2d']));
});

test('승률 계산 스레드: 본 스레드와 같은 계산을 따로 돌려 돌려준다', async () => {
    const v = await EqPool.request({ hand: ['As', 'Ad'], board: ['Ah', '7c', '2d'], oppMin: [0], iters: 1000 }, 5000);
    assert.strictEqual(typeof v, 'number');
    assert.ok(v > 0.9, '탑셋: ' + v);
    await EqPool.close();
});
