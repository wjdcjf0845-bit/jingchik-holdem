// 🎬 명장면 — 배드비트 · 쿨러 · 리버 역전 · 큰 팟 · 포카드 이상 같은 판을 골라 리플레이째로 남긴다(친구에게 링크로 보낼 수 있게).
//   detect(): 쇼다운 결과 → 가장 눈에 띄는 한 가지(없으면 null). 순수 함수라 시험한다.
//   저장: DATA_DIR/highlights.json(최근 300개) — 전적 DB(Turso)와 별개. 서버가 꺼져도 남고, 매일 백업에는 안 들어간다.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const RANK_ORDER = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush', 'Royal Flush'];
const rankIx = r => RANK_ORDER.indexOf(r);
const KO = { 'High Card': '하이카드', Pair: '원페어', 'Two Pair': '투페어', 'Three of a Kind': '트리플', Straight: '스트레이트', Flush: '플러시', 'Full House': '풀하우스', 'Four of a Kind': '포카드', 'Straight Flush': '스트레이트 플러시', 'Royal Flush': '로얄 플러시' };

// s: { winners:[nick], contenders:[{ nick, rank(영문 족보), human }], potBB, allinEq:{ nick: 승률% }(둘이 올인했을 때 · 없으면 null), riverFlip:{ loser, eq% }(턴에서 앞섰는데 리버에 진 사람 · 없으면 null) }
// 반환: { kind, title, sub, score } — score 가 클수록 더 볼 만한 판
function detect(s) {
    if (!s || !s.contenders || s.contenders.length < 2) return null;
    if (!s.contenders.some(c => c.human)) return null;                 // 사람이 낀 판만(봇끼리 판은 넘친다)
    const W = new Set(s.winners || []), win = s.contenders.filter(c => W.has(c.nick)), lose = s.contenders.filter(c => !W.has(c.nick));
    if (!win.length || !lose.length) return null;
    const best = win.reduce((a, c) => (rankIx(c.rank) > rankIx(a.rank) ? c : a), win[0]);
    const loserBest = lose.reduce((a, c) => (rankIx(c.rank) > rankIx(a.rank) ? c : a), lose[0]);
    const out = [];
    const bb = Math.round(s.potBB || 0);
    if (best.rank === 'Royal Flush') out.push({ kind: 'royal', title: '👑 로얄 플러시!', sub: `${best.nick} — 평생 한 번 볼까 말까`, score: 100 });
    else if (best.rank === 'Straight Flush') out.push({ kind: 'sflush', title: '🌈 스트레이트 플러시!', sub: `${best.nick}`, score: 90 });
    else if (best.rank === 'Four of a Kind') out.push({ kind: 'quads', title: '💎 포카드!', sub: `${best.nick}`, score: 70 });
    // 배드비트: 둘이 올인했을 때 이길 확률이 높던 쪽이 졌다
    if (s.allinEq) {
        const lost = lose.find(c => typeof s.allinEq[c.nick] === 'number' && s.allinEq[c.nick] >= 80);
        if (lost) out.push({ kind: 'badbeat', title: '😱 배드비트!', sub: `${lost.nick} ${Math.round(s.allinEq[lost.nick])}% 에서 역전패 — ${best.nick} 의 기적`, score: 60 + (s.allinEq[lost.nick] - 80) });
    }
    // 리버 역전: 턴까지 앞서던 사람이 마지막 카드에 뒤집혔다
    if (s.riverFlip && s.riverFlip.eq >= 70 && !out.some(o => o.kind === 'badbeat')) out.push({ kind: 'river', title: '🌊 리버 역전!', sub: `${s.riverFlip.loser} 턴까지 ${Math.round(s.riverFlip.eq)}% — 리버 한 장에 뒤집혔다`, score: 50 });
    // 쿨러: 둘 다 풀하우스 이상(누구라도 못 접는 판)
    if (rankIx(loserBest.rank) >= rankIx('Full House')) out.push({ kind: 'cooler', title: '🧊 쿨러!', sub: `${KO[best.rank] || best.rank} 대 ${KO[loserBest.rank] || loserBest.rank} — 둘 다 못 접는 판`, score: 55 });
    // 큰 팟
    if (bb >= 150) out.push({ kind: 'bigpot', title: '💰 초대형 팟!', sub: `${best.nick} ${bb}bb 를 가져갔다`, score: 30 + Math.min(20, bb / 20) });
    if (!out.length) return null;
    return out.sort((a, b) => b.score - a.score)[0];
}

module.exports = { detect, KO };
