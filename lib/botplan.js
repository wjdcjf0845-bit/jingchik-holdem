'use strict';
// ════════════════════════════════════════════════════════════════
//  botplan.js — 봇 스트리트 플랜 (핸드 단위 의도 유지)
//
//  문제: 기존 봇은 매 스트리트를 "독립적으로" 판단했다. 플랍에서 드로우로
//        세미블러프 벳을 해놓고, 턴에서 드로우가 안 맞으면 raw equity가 낮다는
//        이유로 그냥 체크(포기)해버린다. 사람이 보면 "왜 벳하다 말지?" 싶은
//        일관성 없는 라인이고, 상대에게 무료 카드 + 주도권을 공짜로 넘긴다.
//
//  개선: 봇이 벳할 때 "왜 벳하는지"(의도)를 핸드에 기록해두고, 다음 스트리트에서
//        그 플랜을 이어간다 = 배럴(연속 벳).
//    - value     : 강한 핸드 밸류 벳 → 다음 스트리트도 계속 밸류
//    - semibluff : 드로우 + 폴드에쿼티 → 드로우 살아있는 동안 계속 압박
//    - bluff     : 순수 블러프 → 상황(드라이 보드/잘 폴드하는 상대)이 좋으면 배럴,
//                  아니면 손절(플랜 종료)
//
//  순수 함수 (난수 미사용, 빈도값만 반환) → 단위 테스트로 검증.
// ════════════════════════════════════════════════════════════════

// 벳 시점의 의도 분류.
//   equity: 현재 승률 추정(0~1), board: analyzeBoardTexture() 결과 또는 null
//   isValue: 호출측에서 이미 "강한 핸드(밸류 구간)"로 판정했는지
//   반환: 'value' | 'semibluff' | 'bluff'
function classifyBetPlan(opts) {
    const o = opts || {};
    const equity = o.equity != null ? o.equity : 0;
    const board = o.board || null;
    if (o.isValue) return 'value';
    // 에퀴티가 어느 정도 있고 보드가 웻하면 = 드로우를 들고 치는 세미블러프
    if (equity > 0.30 && board && board.wet) return 'semibluff';
    return 'bluff';
}

// 배럴(연속 벳) 빈도 계산.
//   plan:      { betStreet, type } — 직전에 세운 플랜 (없으면 0 반환)
//   street:    현재 스트리트 (2=플랍 3=턴 4=리버)
//   board:     analyzeBoardTexture() 결과 또는 null
//   oppRead:   { foldToBet } 또는 null
//   skill:     봇 실력 계수 (0~1)
//   activeOpp: 나 말고 살아있는 상대 수
//   equity:    현재 승률 추정
//   반환: 0~0.9 사이의 배럴 확률. 0이면 배럴 조건 미충족(호출측 기본 블러프 빈도 사용)
function barrelFrequency(opts) {
    const o = opts || {};
    const plan = o.plan;
    const street = o.street != null ? o.street : 2;
    const board = o.board || null;
    const oppRead = o.oppRead || null;
    const skill = o.skill != null ? o.skill : 0.8;
    const activeOpp = o.activeOpp != null ? o.activeOpp : 1;
    const equity = o.equity != null ? o.equity : 0;

    // 배럴 조건: 직전 스트리트에 내가 벳한 어그레서 + 턴 이후 + 상대가 남아있음
    if (!plan || plan.betStreet !== street - 1) return 0;
    if (street < 3 || activeOpp < 1) return 0;

    // 세미블러프는 에퀴티가 뒤를 받쳐주므로 더 자주 배럴
    let barrel = (plan.type === 'semibluff') ? 0.60 : 0.48;
    if (board && board.dry) barrel += 0.14;   // 드라이 = 상대 레인지 약함 → 배럴이 잘 통함
    if (board && board.wet && plan.type === 'bluff') barrel -= 0.16; // 웻 보드 순블러프 배럴은 위험
    if (oppRead && oppRead.foldToBet != null) barrel += (oppRead.foldToBet - 0.45) * 0.6; // 잘 폴드하는 상대엔 ↑
    barrel *= skill;
    if (activeOpp >= 2) barrel *= 0.35;       // 멀티웨이에선 블러프가 안 통함 — 대폭 축소
    if (street === 4 && plan.type === 'bluff' && equity < 0.12) barrel *= 0.55; // 리버 순블러프는 신중

    return Math.max(0, Math.min(0.9, barrel));
}

module.exports = { classifyBetPlan, barrelFrequency };
