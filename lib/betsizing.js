'use strict';
// ════════════════════════════════════════════════════════════════
//  betsizing.js — 봇 베팅 사이즈 선택 (이산 GTO 버킷)
//
//  기존: 팟 대비 연속 스케일 하나 (persona.sizeBase * 난수) → 사이즈가 밋밋하고
//        레인지 표현력이 없음.
//  개선: GTO식 이산 버킷 {33% / 55% / 78% / 오버벳 115%} 중 가중 추첨.
//   - 보드 텍스처가 1차 결정: 드라이=작게(레인지벳), 웻=크게(드로우 과금)
//   - 리버에서만 폴라라이즈 오버벳 옵션 열림
//   - persona.sizeBase(성격)로 큰/작은 쪽 성향 가중
//   - ⚖️ 밸류와 블러프가 "같은 분포"를 쓴다 — 사이즈로 핸드 강도가 새지 않게(밸런스)
//  순수 함수 (난수 주입 가능) → 단위 테스트로 분포·범위 검증.
// ════════════════════════════════════════════════════════════════

// 팟 대비 비율 버킷
const BUCKETS = { small: 0.33, mid: 0.55, big: 0.78, over: 1.15 };

// 베팅 사이즈(팟 비율) 추첨.
//   street: 2=플랍 3=턴 4=리버 (서버 gameStage와 동일 표기)
//   board:  analyzeBoardTexture() 결과 { wet, dry, paired } 또는 null
//   sizeBase: 성격별 기본 크기 성향 (nit ~0.45 … maniac ~0.9)
//   rand/jitterRand: [0,1) 난수 (테스트용 주입 가능, 기본 Math.random)
//   반환: { key: 'small'|'mid'|'big'|'over', frac: 팟 비율 (지터 포함) }
function pickBetFraction(opts) {
    const o = opts || {};
    const street = o.street != null ? o.street : 2;
    const board = o.board || null;
    const sizeBase = o.sizeBase != null ? o.sizeBase : 0.6;
    const rand = o.rand != null ? o.rand : Math.random();
    const jitterRand = o.jitterRand != null ? o.jitterRand : Math.random();

    // 텍스처 기반 가중치
    let w;
    if (board && board.wet) w = { small: 1, mid: 3, big: 6, over: 0 };      // 웻: 드로우 과금 — 크게
    else if (board && board.dry) w = { small: 5, mid: 4, big: 1, over: 0 }; // 드라이: 레인지벳 — 작게
    else w = { small: 3, mid: 4, big: 3, over: 0 };                          // 중립

    // 리버: 폴라라이즈 오버벳 옵션 (밸류·블러프 공통 — 밸런스)
    if (street >= 4) w.over = 2;

    // 성격 가중: 공격형은 big/over 쪽, 소심형은 small 쪽
    if (sizeBase >= 0.65) { w.big += 2; if (street >= 4) w.over += 1; }
    else if (sizeBase <= 0.5) { w.small += 2; }

    // 가중 추첨
    const keys = ['small', 'mid', 'big', 'over'];
    const total = keys.reduce((s, k) => s + w[k], 0);
    let roll = rand * total;
    let key = 'mid';
    for (const k of keys) { roll -= w[k]; if (roll <= 0) { key = k; break; } }

    // ±7% 지터 — 같은 상황에서 금액이 기계적으로 동일해지는 것 방지
    const frac = BUCKETS[key] * (0.93 + jitterRand * 0.14);
    return { key, frac };
}

// 체크레이즈/레이즈 사이징 — "레이즈 to" 금액 계산 (표준: 상대 벳의 ~3배 + 팟 고려)
//   currentHighestBet: 현재 최고 벳, pot: 스트리트 시작 전 누적 팟, minRaiseTo: 합법 최소 레이즈 목표액
//   반환: 레이즈 목표액 (호출측에서 스택 상한 클램프)
function raiseToAmount(currentHighestBet, pot, minRaiseTo, rand) {
    const r = rand != null ? rand : Math.random();
    const mult = 2.7 + r * 0.6; // 2.7x ~ 3.3x
    const target = Math.round(currentHighestBet * mult + pot * 0.25);
    return Math.max(minRaiseTo, target);
}

module.exports = { pickBetFraction, raiseToAmount, BUCKETS };
