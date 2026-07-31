// 🚀 게임: 총알 피하기 (TV 아레나) — TV 한 화면에서 전원이 함께 탄막을 피한다
//
// 구조: 서버가 시뮬레이션을 소유하고, 폰은 '터치패드'로 이동 입력만 보낸다.
//   폰 → 서버 : player:pad (초당 ~20회, 브로드캐스트 우회)
//   서버 → TV : host:arena (초당 30회, TV 한 대에만 전송)
//   서버 → 폰 : 생존/사망 등 상태가 바뀔 때만 (일반 브로드캐스트)
//
// ⚠️ 조작 지연(폰→서버→TV, 50~150ms) 대응이 설계의 핵심:
//   - 총알은 '경고선'으로 먼저 예고한 뒤 발사한다 (예고 시간 동안 피할 수 있음)
//   - 총알 속도는 느리게, 아레나는 넓게 → 반사신경이 아니라 위치 선정 싸움
const NUM_ROUNDS = 3;
const ROUND_MS = 45000;
const COUNTDOWN_MS = 3000;
const TICK_MS = 33;                 // 시뮬레이션 30fps

const FW = 200, FH = 112;           // 아레나 (TV 16:9)
const SHIP_R = 3.2;
const SHIP_SPEED = 62;              // 초당 이동 한도 (조작 폭주·조작질 방지)
const BULLET_R = 2.0;
const WARN_MS = 850;                // 경고선이 뜬 뒤 발사까지 — 지연을 흡수하는 장치
const BULLET_SPEED = 46;            // 느리게: 지연이 있어도 피할 수 있게

const RANK_PTS = [100, 80, 65, 55, 45, 40, 35, 30, 25, 20, 15, 10];
const BASELINE_ROUNDS = 3;
const RANK_SCALE = BASELINE_ROUNDS / NUM_ROUNDS;
function rankPts(order) { return Math.max(3, Math.round((RANK_PTS[order] || 5) * RANK_SCALE)); }

const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const r1 = v => Math.round(v * 10) / 10;   // 전송량 절감

function startRound(gs) {
    gs.phase = 'countdown';
    gs.ships = {};
    gs.bullets = [];
    gs.warns = [];
    gs.nextSpawn = 0.6;
    gs.startAt = Date.now() + COUNTDOWN_MS;
    gs.lastTick = gs.startAt;
    gs.deadline = gs.startAt;
    gs._pushClock = false;
}

function beginPlay(gs, ctx) {
    gs.phase = 'playing';
    const players = ctx.awaitedPlayers();
    // 시작 위치를 원형으로 고르게 배치 (겹치지 않게)
    players.forEach((p, i) => {
        const ang = (i / Math.max(1, players.length)) * Math.PI * 2;
        gs.ships[p.id] = {
            x: FW / 2 + Math.cos(ang) * FW * 0.22,
            y: FH / 2 + Math.sin(ang) * FH * 0.28,
            pdx: 0, pdy: 0, dead: false, deathMs: null,
            nick: p.nick, color: p.color,
        };
    });
    gs.lastTick = Date.now();
    gs.deadline = Date.now() + ROUND_MS;
    gs._pushClock = false;
}

// 경고선 생성: 아레나 한쪽 변에서 반대편으로 지나가는 직선 경로를 예고
function spawnWarning(gs, t, rnd) {
    const prog = clamp(t / (ROUND_MS / 1000), 0, 1);
    const side = Math.floor(rnd() * 4);
    let x, y;
    if (side === 0) { x = rnd() * FW; y = -4; }
    else if (side === 1) { x = rnd() * FW; y = FH + 4; }
    else if (side === 2) { x = -4; y = rnd() * FH; }
    else { x = FW + 4; y = rnd() * FH; }
    const tx = FW * (0.1 + rnd() * 0.8), ty = FH * (0.1 + rnd() * 0.8);
    const dx = tx - x, dy = ty - y;
    const len = Math.hypot(dx, dy) || 1;
    const sp = BULLET_SPEED * (0.85 + rnd() * 0.4) * (1 + prog * 0.45);
    gs.warns.push({ x, y, vx: dx / len * sp, vy: dy / len * sp, fireAt: Date.now() + WARN_MS });
}

function toResult(room, gs, ctx) {
    if (gs.phase !== 'playing') return;
    const rows = Object.entries(gs.ships)
        .map(([pid, s]) => ({ pid, ms: s.deathMs != null ? s.deathMs : ROUND_MS, survived: s.deathMs == null }))
        .sort((a, b) => b.ms - a.ms);
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
    desc: 'TV 화면에서 다 같이 탄막 피하기',
    tickMs: TICK_MS,

    rules: {
        goal: 'TV 화면을 보며 총알을 피해 가장 오래 살아남으세요',
        steps: [
            '<b>TV 화면</b>에 참가자 전원의 우주선이 나타납니다',
            '폰은 <b>조종기</b> — 화면을 문지르면 내 우주선이 그 방향으로 움직여요',
            '<b>빨간 경고선</b>이 뜨면 잠시 후 그 길로 총알이 지나갑니다',
        ],
        scoring: [
            '<b>오래 버틴 순서</b>대로 점수 (' + rankPts(0) + ' · ' + rankPts(1) + ' · ' + rankPts(2) + '…)',
            '총 <b>' + NUM_ROUNDS + '라운드</b> 합산',
            '끝까지 살아남으면 만점',
        ],
        tips: [
            '<b>폰이 아니라 TV를 보세요</b> — 폰은 그냥 문지르기만 하면 됩니다',
            '경고선이 뜨고 나서 움직여도 충분히 피할 수 있어요',
            '가장자리는 피할 곳이 없습니다 · 가운데 넓은 곳을 지키세요',
        ],
    },

    create(room, ctx) {
        const gs = { rIndex: 0, total: NUM_ROUNDS, ranking: [], seed: Math.random() * 1e9 };
        startRound(gs);
        return gs;
    },

    // 폰 터치패드 입력 (브로드캐스트 없음)
    onPad(room, gs, player, data) {
        if (gs.phase !== 'playing') return;
        const s = gs.ships[player.id];
        if (!s || s.dead) return;
        const dx = Number(data.dx), dy = Number(data.dy);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        // 누적 이동 요청 (실제 적용은 tick에서 속도 제한과 함께)
        s.pdx = clamp(s.pdx + dx, -FW, FW);
        s.pdy = clamp(s.pdy + dy, -FH, FH);
    },

    // 30fps 시뮬레이션 + TV 전송
    onTick(room, gs, ctx, toHost) {
        const now = Date.now();
        if (gs.phase === 'countdown') {
            toHost('host:arena', { phase: 'countdown',
                count: Math.max(0, Math.ceil((gs.startAt - now) / 1000)) });
            return;
        }
        if (gs.phase !== 'playing') return;

        const dt = Math.min(0.12, Math.max(0, (now - gs.lastTick) / 1000));
        gs.lastTick = now;
        const t = (now - gs.startAt) / 1000;

        // 1) 입력 반영 — 속도 제한(초과분은 다음 틱으로 이월해 조작이 끊기지 않게)
        for (const s of Object.values(gs.ships)) {
            if (s.dead) continue;
            const maxStep = SHIP_SPEED * dt;
            const len = Math.hypot(s.pdx, s.pdy);
            let ax = s.pdx, ay = s.pdy;
            if (len > maxStep) { const k = maxStep / len; ax = s.pdx * k; ay = s.pdy * k; }
            s.x = clamp(s.x + ax, SHIP_R, FW - SHIP_R);
            s.y = clamp(s.y + ay, SHIP_R, FH - SHIP_R);
            s.pdx -= ax; s.pdy -= ay;
        }

        // 2) 경고선 생성 (갈수록 촘촘하게)
        const prog = clamp(t / (ROUND_MS / 1000), 0, 1);
        const rnd = Math.random;
        while (t >= gs.nextSpawn) {
            const waves = 1 + Math.floor(prog * 2.4);
            for (let i = 0; i < waves; i++) spawnWarning(gs, t, rnd);
            gs.nextSpawn += Math.max(0.34, 1.05 - prog * 0.72);
        }

        // 3) 경고 → 발사
        for (let i = gs.warns.length - 1; i >= 0; i--) {
            if (now >= gs.warns[i].fireAt) {
                const w = gs.warns[i];
                gs.bullets.push({ x: w.x, y: w.y, vx: w.vx, vy: w.vy });
                gs.warns.splice(i, 1);
            }
        }

        // 4) 총알 이동 + 화면 밖 제거
        for (let i = gs.bullets.length - 1; i >= 0; i--) {
            const b = gs.bullets[i];
            b.x += b.vx * dt; b.y += b.vy * dt;
            if (b.x < -12 || b.x > FW + 12 || b.y < -12 || b.y > FH + 12) gs.bullets.splice(i, 1);
        }

        // 5) 충돌 판정
        const hitR = (BULLET_R + SHIP_R) * (BULLET_R + SHIP_R);
        let died = false;
        for (const [pid, s] of Object.entries(gs.ships)) {
            if (s.dead) continue;
            for (const b of gs.bullets) {
                const dx = b.x - s.x, dy = b.y - s.y;
                if (dx * dx + dy * dy < hitR) {
                    s.dead = true; s.deathMs = Math.max(0, Math.round(t * 1000));
                    died = true;
                    break;
                }
            }
        }
        // 사망이 생기면 TV 생존자 수와 해당 폰의 '탈락' 화면을 갱신한다
        // (아레나 프레임은 TV에만 가므로, 이걸 안 하면 폰이 자기 죽은 줄 모른다)
        if (died) ctx.broadcast();

        // 6) TV로 화면 전송
        toHost('host:arena', {
            phase: 'playing', t: r1(t), fw: FW, fh: FH,
            ships: Object.values(gs.ships).map(s => ({
                x: r1(s.x), y: r1(s.y), n: s.nick, c: s.color, d: s.dead ? 1 : 0 })),
            bullets: gs.bullets.map(b => ({ x: r1(b.x), y: r1(b.y) })),
            warns: gs.warns.map(w => ({ x: r1(w.x), y: r1(w.y),
                vx: r1(w.vx), vy: r1(w.vy), p: r1(clamp(1 - (w.fireAt - now) / WARN_MS, 0, 1)) })),
            br: BULLET_R, sr: SHIP_R,
        });

        // 7) 전원 사망 → 조기 종료
        const living = Object.values(gs.ships).filter(s => !s.dead).length;
        if (Object.keys(gs.ships).length > 0 && living === 0) {
            toResult(room, gs, ctx);
            ctx.broadcast();
        }
    },

    action() { /* 이 게임은 player:pad 로만 입력받는다 */ },

    onDeadline(room, gs, ctx) {
        if (gs.phase === 'countdown') { beginPlay(gs, ctx); return; }
        if (gs.phase === 'playing') { toResult(room, gs, ctx); return; }
    },

    onPlayerLeave(room, gs, player, ctx) {
        if (gs.phase !== 'playing') return;
        const s = gs.ships[player.id];
        if (s && !s.dead) {
            s.dead = true;
            s.deathMs = Math.max(0, Date.now() - gs.startAt);
        }
    },

    advance(room, gs, ctx) {
        if (gs.phase === 'countdown') return;
        if (gs.phase === 'playing') { toResult(room, gs, ctx); return; }
        if (gs.rIndex + 1 >= NUM_ROUNDS) { ctx.finish(); return; }
        gs.rIndex++;
        startRound(gs);
    },

    hostView(room, gs) {
        const base = { round: gs.rIndex + 1, total: NUM_ROUNDS };
        if (gs.phase === 'countdown') return { screen: 'dodge_countdown', ...base };
        if (gs.phase === 'playing') {
            const list = Object.values(gs.ships);
            return { screen: 'dodge_playing', ...base,
                     living: list.filter(s => !s.dead).length, totalPlayers: list.length };
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
            const s = gs.ships[player.id];
            return { screen: 'dodge_playing', ...base,
                     playing: !!s && !s.dead,
                     spectator: !s,
                     dead: !!s && s.dead,
                     mySec: s && s.deathMs != null ? +(s.deathMs / 1000).toFixed(1) : null,
                     living: Object.values(gs.ships).filter(x => !x.dead).length };
        }
        const mine = (gs.ranking || []).find(r => r.pid === player.id);
        return { screen: 'dodge_result', ...base,
                 rank: mine ? mine.rank : null, pts: mine ? mine.pts : 0,
                 sec: mine ? mine.sec : null, survived: mine ? mine.survived : false,
                 totalPlayers: (gs.ranking || []).length };
    },
};
