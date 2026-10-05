'use strict';
// ═══════════════════════════════════════════════════════════
//  gtoquiz.js — 🧠 GTO 문제 학습
//
//  "이 상황에선 어떻게 치는 게 맞나"를 상황별 문제로 묻는다.
//   · 숏스택 푸시/폴드, 올인 받기, 리쉬브  — lib/shortstack.js 의 기준표(내시 푸시/폴드 차트 근사)에서 만든다
//   · 포지션별 오픈, 헤즈업                — lib/preflop.js 의 6맥스 오픈 차트·디펜스 기준에서 만든다
//   · 팟오즈·아웃츠                        — 공식 그대로 계산한다
//   · 멀티웨이, 스택 깊이(SPR)             — 널리 합의된 원칙을 손으로 쓴 문제
//
//  ⚠️ 기준표는 솔버 해답 그 자체가 아니라 근사다. 그래서 표로 만드는 문제는 **경계에서 먼 패만** 낸다
//     (경계 근처는 차트마다 답이 갈린다). 봇이 실제로 쓰는 표와 같은 표라, 문제의 정답과 게임 속 조언이 어긋나지 않는다.
// ═══════════════════════════════════════════════════════════

const SS = require('./shortstack');
const PF = require('./preflop');

const ORDER = '23456789TJQKA';
const SUITS = ['s', 'h', 'd', 'c'];
const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };

const CATS = {
    push:      { icon: '🚀', name: '숏스택 푸시/폴드', desc: '12bb 이하 — 올인 아니면 폴드' },
    callshove: { icon: '🛡️', name: '올인 받기',        desc: '상대 올인을 콜할지, 접을지' },
    reshove:   { icon: '↩️', name: '리쉬브 (13~20bb)', desc: '오픈에 올인으로 되받아치기' },
    open:      { icon: '📍', name: '포지션별 오픈',    desc: '같은 패도 자리에 따라 다르다' },
    headsup:   { icon: '⚔️', name: '헤즈업',           desc: '둘이서 칠 때는 훨씬 넓게' },
    multiway:  { icon: '👥', name: '멀티웨이',         desc: '3명 이상 팟의 벳·블러프' },
    odds:      { icon: '🧮', name: '팟오즈 · 아웃츠',  desc: '콜에 필요한 승률 계산' },
    depth:     { icon: '📏', name: '스택 깊이 · SPR',  desc: '칩이 얕을 때와 깊을 때' }
};
const CAT_IDS = Object.keys(CATS);

// 169개 핸드 코드
const ALL_CODES = (() => {
    const out = [];
    for (let i = 12; i >= 0; i--) for (let j = i; j >= 0; j--) {
        if (i === j) out.push(ORDER[i] + ORDER[j]);
        else { out.push(ORDER[i] + ORDER[j] + 's'); out.push(ORDER[i] + ORDER[j] + 'o'); }
    }
    return out;
})();

// 헤즈업 버튼(SB)이 여는 기준 점수 — 이 점수 초과면 전체 패의 약 76% (학습모드 조언도 같은 값을 쓴다)
const HU_OPEN_SCORE = 35;

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const pct = x => Math.round(x * 100);
function shuffle(arr, rng) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// 코드('A7o') → 실제 카드 두 장 (['Ah','7c'])
function realize(code, rng) {
    const s1 = pick(SUITS, rng);
    if (code.length === 2) { const s2 = pick(SUITS.filter(s => s !== s1), rng); return [code[0] + s1, code[1] + s2]; }
    if (code[2] === 's') return [code[0] + s1, code[1] + s1];
    return [code[0] + s1, code[1] + pick(SUITS.filter(s => s !== s1), rng)];
}
function codeKo(code) {
    if (code.length === 2) return code + ' (포켓 페어)';
    return code.slice(0, 2) + (code[2] === 's' ? ' 수딧' : ' 오프수트');
}
// 뒤에 남은 사람 수 → 6맥스 자리 이름
const POS_BY_BEHIND = { 1: 'SB', 2: 'BTN', 3: 'CO', 4: 'HJ', 5: 'UTG' };

// 조건에 맞는 핸드를 고른다 (없으면 null)
function pickCode(rng, test) {
    const pool = ALL_CODES.filter(test);
    return pool.length ? pick(pool, rng) : null;
}

// ── 1. 숏스택 푸시/폴드 ─────────────────────────────────────
function genPush(rng) {
    for (let t = 0; t < 40; t++) {
        const stack = 5 + Math.floor(rng() * 8);          // 5~12bb
        const behind = 1 + Math.floor(rng() * 5);         // 1~5명
        const range = SS.pushPct(stack, behind);
        const wantPush = rng() < 0.5;
        // 경계에서 먼 패만(그렇다고 뻔한 72o 만 나오지도 않게): 푸시는 범위의 30~70% 안쪽, 폴드는 범위의 1.4~2배 바깥
        const code = wantPush
            ? pickCode(rng, c => { const p = SS.handPercentile(c); return p >= range * 0.30 && p <= range * 0.70; })
            : pickCode(rng, c => { const p = SS.handPercentile(c); return p >= range * 1.4 && p <= Math.min(0.97, range * 2.0); });
        if (!code) continue;
        const pos = POS_BY_BEHIND[behind];
        const other = stack <= 8 ? 12 : 6;
        return {
            cat: 'push', hand: realize(code, rng),
            tags: [`스택 ${stack}bb`, `내 자리 ${pos}`, `뒤에 ${behind}명`, '앞은 전부 폴드'],
            prompt: `토너먼트. 스택이 ${stack}bb 남았고, 내 앞은 전부 접었습니데이. ${pos}에서 ${codeKo(code)} — 어떻게 칩니꺼?`,
            choices: [{ id: 'push', label: '올인' }, { id: 'open', label: '2.2bb 오픈' }, { id: 'fold', label: '폴드' }],
            answer: wantPush ? 'push' : 'fold',
            explain: `${stack}bb에서는 2.2bb로 열고 3벳에 접을 칩이 없습니데이(오픈 한 번에 스택의 ${pct(2.2 / stack)}%). 그래서 "올인 아니면 폴드"가 기준입니데이. ` +
                `${stack}bb · 뒤에 ${behind}명이면 푸시 범위는 상위 약 ${pct(range)}%이고, ${code}는 상위 ${pct(SS.handPercentile(code))}%라 ${wantPush ? '범위 안 — 올인' : '범위 밖 — 폴드'}입니데이. ` +
                `같은 자리라도 ${other}bb였다면 범위는 상위 약 ${pct(SS.pushPct(other, behind))}%로 ${other < stack ? '넓어집니데이(짧을수록 넓게)' : '좁아집니데이(길수록 좁게)'}.`,
            ref: '기준: 푸시/폴드 표(내시 차트 6인 근사) — 스택이 짧을수록, 뒤에 남은 사람이 적을수록 넓게'
        };
    }
    return null;
}

// ── 2. 올인 받기 ─────────────────────────────────────────────
function genCallShove(rng) {
    for (let t = 0; t < 80; t++) {
        const stack = 6 + Math.floor(rng() * 10);         // 올인한 사람 6~15bb
        const behind = 2 + Math.floor(rng() * 4);         // 그 사람 뒤에 2~5명 (BTN~UTG)
        const x = SS.shoverPct(stack, behind, 1);
        const pot = stack + 1.5, toCall = stack - 1;      // 나는 BB(이미 1bb), SB는 접음
        const odds = toCall / (pot + toCall);
        const wantCall = rng() < 0.5;
        const code = pickCode(rng, c => {
            const d = SS.equityVs(c, x) - odds;
            // 폴드 문제는 "받고 싶어지는" 패에서만 낸다 (T2s 같은 뻔한 폴드는 배울 게 없다)
            return wantCall ? (d >= 0.05 && d <= 0.16) : (d <= -0.05 && d >= -0.16 && SS.handPercentile(c) <= 0.5);
        });
        if (!code) continue;
        const eq = SS.equityVs(code, x), pos = POS_BY_BEHIND[behind];
        return {
            cat: 'callshove', hand: realize(code, rng),
            tags: ['내 자리 BB', `${pos} ${stack}bb 올인`, '나머지 폴드', `콜 ${toCall}bb · 팟 ${pot.toFixed(1)}bb`],
            prompt: `${pos} 자리에서 ${stack}bb 올인이 나왔고 나머지는 접었습니데이. BB에서 ${codeKo(code)} — 콜합니꺼?`,
            choices: [{ id: 'call', label: '콜' }, { id: 'fold', label: '폴드' }],
            answer: wantCall ? 'call' : 'fold',
            explain: `올인을 받을 때는 "아무 패 상대 승률"이 아니라 "올인하는 사람의 범위 상대 승률"로 봅니데이. ${stack}bb로 ${pos}에서 미는 범위는 상위 약 ${pct(x)}%. ` +
                `그 범위 상대로 ${code}의 승률은 약 ${pct(eq)}%이고, 콜에 필요한 승률(팟오즈)은 ${toCall} ÷ (${pot.toFixed(1)} + ${toCall}) = ${pct(odds)}%입니데이. ` +
                `${wantCall ? '필요 승률을 넘으니 콜' : '필요 승률에 못 미치니 폴드'}. 상대 스택이 짧을수록·자리가 늦을수록 범위가 넓어져 더 넓게 받을 수 있습니데이.`,
            ref: '기준: 올인 범위 추정 + 범위 상대 승률표(몬테카를로) vs 팟오즈'
        };
    }
    return null;
}

// ── 3. 리쉬브 ───────────────────────────────────────────────
function genReshove(rng) {
    for (let t = 0; t < 40; t++) {
        const opener = pick(['UTG', 'HJ', 'CO', 'BTN'], rng);
        const stack = 13 + Math.floor(rng() * 8);         // 13~20bb
        const r = SS.reshovePct(SS.openPct(opener), stack);
        const wantShove = rng() < 0.5;
        const code = wantShove
            ? pickCode(rng, c => { const p = SS.handPercentile(c); return p >= r * 0.25 && p <= r * 0.7; })
            : pickCode(rng, c => { const p = SS.handPercentile(c); return p >= Math.max(r * 2.2, 0.30) && p <= 0.75; });
        if (!code) continue;
        const wide = SS.reshovePct(SS.openPct('BTN'), stack), tight = SS.reshovePct(SS.openPct('UTG'), stack);
        return {
            cat: 'reshove', hand: realize(code, rng),
            tags: [`스택 ${stack}bb`, '내 자리 SB', `${opener} 2.2bb 오픈`, '사이는 전부 폴드'],
            prompt: `${opener} 자리에서 2.2bb 오픈이 나왔고 나는 SB, 스택 ${stack}bb입니데이. ${codeKo(code)} — 어떻게 칩니꺼?`,
            choices: [{ id: 'push', label: '올인 (리쉬브)' }, { id: 'call', label: '콜' }, { id: 'fold', label: '폴드' }],
            answer: wantShove ? 'push' : 'fold',
            explain: `${stack}bb에서 SB 콜은 포지션도 불리하고 플랍 뒤에 남는 칩도 애매합니데이 — "올인 아니면 폴드"가 기준입니데이. ` +
                `리쉬브 범위는 상대 오픈이 넓을수록 넓어집니데이: ${opener} 오픈(상위 약 ${pct(SS.openPct(opener))}%) 상대로 ${stack}bb면 상위 약 ${pct(r)}%. ${code}는 상위 ${pct(SS.handPercentile(code))}%라 ${wantShove ? '올인' : '폴드'}입니데이. ` +
                `같은 스택이라도 BTN 오픈 상대면 약 ${pct(wide)}%, UTG 오픈 상대면 약 ${pct(tight)}%로 달라집니데이.`,
            ref: '기준: 리쉬브 표 — 상대 오픈 범위 × 스택 깊이'
        };
    }
    return null;
}

// ── 4. 포지션별 오픈 (6맥스, 100bb) ─────────────────────────
const OPEN_POS = ['UTG', 'HJ', 'CO', 'BTN', 'SB'];
function genOpen(rng) {
    for (let t = 0; t < 60; t++) {
        // 자리에 따라 답이 갈리는 패를 주로 낸다 (BTN에선 열지만 UTG에선 못 여는 패)
        const split = rng() < 0.75;
        const code = split
            ? pickCode(rng, c => PF.isInOpenRange(c, 'BTN') && !PF.isInOpenRange(c, 'UTG'))
            : pick(ALL_CODES, rng);
        const pos = pick(OPEN_POS, rng);
        const tier = PF.preflopRangeTier(code, pos, false).tier;
        if (tier === 'call') continue;                    // 마지널(차트 경계)은 내지 않는다
        const row = OPEN_POS.map(p => `${p} ${PF.isInOpenRange(code, p) ? '⭕' : '✖'}`).join(' · ');
        return {
            cat: 'open', hand: realize(code, rng),
            tags: ['6인 테이블', '스택 100bb', `내 자리 ${pos}`, '앞은 전부 폴드'],
            prompt: `6인 테이블, 스택 100bb. 앞은 전부 접었고 나는 ${pos}입니데이. ${codeKo(code)} — 엽니꺼?`,
            choices: [{ id: 'raise', label: '오픈 레이즈' }, { id: 'limp', label: '림프 (콜만)' }, { id: 'fold', label: '폴드' }],
            answer: tier === 'raise' ? 'raise' : 'fold',
            explain: `뒤에 남은 사람이 많을수록 누군가 더 좋은 패를 들고 있을 확률이 커서, 앞자리일수록 좁게 엽니데이. ${code}의 자리별 오픈: ${row}. ` +
                `${pos}에서는 ${tier === 'raise' ? '오픈 범위 안이라 레이즈' : '오픈 범위 밖이라 폴드'}입니데이. 림프는 블라인드를 훔칠 기회도, 주도권도 버리는 선택이라 기준 전략에는 거의 없습니데이.`,
            ref: '기준: 6맥스 RFI(먼저 여는) 오픈 차트 — 솔버 근사'
        };
    }
    return null;
}

// ── 5. 헤즈업 ───────────────────────────────────────────────
function genHeadsUp(rng) {
    for (let t = 0; t < 80; t++) {
        if (rng() < 0.5) {
            // (가) 버튼(=SB) 오픈: 6인 UTG에선 못 여는 패를 헤즈업 버튼에선 연다
            const code = pick(ALL_CODES, rng), score = PF.handRangeScore(code);
            if (score >= 32 && score <= 39) continue;      // 경계(HU_OPEN_SCORE 근처)는 내지 않는다
            const open = score > HU_OPEN_SCORE;
            if (open && PF.isInOpenRange(code, 'UTG') && rng() < 0.8) continue;   // 어디서나 여는 패는 재미없다
            return {
                cat: 'headsup', hand: realize(code, rng),
                tags: ['헤즈업 (둘만)', '스택 50bb', '내 자리 버튼(SB)', '먼저 행동'],
                prompt: `둘만 남은 헤즈업, 스택 50bb. 나는 버튼(SB)이고 먼저 칩니데이. ${codeKo(code)} — 어떻게 칩니꺼?`,
                choices: [{ id: 'raise', label: '오픈 레이즈' }, { id: 'fold', label: '폴드' }],
                answer: open ? 'raise' : 'fold',
                explain: `헤즈업 버튼은 상대가 한 명뿐이고 플랍 뒤에 계속 포지션을 가집니데이. 그래서 전체 패의 4분의 3 정도를 엽니데이. ` +
                    `${code}는 6인 테이블 UTG에서는 ${PF.isInOpenRange(code, 'UTG') ? '여는' : '못 여는'} 패지만, 헤즈업 버튼에서는 ${open ? '충분히 여는 패' : '그래도 버리는 최하위권 패'}입니데이. ` +
                    `인원이 줄수록 "평균적인 상대 패"가 약해지기 때문에 같은 패의 가치가 올라갑니데이.`,
                ref: '기준: 헤즈업 버튼 오픈은 상위 약 76% (핸드 점수 기준, 경계 근처 패는 출제 제외)'
            };
        }
        // (나) BB 방어: 6인이면 접을 패를 헤즈업에선 지킨다
        const code = pick(ALL_CODES, rng);
        const hu = PF.preflopRangeTier(code, 'BB', true, { numActive: 2 }).tier;
        const six = PF.preflopRangeTier(code, 'BB', true, { numActive: 6 }).tier;
        if (hu === six && rng() < 0.85) continue;          // 답이 갈리는 패 위주
        const score = PF.handRangeScore(code);
        if (Math.abs(score - 52) <= 3 || Math.abs(score - 56) <= 2) continue;   // 디펜스 경계 근처 제외
        const ko = { raise: '3벳', call: '콜', fold: '폴드' };
        return {
            cat: 'headsup', hand: realize(code, rng),
            tags: ['헤즈업 (둘만)', '스택 50bb', '내 자리 BB', '버튼이 2bb 오픈'],
            prompt: `헤즈업, 스택 50bb. 버튼이 2bb로 열었고 나는 BB입니데이. ${codeKo(code)} — 어떻게 칩니꺼?`,
            choices: [{ id: 'raise', label: '3벳' }, { id: 'call', label: '콜' }, { id: 'fold', label: '폴드' }],
            answer: hu,
            explain: `헤즈업 버튼은 아주 넓게 엽니데이. 그런 범위 상대로 BB가 자주 접으면 블라인드를 계속 뺏깁니데이 — 2bb 오픈에 콜은 1bb를 더 내고 4bb 팟을 보는 것이라(필요 승률 25%) 넓게 지켜야 합니데이. ` +
                `${code}: 헤즈업에서는 ${ko[hu]}, 6인 테이블에서 같은 오픈을 받았다면 ${ko[six]}${hu === six ? ' (이 패는 인원과 무관)' : ' — 인원이 줄면 방어 폭이 넓어집니데이'}.`,
            ref: '기준: 디펜스 기준표 — 살아 있는 인원이 적을수록 넓게 방어(MDF)'
        };
    }
    return null;
}

// ── 6. 팟오즈 · 아웃츠 ──────────────────────────────────────
function numericChoices(correct, wrongs, rng) {
    const set = [correct].concat(wrongs.filter(w => w !== correct && w > 0 && w < 100)).slice(0, 4);
    return shuffle([...new Set(set)], rng).map(v => ({ id: String(v), label: v + '%' }));
}
function genOdds(rng) {
    const type = Math.floor(rng() * 5);
    const pot = pick([400, 600, 800, 1000, 1200, 1500, 2000], rng);
    const frac = pick([[1, 3, '1/3'], [1, 2, '절반'], [2, 3, '2/3'], [1, 1, '100%'], [3, 2, '150%']], rng);
    const bet = Math.round(pot * frac[0] / frac[1] / 50) * 50;
    if (type === 0) {
        const need = pct(bet / (pot + 2 * bet));
        return {
            cat: 'odds', tags: [`팟 ${pot.toLocaleString()}`, `상대 벳 ${bet.toLocaleString()} (팟의 ${frac[2]})`],
            prompt: `팟이 ${pot.toLocaleString()}인데 상대가 ${bet.toLocaleString()}을 쳤습니데이. 콜이 본전이 되려면 승률이 최소 얼마여야 합니꺼?`,
            choices: numericChoices(need, [pct(bet / (pot + bet)), pct(bet / pot / 2), need + 12, need - 8, 50], rng),
            answer: String(need),
            explain: `필요 승률 = 콜 금액 ÷ (콜한 뒤의 전체 팟) = ${bet.toLocaleString()} ÷ (${pot.toLocaleString()} + ${bet.toLocaleString()} + ${bet.toLocaleString()}) = ${need}%. 흔한 실수는 내 콜 금액을 분모에 안 넣는 것입니데이. ` +
                `외워둘 값: 1/3팟 벳 → 20%, 절반 → 25%, 2/3 → 29%, 팟 → 33%, 1.5배 → 38%.`,
            ref: '공식: 필요 승률 = 콜 ÷ (팟 + 벳 + 콜)'
        };
    }
    if (type === 1) {
        const mdf = pct(pot / (pot + bet));
        return {
            cat: 'odds', tags: ['헤즈업 리버', `팟 ${pot.toLocaleString()}`, `상대 벳 ${bet.toLocaleString()} (팟의 ${frac[2]})`],
            prompt: `헤즈업 리버, 팟 ${pot.toLocaleString()}에 상대가 ${bet.toLocaleString()}을 쳤습니데이. 상대의 블러프가 공짜로 이득 보지 못하게 하려면 내 범위의 최소 몇 %로 계속(콜·레이즈)해야 합니꺼? (최소 방어 빈도)`,
            choices: numericChoices(mdf, [100 - mdf, pct(bet / (pot + 2 * bet)), mdf + 15, mdf - 15], rng),
            answer: String(mdf),
            explain: `최소 방어 빈도(MDF) = 팟 ÷ (팟 + 벳) = ${pot.toLocaleString()} ÷ ${(pot + bet).toLocaleString()} = ${mdf}%. 이보다 자주 접으면 상대는 아무 패로나 블러프해도 이득입니데이. ` +
                `벳이 클수록 덜 방어해도 됩니데이: 절반 벳 67%, 팟 벳 50%, 2배 벳 33%. (이건 헤즈업 기준 — 여러 명이 받으면 부담을 나눠 가집니데이.)`,
            ref: '공식: MDF = 팟 ÷ (팟 + 벳)'
        };
    }
    if (type === 2) {
        const d = pick([[9, '플러시 드로우', 35, 20], [8, '양방 스트레이트 드로우', 32, 17], [4, '것샷(안쪽) 스트레이트 드로우', 17, 9], [15, '플러시 드로우 + 양방 스트레이트 드로우', 54, 33], [6, '오버카드 두 장(페어 노림)', 24, 13]], rng);
        const flop = rng() < 0.6, ans = flop ? d[2] : d[3];
        return {
            cat: 'odds', tags: [flop ? '플랍 (카드 2장 남음)' : '턴 (카드 1장 남음)', `${d[1]}`, `아웃츠 ${d[0]}장`],
            prompt: `${flop ? '플랍' : '턴'}에서 ${d[1]}(아웃츠 ${d[0]}장)를 들고 있습니데이. ${flop ? '리버까지 다 봤을 때' : '리버 한 장에'} 완성될 확률은 대략 얼마입니꺼?`,
            choices: numericChoices(ans, [flop ? d[3] : d[2], ans + 15, Math.max(3, ans - 12), d[0]], rng),
            answer: String(ans),
            explain: `어림법: 아웃츠 × 4 = 플랍에서 리버까지, 아웃츠 × 2 = 한 장. ${d[0]}장이면 ${flop ? `${d[0]} × 4 ≈ ${d[0] * 4}%` : `${d[0]} × 2 ≈ ${d[0] * 2}%`} (정확히는 약 ${ans}%). ` +
                `주의: "× 4"는 상대가 턴에 또 벳하지 않고 두 장을 다 볼 수 있을 때만 맞습니데이. 턴에 또 벳이 나올 것 같으면 한 장 값(× 2)으로 계산해야 합니데이.`,
            ref: '어림법: 2와 4의 법칙'
        };
    }
    if (type === 3) {
        const need = bet / (pot + 2 * bet);
        const eq = pick([15, 20, 25, 30, 35, 40, 45], rng);
        if (Math.abs(eq / 100 - need) < 0.035) return genOdds(rng);
        const call = eq / 100 > need;
        return {
            cat: 'odds', tags: [`팟 ${pot.toLocaleString()}`, `상대 벳 ${bet.toLocaleString()}`, `내 승률 ${eq}%`, '리버 (더 올 카드 없음)'],
            prompt: `리버. 팟 ${pot.toLocaleString()}에 상대가 ${bet.toLocaleString()}을 쳤고, 내가 이길 확률은 ${eq}%로 봅니데이. 콜합니꺼?`,
            choices: [{ id: 'call', label: '콜' }, { id: 'fold', label: '폴드' }],
            answer: call ? 'call' : 'fold',
            explain: `필요 승률 = ${bet.toLocaleString()} ÷ ${(pot + 2 * bet).toLocaleString()} = ${pct(need)}%. 내 승률 ${eq}%는 ${call ? '그보다 높으니 콜이 이득' : '그보다 낮으니 폴드'}입니데이. ` +
                `절반도 못 이기는 패라도 팟이 주는 값이 좋으면 콜이 맞고, 꽤 이기는 패라도 벳이 크면 접어야 할 때가 있습니데이.`,
            ref: '공식: 승률 > 콜 ÷ (팟 + 벳 + 콜) 이면 콜'
        };
    }
    const be = pct(bet / (pot + bet));
    return {
        cat: 'odds', tags: [`팟 ${pot.toLocaleString()}`, `내 블러프 ${bet.toLocaleString()} (팟의 ${frac[2]})`],
        prompt: `팟 ${pot.toLocaleString()}에 내가 ${bet.toLocaleString()}을 순수 블러프로 칩니데이(콜당하면 무조건 짐). 상대가 최소 몇 % 접어야 본전입니꺼?`,
        choices: numericChoices(be, [100 - be, pct(bet / (pot + 2 * bet)), be + 14, be - 12], rng),
        answer: String(be),
        explain: `블러프 손익분기 = 벳 ÷ (팟 + 벳) = ${bet.toLocaleString()} ÷ ${(pot + bet).toLocaleString()} = ${be}%. 작게 칠수록 덜 접어도 본전입니데이(1/3팟 25%, 절반 33%, 팟 50%). ` +
            `상대가 여러 명이면 "전원이" 접어야 하므로 한 명당 접을 확률을 곱해야 합니데이 — 그래서 멀티웨이 블러프는 훨씬 어렵습니데이.`,
        ref: '공식: 블러프 손익분기 폴드율 = 벳 ÷ (팟 + 벳)'
    };
}

// ── 7·8. 손으로 쓴 원칙 문제 ────────────────────────────────
const AUTHORED = {
    multiway: [
        { hand: ['Kh', 'Qh'], board: ['As', '7d', '2c'], tags: ['4명이 본 플랍', '내가 프리플랍 레이저', '앞 두 명 체크'],
          prompt: 'CO에서 열었는데 BTN·SB·BB가 모두 콜했습니데이(4명). 플랍 A♠7♦2♣, 내 패는 K♥Q♥(아무것도 없음). 앞 두 명이 체크했습니데이.',
          choices: [['bet', '블러프 c-bet'], ['check', '체크']], answer: 'check',
          explain: '헤즈업이라면 에이스 하이 마른 보드는 레이저에게 유리해 작은 c-bet이 잘 통합니데이. 하지만 상대가 3명이면 "전원이" 접어야 합니데이 — 한 명이 60% 접어도 셋 다 접을 확률은 0.6³ ≈ 22%뿐. 멀티웨이에서는 아무것도 없는 블러프 c-bet을 거의 하지 않습니데이.',
          ref: '원칙: 멀티웨이에선 블러프 빈도를 크게 줄인다' },
        { hand: ['Kh', 'Qh'], board: ['As', '7d', '2c'], tags: ['헤즈업 플랍', '내가 프리플랍 레이저', 'BB 체크'],
          prompt: 'CO에서 열었고 BB만 콜했습니데이(헤즈업). 플랍 A♠7♦2♣, 내 패는 K♥Q♥(아무것도 없음). BB가 체크했습니데이.',
          choices: [['bet', '작게 c-bet (팟의 1/3)'], ['check', '체크'], ['big', '크게 c-bet (팟 크기)']], answer: 'bet',
          explain: '에이스 하이 마른 보드는 프리플랍 레이저 범위에 에이스가 훨씬 많아 유리합니데이. 상대는 한 명뿐이고, 1/3팟 벳은 25%만 접혀도 본전이라 범위 전체로 작게 치는 게 기준입니데이. 같은 패·같은 보드라도 상대가 3명이면 체크가 맞습니데이 — 인원이 답을 바꿉니데이.',
          ref: '원칙: 헤즈업 + 레이저에게 유리한 마른 보드 → 작은 c-bet' },
        { hand: ['Kd', '5d'], board: ['Kc', '9c', '4h'], tags: ['4명이 본 플랍', '탑페어 약한 키커', '앞에서 벳 → 레이즈'],
          prompt: '4명이 본 플랍 K♣9♣4♥. 내 패는 K♦5♦(탑페어, 키커 약함). 앞 사람이 벳했고 그다음 사람이 레이즈했습니데이.',
          choices: [['call', '콜'], ['fold', '폴드'], ['raise', '리레이즈']], answer: 'fold',
          explain: '멀티웨이에서 벳에 레이즈까지 나오면 블러프일 확률이 매우 낮습니데이(사람이 많을수록 블러프가 줄어든다는 걸 서로 압니데이). 탑페어 약한 키커는 더 좋은 킹·투페어·셋에게 크게 지고, 이기고 있어도 드로우가 많아 끝까지 가기 어렵습니데이. 헤즈업이었다면 콜할 수 있는 패입니데이.',
          ref: '원칙: 멀티웨이의 벳·레이즈는 헤즈업보다 훨씬 강하다' },
        { hand: ['7s', '7h'], board: ['7d', '8d', '9s'], tags: ['4명이 본 플랍', '셋(트리플)', '젖은 보드'],
          prompt: '4명이 본 플랍 7♦8♦9♠. 내 패는 7♠7♥(셋). 내가 먼저 칩니데이.',
          choices: [['big', '크게 벳 (팟의 2/3 이상)'], ['small', '작게 벳 (팟의 1/4)'], ['check', '체크 (슬로우플레이)']], answer: 'big',
          explain: '강한 패지만 보드가 매우 젖어 있습니데이(플러시·스트레이트 드로우 다수). 상대가 3명이면 누군가는 드로우를 갖고 있습니데이 — 싸게 카드를 보여주면 역전당하고, 지금이 값을 가장 많이 받을 수 있는 때입니데이. 멀티웨이에서는 "밸류는 크게, 블러프는 적게"가 기준입니데이.',
          ref: '원칙: 멀티웨이 + 젖은 보드의 강한 패는 크게 벳' },
        { tags: ['c-bet 폴드 확률', '상대 3명'],
          prompt: '내 c-bet에 상대 한 명이 접을 확률이 55%라고 합시더. 상대가 3명일 때 셋 다 접을 확률은 대략 얼마입니꺼?',
          choices: [['17', '약 17%'], ['55', '약 55%'], ['35', '약 35%'], ['80', '약 80%']], answer: '17',
          explain: '각자 독립적으로 접는다면 0.55 × 0.55 × 0.55 ≈ 17%입니데이. 헤즈업에서 55% 통하던 블러프가 4명 팟에서는 6번에 1번만 통하는 셈입니데이. 그래서 인원이 늘수록 블러프를 줄이고 진짜 패로만 벳합니데이.',
          ref: '계산: 전원 폴드 확률 = 한 명 폴드 확률의 인원 제곱' },
        { hand: ['Ah', '5h'], board: ['Kh', '8h', '2c'], tags: ['3명이 본 플랍', '넛 플러시 드로우', '앞에서 절반 벳 → 콜'],
          prompt: '3명이 본 플랍 K♥8♥2♣. 내 패는 A♥5♥(넛 플러시 드로우). 앞 사람이 팟의 절반을 벳했고 한 명이 콜했습니데이.',
          choices: [['call', '콜'], ['fold', '폴드'], ['raise', '레이즈 (세미블러프)']], answer: 'call',
          explain: '팟 1에 벳 0.5, 콜 0.5가 들어와 있으니 필요 승률은 0.5 ÷ 2.5 = 20%. 넛 플러시 드로우는 리버까지 약 35%라 콜이 충분히 이득입니데이. 레이즈는 헤즈업에서 좋은 선택이지만, 이미 두 명이 돈을 넣은 멀티웨이에서는 둘 다 접게 만들기 어려워 콜로 싸게 보는 쪽이 기준입니데이(완성되면 두 명에게서 값을 받습니데이).',
          ref: '원칙: 멀티웨이의 강한 드로우는 폴드 이퀴티가 낮아 콜 위주' }
    ],
    depth: [
        { hand: ['5s', '5d'], tags: ['유효 스택 20bb', '내 자리 BTN', 'UTG가 2.2bb 오픈'],
          prompt: '유효 스택 20bb. UTG가 2.2bb로 열었고 나는 BTN에서 5♠5♦입니데이. 셋(트리플)을 노리고 콜합니꺼?',
          choices: [['call', '콜 (셋 노림)'], ['nocall', '콜은 아니다 (폴드 또는 올인)']], answer: 'nocall',
          explain: '포켓 페어가 플랍에 셋이 될 확률은 약 12%(8번에 1번)입니데이. 못 맞춘 7번의 손해를 메우려면 맞췄을 때 크게 따야 해서, 콜 금액의 15~20배 스택이 남아 있어야 본전입니데이. 20bb ÷ 2.2bb ≈ 9배라 셋마이닝 콜은 손해입니데이. 이 깊이에서는 접거나, 올인으로 되받아치는 것 중에서 고릅니데이.',
          ref: '원칙: 셋마이닝은 콜 금액의 15~20배 스택이 있을 때만' },
        { hand: ['5s', '5d'], tags: ['유효 스택 100bb', '내 자리 BTN', 'UTG가 2.5bb 오픈'],
          prompt: '유효 스택 100bb. UTG가 2.5bb로 열었고 나는 BTN에서 5♠5♦입니데이.',
          choices: [['call', '콜'], ['fold', '폴드'], ['raise', '3벳']], answer: 'call',
          explain: '100bb ÷ 2.5bb = 40배 — 셋마이닝 조건(15~20배)을 넉넉히 채웁니데이. 포지션도 있어서 셋을 맞추면 큰 팟을 만들기 좋습니데이. 같은 패·같은 자리라도 스택이 20bb였다면 콜이 손해였습니데이 — 스택 깊이가 답을 바꿉니데이.',
          ref: '원칙: 깊은 스택 + 포지션 = 작은 페어 콜' },
        { hand: ['As', 'Kd'], board: ['Kh', '8c', '3d'], tags: ['팟 1,000', '남은 스택 800 (SPR 0.8)', '상대 올인'],
          prompt: '팟 1,000, 내 남은 스택 800(SPR 0.8). 플랍 K♥8♣3♦에서 내 패는 A♠K♦(탑페어 탑키커). 상대가 올인했습니데이.',
          choices: [['call', '콜'], ['fold', '폴드']], answer: 'call',
          explain: '남은 스택이 팟보다 작으면(SPR 1 이하) 탑페어 탑키커는 접을 수 없는 패입니데이. 800을 콜해 2,600 팟을 보는 것이라 필요 승률이 약 31%뿐인데, 탑페어 탑키커는 상대의 올인 범위(약한 킹, 드로우, 블러프 포함) 상대로 그보다 훨씬 자주 이깁니데이.',
          ref: '원칙: SPR이 낮으면 탑페어급으로 커밋' },
        { hand: ['As', 'Kd'], board: ['Kh', '8c', '3d', '6s', '2h'], tags: ['팟 300에서 시작', '남은 스택 6,000 (SPR 20)', '플랍 레이즈 → 턴 큰 벳 → 리버 올인'],
          prompt: '스택이 아주 깊습니데이(SPR 20). A♠K♦로 플랍 K♥8♣3♦에 벳했더니 상대가 레이즈, 턴에 큰 벳, 리버에 올인까지 왔습니데이.',
          choices: [['call', '콜'], ['fold', '폴드']], answer: 'fold',
          explain: '깊은 스택에서 세 번 연속 큰 돈을 넣는 상대의 범위는 투페어·셋 이상에 몰려 있습니데이. 원페어는 "작은 팟을 이기는 패"지 스택 전부를 걸 패가 아닙니데이. 같은 패라도 SPR 0.8에서는 무조건 콜, SPR 20에서는 폴드 — 스택 깊이가 패의 가치를 바꿉니데이.',
          ref: '원칙: 깊은 스택에서 원페어로 큰 팟을 만들지 않는다' },
        { tags: ['스택 15bb', '토너먼트 중반', '오픈 사이즈'],
          prompt: '토너먼트에서 스택이 15bb로 줄었습니데이. 좋은 패로 먼저 열 때 오픈 크기는 어떻게 하는 게 기준입니꺼?',
          choices: [['small', '작게 (2~2.2bb)'], ['big', '크게 (3.5~4bb)'], ['same', '100bb 때와 똑같이 (2.5~3bb)']], answer: 'small',
          explain: '스택이 얕을수록 오픈은 작게 합니데이. 3bb로 열면 스택의 20%가 나가서 3벳에 접기도, 콜하기도 어정쩡해집니데이. 2~2.2bb면 같은 스틸 효과를 내면서 잃는 칩이 적고, 상대의 올인에 접을 여유가 남습니데이. (12bb 아래로 내려가면 아예 올인 아니면 폴드로 바뀝니데이.)',
          ref: '원칙: 스택이 얕을수록 오픈 사이즈를 줄인다' },
        { hand: ['Jh', '8h'], tags: ['내 스택 40bb', '내 자리 BTN', 'SB·BB 스택 10bb'],
          prompt: '나는 BTN에서 40bb, 뒤의 SB와 BB는 둘 다 10bb 숏스택입니데이. 앞은 전부 접었고 내 패는 J♥8♥. 평소라면 스틸 오픈하는 패입니데이.',
          choices: [['fold', '폴드 (또는 올인에 콜할 패로만 오픈)'], ['open', '평소처럼 스틸 오픈하고, 올인이 오면 폴드']], answer: 'fold',
          explain: '뒤에 10bb 숏스택이 있으면 내 오픈에 "올인"으로 답하는 일이 잦습니데이. J8s는 그 올인을 콜하기엔 약해서, 열고 접으면 2.2bb를 그냥 버리게 됩니데이. 숏스택 앞에서는 스틸 범위를 줄이고, 올인을 받아도 콜할 수 있는 패 위주로 엽니데이. 뒤가 전부 100bb였다면 J8s 오픈이 기준입니데이.',
          ref: '원칙: 뒤에 리쉬브 스택이 있으면 스틸 범위를 줄인다' }
    ]
};
function genAuthored(cat, rng) {
    const q = pick(AUTHORED[cat], rng);
    return {
        cat, hand: q.hand || null, board: q.board || null, tags: q.tags.slice(), prompt: q.prompt,
        choices: q.choices.map(c => ({ id: c[0], label: c[1] })), answer: q.answer, explain: q.explain, ref: q.ref
    };
}

const GEN = {
    push: genPush, callshove: genCallShove, reshove: genReshove, open: genOpen, headsup: genHeadsUp, odds: genOdds,
    multiway: rng => genAuthored('multiway', rng), depth: rng => genAuthored('depth', rng)
};

// 문제 하나 만들기. cat 이 없거나 'all' 이면 아무 분야나.
function generate(cat, rng) {
    rng = rng || Math.random;
    const c = (typeof cat === 'string' && Object.prototype.hasOwnProperty.call(GEN, cat)) ? cat : pick(CAT_IDS, rng);
    for (let t = 0; t < 6; t++) {
        const q = GEN[c](rng);
        if (q && q.choices.length >= 2 && q.choices.some(x => x.id === q.answer)) {
            q.catName = CATS[c].name; q.catIcon = CATS[c].icon;
            return q;
        }
    }
    return genOdds(rng);   // 만에 하나 못 만들면 계산 문제로
}

// 화면에 내려보낼 모양 (정답·해설은 뺀다)
function publicView(q) {
    return { cat: q.cat, catName: q.catName, catIcon: q.catIcon, hand: q.hand || null, board: q.board || null, tags: q.tags, prompt: q.prompt, choices: q.choices };
}

// 계정의 문제 기록 — 항상 온전한 모양으로
function statsOf(u) {
    const s = (u && u.quiz && typeof u.quiz === 'object') ? u.quiz : {};
    const n = v => (Number.isInteger(v) && v > 0 ? v : 0);
    const out = { cats: {}, streak: n(s.streak), best: n(s.best), total: 0, ok: 0 };
    CAT_IDS.forEach(id => {
        const c = (s.cats && typeof s.cats === 'object' && s.cats[id]) || {};
        const tot = n(c.n), ok = Math.min(tot, n(c.ok));
        out.cats[id] = { n: tot, ok };
        out.total += tot; out.ok += ok;
    });
    return out;
}
function record(u, cat, correct) {
    const s = statsOf(u);
    if (!Object.prototype.hasOwnProperty.call(s.cats, cat)) return s;
    s.cats[cat].n += 1; if (correct) s.cats[cat].ok += 1;
    s.streak = correct ? s.streak + 1 : 0;
    s.best = Math.max(s.best, s.streak);
    u.quiz = { cats: s.cats, streak: s.streak, best: s.best };
    return statsOf(u);
}
function catList() { return CAT_IDS.map(id => Object.assign({ id }, CATS[id])); }

module.exports = { CATS, CAT_IDS, ALL_CODES, SUIT_SYM, HU_OPEN_SCORE, generate, publicView, statsOf, record, catList, realize };
