// 🧠 스피드 퀴즈 문제은행 — 신서유기식 대중문화 퀴즈 (음악 · 영화 · 인물 · 상식)
// correct = choices 배열의 정답 인덱스(0~3)
// category: 'music' | 'movie' | 'person' | 'general'
// 매 판 이 중 10문항을 랜덤으로 뽑습니다. 자유롭게 추가/수정하세요.
module.exports = [
    // ── 🎬 영화 ──
    { category: 'movie', q: '영화 「기생충」의 감독은?',
      choices: ['박찬욱', '봉준호', '김지운', '나홍진'], correct: 1 },
    { category: 'movie', q: '「기생충」이 아카데미 작품상을 받은 해는?',
      choices: ['2018년', '2019년', '2020년', '2021년'], correct: 2 },
    { category: 'movie', q: '영화 「아바타」의 감독은?',
      choices: ['스티븐 스필버그', '제임스 카메론', '크리스토퍼 놀란', '리들리 스콧'], correct: 1 },
    { category: 'movie', q: '영화 「올드보이」에서 오대수를 연기한 배우는?',
      choices: ['송강호', '최민식', '설경구', '황정민'], correct: 1 },
    { category: 'movie', q: '마블 「아이언맨」의 토니 스타크를 연기한 배우는?',
      choices: ['크리스 에번스', '크리스 헴스워스', '로버트 다우니 주니어', '마크 러팔로'], correct: 2 },

    // ── 🎵 음악 ──
    { category: 'music', q: '「겨울왕국」 OST \'Let It Go\'의 영화 원곡 가수는?',
      choices: ['이디나 멘젤', '데미 로바토', '아델', '아리아나 그란데'], correct: 0 },
    { category: 'music', q: '「타이타닉」 주제가 \'My Heart Will Go On\'을 부른 가수는?',
      choices: ['머라이어 캐리', '휘트니 휴스턴', '셀린 디온', '바브라 스트라이샌드'], correct: 2 },
    { category: 'music', q: '다음 중 비틀즈(The Beatles) 멤버가 아닌 사람은?',
      choices: ['존 레논', '폴 매카트니', '링고 스타', '믹 재거'], correct: 3 },
    { category: 'music', q: '방탄소년단(BTS)이 데뷔한 해는?',
      choices: ['2011년', '2012년', '2013년', '2014년'], correct: 2 },
    { category: 'music', q: '전 세계적으로 히트한 \'강남스타일\'을 부른 가수는?',
      choices: ['싸이', '비', '지드래곤', 'god'], correct: 0 },

    // ── 👤 인물 ──
    { category: 'person', q: '「신서유기」를 연출한 PD는?',
      choices: ['김태호', '나영석', '정종연', '이우정'], correct: 1 },
    { category: 'person', q: '「무한도전」을 오래 이끈 대표 진행자는?',
      choices: ['강호동', '유재석', '신동엽', '김구라'], correct: 1 },
    { category: 'person', q: '손흥민 선수가 오랫동안 활약한 잉글랜드 프리미어리그 팀은?',
      choices: ['아스널', '첼시', '토트넘', '리버풀'], correct: 2 },
    { category: 'person', q: '\'팝의 황제\'라 불린 가수는?',
      choices: ['엘비스 프레슬리', '마이클 잭슨', '프린스', '스티비 원더'], correct: 1 },

    // ── 💡 상식 ──
    { category: 'general', q: '태양계에서 가장 큰 행성은?',
      choices: ['지구', '토성', '목성', '화성'], correct: 2 },
    { category: 'general', q: '무지개 색은 흔히 몇 가지로 말할까?',
      choices: ['5가지', '6가지', '7가지', '8가지'], correct: 2 },
];
