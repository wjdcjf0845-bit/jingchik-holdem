'use strict';
// ════════════════════════════════════════════════════════════════
//  showdown.js — 쇼다운 팟 분배 파이프라인 (돈 로직의 심장)
//
//  왜: evaluateWinner()가 사이드팟 보정 → 폴드 롤다운 → (런잇트와이스) 보드별
//  분할 → 족보 평가 → 승자 배분을 전부 서버 클래스 안에서 수행해 단위 테스트가
//  불가능했다. 여기서 버그가 나면 칩이 증발하거나 복제된다 — 포커 게임에서
//  가장 치명적인 종류의 버그인데 회귀 방어막이 없었다.
//
//  이 모듈은 그 파이프라인을 입력→출력 순수 함수로 옮긴 것이다. 서버는 결과를
//  받아 칩 반영·한국어 라벨·메시지 등 표현만 담당한다.
//  ⚠️ 동작 보존이 절대 조건 — 서버의 기존 분기(스킵 조건, 홀수 칩 귀속,
//     마지막 팟 보정)를 한 줄 단위로 그대로 따른다.
//
//  pokersolver(Hand)는 결정적(순수) 평가기라 직접 의존해도 테스트 가능하다.
// ════════════════════════════════════════════════════════════════

const Hand = require('pokersolver').Hand;
const Pots = require('./pots');
const RIT = require('./runittwice');

// 쇼다운 분배 계산.
//   opts:
//     contributions: [{ nick, invested }] — totalInvested > 0 인 참가자
//     totalPot:      서버가 집계한 실제 팟. 사이드팟 합과 다르면(BB 앤티 = 누구의 벳도 아닌 죽은 돈) 그 차액을
//                    "메인팟"에 가산 — 죽은 돈은 판에 남은 모든 사람이 다투는 돈이다
//     boards:        [보드1] 또는 [보드1, 보드2] (런잇트와이스). 각 보드는 카드 5장
//     holeCards:     { nick: [c1, c2] }
//     isFolded:      (nick) => boolean
//   반환:
//     awards:       { nick: 총 획득 칩 }
//     winnersAll:   승자 닉 배열 (중복 없음 — 먹은 사람 전부)
//     results:      [{ potIdx, runIdx, amount, board, winners: [{nick, rankName, won, best5}] }]
//     sidePotCount: 사이드팟 배열 길이 (라벨 "[메인팟]/[사이드팟 n]" 판단용)
function computeShowdown(opts) {
    const o = opts || {};
    const boards = (o.boards && o.boards.length) ? o.boards : [[]];
    const holeCards = o.holeCards || {};
    const isFolded = o.isFolded || (() => false);

    // 1) 사이드팟 계산 + 실팟과의 차액(죽은 돈) 보정
    //    🐛 예전엔 차액을 "마지막(가장 위) 팟"에 얹었다. 올인으로 사이드팟이 생긴 판에서 가장 위 팟은 큰 스택의 "받아 주지 않은 벳"이라,
    //       BB 앤티가 메인팟을 이긴 사람이 아니라 큰 스택에게 돌아갔다(규칙 심판 스크립트로 발견: 앤티 판 768개 중 10건, 정확히 앤티만큼 어긋남).
    // 🐛 접은 사람이 "남아 있는 누구보다도 많이" 낸 부분은 아무도 받아 준 적 없는 돈이다(주로 올인한 짧은 스택보다 큰 블라인드).
    //    예전엔 그 부분이 아래 팟으로 굴러 내려가 쇼다운 승자에게 갔다 → 낸 사람에게 돌려준다.
    const refunds = {};
    const contribs = (o.contributions || []).map(c => ({ nick: c.nick, invested: c.invested }));
    const maxActive = contribs.filter(c => !isFolded(c.nick)).reduce((m, c) => Math.max(m, c.invested), 0);
    if (maxActive > 0) contribs.forEach(c => { if (isFolded(c.nick) && c.invested > maxActive) { refunds[c.nick] = c.invested - maxActive; c.invested = maxActive; } });
    const refundTotal = Object.values(refunds).reduce((a, b) => a + b, 0);
    const sidePots = Pots.calculateSidePots(contribs);
    const sidePotsTotal = sidePots.reduce((s, sp) => s + sp.amount, 0);
    const diff = (o.totalPot != null ? o.totalPot - refundTotal : sidePotsTotal) - sidePotsTotal;
    if (diff > 0) {
        // 죽은 돈(BB 앤티)은 판에 남은 "모든" 사람이 다툰다 — 앤티만 내고 올인해서 건 돈이 0 인 사람도 포함.
        // 그런 사람이 있으면 벳으로 만든 팟에는 이름이 없으므로, 죽은 돈을 따로 맨 아래 팟으로 둔다.
        const everyone = Object.keys(holeCards);
        const inPots = new Set(sidePots.length ? sidePots[0].eligible : []);
        const zeroLive = everyone.filter(n => !inPots.has(n) && !isFolded(n) && Array.isArray(holeCards[n]) && holeCards[n].length === 2);
        if (zeroLive.length || !sidePots.length) sidePots.unshift({ amount: diff, eligible: everyone.filter(n => Array.isArray(holeCards[n]) && holeCards[n].length === 2) });
        else sidePots[0].amount += diff;
    }

    // 2) 폴드 전용 상위 팟 롤다운 (칩 누수 방지)
    Pots.rollDownFoldedPots(sidePots, isFolded);

    // 3) 팟별 × 보드(런)별 평가·배분
    const awards = {};
    Object.keys(refunds).forEach(n => { awards[n] = refunds[n]; });   // 돌려주는 돈도 '받는 칩'에 넣는다(승자 목록에는 넣지 않는다)
    const winnersSet = new Set();
    const results = [];

    sidePots.forEach((sp, potIdx) => {
        if (sp.amount <= 0) return;
        const eligibleActive = sp.eligible.filter(n => !isFolded(n));
        if (eligibleActive.length === 0) return;

        const runAmounts = RIT.splitPotForRuns(sp.amount, boards.length); // 홀수 칩은 앞 런에게

        boards.forEach((board, runIdx) => {
            const runAmount = runAmounts[runIdx];
            if (runAmount <= 0) return;

            const solved = eligibleActive.map(nick => {
                const h = Hand.solve((holeCards[nick] || []).concat(board));
                h.playerId = nick;
                return h;
            });
            const winners = Hand.winners(solved);
            const { perWinner, remainder } = Pots.splitAmount(runAmount, winners.length); // 홀수 칩은 winners[0]에게

            const winnerRows = winners.map((w, i) => {
                const won = perWinner + (i === 0 ? remainder : 0);
                awards[w.playerId] = (awards[w.playerId] || 0) + won;
                winnersSet.add(w.playerId);
                return {
                    nick: w.playerId,
                    rankName: w.name, // 영문 족보명 — 한국어 매핑은 표현 계층(서버)에서
                    won,
                    // 승리 조합 5장 (pokersolver가 '10'을 줄 수 있어 'T'로 정규화 — 기존 동작)
                    best5: w.cards.map(c => ((c.value === '10' ? 'T' : c.value) + c.suit))
                };
            });

            results.push({ potIdx, runIdx, amount: runAmount, board: board.slice(), winners: winnerRows });
        });
    });

    return { awards, winnersAll: [...winnersSet], results, sidePotCount: sidePots.length };
}

module.exports = { computeShowdown };
