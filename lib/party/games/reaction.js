// ⚡ 게임4: 반응속도 — TV의 "지금!" 신호에 맞춰 폰을 가장 빨리 탭
// 부정출발(신호 전 탭) = 그 라운드 0점. 3라운드 합산.
const NUM_ROUNDS = 3;
const GO_WINDOW = 4000;     // 신호 후 입력 시간
const RANK_PTS = [100, 80, 65, 55, 45, 40, 35, 30, 25, 20, 15, 10];
const MIN_HUMAN_MS = 80;   // 사람이 낼 수 있는 최소 반응시간(그 이하는 찍은 것) — 조작 방지 하한

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

    rules: {
        goal: '신호가 뜨는 순간 가장 빨리 폰을 터치하세요',
        steps: [
            'TV와 폰에 <b>"준비…"</b> 화면이 뜹니다',
            '무작위 시간(2~5초) 뒤 <b>"지금 탭!"</b> 신호가 나타납니다',
            '신호를 보자마자 폰 화면을 터치!',
        ],
        scoring: [
            '빠른 순서대로 <b>100 · 80 · 65 · 55…</b>점',
            '총 <b>3라운드</b> 합산',
        ],
        tips: [
            '⚠ 신호 전에 누르면 <b>부정출발</b> — 그 라운드는 0점',
            '반응시간은 폰에서 직접 재기 때문에 인터넷 속도는 순위에 영향이 없어요',
            '폰을 손에 들고 화면을 보고 계세요',
        ],
    },

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
            // ⚡ 공정성: 서버에서 재면 네트워크 왕복 지연(RTT)이 그대로 더해져
            //    인터넷이 빠른 사람이 유리해진다. 그래서 폰에서 잰 시간을 우선 사용한다.
            //    단, 폰 값은 서버 측정치보다 클 수 없다(물리적으로 불가) → 조작 방지 상한.
            const serverMs = Date.now() - gs.goAt;
            const client = Number(msg.ms);
            let ms = serverMs;
            if (Number.isFinite(client) && client >= 0 && client <= serverMs + 60) {
                ms = Math.max(MIN_HUMAN_MS, Math.round(client));
            }
            gs.taps[player.id] = ms;
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
                     falseStarted: !!gs.falseStart[player.id], round: gs.rIndex + 1 };
        }
        const mine = (gs.ranking || []).find(r => r.pid === player.id);
        return { screen: 'reaction_result', falseStarted: !!gs.falseStart[player.id],
                 rank: mine ? mine.rank : null, ms: mine ? mine.ms : null, pts: mine ? mine.pts : 0 };
    },
};
