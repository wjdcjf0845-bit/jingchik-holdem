// 🎵 노래 맞히기 문제은행 — 노래를 처음부터 계속 듣고 제목 맞히기 (주관식)
// 이번 판 콘셉트: 요즘 유행하는 "트로트 버전" 커버 모음 🎤
// 선착순 3등까지만 점수 (1등 150 / 2등 100 / 3등 70). 3명이 맞히면 라운드 자동 종료.
//
// 📁 음원 위치: public/party/audio/<file>  (TV에서만 재생, 폰으로는 전송 안 됨)
//
// title  : TV에 공개할 정답 제목
// answers: 추가로 인정할 답. 영어 제목은 한글 표기도 꼭 넣어주세요 (U R Man → 유얼맨)
//          ※ 채점은 띄어쓰기·대소문자·괄호·기호를 모두 무시하고 비교합니다.
//            (예: '무제(無題)' → '무제' 로 비교되어 "무제"만 쳐도 정답)
// file   : public/party/audio/ 안의 파일명 (그대로 일치해야 함)
// start  : 재생 시작 지점(초). 기본 0 = 노래 처음부터.
//          인트로가 너무 길면 그 곡만 값을 올리세요.
module.exports = [
    { title: '좋은 날', artist: '아이유', file: '[히트곡] 아이유(IU) - 좋은날 (트로트 ver.).mp3', start: 0,
      answers: ['good day', '굿데이'] },

    { title: '뱅뱅뱅', artist: '빅뱅', file: 'BIGBANG (빅뱅) - 뱅뱅뱅 (트로트 버전) [MV].mp3', start: 0,
      answers: ['bang bang bang', '뱅뱅뱅뱅'] },

    { title: 'Ditto', artist: '뉴진스', file: 'NewJeans (뉴진스) - Ditto (트로트 버전).mp3', start: 0,
      answers: ['디토', '디또'] },

    { title: 'U R Man', artist: 'SS501', file: 'SS501 - U R Man (트로트 버전).mp3', start: 0,
      answers: ['유얼맨', '유알맨', '유어맨', 'you are man'] },

    { title: '무제 (無題)', artist: 'G-DRAGON', file: 'G-DRAGON (권지용) – 무제(無題) (7080 버전) [MV].mp3', start: 0,
      answers: ['untitled', '언타이틀드', '무제 2014'] },

    { title: '고민중독', artist: 'QWER', file: 'QWER - 고민중독 (트로트 버전) [MV].mp3', start: 0,
      answers: [] },

    { title: '벌써 일년', artist: '브라운 아이즈', file: '브라운 아이즈 (Brown Eyes) - 벌써 일년 (트로트 버전).mp3', start: 0,
      answers: ['벌써 1년'] },

    { title: '밤양갱', artist: '비비', file: '비비 - 밤양갱 (트로트 ver.).mp3', start: 0,
      answers: [] },

    { title: '갑자기', artist: '아이오아이 (I.O.I)', file: '아이오아이 (I.O.I) - 갑자기 (트로트 버전).mp3', start: 0,
      answers: [] },

    { title: '마에스트로', artist: '창모', file: '창모 - 마에스트로 (트로트버전).mp3', start: 0,
      answers: ['maestro'] },
];
