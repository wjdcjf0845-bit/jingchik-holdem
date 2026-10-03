// ════════════════════════════════════════════════════════════
// 🛡️ 관리자 페이지 — /admin 에 마운트되는 라우터
//
// server.js 에서:
//     app.use('/admin', require('./admin')({ accessLog, MockDB, rooms, io }));
//
// ⚠️ 아이디/비밀번호는 코드에 적지 않는다. 이 저장소는 공개 저장소라서
//    여기 적는 순간 누구나 읽을 수 있다. 환경변수 ADMIN_USER / ADMIN_PASS 로만 받고,
//    설정이 없으면 라우터 자체를 꺼서 관리자 페이지가 아예 열리지 않게 한다.
//
// 이 페이지에서 바꿀 수 있는 건 "뱅크롤 지급/회수" 하나뿐이다(운영자가 요청해서 추가). 계정을 지우는 기능은 없다 —
// 실수 한 번으로 남의 기록이 날아가는 버튼은 요청받은 적이 없으므로 만들지 않았다.
// ════════════════════════════════════════════════════════════
const express = require('express');
const { TYPE_LABEL, shortUA } = require('./lib/accesslog');
const { makeToken, verifyToken, safeEqual, FailLimiter, parseCookies } = require('./lib/adminauth');

const COOKIE = 'jc_adm';
const SESSION_MS = 8 * 60 * 60 * 1000;   // 8시간이면 하루 일과 안에서 다시 안 묻는다
const FAIL_MAX = 8;                       // 4자리 비밀번호는 1만 가지뿐이라 시도 제한이 필수다
const FAIL_WINDOW_MS = 15 * 60 * 1000;

module.exports = function createAdminRouter(deps) {
    const router = express.Router();
    const d = deps || {};

    const USER = d.adminNick || 'admin';

    // 세션 비밀키는 부팅할 때마다 새로 만든다 — 저장소에 남지 않고,
    // 서버가 재시작되면 기존 세션이 모두 끊겨서 더 안전하다.
    const SECRET = process.env.ADMIN_SECRET || require('crypto').randomBytes(32).toString('hex');
    const limiter = new FailLimiter(FAIL_MAX, FAIL_WINDOW_MS);

    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('X-Robots-Tag', 'noindex, nofollow'); // 검색엔진에 잡히지 않게
        res.set('Referrer-Policy', 'no-referrer');
        next();
    });

    // 🎟️ 게임 로그인 → 관리자 페이지로 넘겨줄 때 쓰는 1회용 입장권.
    //    소켓 로그인은 쿠키를 심을 수 없어서, 30초짜리 서명 토큰을 주소에 실어 보낸 뒤 여기서 쿠키로 바꾼다.
    const usedTickets = new Set();
    router.mintTicket = () => '/admin/enter?t=' + encodeURIComponent(makeToken(SECRET + '|ticket', Date.now() + 30000));
    const setSession = (req, res) => res.cookie(COOKIE, makeToken(SECRET, Date.now() + SESSION_MS),
        { httpOnly: true, sameSite: 'strict', maxAge: SESSION_MS, secure: !!req.secure, path: '/admin' });

    router.get('/enter', (req, res) => {
        const t = String(req.query.t || '');
        if (!verifyToken(SECRET + '|ticket', t) || usedTickets.has(t)) return res.redirect('/admin/');
        usedTickets.add(t);
        if (usedTickets.size > 500) usedTickets.clear(); // 30초면 만료되니 오래 들고 있을 이유가 없다
        setSession(req, res);
        res.redirect('/admin/');
    });

    const clientIp = req => {
        const xf = req.headers['x-forwarded-for'];
        let ip = xf ? String(xf).split(',')[0].trim() : (req.ip || req.socket.remoteAddress || '');
        if (ip.startsWith('::ffff:')) ip = ip.slice(7);
        if (ip === '::1') ip = '127.0.0.1';
        return ip;
    };
    const authed = req => verifyToken(SECRET, parseCookies(req.headers.cookie)[COOKIE]);
    const needAuth = (req, res, next) => {
        if (authed(req)) return next();
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: '로그인이 필요합니데이.' });
        res.status(401).type('html').send(loginPage(''));
    };

    router.limiter = limiter; // 게임 로그인 쪽 admin 시도도 같은 제한기를 쓴다
    router.use(express.urlencoded({ extended: false, limit: '4kb' }));

    // ── 로그인 ────────────────────────────────────────────────
    router.post('/login', (req, res) => {
        const ip = clientIp(req);
        if (limiter.blocked(ip)) {
            const mins = Math.ceil(limiter.retryAfterMs(ip) / 60000);
            d.accessLog && d.accessLog.push({ type: 'adminfail', ip, detail: '시도 횟수 초과 차단' });
            return res.status(429).type('html').send(loginPage(`시도가 너무 많습니데이. ${mins}분 뒤에 다시 해보이소.`));
        }
        const u = (req.body && req.body.user) || '';
        const p = (req.body && req.body.pass) || '';
        // 비밀번호 확인은 게임 로그인과 같은 함수(server.js 의 verifyAdmin)에 맡긴다 — 기준이 둘이면 언젠가 어긋난다
        const ok = safeEqual(u, USER) && d.verify && d.verify(p) === true;
        if (!ok) {
            const n = limiter.fail(ip);
            d.accessLog && d.accessLog.push({ type: 'adminfail', ip, nick: String(u).slice(0, 24), detail: `실패 ${n}/${FAIL_MAX}` });
            return res.status(401).type('html').send(loginPage(`아이디나 비밀번호가 틀렸습니데이. (${n}/${FAIL_MAX})`));
        }
        limiter.reset(ip);
        d.accessLog && d.accessLog.push({ type: 'admin', ip, nick: USER, ua: shortUA(req.headers['user-agent']), detail: '관리자 로그인' });
        setSession(req, res);
        res.redirect('/admin/');
    });

    router.post('/logout', (req, res) => {
        res.clearCookie ? res.clearCookie(COOKIE, { path: '/admin' }) : res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/admin`);
        res.redirect('/admin/');
    });

    // ── 화면 ──────────────────────────────────────────────────
    router.get('/', (req, res) => {
        if (!authed(req)) return res.type('html').send(loginPage(''));
        res.type('html').send(dashboardPage());
    });

    // ── 조회 API ──────────────────────────────────────────────
    router.get('/api/overview', needAuth, (req, res) => {
        const now = Date.now();
        const log = d.accessLog;
        const online = [];
        try {
            d.io.sockets.sockets.forEach(s => {
                if (!s.nickname) return;
                online.push({
                    nick: s.nickname,
                    ip: s._ip || '',
                    room: s.currentRoom || '',
                    since: s._loginAt || null,
                    ua: shortUA(s.handshake && s.handshake.headers && s.handshake.headers['user-agent'])
                });
            });
        } catch (e) { /* 소켓 목록을 못 읽어도 나머지는 보여준다 */ }
        online.sort((a, b) => (a.since || 0) - (b.since || 0));

        const rooms = [];
        try {
            d.rooms.forEach(r => rooms.push({
                id: r.roomId,
                mode: r.mode,
                stage: r.gameStage,
                players: (r.playerOrder || []).length,
                humans: (r.playerOrder || []).filter(n => r.players[n] && !r.players[n].isBot).length,
                host: r.hostNickname || ''
            }));
        } catch (e) { /* 동일 */ }

        res.json({
            now,
            summary: log ? log.summary(now) : null,
            online,
            rooms,
            totalUsers: d.MockDB ? d.MockDB.users.size : 0,
            uptimeSec: Math.floor(process.uptime())
        });
    });

    router.get('/api/log', needAuth, (req, res) => {
        if (!d.accessLog) return res.json({ rows: [] });
        const rows = d.accessLog.list({
            type: req.query.type,
            nick: req.query.nick,
            ip: req.query.ip,
            limit: Number(req.query.limit) || 300
        });
        res.json({ rows, labels: TYPE_LABEL });
    });

    // 💰 뱅크롤 지급/회수 — 이 페이지에서 유일하게 "바꾸는" 기능.
    //    · 있는 계정에만 (조회하다 새 계정이 생기면 안 된다) · 한 번에 ±1,000만 이내 · 전부 접속 기록에 남긴다
    //    · peakBankroll 은 건드리지 않는다 — 운영자가 준 돈으로 등급 테두리가 열리면 등급의 뜻이 없어진다
    router.post('/api/grant', needAuth, express.json({ limit: '2kb' }), (req, res) => {
        const nick = String((req.body && req.body.nick) || '');
        const amount = Number(req.body && req.body.amount);
        if (!d.MockDB || !d.MockDB.users.has(nick)) return res.status(404).json({ error: '그런 계정이 없습니데이.' });
        if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10000000) {
            return res.status(400).json({ error: '금액은 0이 아닌 정수, 한 번에 ±1,000만 이내로 넣으이소.' });
        }
        const u = d.MockDB.users.get(nick);
        const before = u.bankroll || 0;
        u.bankroll = Math.max(0, before + amount);
        d.MockDB.save();
        d.accessLog && d.accessLog.push({
            type: 'admin', nick: USER, ip: clientIp(req),
            detail: `${nick} 뱅크롤 ${amount > 0 ? '+' : ''}${amount.toLocaleString()} → ${u.bankroll.toLocaleString()}`
        });
        // 접속 중이면 화면의 잔고도 바로 맞춰준다
        try { d.io.sockets.sockets.forEach(sk => { if (sk.nickname === nick) sk.emit('bankrollUpdate', { bankroll: u.bankroll }); }); } catch (e) {}
        res.json({ ok: true, nick, before, after: u.bankroll });
    });

    router.get('/api/users', needAuth, (req, res) => {
        if (!d.MockDB) return res.json({ rows: [] });
        const q = String(req.query.q || '').toLowerCase();
        const rows = [];
        d.MockDB.users.forEach(u => {
            if (!u || !u.nickname) return;
            if (q && !u.nickname.toLowerCase().includes(q)) return;
            rows.push({
                nick: u.nickname,
                bankroll: u.bankroll || 0,
                peak: u.peakBankroll || 0,
                wins: u.wins || 0,
                hands: u.handsPlayed || 0,
                hasPin: !!u.pinHash,
                hasPhoto: !!(u.photo && u.photo.b64),
                lastSeen: u.lastSeen || null
            });
        });
        rows.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        res.json({ rows: rows.slice(0, 500), total: d.MockDB.users.size });
    });

    return router;
};

// ── 페이지들 (public/ 에 두지 않는다 — 인증을 통과해야만 나간다) ──
const STYLE = `
:root { --paper:#0b1020; --paper-hi:#171f36; --paper-lo:#0f1528; --ink:#eef2fb; --verm:#ffc857; --dim:#8d98b3; --edge:rgba(255,255,255,0.13); }
* { box-sizing:border-box; }
input, select, button { color:var(--ink); }
th { background:var(--paper-hi) !important; }
body { margin:0; background:radial-gradient(ellipse 90% 50% at 50% -10%, rgba(64,110,255,0.18), transparent 60%), var(--paper); min-height:100vh; color:var(--ink); font-family:"Pretendard","Malgun Gothic",system-ui,sans-serif; }
a { color:var(--verm); }
.wrap { max-width:1100px; margin:0 auto; padding:22px 16px 60px; }
h1 { font-size:22px; margin:0 0 4px; letter-spacing:-0.5px; }
.sub { color:var(--dim); font-size:12.5px; margin-bottom:18px; }
.card { background:var(--paper-hi); border:1px solid var(--edge); border-radius:14px; padding:14px 16px; margin-bottom:14px; box-shadow:0 10px 28px rgba(0,0,0,0.45); }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(128px,1fr)); gap:10px; }
.kpi { background:var(--paper-lo); border:1px solid var(--edge); border-radius:10px; padding:10px 12px; }
.kpi .v { font-size:21px; font-weight:900; }
.kpi .k { font-size:11px; color:var(--dim); margin-top:2px; }
.tabs { display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap; }
.tabs button { flex:1; min-width:110px; padding:9px 10px; font:inherit; font-weight:800; font-size:13px; cursor:pointer; background:transparent; color:var(--ink); border:1px solid var(--edge); border-radius:9px; }
.tabs button.on { background:linear-gradient(180deg,#ffe7a8,#ffc857); color:#2c1c00; border-color:transparent; box-shadow:0 0 0 1px rgba(255,200,87,0.55); }
.filters { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:10px; }
.filters input, .filters select { font:inherit; font-size:13px; padding:7px 10px; border:1px solid var(--edge); border-radius:8px; background:var(--paper-hi); color:var(--ink); }
.filters input { min-width:120px; }
table { width:100%; border-collapse:collapse; font-size:12.5px; }
th, td { text-align:left; padding:7px 8px; border-bottom:1px solid rgba(255,255,255,0.09); white-space:nowrap; }
th { font-size:11px; color:var(--dim); text-transform:none; position:sticky; top:0; background:var(--paper-hi); }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
.scroll { max-height:60vh; overflow:auto; }
.tag { display:inline-block; padding:1px 7px; border-radius:999px; font-size:10.5px; font-weight:800; border:1px solid var(--edge); }
.tag { color:#10162a; } .t-login { background:#7fe0b0; } .t-logout { background:#aab4cc; } .t-fail { background:#ff9d8a; }
.t-join { background:#9fc4ff; } .t-admin { background:#ffd98a; } .t-adminfail { background:#ff8a78; } .t-etc { background:#aab4cc; }
.dot { width:8px; height:8px; border-radius:50%; background:#2e9e5b; display:inline-block; margin-right:5px; }
.empty { color:var(--dim); padding:18px 4px; font-size:13px; }
.topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.topbar form { margin:0; }
.btn { font:inherit; font-weight:800; font-size:12px; padding:7px 14px; border:1px solid var(--edge); border-radius:8px; background:var(--paper-hi); color:var(--ink); cursor:pointer; }
.note { font-size:11.5px; color:var(--dim); margin-top:10px; line-height:1.6; }
code { background:var(--paper-lo); padding:1px 5px; border-radius:4px; font-size:12px; }
@media (max-width:620px){ th,td{ padding:6px 5px; font-size:11.5px; } h1{ font-size:19px; } }
`;

function shell(title, body) {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title><style>${STYLE}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function loginPage(err) {
    const msg = err ? `<div style="color:var(--verm); font-weight:800; font-size:13px; margin-bottom:10px">${String(err).replace(/[<>&"]/g, '')}</div>` : '';
    return shell('관리자 로그인', `
<h1>🛡️ 관리자</h1>
<div class="sub">징칡홀덤 운영 · 접속 기록</div>
<div class="card" style="max-width:360px">
  ${msg}
  <form method="post" action="/admin/login">
    <div style="margin-bottom:8px"><input name="user" placeholder="아이디" autocomplete="username" autofocus
      style="width:100%; font:inherit; padding:10px; border:1px solid var(--edge); border-radius:8px; background:var(--paper-hi)"></div>
    <div style="margin-bottom:12px"><input name="pass" type="password" placeholder="비밀번호" autocomplete="current-password"
      style="width:100%; font:inherit; padding:10px; border:1px solid var(--edge); border-radius:8px; background:var(--paper-hi)"></div>
    <button class="btn" style="width:100%; padding:11px; background:linear-gradient(180deg,#ffe7a8,#ffc857); color:#2c1c00; border:none">로그인</button>
  </form>
</div>
<div class="note">게임 로그인 화면에서 <b>admin</b> 으로 로그인해도 바로 이 페이지로 옵니다.<br>비밀번호는 admin 계정에 처음 등록한 4자리입니다. 연속 ${FAIL_MAX}회 틀리면 ${FAIL_WINDOW_MS / 60000}분 동안 막힙니다.</div>`);
}

function dashboardPage() {
    return shell('관리자 — 접속 기록', `
<div class="topbar">
  <div><h1>🛡️ 관리자</h1><div class="sub" id="sub">불러오는 중...</div></div>
  <form method="post" action="/admin/logout"><button class="btn">로그아웃</button></form>
</div>

<div class="card"><div class="kpis" id="kpis"></div></div>

<div class="tabs">
  <button data-v="log" class="on">📋 접속 기록</button>
  <button data-v="online">🟢 지금 접속중</button>
  <button data-v="rooms">🎮 열린 방</button>
  <button data-v="users">👤 계정</button>
</div>

<div class="card" id="panel"></div>
<div class="note">기록은 최근 3,000건 · 최대 60일까지만 보관되고 오래된 것부터 자동으로 지워집니다.<br>
바꿀 수 있는 건 계정 탭의 뱅크롤 지급/회수뿐이고, 한 건 한 건 접속 기록에 남습니다.</div>

<script>
const $ = s => document.querySelector(s);
let view = 'log', over = null, timer = null;

const fmt = t => { if (!t) return '-'; const d = new Date(t);
  const p = n => String(n).padStart(2,'0');
  return \`\${p(d.getMonth()+1)}/\${p(d.getDate())} \${p(d.getHours())}:\${p(d.getMinutes())}:\${p(d.getSeconds())}\`; };
const ago = t => { if (!t) return '-'; const s = Math.floor((Date.now()-t)/1000);
  if (s < 60) return s+'초'; if (s < 3600) return Math.floor(s/60)+'분'; if (s < 86400) return Math.floor(s/3600)+'시간';
  return Math.floor(s/86400)+'일'; };
const num = n => (n||0).toLocaleString();

// 표는 전부 textContent 로 채운다 — 닉네임·UA 는 바깥에서 들어온 값이라 HTML 로 붙이면 안 된다
function table(cols, rows, cell) {
  if (!rows.length) return Object.assign(document.createElement('div'), { className:'empty', textContent:'기록이 없습니데이.' });
  const wrap = document.createElement('div'); wrap.className = 'scroll';
  const t = document.createElement('table');
  const thead = document.createElement('thead'); const htr = document.createElement('tr');
  cols.forEach(c => { const th = document.createElement('th'); th.textContent = c; htr.appendChild(th); });
  thead.appendChild(htr); t.appendChild(thead);
  const tb = document.createElement('tbody');
  rows.forEach(r => { const tr = document.createElement('tr'); cell(tr, r); tb.appendChild(tr); });
  t.appendChild(tb); wrap.appendChild(t); return wrap;
}
function td(tr, text, cls) { const e = document.createElement('td'); if (cls) e.className = cls; e.textContent = text; tr.appendChild(e); return e; }

async function loadOverview() {
  const r = await fetch('/admin/api/overview');
  if (r.status === 401) { location.reload(); return; }
  over = await r.json();
  const s = over.summary || {};
  $('#sub').textContent = \`가동 \${Math.floor(over.uptimeSec/3600)}시간 \${Math.floor(over.uptimeSec%3600/60)}분 · 갱신 \${fmt(over.now)}\`;
  const k = [
    ['🟢 지금 접속', num(over.online.length)],
    ['24시간 접속자', num(s.uniqueNicks24h)],
    ['24시간 IP', num(s.uniqueIps24h)],
    ['24시간 기록', num(s.today)],
    ['로그인 실패(24h)', num(s.fails24h)],
    ['열린 방', num(over.rooms.length)],
    ['총 계정', num(over.totalUsers)],
    ['보관 기록', num(s.total)]
  ];
  const box = $('#kpis'); box.textContent = '';
  k.forEach(([label, v]) => { const d = document.createElement('div'); d.className='kpi';
    const a = document.createElement('div'); a.className='v'; a.textContent=v;
    const b = document.createElement('div'); b.className='k'; b.textContent=label;
    d.append(a,b); box.appendChild(d); });
  if (view === 'online' || view === 'rooms') render();
}

async function render() {
  const p = $('#panel'); p.textContent = '';
  if (view === 'log') {
    const bar = document.createElement('div'); bar.className='filters';
    bar.innerHTML = '<input id="f-nick" placeholder="닉네임"><input id="f-ip" placeholder="IP">' +
      '<select id="f-type"><option value="">전체</option><option value="login">로그인</option>' +
      '<option value="logout">접속 종료</option><option value="fail">로그인 실패</option>' +
      '<option value="join">방 입장</option><option value="admin">관리자 로그인</option>' +
      '<option value="adminfail">관리자 실패</option></select><button class="btn" id="f-go">조회</button>';
    p.appendChild(bar);
    const holder = document.createElement('div'); p.appendChild(holder);
    const run = async () => {
      const q = new URLSearchParams({ nick:$('#f-nick').value, ip:$('#f-ip').value, type:$('#f-type').value, limit:'300' });
      const r = await fetch('/admin/api/log?' + q);
      if (r.status === 401) { location.reload(); return; }
      const { rows, labels } = await r.json();
      holder.textContent = '';
      holder.appendChild(table(['시각','구분','닉네임','IP','기기','비고'], rows, (tr, e) => {
        td(tr, fmt(e.t));
        const c = document.createElement('td'); const s = document.createElement('span');
        s.className = 'tag t-' + e.type; s.textContent = labels[e.type] || e.type; c.appendChild(s); tr.appendChild(c);
        td(tr, e.nick || '-'); td(tr, e.ip || '-'); td(tr, e.ua || '-'); td(tr, e.detail || '');
      }));
    };
    $('#f-go').onclick = run;
    bar.querySelectorAll('input').forEach(i => i.onkeydown = ev => { if (ev.key === 'Enter') run(); });
    run();
  } else if (view === 'online') {
    p.appendChild(table(['닉네임','IP','방','접속 시각','머문 시간','기기'], over.online, (tr, o) => {
      const c = document.createElement('td'); const dot = document.createElement('span'); dot.className='dot';
      c.append(dot, document.createTextNode(o.nick)); tr.appendChild(c);
      td(tr, o.ip || '-'); td(tr, o.room || '로비'); td(tr, fmt(o.since)); td(tr, ago(o.since)); td(tr, o.ua || '-');
    }));
  } else if (view === 'rooms') {
    p.appendChild(table(['방','모드','단계','인원','사람','방장'], over.rooms, (tr, r) => {
      td(tr, r.id); td(tr, r.mode === 'cash' ? '캐시' : '토너먼트');
      td(tr, r.stage === 0 ? '대기' : (r.stage === 5 ? '결과' : '진행 ' + r.stage));
      td(tr, String(r.players), 'num'); td(tr, String(r.humans), 'num'); td(tr, r.host || '-');
    }));
  } else {
    const bar = document.createElement('div'); bar.className='filters';
    bar.innerHTML = '<input id="u-q" placeholder="닉네임 검색"><button class="btn" id="u-go">조회</button>';
    p.appendChild(bar);
    const holder = document.createElement('div'); p.appendChild(holder);
    const run = async () => {
      const r = await fetch('/admin/api/users?q=' + encodeURIComponent($('#u-q').value));
      if (r.status === 401) { location.reload(); return; }
      const { rows } = await r.json();
      holder.textContent = '';
      holder.appendChild(table(['닉네임','뱅크롤','최고','우승','핸드','비번','사진','마지막 접속','지급'], rows, (tr, u) => {
        td(tr, u.nick); td(tr, num(u.bankroll), 'num'); td(tr, num(u.peak), 'num');
        td(tr, String(u.wins), 'num'); td(tr, num(u.hands), 'num');
        td(tr, u.hasPin ? '○' : '-'); td(tr, u.hasPhoto ? '○' : '-');
        td(tr, u.lastSeen ? fmt(u.lastSeen) + ' (' + ago(u.lastSeen) + ' 전)' : '-');
        const gc = document.createElement('td'); const gb = document.createElement('button');
        gb.className = 'btn'; gb.textContent = '💰 지급'; gb.style.padding = '3px 9px';
        gb.onclick = async () => {
          const raw = prompt(u.nick + ' 에게 줄 뱅크롤 (빼려면 음수, 예: 200000)');
          if (raw === null) return;
          const amount = Number(String(raw).replace(/[,s]/g, ''));
          if (!Number.isInteger(amount) || amount === 0) { alert('0이 아닌 정수로 넣으이소.'); return; }
          if (!confirm(u.nick + ' 뱅크롤 ' + (amount > 0 ? '+' : '') + amount.toLocaleString() + ' — 진행할까예?')) return;
          const r = await fetch('/admin/api/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nick: u.nick, amount }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { alert(j.error || '실패했습니데이.'); return; }
          alert(j.nick + ': ' + num(j.before) + ' → ' + num(j.after));
          run();
        };
        gc.appendChild(gb); tr.appendChild(gc);
      }));
    };
    $('#u-go').onclick = run;
    $('#u-q').onkeydown = ev => { if (ev.key === 'Enter') run(); };
    run();
  }
}

document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  view = b.dataset.v; render();
});
loadOverview().then(render);
timer = setInterval(loadOverview, 10000);
</script>`);
}
