'use strict';
// ════════════════════════════════════════════════════════════════
//  blockers.js — 블로커 기반 블러프 선택
//
//  왜: 지금 봇은 블러프 여부를 보드 텍스처·상대 성향·빈도로만 정한다. 하지만
//  프로가 블러프를 고를 때 가장 중요한 기준 하나가 빠졌다 — "블로커".
//  내가 상대의 넛(최강 핸드)을 만드는 카드를 쥐고 있으면, 상대가 그 넛을
//  가졌을 경우의 수가 줄어든다 → 내 블러프가 통할 확률이 오른다.
//   예) 하트 3장 보드에서 A♥ 보유 = 상대의 넛플러시 조합을 차단 → 최고의 블러프.
//      반대로 넛을 만드는 카드가 하나도 없으면 블러프는 상대 넛에 걸리기 쉽다.
//
//  이 모듈은 "블러프 빈도 배수"(1.0~1.5)를 돌려준다. 좋은 블로커를 쥐었을 때만
//  1.0 위로 올라가고, 없으면 1.0(중립) — 순수 가산이라 기존 로직과 안전하게 곱해진다.
//
//  ⚠️ skill 스케일링: 보정은 봇 실력에 비례한다. 초보 봇은 배수가 1.0에 수렴해
//     블로커를 못 읽는다(난이도 구분 유지).
//
//  순수 함수 → 단위 테스트로 검증.
// ════════════════════════════════════════════════════════════════

const ORDER = '23456789TJQKA';
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// 보드 텍스처에서 블로커 원배수(skill 미반영)를 계산. 1.0 = 블로커 없음.
function rawBlockerMult(hand, board) {
    if (!hand || hand.length !== 2 || !board || board.length < 3) return 1.0;
    let mult = 1.0;

    // ── 플러시 블로커 ── 보드에서 가장 많은 무늬를 찾는다
    const suitCount = {};
    for (const c of board) suitCount[c[1]] = (suitCount[c[1]] || 0) + 1;
    let flushSuit = null, flushCount = 0;
    for (const s in suitCount) if (suitCount[s] > flushCount) { flushCount = suitCount[s]; flushSuit = s; }

    if (flushCount >= 3) {
        // 보드에 플러시가 이미 가능 — 넛플러시 카드(그 무늬 A>K)를 쥐면 강한 블로커
        for (const c of hand) {
            if (c[1] !== flushSuit) continue;
            if (c[0] === 'A') mult += 0.30;      // 넛플러시 차단 — 최고
            else if (c[0] === 'K') mult += 0.15; // 2nd 넛 차단
            else mult += 0.05;                   // 어떤 플러시든 일부 차단
        }
    } else if (flushCount === 2) {
        // 플러시 드로우 — 넛플러시 드로우 카드(그 무늬 A)만 소폭 인정
        for (const c of hand) if (c[1] === flushSuit && c[0] === 'A') mult += 0.12;
    }

    // ── 탑카드 블로커 ── 보드 최고 랭크를 쥐면 상대의 강한 탑페어 조합을 차단
    const boardRanks = board.map(c => ORDER.indexOf(c[0])).filter(v => v >= 0);
    const boardHigh = boardRanks.length ? Math.max(...boardRanks) : -1;
    if (boardHigh >= 0) {
        const highChar = ORDER[boardHigh];
        for (const c of hand) {
            if (c[0] !== highChar) continue;
            // 에이스 하이 보드에서 A 보유 = 상대의 강한 Ax 밸류를 차단 (가장 유효)
            mult += (highChar === 'A') ? 0.15 : 0.08;
            break; // 탑카드 블로커는 1회만
        }
    }

    return clamp(mult, 1.0, 1.5);
}

// skill을 반영한 최종 블러프 빈도 배수. skill 0이면 1.0(효과 없음).
function bluffBlockerMult(hand, board, skill) {
    const raw = rawBlockerMult(hand, board);
    const sk = clamp(skill != null ? skill : 0.8, 0, 1);
    return 1 + (raw - 1) * sk;
}

module.exports = { rawBlockerMult, bluffBlockerMult };
