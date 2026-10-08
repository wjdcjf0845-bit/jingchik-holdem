const Ranges = require('./ranges');   // 📊 레이즈를 받았을 때의 범위표
'use strict';
// ════════════════════════════════════════════════════════════════
//  preflop.js — 프리플랍 GTO 레인지 로직 (서버 봇 + 학습모드 조언 + 테스트가 공유)
//  핵심: 169칸 핸드 표기 → 포지션별 RFI(Raise First In) 차트로 raise/call/fold 등급.
//  상태(this)·소켓 의존성이 없는 순수 로직이라, "학습모드가 보여주는 GTO 데이터"와
//  "봇이 실제로 쓰는 데이터"가 동일한 단일 출처임을 단위 테스트로 보장한다.
// ════════════════════════════════════════════════════════════════

// 핸드 두 장 → 169칸 표기 (예: 'AKs','AJo','TT')
function handToCode(hand) {
    const order = '23456789TJQKA';
    const r1 = hand[0][0], r2 = hand[1][0];
    const v1 = order.indexOf(r1), v2 = order.indexOf(r2);
    const hi = v1 >= v2 ? r1 : r2, lo = v1 >= v2 ? r2 : r1;
    if (r1 === r2) return hi + lo;                 // 페어
    const suited = hand[0][1] === hand[1][1];
    return hi + lo + (suited ? 's' : 'o');
}

// 핸드의 "강도 순위" 점수 (레인지 임계값 비교용, 0~100). Chen 변형 + 승률 근사 혼합.
function handRangeScore(code) {
    const order = '23456789TJQKA';
    const a = order.indexOf(code[0]), b = order.indexOf(code[1]);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    const pair = code[0] === code[1];
    const suited = code[2] === 's';
    const gap = hi - lo;
    let s;
    if (pair) {
        s = 50 + hi * 4;                            // 22=50 ... AA=98
    } else {
        s = 18 + hi * 2.6 + lo * 1.4;               // 하이/로우 가중
        if (suited) s += 7;
        if (gap === 1) s += 6;                      // 커넥터
        else if (gap === 2) s += 3;
        else if (gap === 3) s += 1;
        else if (gap >= 5) s -= 4;                  // 큰 갭 페널티
        // 수딧 커넥터/원갭퍼는 낮은 카드여도 플레이성 보너스 (54s~JTs류 BTN 오픈)
        if (suited && gap === 1 && lo >= 2) s += 4; // 43s 이상 수딧 커넥터
        if (suited && gap === 2 && lo >= 3) s += 2; // 수딧 원갭퍼
        // A는 별도 보너스(너트 잠재력)
        if (hi === 12) s += suited ? 5 : 2;
        // 오프수트 약한 갭 핸드 추가 페널티 (J8o, T8o, K5o 류 — 플레이성 낮음)
        if (!suited && gap >= 2 && hi < 12) s -= 3;
        // 매우 낮은 오프수트(둘 다 9 이하)는 더 페널티
        if (!suited && hi <= 7 && gap >= 2) s -= 2;
    }
    return Math.max(0, Math.min(100, Math.round(s)));
}

// 포지션별 오픈(레이즈) 임계값 — 차트에 없는 핸드의 보조 판단용
const POSITION_OPEN_THRESHOLD = {
    'UTG': 60, 'UTG+1': 60, 'UTG+2': 59, 'LJ': 59, 'HJ': 58, 'CO': 55, 'BTN': 49, 'SB': 51, 'BB': 44
};
function openThreshold(position) {
    if (POSITION_OPEN_THRESHOLD[position] !== undefined) return POSITION_OPEN_THRESHOLD[position];
    if (position && position.startsWith('UTG')) return 64;
    return 58;
}

// 📊 표준 6맥스 RFI(Raise First In) 오픈 레인지 차트 — GTO 솔버 근사, 학습 정확도용
const PREFLOP_OPEN_RANGE = {
  'UTG': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','QJs','QTs','JTs','J9s','T9s','98s','87s','76s','65s','54s','AKo','AQo','AJo','KQo']),
  'HJ': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','QJs','QTs','Q9s','JTs','J9s','T9s','T8s','98s','97s','87s','76s','65s','54s','AKo','AQo','AJo','ATo','KQo','KJo','QJo']),
  'CO': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s','QJs','QTs','Q9s','Q8s','JTs','J9s','J8s','T9s','T8s','98s','97s','87s','76s','65s','54s','43s','AKo','AQo','AJo','ATo','A9o','KQo','KJo','KTo','QJo','QTo','JTo']),
  'BTN': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s','K4s','K3s','K2s','QJs','QTs','Q9s','Q8s','Q7s','Q6s','Q5s','Q4s','JTs','J9s','J8s','J7s','J6s','T9s','T8s','T7s','T6s','98s','97s','96s','87s','86s','85s','76s','75s','65s','64s','54s','53s','43s','AKo','AQo','AJo','ATo','A9o','A8o','A7o','A6o','A5o','A4o','A3o','A2o','KQo','KJo','KTo','K9o','K8o','QJo','QTo','Q9o','JTo','J9o','T9o','98o','87o','76o']),
  'SB': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s','K4s','K3s','K2s','QJs','QTs','Q9s','Q8s','Q7s','Q6s','Q5s','JTs','J9s','J8s','J7s','T9s','T8s','T7s','98s','97s','87s','76s','65s','54s','43s','AKo','AQo','AJo','ATo','A9o','A8o','A7o','A5o','KQo','KJo','KTo','K9o','QJo','QTo','Q9o','JTo','J9o','T9o'])
};
function rangeKeyFor(position) {
    if (!position) return 'CO';
    if (PREFLOP_OPEN_RANGE[position]) return position;
    if (position.startsWith('UTG')) return 'UTG';
    if (position === 'LJ') return 'HJ';
    return 'CO';
}
function isInOpenRange(code, position) {
    const set = PREFLOP_OPEN_RANGE[rangeKeyFor(position)];
    return set ? set.has(code) : false;
}
// 레이즈 직면 시 "콜로 디펜스"할 최소 점수 임계값.
//   GTO 원칙: ① 인원이 적을수록(헤즈업·3way) 더 넓게 방어(MDF↑) — 폴드 과다 시 착취당함
//             ② 단일 오픈보다 리레이즈(3벳+)엔 더 타이트하게 방어
//   numActive: 이 핸드에 아직 살아있는(폴드 안 한) 플레이어 수. threeBetPlus: 이미 리레이즈가 나온 상황.
//   기본값(미지정)은 6맥스·단일레이즈 = 66 으로 기존 동작 보존.
function defenseThreshold(numActive, threeBetPlus) {
    let adj;
    if (numActive <= 2) adj = -14;        // 헤즈업: 아주 넓게 디펜스
    else if (numActive === 3) adj = -8;   // 3way
    else if (numActive === 4) adj = -3;   // 4way
    else adj = 0;                          // 5인+: 기존(타이트)
    let th = 66 + adj + (threeBetPlus ? 6 : 0); // 리레이즈엔 +6(더 타이트)
    return Math.max(48, Math.min(74, th));
}

// 🎓 학습용 방어 기준 (선택 입력) — 누가 열었나 / 내가 마지막으로 행동하나(BB) / 헤즈업인가.
//   기본 기준(defenseThreshold)은 "아직 살아 있는 인원"만 봐서, 버튼 스틸을 받는 BB와 UTG 오픈을 받는 BB를 구분하지 못한다.
//   실제로는: 앞자리 오픈은 좁고 강하다 → 타이트하게 / 버튼·SB 스틸은 넓다 → 넓게 /
//             BB는 이미 1bb를 냈고 뒤에 아무도 없다 → 훨씬 넓게 / 헤즈업 BB는 절반 넘게 지킨다.
//   값은 "계속하는 패의 비율"이 통상 범위에 오도록 맞췄다(점수 기준 근사):
//     BB vs UTG ≈ 23% · vs HJ ≈ 25% · vs CO ≈ 31% · vs BTN ≈ 36% · vs SB ≈ 39% · 헤즈업 BB ≈ 63%
//     그 외 자리(콜드콜) vs UTG ≈ 8% · vs HJ ≈ 11% · vs CO ≈ 16% · vs BTN ≈ 18%
//   ⚠️ 봇은 이 입력을 주지 않는다(예전 기준 그대로) — 학습모드 조언과 문제 학습에서만 쓴다.
const DEF_IP = { 'UTG': 68, 'UTG+1': 68, 'UTG+2': 67, 'LJ': 66, 'HJ': 66, 'CO': 61, 'BTN': 59, 'SB': 58 };
// 🔎 [외부 자료 대조 — 2026-10-06] 공개된 솔버 기준(6인 100bb, 2.5bb 오픈)과 견줘 보니 BB 방어가 크게 좁았다.
//    솔버: BB vs UTG 25~30%(3벳 4~6) · HJ 32~38%(6~8) · CO 40~48%(8~10) · BTN 52~58%(11~13) · SB 55~62%(13~16)
//    예전: 23% · 25% · 32% · 37% · 39%, 3벳은 자리와 무관하게 3%
//    → 방어 폭과 3벳 폭을 그 범위에 들도록 다시 맞췄다: 26% · 33% · 44% · 54% · 59% / 3벳 5.6% · 6.9% · 7.8% · 11.9% · 15.7%
const DEF_BB = { 'UTG': 52, 'UTG+1': 52, 'UTG+2': 51, 'LJ': 50, 'HJ': 48, 'CO': 44, 'BTN': 40, 'SB': 38 };
const TB_BB = { 'UTG': 74, 'UTG+1': 74, 'UTG+2': 73, 'LJ': 72, 'HJ': 70, 'CO': 68, 'BTN': 64, 'SB': 62 };
// 그 외 자리(콜드콜 자리)의 3벳 문턱 — 상대 범위가 넓을수록 조금 넓게
const TB_IP = { 'UTG': 78, 'UTG+1': 78, 'UTG+2': 78, 'LJ': 76, 'HJ': 76, 'CO': 72, 'BTN': 70, 'SB': 70 };
// SB 가 오픈을 받을 때: 솔버는 "3벳 아니면 폴드"(콜은 거의 없음), 버튼 오픈 상대 약 18~22%
const DEF_SB = { 'UTG': 68, 'UTG+1': 68, 'UTG+2': 68, 'LJ': 66, 'HJ': 66, 'CO': 62, 'BTN': 58 };
const HU_DEFEND_SCORE = 40;
// 💲 [가격에 따른 방어 폭] 방어 기준표는 "2.5bb 오픈"을 받는 값이다. 오픈이 작으면(2bb) 콜 값이 싸서 더 넓게, 크면(3bb+) 더 좁게 지켜야 한다.
//    예전엔 크기와 무관하게 같은 기준을 써서, 헤즈업에서 최소 레이즈(2bb)를 넓게 받은 정상적인 콜이 "접어야 할 패로 콜"로 채점됐다.
//    기준 가격(필요 승률): 헤즈업 30% · 6인 BB 27% · 콜드콜 자리 38%. 거기서 벗어난 만큼 문턱(핸드 점수)을 옮긴다.
//    BB 앤티가 있으면 팟이 커져 필요 승률이 내려가므로 같은 식으로 조금 넓어진다.
function priceAdj(ctx, kind) {
    if (!ctx || !(ctx.potOdds > 0) || ctx.threeBetPlus) return 0;
    const base = kind === 'hu' ? 0.30 : kind === 'bb' ? 0.27 : 0.38;
    const d = (ctx.potOdds - base) * 100;
    const adj = d < 0 ? d * (kind === 'hu' ? 1.5 : kind === 'bb' ? 0.7 : 0) : d * 1.8;
    return Math.round(Math.max(-9, Math.min(14, adj)));
}
function studyDefense(ctx, heroPos) {
    if (!ctx) return null;
    if (ctx.headsUp) return { callTh: HU_DEFEND_SCORE + (ctx.threeBetPlus ? 12 : 0) + priceAdj(ctx, 'hu'), flat: true };
    const op = ctx.openerPos || '';
    if (!ctx.closing && heroPos === 'SB' && Object.prototype.hasOwnProperty.call(DEF_SB, op)) {
        return { callTh: DEF_SB[op] + (ctx.threeBetPlus ? 6 : 0), raiseTh: DEF_SB[op], flat: false, allRaise: !ctx.threeBetPlus };
    }
    const table = ctx.closing ? DEF_BB : DEF_IP;
    if (!Object.prototype.hasOwnProperty.call(table, op)) return null;
    return { callTh: table[op] + (ctx.threeBetPlus ? 6 : 0) + priceAdj(ctx, ctx.closing ? 'bb' : 'ip'), raiseTh: (ctx.closing ? TB_BB : TB_IP)[op], flat: false };
}

// 📊 [범위표] 레이즈를 받았을 때 패마다 3벳·콜·폴드 빈도 (lib/ranges.js). ctx.chart 를 준 곳(학습 조언·문제·채점)에서만 쓴다 — 봇은 예전 기준 그대로.
//   범위표는 2.5bb 오픈 기준이다. 가격이 다르면(작은 오픈·큰 오픈·앤티) 예전 점수 기준으로 "폭이 몇 % 달라지는가"를 재서,
//   그만큼 콜 범위의 아래쪽을 덜어 내거나(비쌀 때) 접던 패 중 좋은 것부터 콜에 넣는다(쌀 때). 3벳 범위는 그대로 둔다.
const _combos = c => c.length === 2 ? 6 : (c[2] === 's' ? 4 : 12);
const _adjCache = {};
function chartFreq(code, position, ctx) {
    const raises = ctx.raises || (ctx.threeBetPlus ? 2 : 1);
    const lc = { heroPos: position, openerPos: ctx.openerPos, raises, iRaised: !!ctx.iRaised, headsUp: !!ctx.headsUp, inPosition: !!ctx.inPosition };
    const f = Ranges.lookup(lc, code);
    if (!f) return null;
    if (raises !== 1) return f;
    const kind = ctx.headsUp ? 'hu' : ctx.closing ? 'bb' : 'ip';
    const pa = priceAdj(ctx, kind);
    if (!pa) return f;
    const key = [Ranges.posKey(position), Ranges.posKey(ctx.openerPos || ''), lc.headsUp ? 1 : 0, ctx.closing ? 1 : 0, pa].join('|');
    let over = _adjCache[key];
    if (!over) {
        over = _adjCache[key] = {};
        const legacy = c => { const o = Object.assign({}, ctx, { chart: false }); return o; };
        const widthOf = c2 => { let n = 0; Ranges.ALL.forEach(c => { if (preflopRangeTier(c, position, true, c2).tier !== 'fold') n += _combos(c); }); return n; };
        const delta = widthOf(legacy()) - widthOf(Object.assign(legacy(), { potOdds: 0 }));       // 가격 때문에 달라지는 폭(콤보 수)
        const rows = Ranges.ALL.map(c => ({ c, f: Ranges.lookup(lc, c), s: handRangeScore(c) + (c[2] === 's' ? 6 : 0) }));   // 수딧은 같은 점수의 오프수트보다 나중에 버린다
        if (delta < 0) {
            let left = -delta;
            rows.filter(r => r.f.call > 0).sort((a, b) => a.s - b.s).forEach(r => {
                if (left <= 0) return;
                const have = r.f.call / 100 * _combos(r.c), cut = Math.min(have, left);
                over[r.c] = Math.round((have - cut) / _combos(r.c) * 100); left -= cut;
            });
        } else if (delta > 0) {
            let left = delta;
            rows.filter(r => r.f.fold > 0).sort((a, b) => b.s - a.s).forEach(r => {
                if (left <= 0) return;
                const room = r.f.fold / 100 * _combos(r.c), add = Math.min(room, left);
                over[r.c] = Math.round(r.f.call + add / _combos(r.c) * 100); left -= add;
            });
        }
    }
    if (over[code] == null) return f;
    const call = Math.max(0, Math.min(100 - f.raise, over[code]));
    return { raise: f.raise, call, fold: 100 - f.raise - call, name: f.name, priced: true };
}

// 차트 기반 분류 — 오픈 레인지에 있으면 raise, 약간 밑이면 call, 아니면 fold
//   ctx(선택): { numActive, threeBetPlus } — 레이즈 직면 시 디펜스 폭 조정용
function preflopRangeTier(code, position, facingRaise, ctx) {
    ctx = ctx || {};
    const score = handRangeScore(code);
    const inRange = isInOpenRange(code, position);
    // AK/AA/KK/QQ는 항상 3벳급 프리미엄 (점수와 무관하게 명시)
    const isPremium3bet = (code === 'AKs' || code === 'AKo' || code === 'AA' || code === 'KK' || code === 'QQ' || code === 'JJ');
    if (facingRaise && ctx.chart) {
        const f = chartFreq(code, position, ctx);
        if (f) {
            const cont = f.raise + f.call;
            const tier = (f.raise >= f.call && f.raise >= f.fold) ? 'raise' : (f.call >= f.fold ? 'call' : 'fold');
            const raises = ctx.raises || (ctx.threeBetPlus ? 2 : 1);
            const rName = raises >= 3 ? '5벳 올인' : raises === 2 ? '4벳' : '3벳';
            // gap: 범위 안쪽이면 +, 바깥이면 − (가운데에서 멀수록 큼) — 기대값 어림의 부호를 범위표에 맞추는 데 쓴다
            const gap = tier === 'fold' ? -(1 + Math.round((f.fold - 50) / 5)) : (1 + Math.round((cont - 50) / 5));
            return { tier, label: tier === 'raise' ? rName : tier === 'call' ? '콜' : '폴드', score, gap, freq: { raise: f.raise, call: f.call, fold: f.fold }, chartName: f.name, priced: !!f.priced, raiseName: rName };
        }
    }
    if (facingRaise) {
        if (isPremium3bet) return { tier: 'raise', label: '3벳/밸류', score };
        const numActive = ctx.numActive || 6;
        const threeBetPlus = !!ctx.threeBetPlus;
        const study = studyDefense(ctx, position);
        const callTh = study ? study.callTh : defenseThreshold(numActive, threeBetPlus);
        if (study && study.flat) {
            // 헤즈업: 차트 안팎을 가리지 않고 점수로만 (버튼이 워낙 넓게 열어서 거의 모든 그럴듯한 패로 지킨다)
            if (score >= (threeBetPlus ? 90 : 80)) return { tier: 'raise', label: '3벳/밸류', score };   // 헤즈업은 3벳도 조금 넓게
            return score >= callTh ? { tier: 'call', label: '콜', score, gap: score - callTh } : { tier: 'fold', label: '폴드', score, gap: score - callTh };
        }
        // 3벳 문턱: 학습 기준이 있으면 "누가 열었나"에 따라(넓은 오픈일수록 넓게), 없으면(봇) 예전 값. 추가 3벳/4벳은 프리미엄 위주
        const raiseTh = threeBetPlus ? 90 : ((study && study.raiseTh) || 85);
        // SB: 콜하면 포지션 없이 BB 의 스퀴즈까지 받는다 — 계속할 패는 전부 3벳
        if (study && study.allRaise) return score >= callTh + (inRange ? 0 : 4) ? { tier: 'raise', label: '3벳 (SB는 3벳 아니면 폴드)', score } : { tier: 'fold', label: '폴드', score };
        if (inRange) {
            // 차트 내 핸드라도 레이즈 직면 시엔 "디펜스 콜" — 인원·리레이즈 깊이로 임계 조정
            if (score >= raiseTh) return { tier: 'raise', label: '3벳/밸류', score };
            if (score >= callTh) return { tier: 'call', label: '콜', score, gap: score - callTh };  // 콜 디펜스
            return { tier: 'fold', label: '폴드', score, gap: score - callTh };  // 디펜스엔 약함
        }
        // 차트 밖 — 디펜스 임계보다 살짝 높아야 콜(차트 밖이라 약간 보수적)
        if (score >= callTh + 4) return { tier: 'call', label: '콜', score, gap: score - callTh - 4 };
        return { tier: 'fold', label: '폴드', score, gap: score - callTh - 4 };
    }
    if (inRange) return { tier: 'raise', label: '오픈 레이즈', score };
    const th = openThreshold(position);
    if (score >= th - 6) return { tier: 'call', label: '마지널', score };
    return { tier: 'fold', label: '폴드', score };
}

module.exports = {
    chartFreq, studyDefense, defenseThreshold, HU_DEFEND_SCORE,
    handToCode, handRangeScore, openThreshold, preflopRangeTier,
    isInOpenRange, rangeKeyFor, POSITION_OPEN_THRESHOLD, PREFLOP_OPEN_RANGE
};
