// 🎲 플랍 이후 승률(몬테카를로) — 남은 카드를 무작위로 깔고, 상대 패는 그 상대의 범위(최소 강도)에 맞게 뽑아 이긴 비율을 센다.
//    server.js 의 estimateBotEquity 가 쓰고(본 스레드 · 500번), 사람 결정은 lib/eqpool.js 의 따로 도는 스레드가 4000번으로 정밀하게 계산한다.
const Hand = require('pokersolver').Hand;
const HandRead = require('./handread');

const RANKS = '23456789TJQKA', SUITS = 'shdc';
const FULL_DECK = []; for (const s of SUITS) for (const r of RANKS) FULL_DECK.push(r + s);

// 프리플랍 핸드 강도 0~1 (Chen 공식 변형)
function preflopStrength(hand) {
    const v1 = RANKS.indexOf(hand[0][0]), v2 = RANKS.indexOf(hand[1][0]);
    const hi = Math.max(v1, v2), lo = Math.min(v1, v2);
    const suited = hand[0][1] === hand[1][1];
    const pair = v1 === v2;
    const gap = hi - lo;
    let s = 0;
    if (pair) s = 0.5 + hi * 0.035;            // 페어: 22=0.5 ~ AA=0.92
    else {
        s = 0.18 + hi * 0.028 + lo * 0.012;    // 하이카드 가중
        if (suited) s += 0.07;
        if (gap === 1) s += 0.05;              // 커넥터
        else if (gap === 2) s += 0.02;
        else if (gap > 4) s -= 0.05;
    }
    return Math.max(0.05, Math.min(0.95, s));
}

// hand: 내 두 장 · board: 깔린 카드(3~5장) · oppMin: 상대마다 범위의 최소 강도(0 이면 아무 패) · iters: 반복 수
function mcEquity({ hand, board, oppMin, iters }) {
    const opponents = oppMin.length;
    if (!opponents) return 1;
    const known = new Set([...board, ...hand]);
    const pool = FULL_DECK.filter(c => !known.has(c));
    const need = 5 - board.length;
    const MAX_TRIES = 4; // 레인지 표본 재추첨 상한 — 못 찾으면 그냥 수용 (성능·표본 고갈 방지)
    let win = 0;
    for (let it = 0; it < iters; it++) {
        const shuffled = pool.slice();
        for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
        let idx = 0;
        const full = board.concat(shuffled.slice(idx, idx += need));
        // 상대 핸드를 레인지에 맞게 추첨 (거절 샘플링, 시도 횟수 제한)
        const oppHands = [];
        for (let o = 0; o < opponents; o++) {
            const min = oppMin[o];
            let h = null;
            for (let t = 0; t < MAX_TRIES; t++) {
                if (idx + 1 >= shuffled.length) break; // 덱 소진 — 마지막 후보 사용
                const cand = [shuffled[idx++], shuffled[idx++]];
                h = cand;
                if (min <= 0) break; // 안 좁히는 상대 → 첫 추첨 그대로
                if (HandRead.acceptOppHand(preflopStrength(cand), min)) break;
            }
            oppHands.push(h || [shuffled[idx++], shuffled[idx++]]);
        }
        try {
            const mine = Hand.solve(hand.concat(full));
            const all = [mine, ...oppHands.map(oh => Hand.solve(oh.concat(full)))];
            const winners = Hand.winners(all);
            if (winners.includes(mine)) win += 1 / winners.length;
        } catch (e) { win += 0.3; }
    }
    return win / iters;
}

module.exports = { mcEquity, preflopStrength, FULL_DECK };
