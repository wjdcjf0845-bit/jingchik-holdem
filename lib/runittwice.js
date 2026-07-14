'use strict';
// ════════════════════════════════════════════════════════════════
//  runittwice.js — 런잇트와이스 (올인 시 보드를 두 번 깔기)
//
//  왜: 올인으로 액션이 끝나면 남은 보드는 순전히 운이다. 큰 팟이 카드 한 장에
//  통째로 갈리면 분산이 커진다. 카지노에서는 양측 합의 하에 보드를 두 번 깔고
//  팟을 반씩 나눠 — 실력 차이가 결과에 더 정직하게 반영되게 한다.
//
//  규칙 (카지노 표준):
//   - 액션이 완전히 끝난 올인 상황에서만 (더 이상 벳할 사람이 없음)
//   - 리버가 이미 나왔으면 의미 없음 (깔 카드가 없음)
//   - 런2는 런1이 쓴 카드 "다음"부터 뽑는다 — 같은 덱, 카드 중복 없음
//   - 각 팟(사이드팟 포함)을 런 수만큼 등분, 홀수 칩은 앞 런부터
//   - 토너먼트는 TDA 규정상 금지 → 캐시 게임 전용
//
//  순수 함수 → 단위 테스트로 검증.
// ════════════════════════════════════════════════════════════════

// 현재 스트리트 기준 아직 깔아야 할 커뮤니티 카드 수.
//   gameStage: 1=프리플랍 2=플랍깔림 3=턴깔림 4=리버깔림
//   (서버 nextStage 의미론과 동일 — 이 단계에서 "다음 스트리트"를 깐다)
function cardsRemainingToDeal(gameStage) {
    if (gameStage === 1) return 5; // 플랍3 + 턴1 + 리버1
    if (gameStage === 2) return 2; // 턴 + 리버
    if (gameStage === 3) return 1; // 리버
    return 0;                      // 리버까지 다 깔림
}

// 런잇트와이스를 발동할 상황인가?
//   enabled:     방 설정 on/off
//   mode:        'cash' | 'tournament' | 'mtt'  (캐시 전용 — TDA 표준)
//   gameStage:   현재 스트리트
//   contestants: 폴드하지 않고 팟을 다투는 인원 수
//   actionable:  아직 벳할 수 있는(올인 아닌) 인원 수 — 0 또는 1이어야 액션 종료
function shouldRunItTwice(opts) {
    const o = opts || {};
    if (!o.enabled) return false;
    if (o.mode !== 'cash') return false;                 // 토너먼트 금지 (TDA)
    if ((o.contestants || 0) < 2) return false;          // 다툴 사람이 없으면 무의미
    if ((o.actionable || 0) > 1) return false;           // 아직 액션이 남았으면 올인 상황 아님
    if (cardsRemainingToDeal(o.gameStage) <= 0) return false; // 깔 카드가 없음
    return true;
}

// 팟을 런 수만큼 등분. 홀수 칩은 앞 런부터 1칩씩.
//   splitPotForRuns(101, 2) → [51, 50]
//   splitPotForRuns(7, 2)   → [4, 3]
//   합은 항상 원래 금액과 정확히 일치 (칩이 생기거나 사라지면 안 됨)
function splitPotForRuns(amount, runs) {
    const n = Math.max(1, Math.floor(runs || 1));
    const total = Math.max(0, Math.floor(amount || 0));
    const base = Math.floor(total / n);
    let rem = total - base * n;
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(base + (rem > 0 ? 1 : 0));
        if (rem > 0) rem--;
    }
    return out;
}

// 런 수만큼 보드를 만든다.
//   committed: 이미 깔린 커뮤니티 카드 (양쪽 런이 공유)
//   drawFn:    카드 한 장을 덱에서 뽑는 함수 (deck.pop 등) — 순차 호출로 중복 방지
//   gameStage: 현재 스트리트
//   runs:      런 수 (기본 2)
//   반환: [boardA, boardB, ...] — 각각 5장짜리 완성 보드
function buildRunBoards(committed, drawFn, gameStage, runs) {
    const n = Math.max(1, Math.floor(runs || 2));
    const need = cardsRemainingToDeal(gameStage);
    const base = (committed || []).slice();
    const boards = [];
    for (let i = 0; i < n; i++) {
        const b = base.slice();
        for (let k = 0; k < need; k++) b.push(drawFn());
        boards.push(b);
    }
    return boards;
}

module.exports = { cardsRemainingToDeal, shouldRunItTwice, splitPotForRuns, buildRunBoards };
