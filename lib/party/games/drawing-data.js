// 🎨 그림 맞히기 제시어 — 조금 난이도 있는 버전
//
// 형식 두 가지를 모두 지원합니다:
//   '단어'                                  → 그 단어만 정답
//   { word: '우주비행사', answers: ['우주인'] } → 동의어도 정답 인정
//
// 채점은 띄어쓰기·대소문자·기호를 무시합니다. ('부케 던지기' = '부케던지기')
// 난이도를 낮추려면 쉬운 단어를 추가하거나 answers를 넉넉히 넣어주세요.
module.exports = [
    // ── 행동 · 상황 (사물보다 어려움) ──
    { word: '짝사랑', answers: ['외사랑'] },
    { word: '야근', answers: ['철야', '야근하기'] },
    { word: '지각', answers: ['늦잠', '지각하기'] },
    { word: '소개팅', answers: ['맞선'] },
    { word: '다이어트', answers: ['살빼기'] },
    { word: '새치기', answers: ['끼어들기'] },
    { word: '몰래카메라', answers: ['몰카'] },
    { word: '밤샘', answers: ['밤새우기'] },
    { word: '숨바꼭질', answers: ['술래잡기'] },
    { word: '줄다리기', answers: [] },
    { word: '물구나무서기', answers: ['물구나무'] },
    { word: '이사', answers: ['이삿짐'] },

    // ── 사물 (복합·구체적) ──
    { word: '에스컬레이터', answers: ['무빙워크'] },
    { word: '롤러코스터', answers: ['청룡열차'] },
    { word: '회전초밥', answers: [] },
    { word: '소화기', answers: [] },
    { word: '등대', answers: [] },
    { word: '나침반', answers: [] },
    { word: '현미경', answers: [] },
    { word: '지구본', answers: ['지구의'] },
    { word: '자판기', answers: ['자동판매기'] },
    { word: '다리미', answers: [] },
    { word: '사다리', answers: [] },
    { word: '망원경', answers: [] },
    { word: '헬리콥터', answers: ['헬기'] },
    { word: '잠수함', answers: [] },
    { word: '열기구', answers: ['풍선기구'] },
    { word: '가로등', answers: [] },
    { word: '분수대', answers: ['분수'] },
    { word: '풍차', answers: [] },
    { word: '드론', answers: [] },
    { word: '지팡이', answers: ['목발'] },

    // ── 직업 · 캐릭터 ──
    { word: '소방관', answers: ['소방수'] },
    { word: '우주비행사', answers: ['우주인', '우주복'] },
    { word: '마술사', answers: ['마법사'] },
    { word: '발레리나', answers: ['발레'] },
    { word: '산타클로스', answers: ['산타'] },
    { word: '해적', answers: ['해적선'] },
    { word: '미라', answers: [] },
    { word: '인어공주', answers: ['인어'] },
    { word: '허수아비', answers: [] },
    { word: '경찰관', answers: ['경찰'] },

    // ── 결혼 · 모임 테마 🎊 ──
    { word: '부케 던지기', answers: ['부케던지기', '부케'] },
    { word: '축의금', answers: ['봉투'] },
    { word: '상견례', answers: [] },
    { word: '웨딩촬영', answers: ['웨딩사진', '스냅촬영'] },
    { word: '신혼여행', answers: ['허니문'] },
    { word: '결혼반지', answers: ['커플링'] },

    // ── 장소 · 장면 ──
    { word: '찜질방', answers: ['사우나', '목욕탕'] },
    { word: '노래방', answers: [] },
    { word: '놀이공원', answers: ['유원지', '테마파크'] },
    { word: '캠핑', answers: ['텐트', '야영'] },
    { word: '낚시', answers: ['낚시하기'] },
    { word: '스키장', answers: ['스키'] },
    { word: '무인도', answers: [] },

    // ── 살짝 추상적 (고난도) ──
    { word: '시간여행', answers: ['타임머신'] },
    { word: '무중력', answers: ['우주유영'] },
    { word: '지진', answers: [] },
    { word: '도둑', answers: ['강도'] },
];
