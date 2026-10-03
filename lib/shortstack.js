'use strict';
// ═══════════════════════════════════════════════════════════
//  shortstack.js — 숏스택 프리플랍(푸시/폴드)과 올인 콜 레인지
//
//  왜 필요한가:
//   · 스택이 12bb 아래로 내려가면 2.5bb 로 열고 3벳에 접는 플레이는 칩을 그냥 흘린다.
//     오픈 한 번에 스택의 20%가 나가고, 플랍을 봐도 남은 칩으로는 상대를 접게 할 수 없다.
//     이 구간은 "올인 아니면 폴드"가 정답에 가깝다(내시 균형 푸시/폴드).
//   · 올인을 받을 때 "아무 패 상대 승률"로 판단하면 너무 넓게 받는다.
//     올인한 사람은 아무 패가 아니라 상위 몇 %만 들고 있다. K7o 는 랜덤 상대로 55%지만
//     상위 15% 레인지 상대로는 35% 남짓이다.
//
//  표는 내시 푸시/폴드 차트를 6인 기준으로 근사한 것이다. 정확한 균형해가 아니라
//  "스택이 줄수록·뒤에 남은 사람이 적을수록 넓게"라는 모양을 맞추는 게 목적이다.
// ═══════════════════════════════════════════════════════════

const ORDER = '23456789TJQKA';

// 올인 상황에서의 패 강도(랜덤 상대 승률 근사). 플레이성(수딧 커넥터)이 아니라
// 쇼다운 승률이 중요하므로 preflop.js 의 오픈용 점수와 따로 둔다.
function allinStrength(code) {
    const a = ORDER.indexOf(code[0]), b = ORDER.indexOf(code[1]);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    if (code[0] === code[1]) return 0.50 + hi * 0.0292;          // 22≈.50 … AA≈.85
    let s = 0.262 + hi * 0.0215 + lo * 0.0105;                    // 하이카드가 대부분을 결정
    if (code[2] === 's') s += 0.03;
    const gap = hi - lo;
    if (gap === 1) s += 0.012; else if (gap === 2) s += 0.006;    // 연결성은 올인에선 조금만
    return s;
}

// 169칸을 강한 순으로 세워, 각 핸드가 "상위 몇 %"인지(콤보 수 가중) 미리 계산
const PCT = (() => {
    const rows = [];
    for (let i = 12; i >= 0; i--) for (let j = i; j >= 0; j--) {
        if (i === j) rows.push({ code: ORDER[i] + ORDER[j], n: 6 });
        else { rows.push({ code: ORDER[i] + ORDER[j] + 's', n: 4 }); rows.push({ code: ORDER[i] + ORDER[j] + 'o', n: 12 }); }
    }
    rows.forEach(r => { r.s = allinStrength(r.code); });
    rows.sort((x, y) => y.s - x.s);
    const map = {}; let acc = 0;
    rows.forEach(r => { acc += r.n; map[r.code] = acc / 1326; });   // 이 핸드까지 포함한 누적 비율
    return map;
})();
function handPercentile(code) { return PCT[code] !== undefined ? PCT[code] : 1; }

// 아무도 안 들어온 팟에서 올인할 레인지(상위 비율).
//   stackBB: 유효 스택(bb), behind: 내 뒤에 남은 사람 수(1 = SB 가 BB 상대로)
function pushPct(stackBB, behind) {
    const b = Math.max(1, Math.min(8, behind || 1));
    // 10bb 기준 — 뒤에 사람이 많을수록 누군가 강한 패로 받을 확률이 커져 좁혀야 한다
    const base10 = [0, 0.58, 0.40, 0.29, 0.22, 0.17, 0.14, 0.12, 0.10][b];
    const s = Math.max(1, stackBB || 1);
    // 스택이 짧을수록 넓게(블라인드가 스택에서 차지하는 몫이 커진다), 길수록 좁게
    const k = s <= 10 ? 1 + (10 - s) * 0.075 : 1 - (s - 10) * 0.06;
    return Math.max(0.04, Math.min(1, base10 * Math.max(0.45, k)));
}

// 포지션별 "오픈하는 사람"의 대략적 레인지 폭 (리쉬브/콜 판단의 기준)
const OPEN_PCT = { 'UTG': 0.15, 'UTG+1': 0.16, 'UTG+2': 0.17, 'LJ': 0.18, 'HJ': 0.20, 'CO': 0.27, 'BTN': 0.42, 'SB': 0.40, 'BB': 0.30 };
function openPct(position) { return OPEN_PCT[position] !== undefined ? OPEN_PCT[position] : 0.20; }

// 오픈 레이즈를 상대로 올인(리쉬브)할 레인지.
//   상대 오픈이 넓을수록(버튼 스틸) 넓게, 타이트할수록(UTG) 좁게. 스택이 길면 잃을 게 많아 좁힌다.
function reshovePct(openerPct, stackBB) {
    const s = Math.max(1, stackBB || 1);
    const k = s <= 8 ? 0.62 : s <= 12 ? 0.50 : s <= 16 ? 0.40 : 0.30;
    return Math.max(0.03, Math.min(0.5, (openerPct || 0.2) * k));
}

// 상대가 올인했을 때 그 사람의 레인지 폭 추정.
//   raises: 이번 프리플랍의 레이즈 횟수(올인 포함). 3벳·4벳 올인일수록 훨씬 좁다.
function shoverPct(stackBB, behind, raises) {
    const r = raises || 1;
    if (r >= 3) return 0.025;                                   // 4벳 이상 올인 — QQ+/AK
    if (r === 2) return stackBB <= 14 ? 0.10 : 0.045;           // 3벳 올인 — 숏스택이면 넓고 딥이면 프리미엄
    if (stackBB > 22) return 0.05;                              // 딥스택 오픈 올인 — 드물고 강하다
    return Math.min(1, pushPct(stackBB, behind) * 1.05);        // 숏스택 오픈 푸시 — 차트대로 치고 있다고 본다
}

// 상위 x% 레인지를 상대로 한 내 승률 근사.
//   내 핸드가 상위 p% 일 때, 상대 레인지(상위 x%) 안에서 내가 어디쯤인지로 가른다.
//   · 상대 레인지 꼭대기보다 한참 위(p ≪ x) → 지배하는 쪽이라 60%대
//   · 레인지 경계 근처(p ≈ x) → 40% 안팎
//   · 레인지 밖(p ≫ x) → 지배당하기 쉬워 30% 초반까지 내려간다
function equityVsRange(p, x) {
    const xx = Math.max(0.01, Math.min(1, x));
    const ratio = Math.max(0, p) / xx;           // 1 이면 상대 레인지의 바닥과 같은 급
    let e;
    if (ratio <= 0.25) e = 0.66 - ratio * 0.28;          // .66 → .59
    else if (ratio <= 1) e = 0.59 - (ratio - 0.25) * 0.2267;   // .59 → .42
    else if (ratio <= 3) e = 0.42 - (ratio - 1) * 0.045;       // .42 → .33
    else e = 0.33 - Math.min(0.05, (ratio - 3) * 0.01);
    // 상대 레인지가 넓을수록(=약한 패가 많이 섞임) 전반적으로 내 승률이 올라간다
    e += (xx - 0.2) * 0.10;
    return Math.max(0.24, Math.min(0.85, e));
}

// 근사식은 실제 승률과 평균 5.7%p 어긋났다(큰 페어는 낮게, 넓은 레인지 상대 잡패는 높게 — scratch/calib.js 실측).
// 그래서 169핸드 × 레인지 폭 9단계의 실제 승률을 몬테카를로로 미리 계산해 둔 표를 쓴다.
// 표가 없을 때만 근사식으로 떨어진다.
let TABLE = null;
try { TABLE = require('./shove_equity.json'); } catch (e) { TABLE = null; }
function equityVs(code, x) {
    const xx = Math.max(0.01, Math.min(1, x || 1));
    const row = TABLE && TABLE.eq && TABLE.eq[code];
    if (!row) return equityVsRange(handPercentile(code), xx);
    const xs = TABLE.xs;
    if (xx <= xs[0]) return row[0];
    for (let i = 1; i < xs.length; i++) {
        if (xx <= xs[i]) { const t = (xx - xs[i - 1]) / (xs[i] - xs[i - 1]); return row[i - 1] + (row[i] - row[i - 1]) * t; }
    }
    return row[row.length - 1];
}

// 올인 콜 여부. potOdds = 콜 금액 / (팟 + 콜 금액). edge = 생존 가치로 더 요구할 여유.
function shouldCallShove(code, x, potOdds, edge) {
    const eq = equityVs(code, x);
    return { call: eq >= potOdds + (edge || 0), equity: eq };
}

module.exports = { allinStrength, handPercentile, pushPct, openPct, reshovePct, shoverPct, equityVsRange, equityVs, shouldCallShove };
