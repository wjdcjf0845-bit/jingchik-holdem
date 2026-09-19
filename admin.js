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
// 이 페이지는 "보기 전용"이다. 계정을 고치거나 지우는 기능은 없다 —
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

    const USER = process.env.ADMIN_USER || '';
    const PASS = process.env.ADMIN_PASS || '';
    const ENABLED = !!(USER && PASS);

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

    if (!ENABLED) {
        console.warn('[admin] ADMIN_USER / ADMIN_PASS 미설정 — /admin 비활성화');
        router.use((req, res) => {
            res.status(503).type('html').send(offPage());
        });
        return router;
    }

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
        // 둘 다 상수시간으로 비교한 뒤 & 로 합친다 (한쪽만 맞았는지 시간으로 못 재게)
        const ok = safeEqual(u, USER) & safeEqual(p, PASS);
        if (!ok) {
            const n = limiter.fail(ip);
            d.accessLog && d.accessLog.push({ type: 'adminfail', ip, nick: String(u).slice(0, 24), detail: `실패 ${n}/${FAIL_MAX}` });
            return res.status(401).type('html').send(loginPage(`아이디나 비밀번호가 틀렸습니데이. (${n}/${FAIL_MAX})`));
        }
        limiter.reset(ip);
        d.accessLog && d.accessLog.push({ type: 'admin', ip, nick: USER, ua: shortUA(req.headers['user-agent']), detail: '관리자 로그인' });
        res.cookie
            ? res.cookie(COOKIE, makeToken(SECRET, Date.now() + SESSION_MS), { httpOnly: true, sameSite: 'strict', maxAge: SESSION_MS, secure: !!req.secure, path: '/admin' })
            : res.set('Set-Cookie', `${COOKIE}=${makeToken(SECRET, Date.now() + SESSION_MS)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}`);
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
:root { --paper:#f0e7d2; --paper-hi:#f7f0e0; --paper-lo:#e6dbc2; --ink:#221d15; --verm:#c8501f; --dim:#7a6f5d; }
* { box-sizing:border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font-family:"Pretendard","Malgun Gothic",system-ui,sans-serif; }
a { color:var(--verm); }
.wrap { max-width:1100px; margin:0 auto; padding:22px 16px 60px; }
h1 { font-size:22px; margin:0 0 4px; letter-spacing:-0.5px; }
.sub { color:var(--dim); font-size:12.5px; margin-bottom:18px; }
.card { background:var(--paper-hi); border:2px solid var(--ink); border-radius:14px; padding:14px 16px; margin-bottom:14px; box-shadow:5px 5px 0 rgba(34,29,21,0.28); }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(128px,1fr)); gap:10px; }
.kpi { background:var(--paper-lo); border:1.5px solid var(--ink); border-radius:10px; padding:10px 12px; }
.kpi .v { font-size:21px; font-weight:900; }
.kpi .k { font-size:11px; color:var(--dim); margin-top:2px; }
.tabs { display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap; }
.tabs button { flex:1; min-width:110px; padding:9px 10px; font:inherit; font-weight:800; font-size:13px; cursor:pointer; background:transparent; color:var(--ink); border:2px solid var(--ink); border-radius:9px; }
.tabs button.on { background:var(--ink); color:var(--paper-hi); box-shadow:3px 3px 0 rgba(200,80,31,0.9); }
.filters { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:10px; }
.filters input, .filters select { font:inherit; font-size:13px; padding:7px 10px; border:1.5px solid var(--ink); border-radius:8px; background:var(--paper-hi); color:var(--ink); }
.filters input { min-width:120px; }
table { width:100%; border-collapse:collapse; font-size:12.5px; }
th, td { text-align:left; padding:7px 8px; border-bottom:1px solid rgba(34,29,21,0.18); white-space:nowrap; }
th { font-size:11px; color:var(--dim); text-transform:none; position:sticky; top:0; background:var(--paper-hi); }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
.scroll { max-height:60vh; overflow:auto; }
.tag { display:inline-block; padding:1px 7px; border-radius:999px; font-size:10.5px; font-weight:800; border:1.5px solid var(--ink); }
.t-login { background:#cfe8d8; } .t-logout { background:var(--paper-lo); } .t-fail { background:#f3c7b6; }
.t-join { background:#d8def0; } .t-admin { background:#efd9a6; } .t-adminfail { background:#f0b0a0; } .t-etc { background:var(--paper-lo); }
.dot { width:8px; height:8px; border-radius:50%; background:#2e9e5b; display:inline-block; margin-right:5px; }
.empty { color:var(--dim); padding:18px 4px; font-size:13px; }
.topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.topbar form { margin:0; }
.btn { font:inherit; font-weight:800; font-size:12px; padding:7px 14px; border:2px solid var(--ink); border-radius:8px; background:var(--paper-hi); color:var(--ink); cursor:pointer; }
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

function offPage() {
    return shell('관리자 — 미설정', `
<h1>🛡️ 관리자 페이지가 꺼져 있습니데이</h1>
<div class="sub">아이디·비밀번호가 설정되지 않아 열리지 않습니다.</div>
<div class="card">
  <p style="margin:0 0 10px; font-size:13.5px; line-height:1.7">
    이 저장소는 <b>공개(public)</b>라 아이디·비밀번호를 코드에 적으면 누구나 볼 수 있습니다.
    그래서 <b>환경변수로만</b> 받도록 해두었습니다.
  </p>
  <p style="margin:0 0 6px; font-size:13px"><b>Render</b> → 해당 서비스 → <b>Environment</b> 에 두 개를 추가하고 재배포하이소:</p>
  <p style="margin:0 0 10px"><code>ADMIN_USER = admin</code> &nbsp; <code>ADMIN_PASS = 1004</code></p>
  <p style="margin:0; font-size:13px"><b>내 컴퓨터</b>에서 켤 때는:</p>
  <p style="margin:6px 0 0"><code>ADMIN_USER=admin ADMIN_PASS=1004 node server.js</code></p>
</div>
<div class="note">비밀번호 4자리는 경우의 수가 1만 개뿐이라 언제든 뚫릴 수 있습니다.
바깥에 열려 있는 주소라면 더 긴 비밀번호를 권합니다 — 환경변수 값만 바꾸면 됩니다.</div>`);
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
      style="width:100%; font:inherit; padding:10px; border:1.5px solid var(--ink); border-radius:8px; background:var(--paper-hi)"></div>
    <div style="margin-bottom:12px"><input name="pass" type="password" placeholder="비밀번호" autocomplete="current-password"
      style="width:100%; font:inherit; padding:10px; border:1.5px solid var(--ink); border-radius:8px; background:var(--paper-hi)"></div>
    <button class="btn" style="width:100%; padding:11px; background:var(--ink); color:var(--paper-hi)">로그인</button>
  </form>
</div>
<div class="note">로그인 실패는 기록에 남습니다. 연속 ${FAIL_MAX}회 틀리면 ${FAIL_WINDOW_MS / 60000}분 동안 막힙니다.</div>`);
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
이 페이지는 보기 전용입니다 — 여기서 계정을 고치거나 지울 수 없습니다.</div>

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
      holder.appendChild(table(['닉네임','뱅크롤','최고','우승','핸드','비번','사진','마지막 접속'], rows, (tr, u) => {
        td(tr, u.nick); td(tr, num(u.bankroll), 'num'); td(tr, num(u.peak), 'num');
        td(tr, String(u.wins), 'num'); td(tr, num(u.hands), 'num');
        td(tr, u.hasPin ? '○' : '-'); td(tr, u.hasPhoto ? '○' : '-');
        td(tr, u.lastSeen ? fmt(u.lastSeen) + ' (' + ago(u.lastSeen) + ' 전)' : '-');
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
