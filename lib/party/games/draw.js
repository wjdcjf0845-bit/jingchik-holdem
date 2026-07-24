// 🎨 게임: 그림 맞히기 (Skribbl식)
// 한 명(드로어)이 폰 캔버스에 그리면 TV에 실시간 중계, 나머지는 폰으로 정답 입력.
// 드로어는 라운드마다 로테이션. 빨리 맞힐수록 고득점, 드로어도 맞힌 사람 수만큼 득점.
const WORDS = require('./drawing-data');

const DRAW_MS = 75000;             // 라운드 제한시간
const DRAWER_PER_CORRECT = 40;     // 드로어(그린 사람) 기본 배점: 맞힌 사람 1명당
// 라운드 수 = 참가 인원 수 (모두 한 번씩 그림) — 제시어 개수가 상한
//
// ⚖️ 밸런스: 이 게임은 라운드 수(=인원)와 라운드별 정답자 수(=인원-1)가 함께 늘어
//    인원이 많아지면 배점이 N² 로 폭증한다(12명이면 다른 게임의 6배 이상).
//    그래서 인원과 무관하게 게임 전체 배포 총점이 아래 값에 맞도록 자동 보정한다.
const TARGET_TOTAL = 1500;

const FEED_MAX = 12;       // TV에 띄우는 최근 정답 시도 개수

function baseGuessPts(order) { return Math.max(40, 120 - order * 20); } // 1등120,2등100…최소40 (보정 전)

// 인원 수에 맞춰 배점 배율을 계산 — 게임 전체 총점이 TARGET_TOTAL 근처가 되게 한다
function computeScale(nPlayers, rounds) {
    const nGuessers = Math.max(1, nPlayers - 1);
    let rawPerRound = DRAWER_PER_CORRECT * nGuessers;          // 그린 사람 몫
    for (let i = 0; i < nGuessers; i++) rawPerRound += baseGuessPts(i); // 맞힌 사람들 몫
    const raw = rawPerRound * Math.max(1, rounds);
    return raw > 0 ? TARGET_TOTAL / raw : 1;
}
const scaled = (base, scale) => Math.max(1, Math.round(base * scale));

// 제시어는 '단어' 또는 { word, answers:[동의어] } 둘 다 지원
function wordOf(e) { return typeof e === 'string' ? e : (e && e.word) || ''; }
function acceptedOf(e) {
    const extra = (e && typeof e === 'object' && e.answers) || [];
    return [wordOf(e), ...extra].map(norm).filter(Boolean);
}

// 오답은 내용까지, 정답은 내용을 숨기고 표시(아직 못 맞힌 사람 스포일러 방지)
function pushFeed(gs, player, text, ok) {
    gs.feed.push({ nick: player.nick, color: player.color, ok: !!ok,
                   text: ok ? '' : String(text || '').trim().slice(0, 30) });
    if (gs.feed.length > FEED_MAX) gs.feed.shift();
}
function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, ''); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

function startRound(gs) {
    gs.drawerId = gs.order[gs.rIndex];
    gs.entry = gs.words[gs.rIndex];      // 서버 전용 (동의어 목록 포함, 폰으로 안 나감)
    gs.word = wordOf(gs.entry);          // 화면에 표시할 제시어
    gs.phase = 'draw';
    gs.guesses = {};        // pid -> { order, pts }
    gs.feed = [];
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

    rules: {
        goal: '한 명이 그림을 그리고, 나머지가 제시어를 맞힙니다',
        steps: [
            '차례가 된 사람의 폰에만 <b>제시어</b>가 표시됩니다',
            '폰 화면에 손가락으로 그리면 TV에 실시간으로 그려집니다',
            '나머지 사람은 폰에 정답을 입력하세요 (오답은 TV에 공개)',
        ],
        scoring: [
            '맞힌 <b>순서가 빠를수록</b> 높은 점수',
            '<b>그린 사람도</b> 맞힌 사람 수만큼 점수 획득',
            '참가자 <b>전원이 한 번씩</b> 그립니다 (배점은 인원에 맞춰 자동 조정)',
        ],
        tips: [
            '글자나 숫자를 쓰면 반칙!',
            '뜻이 같은 다른 표현도 정답으로 인정되는 경우가 있어요',
            '한 라운드 75초',
        ],
    },

    create(room, ctx) {
        const connected = ctx.connectedPlayers().map(p => p.id);
        const order = shuffle(connected.slice());
        // 참가자 한 명당 한 번씩 그리도록 라운드 수를 인원 수에 맞춤
        const total = Math.max(1, Math.min(order.length, WORDS.length));
        const words = shuffle(WORDS.slice()).slice(0, total);
        const scale = computeScale(connected.length, total);
        const gs = { order: order.slice(0, total), words, rIndex: 0, total, scale,
                     drawerPer: scaled(DRAWER_PER_CORRECT, scale) };
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
        if (acceptedOf(gs.entry).includes(g)) {
            const order = gs.correctOrder++;
            const pts = scaled(baseGuessPts(order), gs.scale);
            gs.guesses[player.id] = { order, pts };
            ctx.award(player.id, pts);
            ctx.award(gs.drawerId, gs.drawerPer);
            pushFeed(gs, player, '', true);
            const guessers = ctx.connectedPlayers().filter(p => p.id !== gs.drawerId);
            if (guessers.length > 0 && guessers.every(p => gs.guesses[p.id])) toReveal(gs);
        } else {
            pushFeed(gs, player, msg.text, false);   // 오답은 TV에 공개
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
        const base = { round: gs.rIndex + 1, total: gs.total, drawerNick, wordLen: [...gs.word].length,
                       feed: (gs.feed || []).slice().reverse() };   // 최신 입력이 위로
        if (gs.phase === 'draw') {
            return { screen: 'draw_drawing', ...base, secLeft, guessers,
                     correctCount: Object.keys(gs.guesses).length };
        }
        const results = Object.entries(gs.guesses)
            .map(([pid, v]) => ({ nick: room.players.get(pid)?.nick || '?', pts: v.pts, order: v.order }))
            .sort((a, b) => a.order - b.order);
        return { screen: 'draw_reveal', ...base, word: gs.word, results,
                 drawerPts: results.length * gs.drawerPer, isLast: gs.rIndex + 1 >= gs.total };
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
        const drawerPts = Object.keys(gs.guesses).length * gs.drawerPer;
        return { screen: 'draw_reveal', word: gs.word, iWasDrawer: isDrawer,
                 guessedRight: !!mine, myPts: isDrawer ? drawerPts : (mine ? mine.pts : 0),
                 drawerNick: drawerNickOf(room, gs) };
    },
};
