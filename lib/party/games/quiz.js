// 🧠 게임1: 스피드 퀴즈 (Kahoot식) — 4지선다 + 속도 보너스
const BANK = require('./quiz-data');

const ANSWER_MS = 20000;   // 문제당 제한시간
const BASE = 100;          // 정답 기본 점수
const SPEED = 100;         // 최대 속도 보너스
const NUM_Q = Math.min(10, BANK.length); // 이번 판 문제 수

function pickQuestions() {
    const arr = BANK.slice();
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr.slice(0, NUM_Q);
}

function toReveal(room, gs) {
    if (gs.phase === 'reveal') return;
    const q = gs.questions[gs.qIndex];
    // 채점
    for (const [pid, a] of Object.entries(gs.answers)) {
        if (a.choice === q.correct) {
            const frac = Math.max(0, 1 - (a.ms / ANSWER_MS));
            const pts = BASE + Math.round(SPEED * frac);
            const p = room.players.get(pid);
            if (p) { p.score += pts; a.pts = pts; }
        } else { a.pts = 0; }
    }
    gs.phase = 'reveal';
    gs.deadline = 0; gs._pushClock = false;
}

module.exports = {
    id: 'quiz', name: '스피드 퀴즈', emoji: '🧠',
    desc: '4지선다 · 빨리 맞힐수록 고득점',

    create(room, ctx) {
        const questions = pickQuestions();
        const gs = { questions, qIndex: 0, phase: 'question', answers: {},
                     qStart: Date.now(), deadline: Date.now() + ANSWER_MS, _pushClock: true, total: questions.length };
        return gs;
    },

    action(room, gs, player, msg, ctx) {
        if (gs.phase !== 'question') return;
        if (msg.type !== 'answer') return;
        const c = parseInt(msg.choice);
        if (!(c >= 0 && c <= 3)) return;
        if (gs.answers[player.id]) return; // 한 번만
        gs.answers[player.id] = { choice: c, ms: Date.now() - gs.qStart };
        // 접속자 전원 응답 시 자동으로 공개로 넘어가기
        const connected = ctx.connectedPlayers().length;
        if (connected > 0 && Object.keys(gs.answers).length >= connected) {
            toReveal(room, gs);
        }
    },

    onDeadline(room, gs, ctx) { toReveal(room, gs); },

    advance(room, gs, ctx) {
        if (gs.phase === 'question') { toReveal(room, gs); return; }
        // reveal → 다음 문제 or 종료
        if (gs.qIndex + 1 >= gs.questions.length) { ctx.finish(); return; }
        gs.qIndex++;
        gs.phase = 'question';
        gs.answers = {};
        gs.qStart = Date.now();
        gs.deadline = Date.now() + ANSWER_MS;
        gs._pushClock = true;
    },

    hostView(room, gs) {
        const q = gs.questions[gs.qIndex];
        const answered = Object.keys(gs.answers).length;
        const connected = room.order.filter(id => room.players.get(id)?.connected).length;
        const secLeft = gs.phase === 'question' ? Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000)) : 0;
        const base = { qNum: gs.qIndex + 1, total: gs.questions.length, category: q.category,
                       question: q.q, choices: q.choices, answered, connected, secLeft };
        if (gs.phase === 'question') {
            return { screen: 'quiz_question', ...base };
        }
        // reveal: 선택 분포 + 상위 득점자
        const dist = [0, 0, 0, 0];
        for (const a of Object.values(gs.answers)) if (a.choice >= 0) dist[a.choice]++;
        const gains = Object.entries(gs.answers)
            .filter(([, a]) => a.pts > 0)
            .map(([pid, a]) => ({ nick: room.players.get(pid)?.nick || '?', pts: a.pts }))
            .sort((x, y) => y.pts - x.pts).slice(0, 5);
        return { screen: 'quiz_reveal', ...base, correct: q.correct, dist, gains,
                 isLast: gs.qIndex + 1 >= gs.questions.length };
    },

    playerView(room, gs, player) {
        const a = gs.answers[player.id];
        if (gs.phase === 'question') {
            const secLeft = Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000));
            return { screen: 'quiz_answer', qNum: gs.qIndex + 1, total: gs.questions.length,
                     choiceCount: 4, answered: !!a, myChoice: a ? a.choice : null, secLeft };
        }
        const q = gs.questions[gs.qIndex];
        const correct = a && a.choice === q.correct;
        return { screen: 'quiz_result', correct: !!correct, answered: !!a,
                 pts: a ? (a.pts || 0) : 0, correctChoice: q.correct, myChoice: a ? a.choice : null };
    },
};
