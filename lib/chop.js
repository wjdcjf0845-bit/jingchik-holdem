'use strict';
// ════════════════════════════════════════════════════════════════
//  chop.js — 토너먼트 합의 종료(칩 찹) 분배
//
//  모두의 동의로 토너먼트를 도중에 끝낼 때, 상금풀을 현재 칩 비율대로 나눈다
//  (포커의 표준 합의 방식 "칩 찹").
//
//  상금풀 = 참가자 시작칩 합(+리바이) = 테이블 위 총 칩이라, 대개 결과는
//  "각자 가진 칩만큼 받기"와 같다. 누가 칩을 들고 나가 풀과 총칩이 어긋나도
//  비율 공식이 풀 전액을 남은 사람에게 정확히 나눈다.
//
//  봇은 비율의 분모에 포함되지만 지급 대상은 아니다(호출측 처리) — 기존
//  "봇이 우승하면 상금 소멸" 규칙과 같다. 봇에게 지는 중인 사람이 혼자 투표해
//  원금을 전부 돌려받는 악용을 막는다.
//
//  순수 함수 → 단위 테스트로 칩 보존(분배합 == 풀)을 검증.
// ════════════════════════════════════════════════════════════════

// stacks: [{ nick, chips, isBot }]
// 반환: [{ nick, chips, isBot, share }] — 칩 0인 참가자는 제외. share 합계는 정확히 pool.
function chipChop(pool, stacks) {
    const rows = (stacks || [])
        .filter(s => s && s.chips > 0)
        .map(s => ({ nick: s.nick, chips: Math.floor(s.chips), isBot: !!s.isBot, share: 0 }));
    const total = rows.reduce((sum, r) => sum + r.chips, 0);
    const P = Math.max(0, Math.floor(pool || 0));
    if (total <= 0 || P <= 0) return rows;

    for (const r of rows) r.share = Math.floor(P * r.chips / total);

    // 내림으로 생긴 끝전(항상 참가자 수 미만)은 칩이 많은 순서로 1칩씩 — 합이 풀과 정확히 같게
    let rem = P - rows.reduce((sum, r) => sum + r.share, 0);
    const order = rows.map((_, i) => i).sort((a, b) => rows[b].chips - rows[a].chips);
    for (let k = 0; rem > 0; k = (k + 1) % order.length) { rows[order[k]].share++; rem--; }
    return rows;
}

module.exports = { chipChop };
