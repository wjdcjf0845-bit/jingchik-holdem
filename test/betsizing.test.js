'use strict';
// ════════════════════════════════════════════════════════════════
//  betsizing.test.js — 봇 이산 베팅 사이징 검증 (node --test)
//  핵심 불변식:
//   (1) 비율은 항상 안전 범위 [0.30, 1.32] (버킷 0.33~1.15 × 지터 ±7%)
//   (2) 텍스처 반응: 드라이→작게, 웻→크게
//   (3) 오버벳은 리버에서만 등장
//   (4) 성격(sizeBase) 반영: 공격형이 평균적으로 더 크게
//   (5) 난수 주입 시 결정적 (재현 가능)
// ════════════════════════════════════════════════════════════════
const test = require('node:test');
const assert = require('node:assert');
const { pickBetFraction, raiseToAmount, BUCKETS } = require('../lib/betsizing');

const N = 6000;
function sample(opts) {
    const keys = { small: 0, mid: 0, big: 0, over: 0 };
    let fracSum = 0;
    for (let i = 0; i < N; i++) {
        const { key, frac } = pickBetFraction(opts);
        keys[key]++;
        fracSum += frac;
        assert.ok(frac >= 0.30 && frac <= 1.32, `frac ${frac} 범위 밖`);
    }
    return { keys, avg: fracSum / N };
}

test('범위 — 모든 조합에서 frac ∈ [0.30, 1.32]', () => {
    for (const street of [2, 3, 4]) {
        for (const board of [null, { dry: true }, { wet: true }, { paired: true }]) {
            for (const sizeBase of [0.4, 0.6, 0.9]) {
                sample({ street, board, sizeBase }); // 내부 assert가 범위 검증
            }
        }
    }
});

test('텍스처 — 드라이 보드는 small 비중이, 웻 보드는 big 비중이 높다', () => {
    const dry = sample({ street: 2, board: { dry: true }, sizeBase: 0.6 });
    const wet = sample({ street: 2, board: { wet: true }, sizeBase: 0.6 });
    assert.ok(dry.keys.small > wet.keys.small * 2, `드라이 small(${dry.keys.small}) ≫ 웻 small(${wet.keys.small})`);
    assert.ok(wet.keys.big > dry.keys.big * 2, `웻 big(${wet.keys.big}) ≫ 드라이 big(${dry.keys.big})`);
    assert.ok(wet.avg > dry.avg, `웻 평균(${wet.avg.toFixed(2)}) > 드라이 평균(${dry.avg.toFixed(2)})`);
});

test('오버벳 — 리버에서만 등장, 플랍/턴에선 0회', () => {
    const flop = sample({ street: 2, board: null, sizeBase: 0.9 });
    const turn = sample({ street: 3, board: null, sizeBase: 0.9 });
    const river = sample({ street: 4, board: null, sizeBase: 0.9 });
    assert.strictEqual(flop.keys.over, 0, '플랍 오버벳 금지');
    assert.strictEqual(turn.keys.over, 0, '턴 오버벳 금지');
    assert.ok(river.keys.over > 0, `리버 오버벳 등장해야 (${river.keys.over}회)`);
});

test('성격 — 공격형(sizeBase 0.9)이 소심형(0.45)보다 평균 사이즈가 크다', () => {
    const timid = sample({ street: 2, board: null, sizeBase: 0.45 });
    const aggro = sample({ street: 2, board: null, sizeBase: 0.9 });
    assert.ok(aggro.avg > timid.avg, `공격형(${aggro.avg.toFixed(2)}) > 소심형(${timid.avg.toFixed(2)})`);
});

test('결정성 — 난수 주입 시 항상 같은 결과', () => {
    const a = pickBetFraction({ street: 3, board: { wet: true }, sizeBase: 0.7, rand: 0.42, jitterRand: 0.5 });
    const b = pickBetFraction({ street: 3, board: { wet: true }, sizeBase: 0.7, rand: 0.42, jitterRand: 0.5 });
    assert.deepStrictEqual(a, b);
});

test('raiseToAmount — 최소 레이즈 이상 + 상대 벳의 약 3배 수준', () => {
    // 상대 벳 300, 팟 1000, 최소레이즈 600
    for (let i = 0; i < 200; i++) {
        const amt = raiseToAmount(300, 1000, 600);
        assert.ok(amt >= 600, `최소 레이즈(600) 이상: ${amt}`);
        assert.ok(amt <= 300 * 3.3 + 1000 * 0.25 + 1, `상한(3.3x+팟25%) 이내: ${amt}`);
    }
    // 최소레이즈가 계산치보다 크면 최소레이즈로 승격
    assert.strictEqual(raiseToAmount(100, 0, 5000, 0.5), 5000);
    // 결정성
    assert.strictEqual(raiseToAmount(300, 1000, 600, 0.5), raiseToAmount(300, 1000, 600, 0.5));
});
