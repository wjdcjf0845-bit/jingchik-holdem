// 🌙 밤마다 봇 맞대결(A/B) — 운영 서버와 따로, 시험 서버 두 대를 띄워 "새 전략 봇" 과 "지금 봇" 을 같은 테이블에서 맞붙인다.
//    짝지은 설계: 서버1 은 닉네임 해시 비트가 1 인 봇이 새 전략, 서버2 는 반대쪽 봇이 새 전략 — 이름·자리 운을 상쇄한다.
//    잣대: 핸드마다 각 봇의 칩 변화(bb) → 새 전략 bb/100 vs 지금 bb/100 (우승 횟수보다 표본이 수십 배 많다).
//    결과: <JINGCHIK_HOME>\ab\<날짜>-<스위치>.json 과 ab\summary.log 한 줄. 관리자 페이지에서도 본다.
//    운영 서버가 시켜서 돈다(새벽 3시 · 접속자 없고 대회 없을 때 — server.js 의 '밤 맞대결'). 손으로: node tools/minipc/nightab.js
//    환경변수: AB_SWITCH(기본 BOT_AB13) · AB_MIN(분, 기본 120) · AB_TABLES(서버당 테이블 수, 기본 3) · AB_START(시작 칩, 기본 20000 = 1레벨 기준 200bb)
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..', '..');
const HOME = process.env.JINGCHIK_HOME || (process.platform === 'win32' ? 'C:\\jingchik-data' : path.join(os.tmpdir(), 'jingchik-data'));
const SW = process.env.AB_SWITCH || 'BOT_AB13', MIN = Number(process.env.AB_MIN || 120), TABLES = Number(process.env.AB_TABLES || 3);
const START = Number(process.env.AB_START || 20000), PORTS = [3901, 3902];
const OUT = path.join(HOME, 'ab'), sleep = ms => new Promise(r => setTimeout(r, ms));
const hashNick = n => { let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0; return h; };
const isBit = n => ((hashNick(n) >> 4) & 1) === 1;

function startServer(port, side) {
    const dir = path.join(OUT, 'tmp' + side);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, BOT_FAST: '1', DEV_FAST_HANDS: '1', MAX_PLAYERS: '0', [SW]: String(side),
        TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', ALERT_NTFY: '', WATCHDOG: '' });
    const c = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
    try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}   // 운영 서버보다 늘 뒤에
    return c;
}

// 한 테이블: 심판(사람 1명, 체크·폴드만) + 고수 봇 5명. 토너먼트지만 블라인드를 거의 안 올려 깊은 스택을 오래 친다.
function table(port, tag) {
    const { io } = require('socket.io-client');
    const H = io('http://localhost:' + port, { transports: ['websocket'], forceNew: true });
    const ME = '심판' + tag, ROOM = 'AB' + tag, ev = {}; let prev = null, prevHand = -1, prevBB = 100, games = 0, started = false;
    const settle = now => { if (!prev) return; Object.keys(prev).forEach(n => { if (prev[n] <= 0) return; const e = ev[n] || (ev[n] = { bb: 0, bb2: 0, hands: 0 }), x = ((now[n] || 0) - prev[n]) / prevBB; e.bb += x; e.bb2 += x * x; e.hands++; }); };
    H.on('connect', () => H.emit('login', { nickname: ME, pin: '1234' }));
    H.on('loginSuccess', () => { if (started) return; started = true;
        H.emit('joinRoom', { roomId: ROOM, settings: { mode: 'tournament', startingChips: START, blindUpInterval: 3600, turnTimeLimit: 5, maxRebuys: 0 } }); });
    H.on('joinRoomSuccess', () => { setTimeout(() => { for (let b = 0; b < 5; b++) H.emit('addBot', { difficulty: 'hard' }); }, 500); setTimeout(() => H.emit('startFirstHand'), 1500); });
    H.on('updateTable', d => {
        if (d.handId !== prevHand && d.gameStage >= 1) {
            const now = {}; Object.entries(d.players).forEach(([n, p]) => { if (n.startsWith('🤖')) now[n] = (p.chips || 0) + (p.currentBet || 0); });
            settle(now); prev = now; prevHand = d.handId; prevBB = (d.tournamentInfo && d.tournamentInfo.bb) || 100;
        }
        const me = d.players[ME];
        if (me && d.turnPlayerId === ME) setTimeout(() => H.emit('action', { type: d.currentHighestBet - me.currentBet > 0 ? 'fold' : 'check' }), 3);
    });
    // 한 판(토너먼트)이 끝나면 마지막 핸드는 버리고 새로 시작 — 스택이 다시 깊어진다
    H.on('tournamentEnd', () => { prev = null; games++; setTimeout(() => H.emit('startFirstHand'), 2500); });
    return { done: () => { H.close(); return { ev, games }; } };
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    // 겹쳐 돌지 않게 — 서버가 새벽 3시에 다시 켜지면 또 시작하려 할 수 있다(시험 서버 포트가 겹친다)
    const LOCK = path.join(OUT, 'running.lock');
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs < (MIN + 30) * 60000) { console.log('이미 돌고 있습니다: ' + LOCK); process.exit(0); } } catch (e) {}
    fs.writeFileSync(LOCK, String(process.pid));
    process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch (e) {} });
    const t0 = Date.now();
    const servers = PORTS.map((p, i) => startServer(p, i + 1));
    await sleep(6000);
    const T = [];
    PORTS.forEach((p, i) => { for (let k = 0; k < TABLES; k++) T.push({ side: i + 1, t: table(p, `${i + 1}_${k}_${process.pid % 1000}`) }); });
    await sleep(MIN * 60000);
    const acc = { neu: { bb: 0, bb2: 0, hands: 0 }, cur: { bb: 0, bb2: 0, hands: 0 } }; let games = 0;
    T.forEach(({ side, t }) => {
        const r = t.done(); games += r.games;
        // 서버1: 해시 비트 1 인 봇이 새 전략 · 서버2: 비트 0 인 봇이 새 전략
        Object.entries(r.ev).forEach(([n, e]) => { const neu = side === 1 ? isBit(n) : !isBit(n); const g = neu ? acc.neu : acc.cur; g.bb += e.bb; g.bb2 += e.bb2; g.hands += e.hands; });
    });
    servers.forEach(c => { try { c.kill(); } catch (e) {} });
    const per100 = g => (g.hands ? Math.round(g.bb / g.hands * 1000) / 10 : null);
    const res = { date: new Date().toISOString(), switch: SW, minutes: Math.round((Date.now() - t0) / 60000), tables: TABLES * 2, games,
        neu: { per100: per100(acc.neu), hands: acc.neu.hands }, cur: { per100: per100(acc.cur), hands: acc.cur.hands } };
    // 차이의 표준오차(bb/100): 실제로 잰 핸드당 분산으로 계산한다. (예전엔 핸드당 10bb 로 가정했다가, 아무것도 안 바꾼 A/A 시험에서 그 5배 넘는 차이가 나왔다 — 200bb 깊은 스택은 한 판의 출렁임이 훨씬 크다)
    const v = g => (g.hands > 1 ? Math.max(0, g.bb2 / g.hands - (g.bb / g.hands) ** 2) / g.hands : 0);
    res.se100 = acc.neu.hands && acc.cur.hands ? Math.round(Math.sqrt(v(acc.neu) + v(acc.cur)) * 1000) / 10 : null;
    res.verdict = res.neu.per100 == null ? '표본 없음' : Math.abs(res.neu.per100 - res.cur.per100) < 2 * res.se100 ? '차이 없음(노이즈 범위)' : (res.neu.per100 > res.cur.per100 ? '새 전략이 더 셈' : '지금 봇이 더 셈');
    const day = new Date(); const tag = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    fs.writeFileSync(path.join(OUT, `${tag}-${SW}.json`), JSON.stringify(res, null, 1));
    fs.appendFileSync(path.join(OUT, 'summary.log'), `${tag} ${SW} 새 ${res.neu.per100} bb/100 (${res.neu.hands}핸드) · 지금 ${res.cur.per100} bb/100 (${res.cur.hands}핸드) · ±${res.se100} → ${res.verdict}\n`);
    PORTS.forEach((p, i) => fs.rmSync(path.join(OUT, 'tmp' + (i + 1)), { recursive: true, force: true }));
    console.log(JSON.stringify(res));
    process.exit(0);
})();
