'use strict';
// ════════════════════════════════════════════════════════════════
//  pots.js — 팟/사이드팟 분배의 순수 함수 모음 (서버 GameRoom과 테스트가 공유)
//  여기엔 상태(this)·소켓·pokersolver 의존성이 없다. 입력→출력만 있는 순수 로직이라
//  단위 테스트로 "칩이 생성/소멸되지 않는지(보존)"를 결정적으로 검증할 수 있다.
// ════════════════════════════════════════════════════════════════

// 사이드팟 계산: 각 기여자의 총 투자액(totalInvested)으로 레이어드 사이드팟을 만든다.
//   contributions: [{ nick, invested }]  (invested > 0 만 유효)
//   반환: [{ amount, eligible: [nick,...] }]  — index 0 = 가장 낮은 레벨(메인팟)
function calculateSidePots(contributions) {
    const list = (contributions || [])
        .filter(c => c && c.invested > 0)
        .map(c => ({ nick: c.nick, invested: c.invested }))
        .sort((a, b) => a.invested - b.invested);

    const sidePots = [];
    let processed = 0;
    let remaining = list.slice();

    while (remaining.length > 0) {
        const level = remaining[0].invested;
        const potSlice = (level - processed) * remaining.length;
        if (potSlice > 0) {
            sidePots.push({ amount: potSlice, eligible: remaining.map(c => c.nick) });
        }
        processed = level;
        remaining = remaining.filter(c => c.invested > level);
    }

    // 🔐 [무결성] 사이드팟 합계는 반드시 총 투자액과 같아야 한다.
    //    부동소수/예외 입력으로 어긋나면 메인팟(0번)에 보정해 칩 누수를 막는다.
    const totalInvested = list.reduce((s, c) => s + c.invested, 0);
    const sidePotSum = sidePots.reduce((s, sp) => s + sp.amount, 0);
    if (sidePotSum !== totalInvested) {
        const diff = totalInvested - sidePotSum;
        if (sidePots.length > 0) sidePots[0].amount += diff;
        else sidePots.push({ amount: totalInvested, eligible: list.map(c => c.nick) });
    }
    return sidePots;
}

// 폴드한 플레이어만 적격이던 상위 사이드팟을 바로 아래 팟으로 굴려 내린다(칩 누수 방지).
//   sidePots: calculateSidePots 결과 (in-place 수정)
//   isFolded: (nick) => boolean
function rollDownFoldedPots(sidePots, isFolded) {
    for (let i = sidePots.length - 1; i >= 0; i--) {
        const eligibleActive = sidePots[i].eligible.filter(n => !isFolded(n));
        if (eligibleActive.length === 0 && i > 0) {
            sidePots[i - 1].amount += sidePots[i].amount;
            sidePots[i].amount = 0;
        }
    }
    return sidePots;
}

// 한 팟을 승자 수로 나눈다. 나누어떨어지지 않는 홀수 칩(나머지)은 첫 승자에게.
//   반환: { perWinner, remainder }  (remainder는 winners[0]이 추가로 가져감)
function splitAmount(amount, winnerCount) {
    if (winnerCount <= 0) return { perWinner: 0, remainder: amount };
    const perWinner = Math.floor(amount / winnerCount);
    const remainder = amount - perWinner * winnerCount;
    return { perWinner, remainder };
}

// 전체 팟 분배를 한 번에 계산하는 순수 함수 (테스트·검증용 — 칩 보존 보장 확인).
//   contributions: [{ nick, invested }]
//   isFolded(nick) => bool : 쇼다운 시점에 폴드했는지
//   pickWinners(eligibleNicks) => [nick,...] : 해당 팟에서 이긴(동점이면 여러) 닉 배열
//   반환: { wonByNick: {nick: amount}, pots: [{amount, eligible, winners, perWinner, remainder}] }
function distributePots(contributions, isFolded, pickWinners) {
    const sidePots = calculateSidePots(contributions);
    rollDownFoldedPots(sidePots, isFolded);

    const wonByNick = {};
    const pots = [];
    sidePots.forEach((sp, idx) => {
        if (sp.amount <= 0) return;
        const eligibleActive = sp.eligible.filter(n => !isFolded(n));
        if (eligibleActive.length === 0) return;
        const winners = pickWinners(eligibleActive) || [];
        if (winners.length === 0) return;
        const { perWinner, remainder } = splitAmount(sp.amount, winners.length);
        winners.forEach((w, i) => {
            const add = perWinner + (i === 0 ? remainder : 0);
            wonByNick[w] = (wonByNick[w] || 0) + add;
        });
        pots.push({ idx, amount: sp.amount, eligible: sp.eligible.slice(), winners: winners.slice(), perWinner, remainder });
    });
    return { wonByNick, pots };
}

module.exports = { calculateSidePots, rollDownFoldedPots, splitAmount, distributePots };
