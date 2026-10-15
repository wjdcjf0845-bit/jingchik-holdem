// 🖥️ 미니 PC 운영 감시기 — Render 대신 집의 미니 PC 에서 서버를 돌린다.
//    · 서버(server.js)를 띄우고, 죽으면 다시 띄운다(10분 안에 5번 넘게 죽으면 1분씩 쉬었다가).
//    · GitHub main 에 새 커밋이 올라오면 받아서 재시작한다(Render 의 자동 배포 대신 — git push 하면 몇 분 안에 반영).
//      진행 중인 대회(딥스택·MTT)가 있으면 끝날 때까지 미룬다(최대 4시간).
//    · 설정은 저장소 밖 파일에서 읽는다: <JINGCHIK_HOME>\server.env (KEY=값 줄). 기본 JINGCHIK_HOME = C:\jingchik-data
//      전적 파일(DATA_DIR)·로그도 그 폴더에 둔다 — 저장소를 지우고 다시 받아도 데이터는 남는다.
//    실행: node tools/minipc/runner.js   (setup.ps1 이 Windows 시작 시 자동 실행되게 등록한다)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http');

const ROOT = process.env.RUNNER_ROOT || path.join(__dirname, '..', '..');      // (RUNNER_ROOT: 시험용으로 다른 폴더를 돌린다)
const HOME = process.env.JINGCHIK_HOME || 'C:\\jingchik-data';
const ENV_FILE = path.join(HOME, 'server.env');
const RUN_LOG = path.join(HOME, 'runner.log'), SERVER_LOG = path.join(HOME, 'server.log');
const POLL_MS = Number(process.env.RUNNER_POLL_MS) || 2 * 60 * 1000, MAX_DEFER_MS = 4 * 60 * 60 * 1000, LOG_MAX = 20 * 1024 * 1024;

fs.mkdirSync(HOME, { recursive: true });
function log(m) {
    const line = new Date().toLocaleString('ko-KR') + ' ' + m;
    console.log(line);
    try { fs.appendFileSync(RUN_LOG, line + '\n'); } catch (e) {}
}
// 로그가 너무 커지면 하나 전 것만 남기고 갈아 끼운다
function rotate(file) { try { if (fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + '.1'); } catch (e) {} }
function loadEnv() {
    const env = {};
    try {
        fs.readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).forEach(l => {
            if (/^\s*#/.test(l)) return;
            const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l);
            const v = m ? m[2].replace(/^(["'])(.*)\1$/, '$2') : '';
            if (v !== '') env[m[1]] = v;          // 빈 칸은 설정 안 한 것으로 본다
        });
    } catch (e) { log('⚠️ 설정 파일이 없습니다: ' + ENV_FILE + ' (기본값으로 실행 — 전적은 이 PC 에만 저장)'); }
    return env;
}
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();

let child = null, wantStop = false, crashes = [], runningHead = '';
function start() {
    let head = 'local';
    try { head = git('rev-parse', 'HEAD'); } catch (e) {}
    runningHead = head;
    const env = Object.assign({}, process.env, { PORT: '3000', DATA_DIR: HOME }, loadEnv(), { RENDER_GIT_COMMIT: head });
    rotate(SERVER_LOG);
    const out = fs.openSync(SERVER_LOG, 'a');
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', out, out, 'ipc'], windowsHide: true });
    fs.closeSync(out);
    log(`▶️ 서버 시작 (커밋 ${head.slice(0, 7)}, 포트 ${env.PORT}, pid ${child.pid})`);
    child.on('exit', (code, sig) => {
        child = null;
        if (wantStop) return;
        crashes = crashes.filter(t => Date.now() - t < 600000).concat([Date.now()]);
        const wait = crashes.length > 5 ? 60000 : 3000;
        log(`💥 서버가 멈췄습니다 (code ${code}, ${sig || '-'}) — ${wait / 1000}초 뒤 다시 띄웁니다`);
        setTimeout(start, wait);
    });
}
// 저장을 마치고 끝나도록 IPC 로 종료를 부탁한다(Windows 에는 SIGTERM 이 없다). 10초 안에 안 끝나면 강제로.
function stop() {
    return new Promise(res => {
        if (!child) return res();
        wantStop = true;
        const c = child;
        const t = setTimeout(() => { try { c.kill(); } catch (e) {} }, 10000);
        c.once('exit', () => { clearTimeout(t); wantStop = false; res(); });
        try { c.send('shutdown'); } catch (e) { try { c.kill(); } catch (e2) {} }
    });
}
function busy() {
    return new Promise(res => {
        const req = http.get({ host: '127.0.0.1', port: Number(loadEnv().PORT || 3000), path: '/busy', timeout: 3000 }, r => {
            let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
        });
        req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null); });
    });
}

let pendingSince = 0, updating = false;
// 새 커밋을 받는다 → (대회 중이면 미룸) → 서버를 끈 뒤에 패키지를 맞추고 → 다시 띄운다.
//   ⚠️ Windows 에서는 돌고 있는 서버가 패키지 파일(.node)을 잡고 있어서, 서버를 끄기 전에 설치하면 실패한다.
//   받아 두기만 하고 재시작을 못 한 경우(설치 실패 등)도 다음 확인 때 "돌고 있는 커밋 ≠ 받은 커밋" 으로 다시 시도한다.
async function checkUpdate() {
    if (updating) return;
    updating = true;
    try {
        git('fetch', '--quiet', 'origin', 'main');
        const remote = git('rev-parse', 'origin/main');
        if (git('rev-parse', 'HEAD') === remote && runningHead === remote) { pendingSince = 0; return; }
        const b = await busy();
        if (b && b.mtt > 0) {
            if (!pendingSince) { pendingSince = Date.now(); log(`⏳ 새 커밋 ${remote.slice(0, 7)} — 대회 ${b.mtt}개가 진행 중이라 끝난 뒤 반영합니다`); }
            if (Date.now() - pendingSince < MAX_DEFER_MS) return;
        }
        if (git('rev-parse', 'HEAD') !== remote) {
            log(`⬇️ 새 커밋 받는 중 (${git('rev-parse', 'HEAD').slice(0, 7)} → ${remote.slice(0, 7)})`);
            git('merge', '--ff-only', 'origin/main');
        }
        let pkgChanged = true;
        try { pkgChanged = git('rev-parse', runningHead + ':package-lock.json') !== git('rev-parse', 'HEAD:package-lock.json'); } catch (e) {}
        const runnerChanged = (() => { try { return git('rev-parse', runningHead + ':tools/minipc/runner.js') !== git('rev-parse', 'HEAD:tools/minipc/runner.js'); } catch (e) { return false; } })();
        pendingSince = 0;
        await stop();
        if (pkgChanged) {
            log('📦 패키지가 바뀌어 npm install 실행');
            try { execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 600000, shell: process.platform === 'win32' }); }
            catch (e) { log('⚠️ npm install 실패(그래도 서버를 띄운다): ' + String(e.stderr || e.message || e).split(/\r?\n/).filter(Boolean).slice(-3).join(' / ')); }
        }
        start();
        if (runnerChanged) log('ℹ️ 감시기(runner.js) 자체도 바뀌었습니다 — 미니 PC 를 다시 켜거나 작업 JingchikHoldem 을 다시 실행하면 적용됩니다');
    } catch (e) {
        log('⚠️ 업데이트 확인 실패: ' + String(e.message || e).split(/\r?\n/)[0]);
        if (!child && !wantStop) start();
    } finally { updating = false; }
}

process.on('SIGINT', async () => { log('🛑 감시기 종료'); await stop(); process.exit(0); });
log('🖥️ 감시기 시작 — 설정 ' + ENV_FILE);
start();
setInterval(checkUpdate, POLL_MS);
