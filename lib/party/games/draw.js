// 🎨 게임: 그림 맞히기 (Skribbl식)
// 한 명(드로어)이 폰 캔버스에 그리면 TV에 실시간 중계, 나머지는 폰으로 정답 입력.
// 드로어는 라운드마다 로테이션. 빨리 맞힐수록 고득점, 드로어도 맞힌 사람 수만큼 득점.
const WORDS = require('./drawing-data');

const DRAW_MS = 75000;             // 라운드 제한시간
const DRAWER_PER_CORRECT = 40;     // 드로어: 맞힌 사람 1명당
const MAX_ROUNDS = 6;              // 최대 라운드(드로어 최대 6명)

function guesserPts(order) { return Math.max(40, 120 - order * 20); } // 1등120,2등100…최소40
function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, ''); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

function startRound(gs) {
    gs.drawerId = gs.order[gs.rIndex];
    gs.word = gs.words[gs.rIndex];
    gs.phase = 'draw';
    gs.guesses = {};        // pid -> { order, pts }
    gs.correctOrder = 0;
    gs.deadline = Date.now() + DRAW_MS;
    gs._pushClock = true;
}

function toReveal(gs) {
    if (gs.phase !== 'draw') return;
    gs.phase = 'reveal';
    gs.deadline = 0; gs._pushClock = false;
}

function drawerNickOf(room, gs) { return room.players.get(gs.drawerId)?.nick || '?'; }

module.exports = {
    id: 'draw', name: '그림 맞히기', emoji: '🎨',
    desc: '한 명이 그리고 · 나머지가 폰으로 정답 맞히기',

    create(room, ctx) {
        const connected = ctx.connectedPlayers().map(p => p.id);
        const order = shuffle(connected.slice());
        const total = Math.max(1, Math.min(order.length, MAX_ROUNDS));
        const words = shuffle(WORDS.slice()).slice(0, total);
        const gs = { order: order.slice(0, total), words, rIndex: 0, total };
        startRound(gs);
        return gs;
    },

    // 드로어 폰의 스트로크를 TV로 저지연 중계 (전체 브로드캐스트 안 거침)
    onDraw(room, gs, player, data, toHost) {
        if (gs.phase !== 'draw' || player.id !== gs.drawerId) return;
        if (data.type === 'seg') toHost('host:stroke', data);
        else if (data.type === 'clear') toHost('host:strokeClear', {});
    },

    action(room, gs, player, msg, ctx) {
        if (gs.phase !== 'draw' || msg.type !== 'guess') return;
        if (player.id === gs.drawerId) return;      // 드로어는 정답 앎
        if (gs.guesses[player.id]) return;          // 이미 맞힘
        const g = norm(msg.text);
        if (!g) return;
        if (g === norm(gs.word)) {
            const order = gs.correctOrder++;
            const pts = guesserPts(order);
            gs.guesses[player.id] = { order, pts };
            ctx.award(player.id, pts);
            ctx.award(gs.drawerId, DRAWER_PER_CORRECT);
            const guessers = ctx.connectedPlayers().filter(p => p.id !== gs.drawerId);
            if (guessers.length > 0 && guessers.every(p => gs.guesses[p.id])) toReveal(gs);
        }
    },

    onDeadline(room, gs, ctx) { toReveal(gs); },

    advance(room, gs, ctx) {
        if (gs.phase === 'draw') { toReveal(gs); return; }
        if (gs.rIndex + 1 >= gs.total) { ctx.finish(); return; }
        gs.rIndex++;
        startRound(gs);
    },

    hostView(room, gs) {
        const drawerNick = drawerNickOf(room, gs);
        const guessers = room.order.map(id => room.players.get(id))
            .filter(p => p && p.connected && p.id !== gs.drawerId)
            .map(p => ({ nick: p.nick, color: p.color, guessed: !!gs.guesses[p.id] }));
        const secLeft = gs._pushClock ? Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000)) : 0;
        const base = { round: gs.rIndex + 1, total: gs.total, drawerNick, wordLen: [...gs.word].length };
        if (gs.phase === 'draw') {
            return { screen: 'draw_drawing', ...base, secLeft, guessers,
                     correctCount: Object.keys(gs.guesses).length };
        }
        const results = Object.entries(gs.guesses)
            .map(([pid, v]) => ({ nick: room.players.get(pid)?.nick || '?', pts: v.pts, order: v.order }))
            .sort((a, b) => a.order - b.order);
        return { screen: 'draw_reveal', ...base, word: gs.word, results,
                 drawerPts: results.length * DRAWER_PER_CORRECT, isLast: gs.rIndex + 1 >= gs.total };
    },

    playerView(room, gs, player) {
        const isDrawer = player.id === gs.drawerId;
        const secLeft = gs._pushClock ? Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000)) : 0;
        if (gs.phase === 'draw') {
            if (isDrawer) {
                return { screen: 'draw_draw', isDrawer: true, word: gs.word, round: gs.rIndex + 1, total: gs.total,
                         secLeft, correctCount: Object.keys(gs.guesses).length };
            }
            const mine = gs.guesses[player.id];
            return { screen: 'draw_draw', isDrawer: false, wordLen: [...gs.word].length,
                     round: gs.rIndex + 1, total: gs.total, guessed: !!mine, myPts: mine ? mine.pts : 0, secLeft };
        }
        // reveal
        const mine = gs.guesses[player.id];
        const drawerPts = Object.keys(gs.guesses).length * DRAWER_PER_CORRECT;
        return { screen: 'draw_reveal', word: gs.word, iWasDrawer: isDrawer,
                 guessedRight: !!mine, myPts: isDrawer ? drawerPts : (mine ? mine.pts : 0),
                 drawerNick: drawerNickOf(room, gs) };
    },
};
