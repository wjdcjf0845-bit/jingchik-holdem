// 🎭 매장형 상대 스타일 — 딥스택 연습의 봇을 실제 매장처럼 여러 스타일로 섞는다(정석 고수만 47명이면 상대를 읽고 이용하는 연습이 안 된다).
//   모두 고수 실력이다(운영자 요청 — 난이도는 예전 "전원 고수"와 비슷하게): 플랍 이후는 고수 판단(범위 읽기 · 솔버 자료) 그대로이고,
//   프리플랍만 그 스타일의 "버릇"대로 친다 — 솔버 표 대신 패 순위(상위 몇 %) · 자리 · 짧은 스택 올인 기준.
//   pct: 패의 순위(0 = AA, 1 = 가장 약한 패 — lib/shortstack.js handPercentile).
//   값은 매장에서 흔히 보는 "버릇 있는 고수"를 어림한 것이다(정답이 있는 값이 아니다).
//   (2026-10-16 처음엔 중수 실력으로 넣었더니 정석 고수가 +70bb/100 으로 이겨서 상대가 너무 쉬워졌다.)
const STYLES = {
    station: { name: '콜링스테이션', open: 0.14, limp: 0.06, iso: 0.06, isoCall: 0.18, tb: 0.035, call: 0.32, call3: 0.09, jam3: 0.03,  callJam: 0.12, shortJam: 0.16, openBB: 2.3 },
    lp:      { name: '루즈-패시브',   open: 0.12, limp: 0.10, iso: 0.06, isoCall: 0.15, tb: 0.03,  call: 0.18, call3: 0.06, jam3: 0.025, callJam: 0.09, shortJam: 0.16, openBB: 2.3 },
    nit:     { name: '초타이트',     open: 0.09, limp: 0,    iso: 0.05, isoCall: 0,    tb: 0.025, call: 0.06, call3: 0.03, jam3: 0.02,  callJam: 0.05, shortJam: 0.10, openBB: 2.3 },
    maniac:  { name: '광폭',         open: 0.30, limp: 0,    iso: 0.22, isoCall: 0.05, tb: 0.12,  call: 0.10, call3: 0.08, jam3: 0.06,  callJam: 0.12, shortJam: 0.30, openBB: 3.0 }
};
const KEYS = Object.keys(STYLES);

// 🏷️ 스타일마다 붙이는 봇 별명 — 이름만 봐도 어떤 버릇인지 짐작할 수 있게(딥스택에서 상대를 읽는 연습용)
const NAMES = {
    pro:     ['솔버', '계산기', '교과서', '냉철', '포커페이스', '분석가', '이론가', '균형감각', '정석맨', '알고리즘', '데이터', '체스마스터', '침착', '전략가',
              '레인지', '기대값', '확률왕', '수학자', '밸류맨', '타이밍', '포지션', '스나이퍼', '마에스트로', '설계자', '냉정', '판독기', '그랜드마스터', '정밀'],
    station: ['끝까지간다', '궁금해서콜', '콜맨', '안접어', '쇼다운러버', '버티기', '물고늘어짐', '호기심', '보러가자', '한번만더', '리버까지', '확인해볼게'],
    lp:      ['림프왕', '구경꾼', '조용한참여', '들어나볼까', '느긋이', '살살', '눈치보기', '얌전이', '천천히', '따라가기', '싸게보자', '평화주의'],
    nit:     ['바위', '돌부처', '철벽', '인내심', '기다림', '자물쇠', '수도승', '에이스만', '금고', '참을인', '조심이', '단단'],
    maniac:  ['불도저', '폭주기관차', '올인맨', '광전사', '블러퍼', '돌격대장', '태풍', '미친손', '압박왕', '깡패', '번개', '화산']
};

// 딥스택 50인의 봇 구성(비율). 나머지는 정석 고수.
const FIELD_MIX = { station: 0.125, lp: 0.125, nit: 0.125, maniac: 0.125 };
// 봇 n 명에게 줄 스타일 목록(앞에서부터 — 섞는 건 부르는 쪽). 없는 칸은 'pro'
function mix(n) {
    const out = [];
    KEYS.forEach(k => { for (let i = 0; i < Math.round(n * FIELD_MIX[k]); i++) out.push(k); });
    while (out.length < n) out.push('pro');
    return out.slice(0, n);
}
// 스타일별 별명을 차례로 — 다 쓰면 뒤에 번호. used: 이미 쓴 이름(🤖 붙은 것) 집합
function nameFor(style, used, rnd) {
    const pool = (NAMES[style] || NAMES.pro).slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor((rnd || Math.random)() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    for (const b of pool) if (!used.has('🤖' + b)) return '🤖' + b;
    for (let k = 2; ; k++) for (const b of pool) if (!used.has('🤖' + b + k)) return '🤖' + b + k;
}

// 자리에 따라 넓히거나 좁힌다: 뒷자리일수록 넓게, 앞자리일수록 좁게
function posFactor(pos, extra) {
    if (pos === 'BTN') return 1.45;
    if (pos === 'CO') return 1.25;
    if (pos === 'SB') return 1.15;
    if (pos === 'BB') return 1.1;
    if (pos === 'HJ') return 1.0;
    return Math.max(0.6, 0.85 - 0.07 * (extra || 0));           // LJ·UTG 계열
}

// 프리플랍 결정. s: { style, pct, pos, extra, facing: 'none'|'limp'|'raise'|'3bet'|'allin', effBB, toCallBB, stackBB, curBB }
// 반환: { act: 'fold'|'check'|'call'|'raise'|'jam', toBB?: 레이즈 목표(bb, 이번 스트리트 총액) }
function preflop(s) {
    const S = STYLES[s.style]; if (!S) return null;
    const f = posFactor(s.pos, s.extra), p = s.pct, short = s.effBB <= 15;
    const within = t => p <= Math.min(1, t * f);
    switch (s.facing) {
        case 'none':
            if (short) return within(S.shortJam) ? { act: 'jam' } : { act: s.toCallBB <= 0 ? 'check' : 'fold' };
            if (within(S.open)) return { act: 'raise', toBB: S.openBB };
            if (within(S.limp)) return { act: 'call' };
            return { act: s.toCallBB <= 0 ? 'check' : 'fold' };
        case 'limp':
            if (within(S.iso)) return short ? { act: 'jam' } : { act: 'raise', toBB: (s.curBB || 1) * 4 + 1 };
            if (within(S.isoCall)) return { act: 'call' };
            return { act: s.toCallBB <= 0 ? 'check' : 'fold' };
        case 'raise': {
            if (within(S.tb)) return short || s.toCallBB > s.stackBB * 0.3 ? { act: 'jam' } : { act: 'raise', toBB: (s.curBB || 2.5) * (s.style === 'maniac' ? 3.8 : 3.2) };
            // 콜하기엔 비쌀수록 좁게: 스택의 15% 를 넘으면 반만
            const callT = S.call * (s.toCallBB > s.stackBB * 0.15 ? 0.5 : 1);
            if (within(callT)) return short && s.toCallBB > s.stackBB * 0.4 ? { act: 'jam' } : { act: 'call' };
            return { act: s.toCallBB <= 0 ? 'check' : 'fold' };
        }
        case '3bet':
            if (p <= S.jam3) return { act: 'jam' };
            if (p <= S.call3 && s.toCallBB <= s.stackBB * 0.35) return { act: 'call' };
            return { act: 'fold' };
        case 'allin':
            return p <= S.callJam * (s.toCallBB > s.stackBB * 0.8 ? 0.8 : 1) ? { act: 'call' } : { act: 'fold' };
    }
    return null;
}

module.exports = { STYLES, KEYS, NAMES, FIELD_MIX, mix, nameFor, preflop, posFactor };
