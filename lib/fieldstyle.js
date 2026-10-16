// 🎭 매장형 상대 스타일 — 딥스택 연습의 봇을 실제 매장처럼 섞는다(정석 고수만 47명이면 상대를 읽고 이용하는 연습이 안 된다).
//   고수 봇은 프리플랍을 솔버 표대로 쳐서 성격이 거의 드러나지 않았다(2026-10-16 측정: 성격과 무관하게 참여율이 같았다).
//   이 스타일들은 프리플랍을 솔버 표 대신 "패 순위(상위 몇 %)" 기준으로 친다. 플랍 이후는 중수 봇의 판단 + 성격 값(잘 안 접음·블러프 많음 등).
//   pct: 패의 순위(0 = AA, 1 = 가장 약한 패 — lib/shortstack.js handPercentile).
//   값은 매장에서 흔히 보는 모습을 어림한 것이다(정답이 있는 값이 아니다).
const STYLES = {
    station: { name: '콜링스테이션', open: 0.07, limp: 0.42, iso: 0.05, isoCall: 0.55, tb: 0.03, call: 0.40, call3: 0.13, jam3: 0.025, callJam: 0.22, shortJam: 0.14, openBB: 2.5 },
    lp:      { name: '루즈-패시브',   open: 0.10, limp: 0.28, iso: 0.07, isoCall: 0.35, tb: 0.035, call: 0.28, call3: 0.08, jam3: 0.025, callJam: 0.13, shortJam: 0.18, openBB: 2.5 },
    nit:     { name: '초타이트',     open: 0.08, limp: 0,    iso: 0.06, isoCall: 0,    tb: 0.02, call: 0.05, call3: 0.02, jam3: 0.015, callJam: 0.035, shortJam: 0.08, openBB: 2.5 },
    maniac:  { name: '광폭',         open: 0.52, limp: 0,    iso: 0.42, isoCall: 0.1,  tb: 0.24, call: 0.16, call3: 0.12, jam3: 0.12, callJam: 0.20, shortJam: 0.45, openBB: 3.5 }
};
const KEYS = Object.keys(STYLES);

// 딥스택 50인의 봇 구성(비율). 나머지는 정석 고수(hard).
const FIELD_MIX = { station: 0.17, lp: 0.13, nit: 0.10, maniac: 0.10 };
// 봇 n 명에게 줄 스타일 목록(앞에서부터 — 섞는 건 부르는 쪽). 없는 칸은 'pro'
function mix(n) {
    const out = [];
    KEYS.forEach(k => { for (let i = 0; i < Math.round(n * FIELD_MIX[k]); i++) out.push(k); });
    while (out.length < n) out.push('pro');
    return out.slice(0, n);
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

// 프리플랍 결정. s: { style, pct, pos, extra, facing: 'none'|'limp'|'raise'|'3bet'|'allin', effBB, toCallBB, stackBB }
// 반환: { act: 'fold'|'check'|'call'|'raise'|'jam', toBB?: 레이즈 목표(bb, 이번 스트리트 총액) }
function preflop(s) {
    const S = STYLES[s.style]; if (!S) return null;
    const f = posFactor(s.pos, s.extra), p = s.pct, short = s.effBB <= 15;
    const within = t => p <= Math.min(1, t * f);
    switch (s.facing) {
        case 'none':
            if (short) return within(S.shortJam) ? { act: 'jam' } : { act: 'fold' };
            if (within(S.open)) return { act: 'raise', toBB: S.openBB };
            if (within(S.limp)) return { act: 'call' };
            return { act: 'fold' };
        case 'limp':
            if (within(S.iso)) return short ? { act: 'jam' } : { act: 'raise', toBB: (s.curBB || 1) * 4 + 1 };
            if (within(S.isoCall)) return { act: 'call' };
            return { act: s.toCallBB <= 0 ? 'check' : 'fold' };
        case 'raise': {
            if (within(S.tb)) return short || s.toCallBB > s.stackBB * 0.3 ? { act: 'jam' } : { act: 'raise', toBB: (s.curBB || 2.5) * (s.style === 'maniac' ? 4 : 3.2) };
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

module.exports = { STYLES, KEYS, FIELD_MIX, mix, preflop, posFactor };
