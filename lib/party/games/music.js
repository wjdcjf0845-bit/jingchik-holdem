// 🎵 게임: 노래 맞히기 — TV에서 노래를 처음부터 계속 재생, 폰으로 제목 입력 (주관식)
// 선착순 3등까지만 점수. 3명이 맞히면 라운드 자동 종료(음악도 정지).
// 채점은 띄어쓰기·대소문자·특수문자를 무시하고 비교합니다.
const SONGS = require('./music-data');

const ANSWER_MS = 120000;         // 라운드 제한시간 2분 — 그 안에 3등이 안 나오면 자동 공개
const RANK_PTS = [150, 100, 70];  // 1등 / 2등 / 3등 — 그 뒤는 0점
const WINNERS = RANK_PTS.length;  // 3등까지
const FEED_MAX = 12;              // TV에 띄우는 최근 입력 개수

// 띄어쓰기·기호·대소문자 무시 정규화
function norm(s) {
    return String(s || '').toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');
}
function acceptedOf(song) {
    return [song.title, ...(song.answers || [])].map(norm).filter(Boolean);
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

// 처음부터 재생 (start는 특별한 경우에만 사용, 기본 0)
function audioOf(song) { return { file: song.file, start: song.start || 0 }; }

// 오답은 내용까지, 정답은 내용을 숨기고 표시(다른 사람 스포일러 방지)
function pushFeed(gs, player, text, ok, rank) {
    gs.feed.push({ nick: player.nick, color: player.color, ok: !!ok,
                   rank: ok ? rank : 0,
                   text: ok ? '' : String(text || '').trim().slice(0, 30) });
    if (gs.feed.length > FEED_MAX) gs.feed.shift();
}

function toReveal(gs) {
    if (gs.phase === 'reveal') return;
    gs.phase = 'reveal';
    gs.deadline = 0; gs._pushClock = false;
}

module.exports = {
    id: 'music', name: '노래 맞히기', emoji: '🎵',
    desc: '노래 듣고 제목 맞히기 · 선착순 3등까지 점수',

    rules: {
        goal: '노래를 듣고 제목을 가장 먼저 맞히세요',
        steps: [
            'TV에서 노래가 처음부터 재생됩니다',
            '폰에 노래 <b>제목</b>을 입력해 제출하세요',
            '틀려도 계속 도전 가능 — 단, 오답은 TV에 이름과 함께 공개돼요 😂',
        ],
        scoring: [
            '선착순 <b>1등 150점 · 2등 100점 · 3등 70점</b>',
            '4등부터는 맞혀도 0점',
            '3명이 맞히면 그 라운드는 즉시 종료',
        ],
        tips: [
            '띄어쓰기·대소문자는 틀려도 정답 처리',
            '영어 제목은 한글로 써도 인정 (U R Man → 유얼맨)',
            '라운드당 제한시간 2분',
        ],
    },

    create(room, ctx) {
        const songs = shuffle(SONGS.slice());
        return { songs, qIndex: 0, phase: 'ready', answers: {}, wrongs: {}, feed: [],
                 correctOrder: 0, startedAt: 0, deadline: 0, _pushClock: false, total: songs.length };
    },

    action(room, gs, player, msg, ctx) {
        if (gs.phase !== 'answering' || msg.type !== 'guess') return;
        if (gs.answers[player.id]) return;   // 이미 맞힘
        const text = norm(msg.text);
        if (!text) return;
        const song = gs.songs[gs.qIndex];
        if (acceptedOf(song).includes(text)) {
            const order = gs.correctOrder++;          // 0-based 선착 순서
            const pts = RANK_PTS[order] || 0;         // 3등까지만 점수
            const ms = Date.now() - gs.startedAt;
            gs.answers[player.id] = { ms, pts, rank: order + 1 };
            if (pts > 0) ctx.award(player.id, pts);
            pushFeed(gs, player, '', true, order + 1);
            // 3등까지 나오면 라운드 종료 (음악 정지)
            if (gs.correctOrder >= WINNERS) { toReveal(gs); return; }
            const connected = ctx.connectedPlayers();
            if (connected.length > 0 && connected.every(p => gs.answers[p.id])) toReveal(gs);
        } else {
            gs.wrongs[player.id] = (gs.wrongs[player.id] || 0) + 1;
            pushFeed(gs, player, msg.text, false);   // 오답은 TV에 공개
        }
    },

    onDeadline(room, gs, ctx) { toReveal(gs); },

    advance(room, gs, ctx) {
        if (gs.phase === 'ready') {          // 호스트가 재생 → 입력 시작
            gs.phase = 'answering';
            gs.startedAt = Date.now();
            gs.deadline = Date.now() + ANSWER_MS;
            gs._pushClock = true;
            return;
        }
        if (gs.phase === 'answering') { toReveal(gs); return; }
        // reveal → 다음 곡 or 종료
        if (gs.qIndex + 1 >= gs.songs.length) { ctx.finish(); return; }
        gs.qIndex++;
        gs.phase = 'ready';
        gs.answers = {}; gs.wrongs = {}; gs.feed = []; gs.correctOrder = 0;
        gs.startedAt = 0; gs.deadline = 0; gs._pushClock = false;
    },

    hostView(room, gs) {
        const song = gs.songs[gs.qIndex];
        const connected = room.order.filter(id => room.players.get(id)?.connected).length;
        const secLeft = gs._pushClock ? Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000)) : 0;
        const base = { qNum: gs.qIndex + 1, total: gs.songs.length, connected,
                       audio: audioOf(song),      // 오디오 정보는 TV에만 전달
                       feed: gs.feed.slice().reverse(),   // 최신 입력이 위로
                       winners: WINNERS, rankPts: RANK_PTS };
        if (gs.phase === 'ready') return { screen: 'music_ready', ...base };
        if (gs.phase === 'answering') {
            return { screen: 'music_play', ...base, secLeft, correctCount: gs.correctOrder };
        }
        const scorers = Object.entries(gs.answers)
            .map(([pid, a]) => ({ nick: room.players.get(pid)?.nick || '?', pts: a.pts, ms: a.ms, rank: a.rank }))
            .sort((x, y) => x.rank - y.rank);
        return { screen: 'music_reveal', ...base, title: song.title, artist: song.artist,
                 scorers, isLast: gs.qIndex + 1 >= gs.songs.length };
    },

    playerView(room, gs, player) {
        const mine = gs.answers[player.id];
        if (gs.phase === 'ready') {
            return { screen: 'music_wait', qNum: gs.qIndex + 1, total: gs.songs.length };
        }
        if (gs.phase === 'answering') {
            const secLeft = Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000));
            return { screen: 'music_answer', qNum: gs.qIndex + 1, total: gs.songs.length,
                     secLeft, correct: !!mine, pts: mine ? mine.pts : 0, rank: mine ? mine.rank : 0,
                     wrongs: gs.wrongs[player.id] || 0,
                     taken: gs.correctOrder, winners: WINNERS };
        }
        const song = gs.songs[gs.qIndex];
        return { screen: 'music_reveal', title: song.title, artist: song.artist,
                 correct: !!mine, pts: mine ? mine.pts : 0, rank: mine ? mine.rank : 0 };
    },
};
