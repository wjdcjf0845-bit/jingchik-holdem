'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyBetPlan, barrelFrequency } = require('../lib/botplan');

// ─────────────────────────────────────────────
//  classifyBetPlan — 벳 의도 분류
// ─────────────────────────────────────────────
test('classifyBetPlan: 강한 핸드는 value', () => {
    assert.strictEqual(classifyBetPlan({ isValue: true }), 'value');
    // isValue가 다른 조건을 이긴다 (웻 보드여도 밸류는 밸류)
    assert.strictEqual(classifyBetPlan({ isValue: true, equity: 0.9, board: { wet: true } }), 'value');
});

test('classifyBetPlan: 웻 보드 + 중간 에퀴티 = semibluff (드로우)', () => {
    assert.strictEqual(classifyBetPlan({ equity: 0.42, board: { wet: true } }), 'semibluff');
});

test('classifyBetPlan: 드라이 보드 약한 핸드 = 순수 bluff', () => {
    assert.strictEqual(classifyBetPlan({ equity: 0.10, board: { dry: true } }), 'bluff');
    // 웻 보드라도 에퀴티가 없으면 드로우가 아니므로 순수 블러프
    assert.strictEqual(classifyBetPlan({ equity: 0.12, board: { wet: true } }), 'bluff');
    // 보드 정보 없으면 안전하게 bluff
    assert.strictEqual(classifyBetPlan({ equity: 0.5, board: null }), 'bluff');
});

// ─────────────────────────────────────────────
//  barrelFrequency — 배럴 발동 조건
// ─────────────────────────────────────────────
test('barrelFrequency: 플랜이 없으면 배럴 안 함', () => {
    assert.strictEqual(barrelFrequency({ plan: null, street: 3, activeOpp: 1 }), 0);
});

test('barrelFrequency: 직전 스트리트 어그레서가 아니면 배럴 안 함', () => {
    // 플랩(2)에 벳했는데 지금 리버(4) — 턴에 이미 주도권을 놓쳤으므로 배럴 대상 아님
    const f = barrelFrequency({ plan: { betStreet: 2, type: 'bluff' }, street: 4, activeOpp: 1 });
    assert.strictEqual(f, 0);
});

test('barrelFrequency: 플랍(street 2)에서는 배럴 개념이 없음', () => {
    assert.strictEqual(barrelFrequency({ plan: { betStreet: 1, type: 'bluff' }, street: 2, activeOpp: 1 }), 0);
});

test('barrelFrequency: 상대가 없으면(전원 폴드/올인) 배럴 안 함', () => {
    assert.strictEqual(barrelFrequency({ plan: { betStreet: 2, type: 'bluff' }, street: 3, activeOpp: 0 }), 0);
});

test('barrelFrequency: 핵심 — 플랍 벳 후 턴에 배럴이 실제로 발동한다', () => {
    const f = barrelFrequency({
        plan: { betStreet: 2, type: 'semibluff' }, street: 3,
        board: { wet: true }, skill: 1.0, activeOpp: 1, equity: 0.4
    });
    // 기존 봇의 기본 블러프 빈도(~0.14)보다 확실히 높아야 "이어서 친다"는 의미가 있음
    assert.ok(f > 0.3, `세미블러프 턴 배럴 빈도가 너무 낮음: ${f}`);
});

test('barrelFrequency: 세미블러프가 순수 블러프보다 자주 배럴한다', () => {
    const base = { betStreet: 2 }, ctx = { street: 3, board: { wet: true }, skill: 1.0, activeOpp: 1, equity: 0.4 };
    const semi = barrelFrequency({ plan: { ...base, type: 'semibluff' }, ...ctx });
    const pure = barrelFrequency({ plan: { ...base, type: 'bluff' }, ...ctx });
    assert.ok(semi > pure, `세미블러프(${semi})가 순수블러프(${pure})보다 높아야 함`);
});

test('barrelFrequency: 드라이 보드가 웻 보드보다 블러프 배럴에 유리', () => {
    const p = { betStreet: 2, type: 'bluff' };
    const dry = barrelFrequency({ plan: p, street: 3, board: { dry: true }, skill: 1.0, activeOpp: 1, equity: 0.1 });
    const wet = barrelFrequency({ plan: p, street: 3, board: { wet: true }, skill: 1.0, activeOpp: 1, equity: 0.1 });
    assert.ok(dry > wet, `드라이(${dry})가 웻(${wet})보다 높아야 함`);
});

test('barrelFrequency: 멀티웨이에서는 블러프 배럴이 대폭 줄어든다', () => {
    const p = { betStreet: 2, type: 'bluff' }, ctx = { street: 3, board: { dry: true }, skill: 1.0, equity: 0.1 };
    const hu = barrelFrequency({ plan: p, ...ctx, activeOpp: 1 });
    const multi = barrelFrequency({ plan: p, ...ctx, activeOpp: 3 });
    assert.ok(multi < hu * 0.5, `멀티웨이(${multi})가 헤즈업(${hu})의 절반 미만이어야 함`);
});

test('barrelFrequency: 잘 폴드하는 상대에게 더 자주 배럴한다', () => {
    const p = { betStreet: 2, type: 'bluff' }, ctx = { street: 3, board: { dry: true }, skill: 1.0, activeOpp: 1, equity: 0.1 };
    const folder = barrelFrequency({ plan: p, ...ctx, oppRead: { foldToBet: 0.8 } });
    const station = barrelFrequency({ plan: p, ...ctx, oppRead: { foldToBet: 0.1 } });
    assert.ok(folder > station, `폴드형(${folder})이 콜링스테이션(${station})보다 높아야 함`);
});

test('barrelFrequency: 실력 낮은 봇은 배럴을 덜 한다', () => {
    const p = { betStreet: 2, type: 'semibluff' }, ctx = { street: 3, board: { wet: true }, activeOpp: 1, equity: 0.4 };
    const pro = barrelFrequency({ plan: p, ...ctx, skill: 1.0 });
    const fish = barrelFrequency({ plan: p, ...ctx, skill: 0.3 });
    assert.ok(pro > fish, `고수(${pro})가 초보(${fish})보다 배럴이 잦아야 함`);
});

test('barrelFrequency: 리버 순수 블러프(에퀴티 0)는 신중해진다', () => {
    const p = { betStreet: 3, type: 'bluff' }, ctx = { board: { dry: true }, skill: 1.0, activeOpp: 1 };
    const river = barrelFrequency({ plan: p, ...ctx, street: 4, equity: 0.05 });
    const turn = barrelFrequency({ plan: { betStreet: 2, type: 'bluff' }, ...ctx, street: 3, equity: 0.05 });
    assert.ok(river < turn, `리버 순블러프(${river})가 턴(${turn})보다 신중해야 함`);
});

test('barrelFrequency: 반환값은 항상 0~0.9 범위 (확률로 사용 가능)', () => {
    // 배럴을 최대로 밀어올리는 조합에서도 상한을 넘지 않아야 함
    const f = barrelFrequency({
        plan: { betStreet: 2, type: 'semibluff' }, street: 3,
        board: { dry: true }, oppRead: { foldToBet: 1.0 }, skill: 1.0, activeOpp: 1, equity: 0.5
    });
    assert.ok(f >= 0 && f <= 0.9, `범위 벗어남: ${f}`);
    // 반대로 최악의 조합에서도 음수가 되면 안 됨
    const worst = barrelFrequency({
        plan: { betStreet: 2, type: 'bluff' }, street: 3,
        board: { wet: true }, oppRead: { foldToBet: 0 }, skill: 0.1, activeOpp: 5, equity: 0
    });
    assert.ok(worst >= 0, `음수 빈도: ${worst}`);
});
