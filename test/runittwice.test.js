'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cardsRemainingToDeal, shouldRunItTwice, splitPotForRuns, buildRunBoards } = require('../lib/runittwice');

// ─────────────────────────────────────────────
//  cardsRemainingToDeal
// ─────────────────────────────────────────────
test('cardsRemainingToDeal: 스트리트별 남은 카드 수', () => {
    assert.strictEqual(cardsRemainingToDeal(1), 5); // 프리플랍 올인 → 플랍3+턴+리버
    assert.strictEqual(cardsRemainingToDeal(2), 2); // 플랍 깔림 → 턴+리버
    assert.strictEqual(cardsRemainingToDeal(3), 1); // 턴 깔림 → 리버
    assert.strictEqual(cardsRemainingToDeal(4), 0); // 리버까지 완료 → 깔 것 없음
});

// ─────────────────────────────────────────────
//  shouldRunItTwice — 발동 조건
// ─────────────────────────────────────────────
const ok = { enabled: true, mode: 'cash', gameStage: 2, contestants: 2, actionable: 0 };

test('shouldRunItTwice: 정상 조건이면 발동', () => {
    assert.strictEqual(shouldRunItTwice(ok), true);
    // 올인 아닌 사람이 1명 남는 건 정상 (콜한 쪽이 스택이 더 많은 경우)
    assert.strictEqual(shouldRunItTwice({ ...ok, actionable: 1 }), true);
});

test('shouldRunItTwice: 설정이 꺼져 있으면 발동 안 함', () => {
    assert.strictEqual(shouldRunItTwice({ ...ok, enabled: false }), false);
});

test('shouldRunItTwice: 토너먼트/MTT는 TDA 규정상 금지', () => {
    assert.strictEqual(shouldRunItTwice({ ...ok, mode: 'tournament' }), false);
    assert.strictEqual(shouldRunItTwice({ ...ok, mode: 'mtt' }), false);
});

test('shouldRunItTwice: 리버가 이미 나왔으면 깔 카드가 없어 발동 안 함', () => {
    assert.strictEqual(shouldRunItTwice({ ...ok, gameStage: 4 }), false);
});

test('shouldRunItTwice: 다투는 사람이 1명이면 무의미', () => {
    assert.strictEqual(shouldRunItTwice({ ...ok, contestants: 1 }), false);
});

test('shouldRunItTwice: 아직 벳할 사람이 2명 이상이면 올인 상황이 아님', () => {
    assert.strictEqual(shouldRunItTwice({ ...ok, actionable: 2 }), false);
});

test('shouldRunItTwice: 프리플랍 올인도 발동 (5장 다 깔기)', () => {
    assert.strictEqual(shouldRunItTwice({ ...ok, gameStage: 1 }), true);
});

// ─────────────────────────────────────────────
//  splitPotForRuns — 칩 보존이 핵심
// ─────────────────────────────────────────────
test('splitPotForRuns: 짝수 팟은 정확히 반반', () => {
    assert.deepStrictEqual(splitPotForRuns(100, 2), [50, 50]);
});

test('splitPotForRuns: 홀수 칩은 앞 런에게', () => {
    assert.deepStrictEqual(splitPotForRuns(101, 2), [51, 50]);
    assert.deepStrictEqual(splitPotForRuns(7, 2), [4, 3]);
});

test('splitPotForRuns: 3런 이상도 나머지를 앞에서부터 분배', () => {
    assert.deepStrictEqual(splitPotForRuns(10, 3), [4, 3, 3]);
    assert.deepStrictEqual(splitPotForRuns(11, 3), [4, 4, 3]);
});

test('splitPotForRuns: 합은 항상 원본과 일치 — 칩이 생기거나 사라지면 안 됨', () => {
    for (const amt of [0, 1, 2, 3, 7, 99, 100, 101, 12345, 99999]) {
        for (const runs of [1, 2, 3, 4]) {
            const parts = splitPotForRuns(amt, runs);
            const sum = parts.reduce((s, x) => s + x, 0);
            assert.strictEqual(sum, amt, `amt=${amt} runs=${runs} → 합 ${sum} ≠ ${amt}`);
            assert.ok(parts.every(x => x >= 0), `음수 몫 발생: ${parts}`);
        }
    }
});

test('splitPotForRuns: 1런이면 전액 그대로 (기존 동작 보존)', () => {
    assert.deepStrictEqual(splitPotForRuns(777, 1), [777]);
});

// ─────────────────────────────────────────────
//  buildRunBoards — 카드 중복이 절대 없어야 함
// ─────────────────────────────────────────────
test('buildRunBoards: 턴에서 올인 → 두 보드가 리버만 다름', () => {
    const deck = ['Xs', 'Yh']; // pop 순서: Yh(런1), Xs(런2)
    const boards = buildRunBoards(['Ah', 'Kd', '7c', '2s'], () => deck.pop(), 3, 2);
    assert.strictEqual(boards.length, 2);
    assert.deepStrictEqual(boards[0], ['Ah', 'Kd', '7c', '2s', 'Yh']);
    assert.deepStrictEqual(boards[1], ['Ah', 'Kd', '7c', '2s', 'Xs']);
    // 공유된 4장은 동일, 마지막 장만 다름
    assert.notStrictEqual(boards[0][4], boards[1][4]);
});

test('buildRunBoards: 플랍에서 올인 → 턴+리버가 각각 다름', () => {
    const deck = ['D4', 'D3', 'D2', 'D1']; // pop: D1,D2 (런1) / D3,D4 (런2)
    const boards = buildRunBoards(['Ah', 'Kd', '7c'], () => deck.pop(), 2, 2);
    assert.deepStrictEqual(boards[0], ['Ah', 'Kd', '7c', 'D1', 'D2']);
    assert.deepStrictEqual(boards[1], ['Ah', 'Kd', '7c', 'D3', 'D4']);
});

test('buildRunBoards: 핵심 — 두 런 사이에 같은 카드가 절대 나오지 않는다', () => {
    // 실제 덱처럼 고유 카드를 넣고, 런 전체에서 중복이 없는지 확인
    const deck = [];
    for (const r of ['2','3','4','5','6','7','8','9','T','J','Q','K','A']) for (const s of ['s','h','d','c']) deck.push(r + s);
    const committed = [deck.pop(), deck.pop(), deck.pop()]; // 플랍
    const boards = buildRunBoards(committed, () => deck.pop(), 2, 2);
    const dealtOnly = [...boards[0].slice(3), ...boards[1].slice(3)]; // 공유 플랍 제외
    assert.strictEqual(new Set(dealtOnly).size, dealtOnly.length, `런 간 카드 중복: ${dealtOnly}`);
    // 공유 플랍과도 겹치면 안 됨
    const all = [...committed, ...dealtOnly];
    assert.strictEqual(new Set(all).size, all.length, '커밋된 보드와 중복');
});

test('buildRunBoards: 프리플랍 올인이면 각 런이 5장 완성 보드', () => {
    const deck = Array.from({ length: 10 }, (_, i) => 'C' + i);
    const boards = buildRunBoards([], () => deck.pop(), 1, 2);
    assert.strictEqual(boards[0].length, 5);
    assert.strictEqual(boards[1].length, 5);
    assert.strictEqual(new Set([...boards[0], ...boards[1]]).size, 10, '카드 중복 발생');
});

test('buildRunBoards: 원본 committed 배열을 변형하지 않는다', () => {
    const committed = ['Ah', 'Kd', '7c'];
    const deck = ['X1', 'X2', 'X3', 'X4'];
    buildRunBoards(committed, () => deck.pop(), 2, 2);
    assert.deepStrictEqual(committed, ['Ah', 'Kd', '7c'], 'committed가 오염됨');
});
