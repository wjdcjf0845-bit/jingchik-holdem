// ⚡ 게임4: 반응속도 — TV의 "지금!" 신호에 맞춰 폰을 가장 빨리 탭
// 부정출발(신호 전 탭) = 그 라운드 0점. 3라운드 합산.
const NUM_ROUNDS = 3;
const GO_WINDOW = 4000;     // 신호 후 입력 시간
const RANK_PTS = [100, 80, 65, 55, 45, 40, 35, 30, 25, 20, 15, 10];

function armRound(gs) {
    gs.phase = 'ready';
    gs.taps = {};        // pid -> ms (신호 후 반응시간)
    gs.falseStart = {};  // pid -> true
    const delay = 2000 + Math.floor(Math.random() * 3500); // 2.0~5.5초
    gs.goAt = Date.now() + delay;
    gs.deadline = gs.goAt; gs._pushClock = false;
}

function toReveal(room, gs, ctx) {
    if (gs.phase !== 'go') return;
    // 순위 채점
    const valid = Object.entries(gs.taps).sort((a, b) => a[1] - b[1]);
    gs.ranking = valid.map(([pid, ms], i) => {
        const pts = RANK_PTS[i] || 5;
        ctx.award(pid, pts);
        return { pid, nick: room.players.get(pid)?.nick || '?', ms, pts, rank: i + 1 };
    });
    gs.phase = 'reveal';
    gs.deadline = 0; gs._pushClock = false;
}

module.exports = {
    id: 'reaction', name: '반응속도', emoji: '⚡',
    desc: '"지금!" 신호에 가장 빨리 탭 · 부정출발 주의',

    create(room, ctx) {
        const gs = { rIndex: 0, total: NUM_ROUNDS };
        armRound(gs);
        return gs;
    },

    action(room, gs, player, msg, ctx) {
        if (msg.type !== 'tap') return;
        if (gs.phase === 'ready') {
            gs.falseStart[player.id] = true; // 부정출발
        } else if (gs.phase === 'go') {
            if (gs.falseStart[player.id]) return;      // 부정출발자는 무효
            if (gs.taps[player.id] != null) return;    // 한 번만
            gs.taps[player.id] = Date.now() - gs.goAt;
            const connected = ctx.connectedPlayers();
            const done = connected.every(p => gs.taps[p.id] != null || gs.falseStart[p.id]);
            if (connected.length > 0 && done) toReveal(room, gs, ctx);
        }
    },

    onDeadline(room, gs, ctx) {
        if (gs.phase === 'ready') {
            // 신호! GO
            gs.phase = 'go';
            gs.goAt = Date.now();
            gs.deadline = Date.now() + GO_WINDOW; gs._pushClock = false;
        } else if (gs.phase === 'go') {
            toReveal(room, gs, ctx);
        }
    },

    advance(room, gs, ctx) {
        if (gs.phase === 'ready') { /* 진행 무시(자동 신호 대기) */ return; }
        if (gs.phase === 'go') { toReveal(room, gs, ctx); return; }
        // reveal → 다음 라운드
        if (gs.rIndex + 1 >= NUM_ROUNDS) { ctx.finish(); return; }
        gs.rIndex++;
        armRound(gs);
    },

    hostView(room, gs) {
        const connected = room.order.filter(id => room.players.get(id)?.connected).length;
        const base = { round: gs.rIndex + 1, total: NUM_ROUNDS, connected };
        if (gs.phase === 'ready') {
            const fs = Object.keys(gs.falseStart).map(pid => room.players.get(pid)?.nick || '?');
            return { screen: 'reaction_ready', ...base, falseStarts: fs };
        }
        if (gs.phase === 'go') {
            return { screen: 'reaction_go', ...base, tapped: Object.keys(gs.taps).length };
        }
        const fs = Object.keys(gs.falseStart).map(pid => room.players.get(pid)?.nick || '?');
        return { screen: 'reaction_reveal', ...base, ranking: gs.ranking || [], falseStarts: fs,
                 isLast: gs.rIndex + 1 >= NUM_ROUNDS };
    },

    playerView(room, gs, player) {
        if (gs.phase === 'ready') {
            return { screen: 'reaction_wait', falseStarted: !!gs.falseStart[player.id],
                     round: gs.rIndex + 1, total: NUM_ROUNDS };
        }
        if (gs.phase === 'go') {
            const tapped = gs.taps[player.id] != null;
            return { screen: 'reaction_tap', tapped, ms: tapped ? gs.taps[player.id] : null,
                     falseStarted: !!gs.falseStart[player.id] };
        }
        const mine = (gs.ranking || []).find(r => r.pid === player.id);
        return { screen: 'reaction_result', falseStarted: !!gs.falseStart[player.id],
                 rank: mine ? mine.rank : null, ms: mine ? mine.ms : null, pts: mine ? mine.pts : 0 };
    },
};
