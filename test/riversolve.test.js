const test = require('node:test');
const assert = require('node:assert');
const RS = require('../lib/riversolve');

// 교과서 문제: 보드 2s2h2d3c3d, 먼저 행동하는 쪽은 "넛(AA) 아니면 꽝(54)" , 나중 쪽은 중간 패(KK)만.
//   팟 100, 벳 100(팟 벳) → 벳하는 쪽은 밸류 2 : 블러프 1 로 치고, 받는 쪽은 절반만 콜한다. 벳하는 쪽의 값은 범위 전체가 팟을 가져가는 것과 같다.
const board = ['2s', '2h', '2d', '3c', '3d'];
const oop = [{ hand: ['As', 'Ah'], w: 1 }, { hand: ['5s', '4h'], w: 1 }];     // 넛 1 : 꽝 1
const ip = [{ hand: ['Ks', 'Kh'], w: 1 }];

test('리버 계산기: 양극 범위 대 블러프 캐처 — 블러프는 밸류의 절반, 콜은 절반', () => {
    const r = RS.solve({ board, pot: 100, stack: 100, bet: 100, oop, ip, iters: 4000 });
    const nut = r.oop[0], air = r.oop[1], kk = r.ip[0];
    assert.ok(nut.sBet > 0.97, '넛은 벳: ' + nut.sBet);
    assert.ok(Math.abs(air.sBet - 0.5) < 0.05, '꽝은 절반 블러프: ' + air.sBet);       // 밸류 1 에 블러프 0.5
    assert.ok(Math.abs(kk.sCall - 0.5) < 0.05, '블러프 캐처는 절반 콜: ' + kk.sCall);
    // 블러프와 체크의 값이 같아야 섞는다(무차별), 넛의 벳 값 = 팟 + 콜 받는 만큼
    assert.ok(Math.abs(air.evBet - air.evCheck) < 3, `${air.evBet} vs ${air.evCheck}`);
    assert.ok(Math.abs(nut.evBet - 150) < 5, '넛의 벳 값 ≈ 100 + 0.5×100: ' + nut.evBet);
    assert.ok(Math.abs(kk.evCall) < 3, '콜과 폴드가 무차별: ' + kk.evCall);
});

test('리버 계산기: 벳이 작으면 블러프가 줄고 콜이 는다 (팟의 절반 → 블러프 1/3, 콜 2/3)', () => {
    const r = RS.solve({ board, pot: 100, stack: 100, bet: 50, oop, ip, iters: 4000 });
    assert.ok(Math.abs(r.oop[1].sBet - 1 / 3) < 0.05, String(r.oop[1].sBet));
    assert.ok(Math.abs(r.ip[0].sCall - 2 / 3) < 0.05, String(r.ip[0].sCall));
});

test('리버 계산기: 지고 있는 패로는 벳하지 않고, 이기는 패는 체크 뒤 벳을 받는다 / 카드가 겹치는 짝은 뺀다', () => {
    const r = RS.solve({ board: ['Ks', '9d', '4c', '7h', '2s'], pot: 100, stack: 200,
        oop: [{ hand: ['Kd', 'Qd'], w: 1 }, { hand: ['8h', '8c'], w: 1 }],
        ip: [{ hand: ['Ah', 'Kc'], w: 1 }, { hand: ['Jc', 'Td'], w: 1 }, { hand: ['Kd', 'Jd'], w: 1 }], iters: 1500 });
    assert.strictEqual(r.oop.length, 2); assert.strictEqual(r.ip.length, 3);
    r.oop.concat(r.ip).forEach(x => { assert.ok(x.sBet >= 0 && x.sBet <= 1); assert.ok(Number.isFinite(x.evBet) && Number.isFinite(x.evCheck)); });
    assert.ok(r.ip[0].sBet > 0.6, 'AK 는 체크 받으면 밸류 벳: ' + r.ip[0].sBet);
    assert.strictEqual(RS.solve({ board, pot: 0, stack: 10, oop, ip }), null);
});

test('리버 계산기: 범위가 넓어도 빠르다(각 120패, 300회)', () => {
    const deck = []; for (const r of '23456789TJQKA') for (const s of 'shdc') deck.push(r + s);
    const bd = ['Ks', '9d', '4c', '7h', '2s'], rest = deck.filter(c => !bd.includes(c));
    const mk = seed => { const out = []; let x = seed; for (let i = 0; i < 120; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; const p = rest[x % rest.length]; x = (x * 1103515245 + 12345) & 0x7fffffff; const q = rest[x % rest.length]; if (p !== q) out.push({ hand: [p, q], w: 1 }); } return out; };
    const t0 = Date.now(), r = RS.solve({ board: bd, pot: 600, stack: 3000, oop: mk(7), ip: mk(99), iters: 300 });
    const ms = Date.now() - t0;
    assert.ok(r && r.oop.length > 100);
    assert.ok(ms < 1500, ms + 'ms');
    console.log('    (걸린 시간 ' + ms + 'ms)');
});
