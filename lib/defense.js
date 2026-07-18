'use strict';
// ════════════════════════════════════════════════════════════════
//  defense.js — 벳에 직면했을 때 "콜에 필요한 최소 승률" 계산
//
//  왜: 기존 봇은 벳을 받으면 순수하게 equity vs potOdds 로만 콜/폴드를 정했다.
//  이건 두 가지를 놓친다.
//   ① 임플라이드 오즈 — 드로우를 들고 딥스택이면, 지금 팟오즈엔 살짝 못 미쳐도
//      맞았을 때 뒤에서 더 벌 수 있으므로 콜이 이득이다.
//   ② 상대 성향 — 블러프 잦은 공격적 상대의 벳엔 블러프가 많으니 가볍게 콜다운
//      해야 하고, 좀처럼 안 치는 수동적 상대가 큰 벳을 하면 밸류가 대부분이라
//      더 자주 폴드해야 한다. (익스플로잇)
//
//  이 모듈은 "콜에 필요한 최소 승률"(requiredEquity)을 돌려준다.
//  호출측은 equity >= requiredEquity 면 콜(또는 강하면 레이즈), 아니면 폴드.
//
//  ⚠️ skill 스케일링: 익스플로잇/임플라이드 보정은 봇 실력에 비례한다.
//     초보 봇(skill 낮음)은 보정이 거의 없어 기존처럼 팟오즈로만 판단한다.
//
//  순수 함수 → 단위 테스트로 검증.
// ════════════════════════════════════════════════════════════════

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// 콜에 필요한 최소 승률.
//   potOdds:       toCall / (pot + toCall)  — 순수 직접 오즈
//   isDraw:        이 핸드가 드로우인가 (뒤 스트리트에 완성 가능성 + 완성 시 추가 수익)
//   sprBehind:     콜 이후 남는 유효 스택 / 현재 팟  — 임플라이드 오즈 크기 (딥할수록 큼)
//   oppAggression: 상대 누적 공격성 0~1 (null 이면 모름)
//   skill:         봇 실력 0~1 (보정 강도 스케일)
//   반환: 0~1 사이 최소 승률. 호출측은 equity 와 직접 비교.
function requiredEquity(opts) {
    const o = opts || {};
    const potOdds = clamp(o.potOdds != null ? o.potOdds : 0.33, 0, 0.95);
    const sk = clamp(o.skill != null ? o.skill : 0.8, 0, 1);
    let req = potOdds;

    // ① 임플라이드 오즈 — 드로우 + 딥스택이면 필요 승률을 낮춘다.
    //    sprBehind 0(숏스택)이면 보정 없음, 딥할수록 최대 -0.12 까지.
    if (o.isDraw) {
        const spr = Math.max(0, o.sprBehind != null ? o.sprBehind : 0);
        const implied = Math.min(0.12, spr * 0.045) * sk;
        req -= implied;
    }

    // ② 상대 성향 익스플로잇 — 0.45를 중립으로, 공격적이면 콜 문턱 인하(블러프 캐치),
    //    수동적이면 인상(정직한 벳엔 폴드). skill 비례.
    if (o.oppAggression != null) {
        const adj = (o.oppAggression - 0.45) * 0.22 * sk; // 대략 ±0.10
        req -= adj;
    }

    // 팟오즈에서 과도하게 벗어나지 않게 제한 — 너무 헐렁하거나 빡빡해지는 것 방지.
    // 바깥 clamp는 최종 승률 범위 [0,1] 보장 (작은 팟오즈에서 하한이 음수가 되는 것 방지).
    return clamp(clamp(req, potOdds - 0.16, potOdds + 0.13), 0, 1);
}

// 드로우 판정 휴리스틱 — 정확한 아웃 계산 없이 신호로 근사.
//   웻 보드(플러시/스트레이트 드로우 존재) + 아직 미완성이라 승률이 드로우 구간 + 리버 전.
//   made hand(이미 강함)나 리버(더 깔 카드 없음)는 드로우가 아니다.
function looksLikeDraw(board, equity, street) {
    if (street >= 4) return false;                 // 리버 — 완성할 카드가 없음
    if (!board) return false;
    if (!(board.flushDraw || board.straighty || board.flushy)) return false;
    const eq = equity != null ? equity : 0;
    return eq >= 0.22 && eq <= 0.50;               // 미완성 드로우의 전형적 승률대
}

module.exports = { requiredEquity, looksLikeDraw };
