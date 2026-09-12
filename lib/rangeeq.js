'use strict';
// ════════════════════════════════════════════════════════════════
//  rangeeq.js — "벳하는 상대의 레인지" 대비 내 핸드 강도
//
//  왜: 봇의 승률(estimateBotEquity)은 몬테카를로로 "상대가 아무 패나 들고 있을 때"를
//  계산한다. 그래서 7-8-2 보드에서 AK 하이가 52.7%로 나온다(실측). 팟오즈가
//  25%면 봇은 당연히 콜한다. 벳에 폴드하는 비율이 5~13%에 그친 진짜 이유다.
//
//  그런데 상대가 "벳을 했다"면 그는 아무 패나 들고 있지 않다. 그 보드에서 벳할 만한
//  패들만 들고 있다. 그 레인지 대비 AK 하이는 15~20%짜리다 — 접어야 하는 패다.
//
//  여기서는 상대 홀카드 후보들을 현재 보드에서 평가해 "상위 몇 %가 벳 레인지인가"를
//  잡고, 내 핸드가 그 레인지를 상대로 몇 %를 이기는지 계산한다.
//
//  ⚠️ 플랍·턴에선 아직 카드가 남아 있어 드로우에 가치가 있다. 그래서 이 값을
//     기존 몬테카를로 승률과 섞는다(리버는 섞을 게 없으니 그대로 쓴다).
//
//  순수 함수 → 단위 테스트로 검증. 카드 평가(pokersolver)는 서버가 주입한다.
// ════════════════════════════════════════════════════════════════

// 족보 등급 + 킥커 5장을 하나의 비교 가능한 점수로.
//   rank: pokersolver 의 족보 등급 (1=하이카드 … 9=스트레이트플러시)
//   values: 그 족보를 이루는 5장의 숫자값 (중요도 순, 큰 값이 강함)
function handScore(rank, values) {
    const v = (values || []).slice(0, 5);
    let s = (rank || 0) * 1e10;
    let mult = 1e8;
    for (let i = 0; i < 5; i++) { s += (v[i] || 0) * mult; mult /= 100; }
    return s;
}

// 상대가 벳할 때 그 벳 레인지는 보드 상위 몇 %인가.
//   · 플랍 C벳은 넓다(레인지로 친다) → 상위 60%
//   · 스트리트가 갈수록, 벳이 클수록 좁아진다
//   · 여러 스트리트를 연속 공격했으면 더 좁다
function bettingRangeTop(opts) {
    const o = opts || {};
    const street = o.street || 2;
    let top = street >= 4 ? 0.32 : (street === 3 ? 0.44 : 0.62);
    const bf = Math.max(0, o.betFrac || 0.5);
    top *= (1 - Math.min(0.40, bf * 0.28));         // 큰 벳일수록 좁은 레인지
    const ag = o.aggroStreets || 0;
    if (ag >= 3) top *= 0.68;
    else if (ag === 2) top *= 0.82;
    return Math.max(0.10, Math.min(0.85, top));
}

// 내 점수가 상대 벳 레인지(상위 topFrac)를 상대로 이기는 비율.
//   oppScores: 상대가 가질 수 있는 모든 후보 핸드의 점수 배열
//   동점은 0.5로 센다.
function shareBeaten(myScore, oppScores, topFrac) {
    const arr = (oppScores || []).slice().sort((a, b) => b - a); // 강한 순
    if (!arr.length) return 0.5;
    const n = Math.max(1, Math.ceil(arr.length * Math.max(0, Math.min(1, topFrac))));
    let win = 0;
    for (let i = 0; i < n; i++) {
        if (myScore > arr[i]) win += 1;
        else if (myScore === arr[i]) win += 0.5;
    }
    return win / n;
}

// 레인지 대비 강도와 원래 몬테카를로 승률을 섞는다.
//   리버는 남은 카드가 없으니 레인지 강도가 곧 답이다.
//   플랍·턴은 드로우가 살아 있어 몬테카를로 쪽 비중을 남긴다.
function blendWithDraws(share, rawEquity, street) {
    const s = Math.max(0, Math.min(1, share || 0));
    const e = Math.max(0, Math.min(1, rawEquity || 0));
    if (street >= 4) return s;
    const w = (street === 3) ? 0.70 : 0.55;   // 턴은 레인지 비중 ↑, 플랍은 드로우 여지 ↑
    return s * w + e * (1 - w);
}

module.exports = { handScore, bettingRangeTop, shareBeaten, blendWithDraws };
