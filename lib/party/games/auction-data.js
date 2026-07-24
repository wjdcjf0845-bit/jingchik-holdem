// 💰 숫자 경매 설정 — 예산 배분 + 눈치싸움
//
// budget : 참가자 전원이 시작할 때 받는 '입찰 예산' (파티 점수와 별개, 보충 없음)
// items  : 경매에 나올 물건 '풀'. 실제 경매에는 인원 수에 맞춰 이 중 일부만 뽑아 씁니다.
//          value = 상대적 가치(가중치). 게임 시작 시 총점이 균형에 맞도록 자동으로 재조정됩니다.
//          mystery:true → 입찰이 끝날 때까지 가치를 숨김 (value를 기준으로 랜덤 공개)
//
// ⚖️ 인원이 많아지면 물건도 자동으로 늘어나(약 인원의 80%, 최소 6개) 대부분이
//    무언가 하나는 노려볼 수 있게 합니다. 물건이 부족해 절반이 빈손 되는 문제 방지.
module.exports = {
    budget: 1000,
    targetTotal: 1500,      // 이 게임 전체가 뿌릴 목표 총점 (다른 게임과 균형)
    itemsPerPlayer: 0.8,    // 물건 개수 = round(인원 × 이 값)
    minItems: 6,
    items: [
        { emoji: '🎟', name: '상품권 조각', value: 150 },
        { emoji: '🍗', name: '치킨 쿠폰',   value: 200 },
        { emoji: '👑', name: '황금 왕관',   value: 250 },
        { emoji: '❓', name: '미스터리 상자', value: 250, mystery: true },
        { emoji: '💎', name: '보석',        value: 300 },
        { emoji: '🏆', name: '우승 트로피',  value: 350 },
        { emoji: '📱', name: '최신 스마트폰', value: 330 },
        { emoji: '🎮', name: '게임기',      value: 300 },
        { emoji: '🎧', name: '무선 헤드폰',  value: 220 },
        { emoji: '🍺', name: '수제맥주 세트', value: 160 },
        { emoji: '🧸', name: '커플 인형',   value: 130 },
        { emoji: '🎂', name: '케이크 교환권', value: 120 },
        { emoji: '💐', name: '꽃다발',      value: 130 },
        { emoji: '🚗', name: '드라이브 데이트권', value: 210 },
        { emoji: '🎁', name: '럭키 박스',   value: 200, mystery: true },
    ],
};
