// ✍️ 게임2: 누가 썼을까 (Quiplash식) — 답 작성 → 익명 공개 → 투표
const PROMPTS = require('./whowrote-data');

const WRITE_MS = 50000;
const VOTE_MS = 30000;
const NUM_ROUNDS = 3;
const PER_VOTE = 100;   // 득표당 점수
const SUBMIT_BONUS = 20; // 답 제출 참여점
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

function pickPrompts() {
    const arr = PROMPTS.slice();
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr.slice(0, Math.min(NUM_ROUNDS, arr.length));
}

function startVoting(room, gs, ctx) {
    if (gs.phase !== 'writing') return;
    // 제출 안 한 사람 자동 '(패스)'
    const subIds = Object.keys(gs.subs);
    for (const p of ctx.connectedPlayers()) {
        if (!gs.subs[p.id]) gs.subs[p.id] = '(답을 못 냈어요)';
    }
    // 제출 참여점
    for (const pid of Object.keys(gs.subs)) {
        if (gs.subs[pid] !== '(답을 못 냈어요)') ctx.award(pid, SUBMIT_BONUS);
    }
    // 표시 순서 섞기
    gs.displayOrder = Object.keys(gs.subs);
    for (let i = gs.displayOrder.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [gs.displayOrder[i], gs.displayOrder[j]] = [gs.displayOrder[j], gs.displayOrder[i]]; }
    gs.phase = 'voting';
    gs.votes = {};
    gs.deadline = Date.now() + VOTE_MS; gs._pushClock = true;
}

function toReveal(room, gs, ctx) {
    if (gs.phase !== 'voting') return;
    // 집계
    const tally = {};
    for (const t of Object.values(gs.votes)) tally[t] = (tally[t] || 0) + 1;
    for (const [pid, n] of Object.entries(tally)) ctx.award(pid, n * PER_VOTE);
    gs.tally = tally;
    gs.phase = 'reveal';
    gs.deadline = 0; gs._pushClock = false;
}

module.exports = {
    id: 'whowrote', name: '누가 썼을까', emoji: '✍️',
    desc: '엉뚱한 답 쓰고 · 최고의 답에 투표',

    create(room, ctx) {
        return { prompts: pickPrompts(), rIndex: 0, phase: 'writing', subs: {}, votes: {},
                 displayOrder: [], tally: {}, deadline: Date.now() + WRITE_MS, _pushClock: true,
                 total: Math.min(NUM_ROUNDS, PROMPTS.length) };
    },

    action(room, gs, player, msg, ctx) {
        if (gs.phase === 'writing' && msg.type === 'submit') {
            const text = String(msg.text || '').trim().slice(0, 100);
            if (!text) return;
            gs.subs[player.id] = text;
            // 전원 제출 시 자동 투표 단계로
            const connected = ctx.connectedPlayers();
            if (connected.length > 0 && connected.every(p => gs.subs[p.id])) startVoting(room, gs, ctx);
        } else if (gs.phase === 'voting' && msg.type === 'vote') {
            const target = String(msg.target || '');
            if (!gs.subs[target]) return;
            if (target === player.id) return; // 자기 답엔 투표 불가
            if (gs.votes[player.id]) return;   // 한 번만
            gs.votes[player.id] = target;
            // 접속자 전원이 투표를 마치면 자동 공개
            const connected = ctx.connectedPlayers();
            if (connected.length > 0 && connected.every(p => gs.votes[p.id])) toReveal(room, gs, ctx);
        }
    },

    onDeadline(room, gs, ctx) {
        if (gs.phase === 'writing') startVoting(room, gs, ctx);
        else if (gs.phase === 'voting') toReveal(room, gs, ctx);
    },

    advance(room, gs, ctx) {
        if (gs.phase === 'writing') { startVoting(room, gs, ctx); return; }
        if (gs.phase === 'voting') { toReveal(room, gs, ctx); return; }
        // reveal → 다음 라운드 or 종료
        if (gs.rIndex + 1 >= gs.prompts.length) { ctx.finish(); return; }
        gs.rIndex++;
        gs.phase = 'writing';
        gs.subs = {}; gs.votes = {}; gs.displayOrder = []; gs.tally = {};
        gs.deadline = Date.now() + WRITE_MS; gs._pushClock = true;
    },

    hostView(room, gs) {
        const prompt = gs.prompts[gs.rIndex];
        const connected = room.order.filter(id => room.players.get(id)?.connected).length;
        const secLeft = gs._pushClock ? Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000)) : 0;
        const base = { round: gs.rIndex + 1, total: gs.prompts.length, prompt, connected, secLeft };
        if (gs.phase === 'writing') {
            return { screen: 'ww_writing', ...base, submitted: Object.keys(gs.subs).length };
        }
        const answers = gs.displayOrder.map((pid, i) => ({
            letter: LETTERS[i], pid, text: gs.subs[pid],
            author: gs.phase === 'reveal' ? (room.players.get(pid)?.nick || '?') : null,
            votes: gs.phase === 'reveal' ? (gs.tally[pid] || 0) : null,
        }));
        if (gs.phase === 'voting') {
            return { screen: 'ww_voting', ...base, answers, voted: Object.keys(gs.votes).length };
        }
        return { screen: 'ww_reveal', ...base, answers: answers.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
                 isLast: gs.rIndex + 1 >= gs.prompts.length };
    },

    playerView(room, gs, player) {
        if (gs.phase === 'writing') {
            return { screen: 'ww_write', prompt: gs.prompts[gs.rIndex], submitted: !!gs.subs[player.id],
                     myText: gs.subs[player.id] || '', round: gs.rIndex + 1, total: gs.prompts.length };
        }
        if (gs.phase === 'voting') {
            const options = gs.displayOrder.map((pid, i) => ({ letter: LETTERS[i], pid, text: gs.subs[pid], mine: pid === player.id }));
            return { screen: 'ww_vote', options, voted: !!gs.votes[player.id], myVote: gs.votes[player.id] || null };
        }
        const myVotes = gs.tally[player.id] || 0;
        return { screen: 'ww_reveal', myVotes, gained: myVotes * PER_VOTE };
    },
};
