// 🚀 게임: 총알 피하기 — 폰 화면에서 손가락으로 우주선을 움직여 탄막을 피한다
//
// ⚡ 구조가 핵심:
//    서버는 '씨드 + 시작시각'만 뿌리고, 실제 게임은 각 폰에서 60fps로 로컬 실행한다.
//    (서버가 매 프레임 좌표를 중계하면 파티 와이파이 지연 때문에 조작이 밀려 게임이 망가짐)
//    같은 씨드 = 모두 똑같은 탄막 → 공정. 폰은 '살아있음/죽었음'만 가끔 보고한다.
const NUM_ROUNDS = 3;
const ROUND_MS = 45000;            // 라운드 최대 시간 (그 전에 전원 사망하면 조기 종료)
const COUNTDOWN_MS = 3000;         // "3·2·1" 카운트다운
const RANK_PTS = [100, 80, 65, 55, 45, 40, 35, 30, 25, 20, 15, 10];
// ⚖️ 밸런스: 다른 게임과 총점을 맞추기 위해 3라운드 기준 배율 적용
const BASELINE_ROUNDS = 3;
const RANK_SCALE = BASELINE_ROUNDS / NUM_ROUNDS;
function rankPts(order) { return Math.max(3, Math.round((RANK_PTS[order] || 5) * RANK_SCALE)); }

function startRound(gs) {
    gs.phase = 'countdown';
    gs.seed = Math.floor(Math.random() * 1e9);   // 이번 라운드 탄막 패턴
    gs.alive = {};        // pid -> true (라운드 시작 시 참가자로 채움)
    gs.deaths = {};       // pid -> 생존 ms
    gs.startAt = Date.now() + COUNTDOWN_MS;      // 실제 게임 시작 시각
    gs.deadline = gs.startAt;                    // 카운트다운 종료 → playing 전환
    gs._pushClock = false;
}

function beginPlay(gs, ctx) {
    gs.phase = 'playing';
    for (const p of ctx.awaitedPlayers()) gs.alive[p.id] = true;
    gs.deadline = Date.now() + ROUND_MS;
    gs._pushClock = true;
}

// 라운드 종료 → 생존 시간 순으로 순위·점수
function toResult(room, gs, ctx) {
    if (gs.phase !== 'playing') return;
    const surviveMs = pid => (gs.deaths[pid] != null ? gs.deaths[pid] : ROUND_MS);
    const rows = Object.keys(gs.alive)
        .map(pid => ({ pid, ms: surviveMs(pid), survived: gs.deaths[pid] == null }))
        .sort((a, b) => b.ms - a.ms);           // 오래 버틴 순
    gs.ranking = rows.map((r, i) => {
        const pts = rankPts(i);
        ctx.award(r.pid, pts);
        const p = room.players.get(r.pid);
        return { pid: r.pid, nick: p?.nick || '?', color: p?.color,
                 rank: i + 1, pts, sec: +(r.ms / 1000).toFixed(1), survived: r.survived };
    });
    gs.phase = 'result';
    gs.deadline = 0; gs._pushClock = false;
}

module.exports = {
    id: 'dodge', name: '총알 피하기', emoji: '🚀',
    desc: '탄막을 피해 끝까지 살아남기',

    rules: {
        goal: '쏟아지는 총알을 피해 가장 오래 살아남으세요',
        steps: [
            '폰 화면에 <b>내 우주선</b>이 나타납니다',
            '<b>화면을 손가락으로 끌어</b> 우주선을 움직이세요 (떼지 말고 그대로)',
            '총알에 맞으면 <b>탈락</b> — TV에서 남은 생존자를 확인하세요',
        ],
        scoring: [
            '<b>오래 버틴 순서</b>대로 점수 (' + rankPts(0) + ' · ' + rankPts(1) + ' · ' + rankPts(2) + '…)',
            '총 <b>' + NUM_ROUNDS + '라운드</b> 합산',
            '끝까지 살아남으면 만점',
        ],
        tips: [
            '모두 <b>똑같은 총알 패턴</b>을 받습니다 — 운이 아니라 실력',
            '시간이 갈수록 총알이 많아지고 빨라져요',
            '가장자리에 몰리면 피할 곳이 없어집니다 · 가운데를 지키세요',
        ],
    },

    create(room, ctx) {
        const gs = { rIndex: 0, total: NUM_ROUNDS, ranking: [] };
        startRound(gs);
        return gs;
    },

    action(room, gs, player, msg, ctx) {
        if (gs.phase !== 'playing') return;
        if (msg.type === 'dead') {
            if (!gs.alive[player.id] || gs.deaths[player.id] != null) return;
            // 폰이 보고한 생존 시간을 사용하되, 서버 경과시간을 넘지 못하게 상한
            const serverMs = Date.now() - gs.startAt;
            const c = Number(msg.ms);
            const ms = (Number.isFinite(c) && c >= 0 && c <= serverMs + 500) ? Math.round(c) : serverMs;
            gs.deaths[player.id] = Math.max(0, ms);
            // 전원 사망 시 조기 종료
            const living = Object.keys(gs.alive).filter(pid => gs.deaths[pid] == null);
            if (living.length === 0) toResult(room, gs, ctx);
        }
    },

    onDeadline(room, gs, ctx) {
        if (gs.phase === 'countdown') { beginPlay(gs, ctx); return; }
        if (gs.phase === 'playing') { toResult(room, gs, ctx); return; }
    },

    // 게임 도중 이탈하면 그 시점까지 버틴 것으로 처리 (라운드가 안 끝나는 것 방지)
    onPlayerLeave(room, gs, player, ctx) {
        if (gs.phase !== 'playing') return;
        if (gs.alive[player.id] && gs.deaths[player.id] == null) {
            gs.deaths[player.id] = Math.max(0, Date.now() - gs.startAt);
            const living = Object.keys(gs.alive).filter(pid => gs.deaths[pid] == null);
            if (living.length === 0) toResult(room, gs, ctx);
        }
    },

    advance(room, gs, ctx) {
        if (gs.phase === 'countdown') return;              // 카운트다운 중엔 무시
        if (gs.phase === 'playing') { toResult(room, gs, ctx); return; }
        if (gs.rIndex + 1 >= NUM_ROUNDS) { ctx.finish(); return; }
        gs.rIndex++;
        startRound(gs);
    },

    hostView(room, gs) {
        const base = { round: gs.rIndex + 1, total: NUM_ROUNDS };
        if (gs.phase === 'countdown') {
            const left = Math.max(0, Math.ceil((gs.startAt - Date.now()) / 1000));
            return { screen: 'dodge_countdown', ...base, count: left };
        }
        if (gs.phase === 'playing') {
            const elapsed = Math.max(0, Date.now() - gs.startAt);
            const list = Object.keys(gs.alive).map(pid => {
                const p = room.players.get(pid);
                return { nick: p?.nick || '?', color: p?.color,
                         dead: gs.deaths[pid] != null,
                         sec: gs.deaths[pid] != null ? +(gs.deaths[pid] / 1000).toFixed(1) : null };
            });
            const living = list.filter(x => !x.dead).length;
            return { screen: 'dodge_playing', ...base, elapsed: +(elapsed / 1000).toFixed(1),
                     living, totalPlayers: list.length, players: list,
                     secLeft: Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000)) };
        }
        return { screen: 'dodge_result', ...base, ranking: gs.ranking || [],
                 isLast: gs.rIndex + 1 >= NUM_ROUNDS };
    },

    playerView(room, gs, player) {
        const base = { round: gs.rIndex + 1, total: NUM_ROUNDS };
        if (gs.phase === 'countdown') {
            return { screen: 'dodge_countdown', ...base,
                     startIn: Math.max(0, gs.startAt - Date.now()) };
        }
        if (gs.phase === 'playing') {
            const joined = !!gs.alive[player.id];
            return { screen: 'dodge_playing', ...base,
                     seed: gs.seed,                       // 탄막 패턴 (전원 동일)
                     startAt: gs.startAt,                 // 서버 기준 시작 시각
                     roundMs: ROUND_MS,
                     playing: joined && gs.deaths[player.id] == null,
                     spectator: !joined,                  // 라운드 중간에 들어온 사람
                     dead: gs.deaths[player.id] != null,
                     mySec: gs.deaths[player.id] != null ? +(gs.deaths[player.id] / 1000).toFixed(1) : null,
                     living: Object.keys(gs.alive).filter(pid => gs.deaths[pid] == null).length };
        }
        const mine = (gs.ranking || []).find(r => r.pid === player.id);
        return { screen: 'dodge_result', ...base,
                 rank: mine ? mine.rank : null, pts: mine ? mine.pts : 0,
                 sec: mine ? mine.sec : null, survived: mine ? mine.survived : false,
                 totalPlayers: (gs.ranking || []).length };
    },
};
