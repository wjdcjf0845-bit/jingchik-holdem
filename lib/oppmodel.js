'use strict';
// ═══════════════════════════════════════════════════════════
//  oppmodel.js — 상대 읽기: "이번 세션에서 본 것" + "그 사람의 누적 전적"
//
//  예전엔 방에서 6번 이상 행동을 봐야만 상대 성향을 읽었다. 그래서 판이 시작되고
//  한참 동안 봇은 모든 사람을 똑같이 대했다 — 매번 블러프에 접는 사람이든, 절대 안 접는 사람이든.
//  계정에는 이미 수백 핸드의 누적 지표가 쌓여 있으므로, 표본이 모일 때까지는 그걸 출발점으로 삼고
//  세션 표본이 늘수록 "지금 이 자리에서의 모습" 쪽으로 무게를 옮긴다(사람은 날마다 다르게 친다).
// ═══════════════════════════════════════════════════════════

const MIN_LIFETIME_HANDS = 30;   // 이보다 적으면 누적 전적도 믿을 게 못 된다
const FULL_TRUST_SAMPLES = 24;   // 세션 표본이 이만큼 쌓이면 누적 전적은 거의 안 본다

// 계정 누적 지표 → 읽기 값. 표본이 모자란 항목은 null.
function lifetimeRead(u) {
    if (!u || (u.handsPlayed || 0) < MIN_LIFETIME_HANDS) return null;
    const ratio = (num, den, minDen) => (den >= minDen ? Math.max(0, Math.min(1, num / den)) : null);
    const bets = u.aggrBets || 0, calls = u.aggrCalls || 0;
    // 세션 쪽 공격성은 "전체 행동 중 벳/레이즈 비율"이라 누적의 벳/(벳+콜)보다 낮게 나온다 → 0.8 로 눌러 눈금을 맞춘다
    const aggr = ratio(bets, bets + calls, 20);
    return {
        foldToBet: ratio(u.foldToBet || 0, u.faceBet || 0, 12),
        aggression: aggr === null ? null : aggr * 0.8,
        loose: ratio(u.vpipHands || 0, u.preflopOpps || 0, 20),
        samples: 0
    };
}

// 세션 읽기(없을 수 있음)와 누적 읽기(없을 수 있음)를 섞는다.
function blendRead(session, lifetime) {
    if (!session && !lifetime) return null;
    if (!lifetime) return session;
    if (!session) return Object.assign({}, lifetime, { samples: 0, fromLifetime: true });
    const w = Math.max(0, Math.min(1, (session.samples || 0) / FULL_TRUST_SAMPLES));
    const mix = (a, b) => (a == null ? b : (b == null ? a : a * w + b * (1 - w)));
    return {
        foldToBet: mix(session.foldToBet, lifetime.foldToBet),
        aggression: mix(session.aggression, lifetime.aggression),
        loose: mix(session.loose, lifetime.loose),
        samples: session.samples || 0
    };
}

module.exports = { lifetimeRead, blendRead, MIN_LIFETIME_HANDS, FULL_TRUST_SAMPLES };
