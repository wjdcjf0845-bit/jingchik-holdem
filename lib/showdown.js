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
//     totalPot:      서버가 집계한 실제 팟. 사이드팟 합과 다르면(안테 등) 그 차액을
//                    "마지막" 팟에 가산 (기존 evaluateWinner 동작 보존)
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

    // 1) 사이드팟 계산 + 실팟과의 차액 보정 (마지막 팟에 — 기존 동작)
    const sidePots = Pots.calculateSidePots(o.contributions || []);
    const sidePotsTotal = sidePots.reduce((s, sp) => s + sp.amount, 0);
    const diff = (o.totalPot != null ? o.totalPot : sidePotsTotal) - sidePotsTotal;
    if (diff > 0 && sidePots.length > 0) {
        sidePots[sidePots.length - 1].amount += diff;
    }

    // 2) 폴드 전용 상위 팟 롤다운 (칩 누수 방지)
    Pots.rollDownFoldedPots(sidePots, isFolded);

    // 3) 팟별 × 보드(런)별 평가·배분
    const awards = {};
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
