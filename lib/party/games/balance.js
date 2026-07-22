// ⚖️ 게임3: 밸런스 게임 / 다수결 — 다수파가 득점 (눈치 심리게임)
const BANK = require('./balance-data');

const VOTE_MS = 15000;
const WIN = 100;   // 다수파 점수
const TIE = 50;    // 동점 시 전원
const NUM_ROUNDS = 6;

function pickRounds() {
    const arr = BANK.slice();
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr.slice(0, Math.min(NUM_ROUNDS, arr.length));
}

function toReveal(room, gs, ctx) {
    if (gs.phase !== 'voting') return;
    let ca = 0, cb = 0;
    for (const v of Object.values(gs.votes)) { if (v === 'a') ca++; else if (v === 'b') cb++; }
    gs.ca = ca; gs.cb = cb;
    let winner = null;
    if (ca > cb) winner = 'a'; else if (cb > ca) winner = 'b'; else winner = 'tie';
    gs.winner = winner;
    for (const [pid, v] of Object.entries(gs.votes)) {
        if (winner === 'tie') ctx.award(pid, TIE);
        else if (v === winner) ctx.award(pid, WIN);
    }
    gs.phase = 'reveal';
    gs.deadline = 0; gs._pushClock = false;
}

module.exports = {
    id: 'balance', name: '밸런스 게임', emoji: '⚖️',
    desc: '다수가 고른 쪽에 점수 · 소수파는 벌주!',

    create(room, ctx) {
        return { rounds: pickRounds(), rIndex: 0, phase: 'voting', votes: {},
                 ca: 0, cb: 0, winner: null, deadline: Date.now() + VOTE_MS, _pushClock: true,
                 total: Math.min(NUM_ROUNDS, BANK.length) };
    },

    action(room, gs, player, msg, ctx) {
        if (gs.phase !== 'voting' || msg.type !== 'vote') return;
        const v = msg.choice === 'a' ? 'a' : msg.choice === 'b' ? 'b' : null;
        if (!v) return;
        gs.votes[player.id] = v; // 마음 바꾸기 허용
        const connected = ctx.connectedPlayers();
        if (connected.length > 0 && connected.every(p => gs.votes[p.id])) toReveal(room, gs, ctx);
    },

    onDeadline(room, gs, ctx) { toReveal(room, gs, ctx); },

    advance(room, gs, ctx) {
        if (gs.phase === 'voting') { toReveal(room, gs, ctx); return; }
        if (gs.rIndex + 1 >= gs.rounds.length) { ctx.finish(); return; }
        gs.rIndex++;
        gs.phase = 'voting'; gs.votes = {}; gs.ca = 0; gs.cb = 0; gs.winner = null;
        gs.deadline = Date.now() + VOTE_MS; gs._pushClock = true;
    },

    hostView(room, gs) {
        const r = gs.rounds[gs.rIndex];
        const connected = room.order.filter(id => room.players.get(id)?.connected).length;
        const secLeft = gs._pushClock ? Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000)) : 0;
        const voted = Object.keys(gs.votes).length;
        const base = { round: gs.rIndex + 1, total: gs.rounds.length, q: r.q, a: r.a, b: r.b, connected, voted, secLeft };
        if (gs.phase === 'voting') {
            // 실시간 카운트(누가 뭘 골랐는지는 숨기고 수만 표시)
            let ca = 0, cb = 0; for (const v of Object.values(gs.votes)) { if (v === 'a') ca++; else if (v === 'b') cb++; }
            return { screen: 'balance_voting', ...base, ca, cb };
        }
        // reveal: 이름까지 공개
        const listA = [], listB = [];
        for (const [pid, v] of Object.entries(gs.votes)) {
            const nick = room.players.get(pid)?.nick || '?';
            (v === 'a' ? listA : listB).push(nick);
        }
        const minority = gs.winner === 'tie' ? null : (gs.winner === 'a' ? listB : listA);
        return { screen: 'balance_reveal', ...base, ca: gs.ca, cb: gs.cb, winner: gs.winner,
                 listA, listB, minority, isLast: gs.rIndex + 1 >= gs.rounds.length };
    },

    playerView(room, gs, player) {
        const r = gs.rounds[gs.rIndex];
        if (gs.phase === 'voting') {
            return { screen: 'balance_vote', q: r.q, a: r.a, b: r.b, myVote: gs.votes[player.id] || null,
                     round: gs.rIndex + 1, total: gs.rounds.length };
        }
        const my = gs.votes[player.id] || null;
        const won = gs.winner === 'tie' ? true : (my && my === gs.winner);
        return { screen: 'balance_result', my, winner: gs.winner, a: r.a, b: r.b, won: !!won,
                 pts: my ? (gs.winner === 'tie' ? TIE : (my === gs.winner ? WIN : 0)) : 0 };
    },
};
