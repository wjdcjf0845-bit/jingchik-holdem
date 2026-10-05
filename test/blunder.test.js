const test = require('node:test');
const assert = require('node:assert');
const B = require('../lib/blunder');

const adv = (mix, best, extra) => Object.assign({ mix, bestAction: best, street: 'flop', equity: 50, potOdds: 25 }, extra || {});

test('실수 판정: 권장 액션이거나 권장 빈도 15% 이상이면 실수가 아니다', () => {
    assert.strictEqual(B.assess(adv({ fold: 5, call: 75, raise: 20 }, 'call'), 'call', { bb: 100, pot: 900, toCall: 300, putIn: 300, equity: 0.5, street: 'flop' }), null);
    assert.strictEqual(B.assess(adv({ fold: 5, call: 75, raise: 20 }, 'call'), 'raise', { bb: 100, pot: 900, toCall: 300, putIn: 900, equity: 0.5, street: 'flop' }), null);
    // 체크 가능한 자리에서의 레이즈는 '벳'으로 본다
    assert.strictEqual(B.assess(adv({ check: 30, bet: 70 }, 'bet'), 'raise', { bb: 100, pot: 600, toCall: 0, putIn: 400, equity: 0.7, street: 'flop' }), null);
});

test('실수 유형과 손실 어림값', () => {
    // 승률 50%, 팟 900에 300 콜 → 접으면 0.5×1200−300 = 300 = 3bb 손해
    const of = B.assess(adv({ fold: 5, call: 75, raise: 20 }, 'call'), 'fold', { bb: 100, pot: 900, toCall: 300, putIn: 0, equity: 0.5, street: 'flop' });
    assert.deepStrictEqual(of, { kind: 'overfold', costBB: 3 });
    // 승률 10%, 팟 1000에 1000 콜 → 1000 − 0.1×2000 = 800 = 8bb 손해
    const oc = B.assess(adv({ fold: 95, call: 5 }, 'fold'), 'call', { bb: 100, pot: 1000, toCall: 1000, putIn: 1000, equity: 0.1, street: 'river' });
    assert.deepStrictEqual(oc, { kind: 'overcall', costBB: 8 });
    assert.strictEqual(B.assess(adv({ check: 100 }, 'check'), 'fold', { bb: 100, pot: 400, toCall: 0, putIn: 0, equity: 0.3, street: 'flop' }).kind, 'freefold');
    assert.strictEqual(B.assess(adv({ check: 10, bet: 90 }, 'bet'), 'check', { bb: 100, pot: 800, toCall: 0, putIn: 0, equity: 0.8, street: 'turn' }).kind, 'missedvalue');
    assert.strictEqual(B.assess(adv({ fold: 92, raise: 8 }, 'fold', { street: 'preflop' }), 'allin', { bb: 100, pot: 150, toCall: 100, putIn: 5000, equity: 0.4, street: 'preflop' }).kind, 'spew');
    assert.strictEqual(B.assess(adv({ check: 90, bet: 10 }, 'check'), 'raise', { bb: 100, pot: 800, toCall: 0, putIn: 600, equity: 0.4, street: 'turn' }).kind, 'badbluff');
    assert.strictEqual(B.assess(null, 'fold', { bb: 100 }), null);
});

test('보관: 30일 지난 것은 버리고, 넘치면 하루 넘은 것 중 가벼운 것부터 뺀다 · 손실 큰 순으로 꺼낸다', () => {
    const now = 1e12, day = 86400000;
    let list = [{ t: now - 40 * day, costBB: 99 }];
    list = B.add(list, { t: now, costBB: 1 }, now);
    assert.strictEqual(list.length, 1, '40일 전 기록은 사라진다');
    for (let i = 0; i < B.MAX_KEEP + 5; i++) list = B.add(list, { t: now - 2 * day, costBB: 2 + i }, now);
    assert.strictEqual(list.length, B.MAX_KEEP);
    assert.ok(list.some(r => r.t === now && r.costBB === 1), '방금 기록은 가벼워도 남는다');
    const top = B.top(list, now - 3 * day, 3);
    assert.strictEqual(top.length, 3);
    assert.ok(top[0].costBB >= top[1].costBB && top[1].costBB >= top[2].costBB);
    assert.strictEqual(B.top(list, now - 1000, 3).length, 1, '기간 밖 기록은 빠진다');
});

test('설명 글: 상황 · 내 플레이 · 권장이 들어간다', () => {
    const d = B.describe({ t: 1, kind: 'overcall', costBB: 8, street: 'river', hand: ['Ks', '7d'], board: ['Ah', 'Qd', '9c', '4s', '2h'], pos: 'BB', seats: 4, opp: 1,
        potBB: 10, toCallBB: 10, stackBB: 60, act: 'call', amtBB: 10, best: 'fold', bestPct: 95, didPct: 5, eq: 10, odds: 50, reason: '승률이 팟오즈보다 낮음', netBB: -10 });
    assert.match(d.situation, /리버/); assert.match(d.situation, /BB 자리/); assert.match(d.situation, /4명 테이블/); assert.match(d.situation, /콜 10bb 필요/);
    assert.strictEqual(d.did, '콜 10bb'); assert.strictEqual(d.should, '폴드'); assert.strictEqual(d.netBB, -10);
    assert.strictEqual(d.title, '접어야 할 패로 콜');
});
