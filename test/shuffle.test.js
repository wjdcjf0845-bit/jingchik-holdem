'use strict';
// ════════════════════════════════════════════════════════════════
//  shuffle.test.js — 검증 가능한 결정적 셔플 테스트 (node --test)
//  핵심 불변식:
//   (1) 결정성: 같은 (seed, entropy) → 항상 같은 덱
//   (2) 무결성: 항상 52장, 전부 유니크, undefined 없음 (Fisher-Yates 인덱스 안전)
//   (3) 커밋-공개: commitHash(seed) 로 사후 검증 가능
//   (4) 공정성(근사): 카드별 위치 분포가 한쪽으로 치우치지 않음
// ════════════════════════════════════════════════════════════════
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { makeServerSeed, commitHash, seededShuffle } = require('../lib/shuffle');

const FULL_DECK = (() => {
    const suits = ['s', 'h', 'd', 'c'];
    const values = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    const d = [];
    for (const s of suits) for (const v of values) d.push(v + s);
    return d;
})();

function assertValidDeck(deck) {
    assert.strictEqual(deck.length, 52, '덱은 52장이어야 한다');
    assert.ok(!deck.includes(undefined), 'undefined 카드가 있으면 안 된다(인덱스 초과)');
    assert.strictEqual(new Set(deck).size, 52, '52장 전부 유니크해야 한다');
    // 표준 52장 구성과 정확히 일치(누락/중복/오염 없음)
    assert.deepStrictEqual([...deck].sort(), [...FULL_DECK].sort());
}

// ───────────────────────── 결정성 ─────────────────────────
test('결정성 — 같은 시드+엔트로피는 항상 같은 덱', () => {
    const seed = 'abc123', entropy = 'prevhash:1700000000000';
    const a = seededShuffle(seed, entropy);
    const b = seededShuffle(seed, entropy);
    assert.deepStrictEqual(a, b);
});

test('엔트로피가 다르면 덱이 달라진다', () => {
    const seed = 'abc123';
    const a = seededShuffle(seed, 'e1');
    const b = seededShuffle(seed, 'e2');
    assert.notDeepStrictEqual(a, b);
});

test('시드가 다르면 덱이 달라진다', () => {
    const a = seededShuffle('seedA', 'e');
    const b = seededShuffle('seedB', 'e');
    assert.notDeepStrictEqual(a, b);
});

test('clientEntropy 생략(undefined)해도 결정적이고 유효하다', () => {
    const a = seededShuffle('soloSeed');
    const b = seededShuffle('soloSeed');
    assert.deepStrictEqual(a, b);
    assertValidDeck(a);
});

// ───────────────────────── 무결성(인덱스 안전성) ─────────────────────────
test('무결성 — 2000개 랜덤 시드 모두 유효한 52장 순열', () => {
    for (let i = 0; i < 2000; i++) {
        const deck = seededShuffle(makeServerSeed(), String(i) + ':' + Date.now());
        assertValidDeck(deck);
    }
});

// ───────────────────────── 커밋-공개 검증 ─────────────────────────
test('commitHash — 시드로 사후 재현/검증이 가능', () => {
    const seed = makeServerSeed();
    const commit = commitHash(seed);
    // 핸드 종료 후: 공개된 seed 의 해시가 사전에 약속한 commit 과 일치해야 한다
    assert.strictEqual(crypto.createHash('sha256').update(seed).digest('hex'), commit);
    // 그리고 그 seed 로 동일 덱을 재현할 수 있어야 한다
    const entropy = 'x:1';
    assert.deepStrictEqual(seededShuffle(seed, entropy), seededShuffle(seed, entropy));
});

test('makeServerSeed — 매번 다른 256비트(64 hex) 시드', () => {
    const s1 = makeServerSeed(), s2 = makeServerSeed();
    assert.match(s1, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(s1, s2);
});

// ───────────────────────── 공정성(분포 치우침 없음) ─────────────────────────
test('공정성 — 특정 카드의 평균 위치가 중앙(≈25.5) 근처', () => {
    // 'As'(스페이드 A)가 셔플 후 놓이는 인덱스의 평균이 한쪽으로 쏠리지 않아야 한다.
    const N = 4000;
    let sumPos = 0;
    for (let i = 0; i < N; i++) {
        const deck = seededShuffle(makeServerSeed(), 'fair:' + i);
        sumPos += deck.indexOf('As');
    }
    const avg = sumPos / N;
    // 0~51 균등이면 기대 평균 25.5. 표본오차 감안해 넉넉한 허용범위(±2.5).
    assert.ok(Math.abs(avg - 25.5) < 2.5, `As 평균 위치 ${avg.toFixed(2)} 가 중앙에서 너무 벗어남`);
});
