'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { requiredEquity, looksLikeDraw } = require('../lib/defense');

// ─────────────────────────────────────────────
//  requiredEquity — 콜에 필요한 최소 승률
// ─────────────────────────────────────────────
test('requiredEquity: 보정 요소가 없으면 팟오즈 그대로', () => {
    const req = requiredEquity({ potOdds: 0.33, skill: 1.0 });
    assert.ok(Math.abs(req - 0.33) < 1e-9, `${req}`);
});

test('requiredEquity: 드로우 + 딥스택이면 필요 승률이 내려간다 (임플라이드 오즈)', () => {
    const shallow = requiredEquity({ potOdds: 0.33, isDraw: true, sprBehind: 0, skill: 1.0 });
    const deep = requiredEquity({ potOdds: 0.33, isDraw: true, sprBehind: 3, skill: 1.0 });
    assert.ok(Math.abs(shallow - 0.33) < 1e-9, `숏스택은 보정 없음: ${shallow}`);
    assert.ok(deep < 0.33, `딥스택은 문턱 인하: ${deep}`);
});

test('requiredEquity: 임플라이드 오즈 인하폭에 상한이 있다', () => {
    const veryDeep = requiredEquity({ potOdds: 0.40, isDraw: true, sprBehind: 100, skill: 1.0 });
    assert.ok(veryDeep >= 0.40 - 0.12 - 1e-9, `상한 초과 인하: ${veryDeep}`);
});

test('requiredEquity: 드로우가 아니면 임플라이드 보정 없음', () => {
    const req = requiredEquity({ potOdds: 0.33, isDraw: false, sprBehind: 5, skill: 1.0 });
    assert.ok(Math.abs(req - 0.33) < 1e-9, `${req}`);
});

test('requiredEquity: 핵심 — 공격적 상대엔 가볍게 콜(문턱↓), 수동적 상대엔 더 폴드(문턱↑)', () => {
    const aggro = requiredEquity({ potOdds: 0.33, oppAggression: 0.75, skill: 1.0 });
    const passive = requiredEquity({ potOdds: 0.33, oppAggression: 0.15, skill: 1.0 });
    assert.ok(aggro < 0.33, `공격적 상대엔 문턱 인하: ${aggro}`);
    assert.ok(passive > 0.33, `수동적 상대엔 문턱 인상: ${passive}`);
    assert.ok(aggro < passive, `공격적(${aggro}) < 수동적(${passive})`);
});

test('requiredEquity: 상대 성향을 모르면(null) 보정 없음', () => {
    const req = requiredEquity({ potOdds: 0.33, oppAggression: null, skill: 1.0 });
    assert.ok(Math.abs(req - 0.33) < 1e-9, `${req}`);
});

test('requiredEquity: 핵심 — 초보 봇(skill 낮음)은 보정이 거의 없다', () => {
    const pro = requiredEquity({ potOdds: 0.33, oppAggression: 0.8, isDraw: true, sprBehind: 4, skill: 1.0 });
    const fish = requiredEquity({ potOdds: 0.33, oppAggression: 0.8, isDraw: true, sprBehind: 4, skill: 0.2 });
    assert.ok(Math.abs(fish - 0.33) < Math.abs(pro - 0.33), `초보가 팟오즈에 더 가까워야 함 (pro ${pro}, fish ${fish})`);
    // skill 0이면 완전히 팟오즈로 수렴
    const zero = requiredEquity({ potOdds: 0.33, oppAggression: 0.8, isDraw: true, sprBehind: 4, skill: 0 });
    assert.ok(Math.abs(zero - 0.33) < 1e-9, `skill 0이면 팟오즈 그대로: ${zero}`);
});

test('requiredEquity: 팟오즈에서 과도하게 벗어나지 않도록 제한된다', () => {
    // 극단적으로 공격적 + 딥 드로우여도 하한 -0.16 이내
    const loose = requiredEquity({ potOdds: 0.40, oppAggression: 1, isDraw: true, sprBehind: 100, skill: 1.0 });
    assert.ok(loose >= 0.40 - 0.16 - 1e-9, `하한 초과: ${loose}`);
    // 극단적으로 수동적이어도 상한 +0.13 이내
    const tight = requiredEquity({ potOdds: 0.20, oppAggression: 0, skill: 1.0 });
    assert.ok(tight <= 0.20 + 0.13 + 1e-9, `상한 초과: ${tight}`);
});

test('requiredEquity: 반환값은 항상 0~1', () => {
    for (const po of [0.05, 0.2, 0.33, 0.5, 0.9]) {
        for (const ag of [0, 0.5, 1, null]) {
            const r = requiredEquity({ potOdds: po, oppAggression: ag, isDraw: true, sprBehind: 10, skill: 1 });
            assert.ok(r >= 0 && r <= 1, `범위 벗어남 po=${po} ag=${ag}: ${r}`);
        }
    }
});

// ─────────────────────────────────────────────
//  looksLikeDraw — 드로우 판정 휴리스틱
// ─────────────────────────────────────────────
test('looksLikeDraw: 웻 보드 + 드로우 구간 승률 + 리버 전이면 드로우', () => {
    assert.strictEqual(looksLikeDraw({ flushDraw: true }, 0.35, 2), true);
    assert.strictEqual(looksLikeDraw({ straighty: true }, 0.40, 3), true);
});

test('looksLikeDraw: 리버(street 4)면 드로우 아님 — 완성할 카드가 없음', () => {
    assert.strictEqual(looksLikeDraw({ flushDraw: true }, 0.35, 4), false);
});

test('looksLikeDraw: 이미 강한 핸드(높은 승률)는 드로우가 아니다', () => {
    assert.strictEqual(looksLikeDraw({ flushy: true }, 0.80, 2), false);
});

test('looksLikeDraw: 승률이 너무 낮으면(에어) 드로우로 안 침', () => {
    assert.strictEqual(looksLikeDraw({ flushDraw: true }, 0.10, 2), false);
});

test('looksLikeDraw: 드라이 보드(드로우 신호 없음)는 드로우 아님', () => {
    assert.strictEqual(looksLikeDraw({ paired: true, dry: true }, 0.35, 2), false);
    assert.strictEqual(looksLikeDraw(null, 0.35, 2), false);
});
