// 🧠 스피드 퀴즈 문제은행 — 신랑·신부 커스텀 10문항
// correct = choices 배열의 정답 인덱스(0~3)
//
// ⚠️ 아래는 "틀"입니다. 실제 신랑·신부 사연에 맞게
//    ① choices(선택지 문구)와  ② correct(정답 인덱스: 0~3) 를 꼭 수정하세요!
//    선택지 순서를 바꾸면 correct 숫자도 같이 바꿔야 합니다.
module.exports = [
    { category: 'couple', q: '신랑과 신부가 처음 만난 곳은?',
      choices: ['소개팅', '같은 회사', '대학교/동창', '동호회·모임'], correct: 0 },

    { category: 'couple', q: '두 사람이 처음으로 데이트한 장소는?',
      choices: ['영화관', '맛집/카페', '한강·공원', '놀이공원'], correct: 1 },

    { category: 'couple', q: '먼저 고백한 사람은?',
      choices: ['신랑', '신부', '동시에(눈빛으로)', '친구가 이어줌'], correct: 0 },

    { category: 'couple', q: '두 사람이 사귄 기간은? (결혼까지)',
      choices: ['1년 미만', '1~2년', '3~4년', '5년 이상'], correct: 2 },

    { category: 'couple', q: '신랑이 프러포즈한 장소는?',
      choices: ['호텔/레스토랑', '여행지', '집', '추억의 그 장소'], correct: 1 },

    { category: 'couple', q: '신랑의 MBTI는?',
      choices: ['E로 시작', 'I로 시작', '극e 인싸', '아무도 모름'], correct: 1 },

    { category: 'couple', q: '신부가 신랑에게 첫눈에 반한 이유는?',
      choices: ['잘생긴 외모', '다정한 성격', '유머 감각', '듬직함/능력'], correct: 1 },

    { category: 'couple', q: '두 사람의 애칭(서로 부르는 말)은?',
      choices: ['자기야', '이름/별명', '여보/신랑아', '비밀 애칭이 있다'], correct: 3 },

    { category: 'couple', q: '데이트 비용은 주로 누가 냈을까?',
      choices: ['신랑', '신부', '반반(데이트 통장)', '그때그때 번갈아'], correct: 2 },

    { category: 'couple', q: '신혼여행지는 어디로 갈까?',
      choices: ['유럽', '동남아/휴양지', '일본/가까운 곳', '제주/국내'], correct: 1 },
];
