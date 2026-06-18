'use strict';
// ════════════════════════════════════════════════════════════════
//  shuffle.js — 검증 가능한 결정적 셔플 (서버 GameRoom과 테스트가 공유)
//  커밋-공개(commit-reveal) 방식: 핸드 시작 전 commitHash(seed)를 공개하고,
//  핸드 종료 후 seed를 공개하면 누구나 seededShuffle(seed, entropy)로 같은 덱을
//  재현해 "딜러가 덱을 조작하지 않았음"을 검증할 수 있다.
//  crypto 외 의존성이 없는 순수 로직이라 단위 테스트로 결정성·공정성을 검증한다.
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');

// 서버 시드 — 핸드마다 새로 뽑는 256비트 난수 (16진 문자열)
function makeServerSeed() {
    return crypto.randomBytes(32).toString('hex');
}

// 시드의 커밋(공개 약속) — 핸드 시작 전에 보여주고, 종료 후 시드 원본을 까서 대조
function commitHash(seed) {
    return crypto.createHash('sha256').update(seed).digest('hex');
}

// 시드 문자열 + 클라이언트 엔트로피로부터 결정적으로 52장 덱을 셔플 (SHA256 카운터 모드 PRNG).
//   같은 (seed, clientEntropy) → 항상 같은 덱. Fisher-Yates로 균등 셔플.
function seededShuffle(seed, clientEntropy) {
    const suits = ['s', 'h', 'd', 'c'];
    const values = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    let deck = [];
    for (let s of suits) for (let v of values) deck.push(v + s);
    const baseSeed = seed + '|' + (clientEntropy || '');
    // 결정적 난수: SHA256(baseSeed:counter)를 정수로 변환
    let counter = 0;
    const nextRand = () => {
        const h = crypto.createHash('sha256').update(baseSeed + ':' + (counter++)).digest();
        // 상위 6바이트(48비트)로 [0,1) 실수 — 2^48로 나눠 결과가 1.0이 되지 않게(Fisher-Yates 인덱스 초과 방지)
        const v = h.readUIntBE(0, 6) / 0x1000000000000;
        return v;
    };
    // Fisher-Yates (결정적)
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(nextRand() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

module.exports = { makeServerSeed, commitHash, seededShuffle };
