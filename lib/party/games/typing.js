// ⌨️ 게임: 한글 타자 — TV·폰에 뜬 문장을 폰으로 빠르고 정확하게 따라 치기
// 순위는 '타수 × 정확도'로 매깁니다 (빠르기만 하고 오타 많으면 손해).
const SENTENCES = require('./typing-data');

const TYPE_MS = 60000;          // 라운드 제한시간
const ROUNDS = 3;               // 문장 3개
const MIN_ACC = 0.6;            // 이 정확도 미만은 미완주 처리(0점)
// 반응속도와 동일한 순위 배점 — 게임 간 총점 균형 유지
const RANK_PTS = [100, 80, 65, 55, 45, 40, 35, 30, 25, 20, 15, 10];

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

// 비교용 정규화: 앞뒤 공백 제거 + 연속 공백 1칸 (띄어쓰기 실수는 관대하게, 글자는 엄격하게)
function norm(s) { return String(s || '').trim().replace(/\s+/g, ' '); }

// 편집 거리 (오타 개수 계산)
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[n];
}

// 제출 채점 → 정확도 / 타수(CPM) / 순위 지표
function grade(target, typed, ms) {
    const t = norm(target), u = norm(typed);
    const dist = levenshtein(t, u);
    const acc = Math.max(0, Math.min(1, 1 - dist / Math.max(1, t.length)));
    const sec = Math.max(0.5, ms / 1000);
    const cpm = Math.round((u.length / sec) * 60);   // 분당 타(글자) 수
    return { acc, cpm, ms, metric: cpm * acc, typos: dist };
}

function startRound(gs) {
    gs.phase = 'typing';
    gs.subs = {};
    gs.startedAt = Date.now();
    gs.deadline = Date.now() + TYPE_MS;
    gs._pushClock = true;
}

function toReveal(room, gs, ctx) {
    if (gs.phase !== 'typing') return;
    const valid = Object.entries(gs.subs)
        .filter(([, s]) => s.acc >= MIN_ACC)
        .sort((a, b) => b[1].metric - a[1].metric);
    gs.ranking = valid.map(([pid, s], i) => {
        const pts = RANK_PTS[i] || 5;
        ctx.award(pid, pts);
        return { pid, nick: room.players.get(pid)?.nick || '?', color: room.players.get(pid)?.color,
                 rank: i + 1, pts, cpm: s.cpm, acc: Math.round(s.acc * 100), typos: s.typos };
    });
    gs.failed = Object.entries(gs.subs)
        .filter(([, s]) => s.acc < MIN_ACC)
        .map(([pid, s]) => ({ nick: room.players.get(pid)?.nick || '?', acc: Math.round(s.acc * 100) }));
    gs.phase = 'reveal';
    gs.deadline = 0; gs._pushClock = false;
}

module.exports = {
    id: 'typing', name: '한글 타자', emoji: '⌨️',
    desc: '문장을 빠르고 정확하게 따라 치기',

    rules: {
        goal: '화면에 뜬 문장을 폰으로 빠르고 정확하게 따라 치세요',
        steps: [
            'TV와 폰에 <b>같은 문장</b>이 나타납니다',
            '폰 입력창에 문장을 <b>그대로</b> 따라 칩니다',
            '다 쳤으면 <b>완료</b>를 눌러 제출하세요 (한 번만 제출 가능)',
        ],
        scoring: [
            '순위는 <b>타수 × 정확도</b>로 결정 — 빠르기만 해선 못 이겨요',
            '빠른 순서대로 <b>100 · 80 · 65 · 55…</b>점',
            '정확도가 너무 낮으면 <b>0점</b> 처리됩니다',
        ],
        tips: [
            '띄어쓰기 실수는 너그럽게 봐주지만 <b>글자·받침</b>은 정확해야 해요',
            '복사·붙여넣기는 막혀 있습니다 😉',
            '문장 3개 · 각 1분',
        ],
    },

    create(room, ctx) {
        const sentences = shuffle(SENTENCES.slice()).slice(0, Math.min(ROUNDS, SENTENCES.length));
        const gs = { sentences, rIndex: 0, total: sentences.length, subs: {}, ranking: [], failed: [] };
        startRound(gs);
        return gs;
    },

    action(room, gs, player, msg, ctx) {
        if (gs.phase !== 'typing' || msg.type !== 'submit') return;
        if (gs.subs[player.id]) return;                 // 한 번만 제출
        const text = String(msg.text || '');
        if (!text.trim()) return;
        gs.subs[player.id] = grade(gs.sentences[gs.rIndex], text, Date.now() - gs.startedAt);
        const connected = ctx.connectedPlayers();
        if (connected.length > 0 && connected.every(p => gs.subs[p.id])) toReveal(room, gs, ctx);
    },

    onDeadline(room, gs, ctx) { toReveal(room, gs, ctx); },

    advance(room, gs, ctx) {
        if (gs.phase === 'typing') { toReveal(room, gs, ctx); return; }
        if (gs.rIndex + 1 >= gs.sentences.length) { ctx.finish(); return; }
        gs.rIndex++;
        startRound(gs);
    },

    hostView(room, gs) {
        const connected = room.order.filter(id => room.players.get(id)?.connected).length;
        const secLeft = gs._pushClock ? Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000)) : 0;
        const base = { round: gs.rIndex + 1, total: gs.sentences.length,
                       sentence: gs.sentences[gs.rIndex], connected };
        if (gs.phase === 'typing') {
            return { screen: 'type_typing', ...base, secLeft, done: Object.keys(gs.subs).length };
        }
        return { screen: 'type_reveal', ...base, ranking: gs.ranking || [], failed: gs.failed || [],
                 isLast: gs.rIndex + 1 >= gs.sentences.length };
    },

    playerView(room, gs, player) {
        const mine = gs.subs[player.id];
        if (gs.phase === 'typing') {
            const secLeft = Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000));
            return { screen: 'type_typing', round: gs.rIndex + 1, total: gs.sentences.length,
                     sentence: gs.sentences[gs.rIndex], secLeft, submitted: !!mine,
                     cpm: mine ? mine.cpm : 0, acc: mine ? Math.round(mine.acc * 100) : 0 };
        }
        const r = (gs.ranking || []).find(x => x.pid === player.id);
        return { screen: 'type_reveal', sentence: gs.sentences[gs.rIndex],
                 rank: r ? r.rank : null, pts: r ? r.pts : 0,
                 cpm: mine ? mine.cpm : 0, acc: mine ? Math.round(mine.acc * 100) : 0,
                 tooManyTypos: !!mine && mine.acc < MIN_ACC, missed: !mine };
    },
};
