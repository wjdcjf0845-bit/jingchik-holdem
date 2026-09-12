'use strict';
// ════════════════════════════════════════════════════════════════
//  postflop.js — 레인지 기반 포스트플랍 전략 (고수처럼 치기)
//
//  왜: 기존 봇은 "내 패의 절대 승률"로만 벳을 결정했다(equity > 0.60 이면 밸류벳).
//  그런데 플랍에서 3인 팟 승률이 0.60을 넘는 패는 몬스터뿐이다. 결과적으로
//  봇의 플랍 C벳 빈도가 33%에 그쳤다 (실측). 프로는 55~70% 친다.
//
//  차이는 사고 수준이다:
//    · 하수: "내 패가 좋은가?"           → 좋은 패만 친다 = 읽히고, 팟을 못 키운다
//    · 고수: "이 보드가 내 레인지에 유리한가?" → 레인지로 친다 = 안 읽히고, 압박한다
//
//  A 하이 마른 보드에서 프리플랍 레이저는 상대보다 AA/AK를 훨씬 많이 들고 있다
//  (레인지 어드밴티지). 그래서 패와 무관하게 작게 전부 친다. 반대로 765 같은
//  낮은 연결 보드는 콜러 레인지에 유리해서 체크가 많다.
//
//  또 한 가지 — 최소 방어 빈도(MDF). 팟의 절반을 베팅당했을 때 67% 이상 방어하지
//  않으면 상대는 아무 패로나 블러프해서 공짜로 이득을 본다. 기존 봇은 승률만 보고
//  접어서 이 구멍이 컸다.
//
//  순수 함수 → 단위 테스트로 검증.
// ════════════════════════════════════════════════════════════════

const ORDER = '23456789TJQKA';
const rankOf = c => ORDER.indexOf(c[0]);

// ── 레인지 어드밴티지: 이 보드가 프리플랍 공격자에게 얼마나 유리한가 (-1 ~ +1)
//   공격자는 넓은 레인지 중 "강한 쪽"을 들고 있다 → 하이카드·마른 보드가 유리.
//   콜러(특히 BB)는 낮고 연결된 카드를 더 많이 들고 있다 → 그런 보드는 불리.
function rangeAdvantage(communityCards) {
    const cc = (communityCards || []).slice(0, 5);
    if (cc.length < 3) return 0;
    const ranks = cc.map(rankOf).filter(v => v >= 0).sort((a, b) => b - a);
    if (!ranks.length) return 0;
    const hi = ranks[0];

    let adv = 0;
    // 최고 카드가 높을수록 공격자 유리 (A=12, K=11, Q=10, J=9, T=8)
    if (hi === 12) adv += 0.38;        // A 하이
    else if (hi === 11) adv += 0.28;   // K 하이
    else if (hi === 10) adv += 0.18;   // Q 하이
    else if (hi === 9) adv += 0.08;    // J 하이
    else if (hi <= 7) adv -= 0.18;     // 9 이하 — 콜러 레인지에 유리

    // 낮은 카드가 여러 장 = 콜러가 더 잘 맞는 보드
    const lows = ranks.filter(v => v <= 6).length;    // 8 이하
    adv -= lows * 0.10;

    // 연결성 — 촘촘할수록 콜러(스몰페어·커넥터)에게 유리
    const uniq = [...new Set(ranks)].sort((a, b) => a - b);
    if (uniq.length >= 3) {
        const span = uniq[uniq.length - 1] - uniq[0];
        if (span <= 4) adv -= 0.16;        // 매우 연결 (765, 987)
        else if (span <= 6) adv -= 0.07;
        else if (span >= 9) adv += 0.10;   // 뚝뚝 떨어진 마른 보드
    }

    // 페어드 보드 — 아무도 잘 안 맞음 → 넓은(공격자) 레인지가 벳하기 편하다
    const counts = {};
    ranks.forEach(v => counts[v] = (counts[v] || 0) + 1);
    if (Object.values(counts).some(c => c >= 2)) adv += 0.14;

    return Math.max(-1, Math.min(1, adv));
}

// ── 스트리트별 기본 C벳 빈도 (포지션 반영)
function baseCbetFreq(street, inPosition) {
    // 실측 튜닝: 0.72/0.56 로 뒀더니 전체 C벳이 85%까지 올라갔다(프로 55~70%).
    if (street === 2) return inPosition ? 0.60 : 0.46; // 플랍
    if (street === 3) return inPosition ? 0.46 : 0.37; // 턴
    return inPosition ? 0.40 : 0.31;                   // 리버
}

// ── 목표 C벳 빈도 — 레인지 어드밴티지·인원수·실력 반영
//   여러 명이 남아 있으면 누군가는 맞았다 → 빈도를 크게 줄인다(정석).
function cbetFrequency(opts) {
    const o = opts || {};
    const street = o.street || 2;
    const nOpp = Math.max(1, o.nOpp || 1);
    const skill = Math.max(0, Math.min(1, o.skill != null ? o.skill : 0.8));
    let f = baseCbetFreq(street, !!o.inPosition);
    f *= (1 + (o.adv || 0) * 0.45);
    if (nOpp === 2) f *= 0.70;
    else if (nOpp >= 3) f *= 0.46;
    // 실력이 낮은 봇은 이 정석을 덜 따른다 (난이도 구분 유지)
    f *= (0.62 + 0.38 * skill);
    return Math.max(0, Math.min(0.95, f));
}

// ── 벳 사이즈 — 레인지로 치면 작게, 양극화되면 크게
//   유리한 마른 보드: 33% 레인지벳 / 웻하거나 불리: 65~75% / 리버 밸류: 크게
function cbetSize(opts) {
    const o = opts || {};
    const board = o.board || {};
    const adv = o.adv || 0;
    const street = o.street || 2;
    if (street >= 4) {
        // 리버는 양극화 — 밸류/블러프 모두 크게
        if (o.kind === 'thin') return 0.36;
        return o.overbet ? 1.15 : 0.78;
    }
    if (board.wet) return 0.70;              // 드로우 과금
    if (adv >= 0.25 && !board.wet) return 0.33; // 레인지벳
    if (adv <= -0.15) return 0.62;           // 불리한 보드에선 칠 거면 세게
    return 0.52;
}

// ── 벳 사이즈가 정하는 블러프 비중.
//   팟 대비 s 크기로 베팅할 때, 벳 레인지 중 s/(1+s) 까지만 블러프여야 한다.
//   (그 이상 블러프하면 상대가 무차별 콜만 해도 이득을 본다)
//   1/3팟 → 25%, 절반 → 33%, 3/4팟 → 43%
function bluffShareForSize(betFrac) {
    const f = Math.max(0, betFrac || 0);
    return f / (1 + f);
}

// ── 블러프 빈도 보정: 상대와 인원수에 맞춘다.
//   · 안 접는 상대(콜링스테이션)에게 블러프하는 건 그냥 칩을 주는 것이다
//   · 멀티웨이에선 누군가는 맞았다 — 순수 블러프는 거의 하지 않는다
//   실측: 이 보정 없이 쓰레기 패의 58%를 블러프했다가 맞대결에서 크게 졌다.
function bluffAdjust(opts) {
    const o = opts || {};
    const skill = Math.max(0, Math.min(1, o.skill != null ? o.skill : 0.8));
    let m = 1;
    const nOpp = Math.max(1, o.nOpp || 1);
    if (nOpp === 2) m *= 0.45;
    else if (nOpp >= 3) m *= 0.20;
    if (o.oppFoldToBet != null) {
        if (o.oppFoldToBet < 0.30) m *= 0.40;       // 안 접는 상대 — 블러프 중단
        else if (o.oppFoldToBet > 0.55) m *= 1.35;  // 잘 접는 상대 — 더 압박
    }
    // 실력이 낮으면 이 조절을 못 한다 (1 쪽으로 끌어당김)
    return 1 + (m - 1) * skill;
}

// ── 최소 방어 빈도(MDF): 팟 대비 betFrac 크기의 벳에 최소 이만큼은 방어해야
//   상대의 무조건 블러프가 이득을 못 본다.  MDF = 1 / (1 + betFrac)
function mdf(betFrac) {
    const f = Math.max(0, betFrac || 0);
    return 1 / (1 + f);
}

// ── 방어 판단: 승률이 팟오즈에 약간 못 미쳐도, 작은 벳이면 접지 않는다.
//   betFrac이 작을수록 MDF가 높다 = 더 넓게 방어해야 한다.
//   returns: 필요한 최소 승률(0~1). 기존 callThresh와 min을 취해서 쓴다.
//   skill이 낮으면 이 절제를 못 해서 그냥 팟오즈만 본다.
function defendThreshold(opts) {
    const o = opts || {};
    const potOdds = Math.max(0, Math.min(1, o.potOdds || 0));
    const skill = Math.max(0, Math.min(1, o.skill != null ? o.skill : 0.8));
    const need = mdf(o.betFrac || 1);            // 방어해야 할 레인지 비율
    // 넓게 방어해야 할수록(작은 벳) 요구 승률을 팟오즈 아래로 내린다.
    // ⚠️ 완화폭은 반드시 작아야 한다. MDF는 "레인지의 몇 %를 지키나"지
    //    "아무 패로나 콜하라"가 아니다. 완화를 크게 줬더니 봇이 벳에 6%밖에 안 접는
    //    콜링스테이션이 됐다(실측). 팟오즈에서 최대 6%p까지만 내린다.
    const relief = Math.min(0.06, Math.max(0, need - 0.5) * 0.20 * skill);
    return Math.max(0, potOdds - relief);
}

// ── 리버 블러프캐치: 승률이 애매할 때 콜할지.
//   팟오즈 + 상대 공격성 + 블로커(내가 넛을 막고 있으면 상대 밸류가 적다)
function bluffCatch(opts) {
    const o = opts || {};
    const potOdds = o.potOdds || 0;
    const skill = Math.max(0, Math.min(1, o.skill != null ? o.skill : 0.8));
    // 상대가 공격적일수록 블러프 비중이 높다 → 더 넓게 콜
    const aggrAdj = (o.oppAggression != null) ? (o.oppAggression - 0.35) * 0.30 : 0;
    // 블로커 점수 1.0 = 중립, >1 = 넛 차단(상대 밸류 적음) → 더 콜
    const blockAdj = ((o.blockerMult != null ? o.blockerMult : 1) - 1) * 0.12;
    const need = potOdds - (aggrAdj + blockAdj) * skill;
    return Math.max(0, Math.min(1, need));
}

// ── 에퀴티 실현율: 승률 30%라고 그 30%를 다 가져가는 게 아니다.
//   포지션이 없으면 다음 스트리트에 또 벳을 맞아 접게 되고, 여러 명이면 더 깎인다.
//   드로우가 아닌 어중간한 패는 맞춰도 못 키우고 빗나가면 접어서 실현율이 더 낮다.
//   ⚠️ 리버와 올인 콜은 더 칠 스트리트가 없으므로 실현율 100%.
//   (이걸 빼먹었더니 봇이 벳에 9%밖에 안 접는 호구가 됐다 — 실측)
function realizationFactor(opts) {
    const o = opts || {};
    const street = o.street || 2;
    if (street >= 4 || o.allIn) return 1;
    // 프리플랍은 이미 포지션별 레인지로 판단한다. 여기서 또 깎으면 BB 방어가 사라져
    // 봇이 "레이즈 아니면 폴드"만 하게 된다(실측: VPIP와 PFR이 같아짐).
    if (street < 2) return 1;
    let f = o.inPosition ? 1.0 : 0.85;          // 포지션이 실현율의 핵심
    if ((o.nOpp || 1) >= 2) f *= 0.90;          // 멀티웨이 — 뚫고 이겨야 한다
    if (!o.hasDraw) f *= 0.90;                  // 드로우 없는 어중간한 패
    f *= (street === 2 ? 0.93 : 0.97);          // 남은 스트리트가 많을수록 더 깎임
    return Math.max(0.55, Math.min(1, f));
}

// ── SPR 기반 커밋 판단: 팟 대비 남은 스택이 얕으면 적당한 패로도 다 넣는 게 맞다.
//   spr = 유효스택 / 팟.  낮을수록 커밋 문턱이 내려간다.
function stackOffThreshold(spr) {
    const s = Math.max(0, spr || 0);
    if (s <= 1) return 0.45;   // 거의 팟커밋 — 탑페어급이면 간다
    if (s <= 3) return 0.55;
    if (s <= 6) return 0.63;
    if (s <= 13) return 0.70;
    return 0.76;               // 딥스택 — 넛급만
}

// ── 이 패로 칠 가치가 있는지 분류 (양극화 전략)
//   고수는 "강한 패"와 "승산 없지만 폴드 에퀴티 있는 패"를 치고,
//   애매한 쇼다운 가치가 있는 패는 체크한다(밸류도 블러프도 아님).
//   returns 'value' | 'semibluff' | 'airbluff' | 'checkdown'
function classifyForBet(opts) {
    const o = opts || {};
    const eq = o.equity || 0;
    const valueLine = o.valueLine != null ? o.valueLine : 0.58;
    if (eq >= valueLine) return 'value';
    if (o.hasDraw && eq >= 0.26) return 'semibluff';
    if (eq < 0.22) return 'airbluff';       // 쇼다운 가치 없음 → 블러프 후보
    return 'checkdown';                      // 어중간 — 체크하고 쇼다운 보기
}

module.exports = {
    rangeAdvantage, baseCbetFreq, cbetFrequency, cbetSize,
    mdf, defendThreshold, bluffCatch, realizationFactor, stackOffThreshold, classifyForBet,
    bluffShareForSize, bluffAdjust
};
