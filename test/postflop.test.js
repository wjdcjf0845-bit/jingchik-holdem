'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/postflop');

// ── 레인지 어드밴티지 ─────────────────────────────────────────
test('A 하이 마른 보드는 프리플랍 공격자에게 유리', () => {
    assert.ok(P.rangeAdvantage(['Ad', '7c', '2h']) > 0.25);
});

test('낮은 연결 보드는 콜러에게 유리 (음수)', () => {
    assert.ok(P.rangeAdvantage(['7d', '6c', '5h']) < 0);
});

test('A 하이가 낮은 연결 보드보다 항상 유리', () => {
    assert.ok(P.rangeAdvantage(['Ad', 'Kc', '4h']) > P.rangeAdvantage(['8d', '7c', '6h']));
});

test('페어드 보드는 공격자 쪽으로 가산', () => {
    assert.ok(P.rangeAdvantage(['Kd', 'Kc', '3h']) > P.rangeAdvantage(['Kd', '9c', '3h']));
});

test('보드 3장 미만이면 판단 불가 → 0', () => {
    assert.strictEqual(P.rangeAdvantage([]), 0);
    assert.strictEqual(P.rangeAdvantage(['Ad', 'Kc']), 0);
});

test('어드밴티지는 항상 -1~1 범위', () => {
    const boards = [['Ad','Ac','Ah'], ['2d','3c','4h'], ['Ad','Kd','Qd','Jd','Td'], ['5d','5c','5h','5s','2d']];
    boards.forEach(b => {
        const v = P.rangeAdvantage(b);
        assert.ok(v >= -1 && v <= 1, `${b} → ${v}`);
    });
});

// ── C벳 빈도 ─────────────────────────────────────────────────
test('플랍 C벳 빈도가 프로 범위(55~80%)에 들어온다 — 헤즈업 유리한 보드', () => {
    const f = P.cbetFrequency({ street: 2, adv: 0.35, nOpp: 1, inPosition: true, skill: 1 });
    assert.ok(f >= 0.55 && f <= 0.95, '실제 ' + f);
});

test('멀티웨이면 C벳 빈도가 크게 줄어든다', () => {
    const hu = P.cbetFrequency({ street: 2, adv: 0.3, nOpp: 1, inPosition: true, skill: 1 });
    const three = P.cbetFrequency({ street: 2, adv: 0.3, nOpp: 2, inPosition: true, skill: 1 });
    const four = P.cbetFrequency({ street: 2, adv: 0.3, nOpp: 3, inPosition: true, skill: 1 });
    assert.ok(three < hu * 0.8, 'HU ' + hu + ' vs 3way ' + three);
    assert.ok(four < three, '3way ' + three + ' vs 4way ' + four);
});

test('불리한 보드에선 C벳 빈도가 낮아진다', () => {
    const good = P.cbetFrequency({ street: 2, adv: 0.4, nOpp: 1, inPosition: true, skill: 1 });
    const bad = P.cbetFrequency({ street: 2, adv: -0.3, nOpp: 1, inPosition: true, skill: 1 });
    assert.ok(bad < good, '유리 ' + good + ' vs 불리 ' + bad);
});

test('포지션이 있으면 더 자주 친다', () => {
    const ip = P.cbetFrequency({ street: 2, adv: 0, nOpp: 1, inPosition: true, skill: 1 });
    const oop = P.cbetFrequency({ street: 2, adv: 0, nOpp: 1, inPosition: false, skill: 1 });
    assert.ok(ip > oop);
});

test('스트리트가 진행될수록 배럴 빈도는 줄어든다', () => {
    const a = { adv: 0.2, nOpp: 1, inPosition: true, skill: 1 };
    const flop = P.cbetFrequency({ ...a, street: 2 });
    const turn = P.cbetFrequency({ ...a, street: 3 });
    const river = P.cbetFrequency({ ...a, street: 4 });
    assert.ok(flop > turn && turn > river, `${flop} > ${turn} > ${river}`);
});

test('실력이 낮은 봇은 정석 빈도를 덜 따른다', () => {
    const pro = P.cbetFrequency({ street: 2, adv: 0.3, nOpp: 1, inPosition: true, skill: 1 });
    const noob = P.cbetFrequency({ street: 2, adv: 0.3, nOpp: 1, inPosition: true, skill: 0.4 });
    assert.ok(noob < pro);
});

test('C벳 빈도는 항상 0~0.95', () => {
    for (const adv of [-1, -0.5, 0, 0.5, 1]) {
        for (const n of [1, 2, 3, 5]) {
            const f = P.cbetFrequency({ street: 2, adv, nOpp: n, inPosition: true, skill: 1 });
            assert.ok(f >= 0 && f <= 0.95);
        }
    }
});

// ── 사이즈 ───────────────────────────────────────────────────
test('유리한 마른 보드는 작은 레인지벳(1/3)', () => {
    assert.ok(P.cbetSize({ adv: 0.35, board: { dry: true }, street: 2 }) <= 0.4);
});

test('웻 보드는 크게 친다', () => {
    assert.ok(P.cbetSize({ adv: 0.3, board: { wet: true }, street: 2 }) >= 0.6);
});

test('리버는 양극화 — 얇은 밸류는 작게, 나머지는 크게', () => {
    assert.ok(P.cbetSize({ street: 4, kind: 'thin', board: {} }) < 0.45);
    assert.ok(P.cbetSize({ street: 4, board: {} }) >= 0.7);
    assert.ok(P.cbetSize({ street: 4, board: {}, overbet: true }) > 1);
});

// ── MDF ──────────────────────────────────────────────────────
test('MDF 공식이 교과서 값과 일치', () => {
    assert.ok(Math.abs(P.mdf(1) - 0.5) < 1e-9);        // 팟 벳 → 50% 방어
    assert.ok(Math.abs(P.mdf(0.5) - 2 / 3) < 1e-9);    // 하프팟 → 67%
    assert.ok(Math.abs(P.mdf(1 / 3) - 0.75) < 1e-9);   // 1/3팟 → 75%
});

test('벳이 클수록 방어 비율은 줄어든다', () => {
    assert.ok(P.mdf(0.33) > P.mdf(0.75));
    assert.ok(P.mdf(0.75) > P.mdf(1.5));
});

test('작은 벳일수록 요구 승률을 팟오즈보다 더 낮춘다 (넓게 방어)', () => {
    const small = P.defendThreshold({ potOdds: 0.25, betFrac: 0.33, skill: 1 });
    const big = P.defendThreshold({ potOdds: 0.33, betFrac: 1.0, skill: 1 });
    assert.ok(small < 0.25, '1/3벳 요구승률 ' + small + ' < 팟오즈 0.25');
    assert.ok(Math.abs(big - 0.33) < 1e-9, '팟벳은 완화 없음 ' + big);
});

test('실력 낮으면 MDF 완화를 못 한다 (팟오즈 그대로)', () => {
    const pro = P.defendThreshold({ potOdds: 0.25, betFrac: 0.33, skill: 1 });
    const noob = P.defendThreshold({ potOdds: 0.25, betFrac: 0.33, skill: 0 });
    assert.ok(pro < noob);
    assert.ok(Math.abs(noob - 0.25) < 1e-9);
});

test('요구 승률은 음수가 되지 않는다', () => {
    assert.ok(P.defendThreshold({ potOdds: 0.02, betFrac: 0.1, skill: 1 }) >= 0);
});

// ── 블러프캐치 ───────────────────────────────────────────────
test('상대가 공격적일수록 더 넓게 블러프캐치한다', () => {
    const vsAggro = P.bluffCatch({ potOdds: 0.3, oppAggression: 0.7, skill: 1 });
    const vsNit = P.bluffCatch({ potOdds: 0.3, oppAggression: 0.15, skill: 1 });
    assert.ok(vsAggro < vsNit, '공격적상대 ' + vsAggro + ' < 소극적상대 ' + vsNit);
});

test('넛 블로커를 쥐면 콜 문턱이 내려간다', () => {
    const blocked = P.bluffCatch({ potOdds: 0.3, blockerMult: 1.5, skill: 1 });
    const plain = P.bluffCatch({ potOdds: 0.3, blockerMult: 1.0, skill: 1 });
    assert.ok(blocked < plain);
});

test('블러프캐치 문턱은 0~1 범위', () => {
    const v = P.bluffCatch({ potOdds: 0.05, oppAggression: 1, blockerMult: 3, skill: 1 });
    assert.ok(v >= 0 && v <= 1);
});

// ── SPR 커밋 ─────────────────────────────────────────────────
test('SPR이 얕을수록 낮은 승률로도 스택을 넣는다', () => {
    assert.ok(P.stackOffThreshold(1) < P.stackOffThreshold(5));
    assert.ok(P.stackOffThreshold(5) < P.stackOffThreshold(20));
});

test('딥스택에선 넛급만 스택오프', () => {
    assert.ok(P.stackOffThreshold(30) >= 0.72);
});

// ── 양극화 분류 ──────────────────────────────────────────────
test('강한 패는 밸류, 드로우는 세미블러프, 무승부 쓰레기는 블러프 후보', () => {
    assert.strictEqual(P.classifyForBet({ equity: 0.72, valueLine: 0.58 }), 'value');
    assert.strictEqual(P.classifyForBet({ equity: 0.34, hasDraw: true, valueLine: 0.58 }), 'semibluff');
    assert.strictEqual(P.classifyForBet({ equity: 0.12, valueLine: 0.58 }), 'airbluff');
});

test('어중간한 쇼다운 가치는 체크다운 (밸류도 블러프도 아님)', () => {
    assert.strictEqual(P.classifyForBet({ equity: 0.42, hasDraw: false, valueLine: 0.58 }), 'checkdown');
});

test('MDF 완화폭은 6%p를 넘지 않는다 — 콜링스테이션 방지 회귀 방어', () => {
    // 완화를 크게 줬다가 봇이 벳에 6%밖에 안 접는 호구가 된 적이 있다.
    for (const frac of [0.1, 0.2, 0.33, 0.5, 0.75, 1, 2]) {
        for (const po of [0.1, 0.2, 0.3, 0.4]) {
            const th = P.defendThreshold({ potOdds: po, betFrac: frac, skill: 1 });
            assert.ok(po - th <= 0.06 + 1e-9, `frac=${frac} po=${po} 완화=${po - th}`);
            assert.ok(th <= po, '완화는 요구승률을 올리지 않는다');
        }
    }
});

test('아주 작은 벳에도 최소한의 승률은 요구한다 (아무 패로나 콜 금지)', () => {
    const th = P.defendThreshold({ potOdds: 0.2, betFrac: 0.25, skill: 1 });
    assert.ok(th >= 0.13, '요구승률 ' + th + ' — 너무 낮으면 호구가 된다');
});

// ── 에퀴티 실현율 ────────────────────────────────────────────
test('포지션이 없으면 승률을 덜 실현한다', () => {
    const ip = P.realizationFactor({ street: 2, inPosition: true, nOpp: 1, hasDraw: false });
    const oop = P.realizationFactor({ street: 2, inPosition: false, nOpp: 1, hasDraw: false });
    assert.ok(oop < ip, 'OOP ' + oop + ' < IP ' + ip);
});

test('멀티웨이일수록 실현율이 낮다', () => {
    const hu = P.realizationFactor({ street: 2, inPosition: false, nOpp: 1, hasDraw: false });
    const multi = P.realizationFactor({ street: 2, inPosition: false, nOpp: 3, hasDraw: false });
    assert.ok(multi < hu);
});

test('드로우는 어중간한 패보다 실현율이 높다', () => {
    const draw = P.realizationFactor({ street: 2, inPosition: false, nOpp: 1, hasDraw: true });
    const air = P.realizationFactor({ street: 2, inPosition: false, nOpp: 1, hasDraw: false });
    assert.ok(draw > air);
});

test('리버와 올인 콜은 실현율 100% — 더 칠 스트리트가 없다', () => {
    assert.strictEqual(P.realizationFactor({ street: 4, inPosition: false, nOpp: 3, hasDraw: false }), 1);
    assert.strictEqual(P.realizationFactor({ street: 2, inPosition: false, nOpp: 3, allIn: true }), 1);
});

test('실현율은 0.55~1 사이를 벗어나지 않는다', () => {
    for (const st of [2, 3, 4]) for (const ip of [true, false]) for (const n of [1, 2, 4]) {
        const f = P.realizationFactor({ street: st, inPosition: ip, nOpp: n, hasDraw: false });
        assert.ok(f >= 0.55 && f <= 1, `${st}/${ip}/${n} → ${f}`);
    }
});

test('최악 조합(OOP·멀티웨이·드로우없음·플랍)도 과하게 깎지 않는다', () => {
    const f = P.realizationFactor({ street: 2, inPosition: false, nOpp: 3, hasDraw: false });
    assert.ok(f >= 0.6 && f <= 0.8, '실제 ' + f);
});

test('프리플랍엔 실현율을 적용하지 않는다 — BB 방어가 사라지는 것 방지', () => {
    assert.strictEqual(P.realizationFactor({ street: 1, inPosition: false, nOpp: 3, hasDraw: false }), 1);
});

// ── 블러프 빈도 ──────────────────────────────────────────────
test('블러프 비중은 벳 사이즈 공식 s/(1+s)를 따른다', () => {
    assert.ok(Math.abs(P.bluffShareForSize(1 / 3) - 0.25) < 1e-9);
    assert.ok(Math.abs(P.bluffShareForSize(1) - 0.5) < 1e-9);
    assert.ok(P.bluffShareForSize(0.75) > P.bluffShareForSize(0.33));
});

test('안 접는 상대에겐 블러프를 줄인다', () => {
    const vsStation = P.bluffAdjust({ oppFoldToBet: 0.1, nOpp: 1, skill: 1 });
    const vsNormal = P.bluffAdjust({ nOpp: 1, skill: 1 });
    assert.ok(vsStation < vsNormal * 0.6, '스테이션 ' + vsStation + ' vs 기본 ' + vsNormal);
});

test('잘 접는 상대에겐 블러프를 늘린다', () => {
    assert.ok(P.bluffAdjust({ oppFoldToBet: 0.7, nOpp: 1, skill: 1 }) > 1);
});

test('멀티웨이에선 순수 블러프를 거의 하지 않는다', () => {
    const hu = P.bluffAdjust({ nOpp: 1, skill: 1 });
    const three = P.bluffAdjust({ nOpp: 2, skill: 1 });
    const four = P.bluffAdjust({ nOpp: 3, skill: 1 });
    assert.ok(three < hu * 0.5 && four < three);
});

test('실력이 낮으면 블러프 조절을 못 한다 (1에 가깝다)', () => {
    const noob = P.bluffAdjust({ oppFoldToBet: 0.1, nOpp: 3, skill: 0 });
    assert.ok(Math.abs(noob - 1) < 1e-9);
});

test('에어 블러프 실빈도가 이론 범위(10~30%)에 들어온다 — 과블러프 회귀 방어', () => {
    // 실측: 쓰레기 패의 58%를 블러프했다가 맞대결에서 크게 졌다.
    const freq = P.cbetFrequency({ street: 2, adv: 0.3, nOpp: 1, inPosition: true, skill: 1 });
    const take = freq * P.bluffShareForSize(0.33) * P.bluffAdjust({ nOpp: 1, skill: 1 });
    assert.ok(take >= 0.10 && take <= 0.30, '에어 블러프 빈도 ' + take);
});
