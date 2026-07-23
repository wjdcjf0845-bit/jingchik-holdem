// 💰 숫자 경매 설정 — 예산 배분 + 눈치싸움
//
// budget : 참가자 전원이 시작할 때 받는 '입찰 예산' (파티 점수와 별개, 보충 없음)
// items  : 경매에 나올 물건. value = 낙찰 시 얻는 파티 점수
//          mystery:true → 입찰이 끝날 때까지 가치를 숨김 (mysteryMin~Max 중 랜덤)
//
// 밸런스 팁: items의 value 총합이 budget보다 커야 경쟁이 생깁니다.
//           (지금은 예산 1000 vs 물건 총합 약 1300~1600)
module.exports = {
    budget: 1000,
    mysteryMin: 100,
    mysteryMax: 400,
    items: [
        { emoji: '🎟', name: '상품권 조각', value: 150 },
        { emoji: '🍗', name: '치킨 쿠폰',   value: 200 },
        { emoji: '👑', name: '황금 왕관',   value: 250 },
        { emoji: '❓', name: '미스터리 상자', mystery: true },
        { emoji: '💎', name: '보석',        value: 300 },
        { emoji: '🏆', name: '우승 트로피',  value: 400 },
    ],
};
