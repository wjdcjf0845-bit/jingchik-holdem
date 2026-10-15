// 🛠️ 미니 PC 운영 도우미 — 전적 백업 · 장애 알림 · 멈춤 감시
//   · 백업: 하루 한 번(새벽 4시 이후 처음) DATA_DIR/backup/poker_stats-YYYY-MM-DD.json.gz 로 전적 파일을 묶어 둔다. 최근 30개만 남긴다.
//   · 알림: server.env 에 ALERT_NTFY=<주제 이름> 을 적으면 ntfy.sh 로 폰에 알린다(폰에 ntfy 앱을 깔고 같은 주제를 구독). 없으면 아무것도 안 보낸다.
//     같은 종류의 알림은 10분에 한 번만.
//   · 비정상 종료 감지: 켜질 때 표식 파일(.running)을 만들고 정상 종료 때 지운다. 켜질 때 표식이 남아 있으면 지난번에 갑자기 꺼진 것.
//   · 멈춤 감시: 별도 스레드가 본 스레드의 맥박을 본다. 60초 넘게 멈춰 있으면(무한 반복 등) 알리고 프로세스를 끝낸다 — 감시기(runner.js)가 다시 띄운다.
//     (2026-10-16 시험 서버에서 ICM 계산이 폭발해 CPU 100% 로 멈춘 일이 있었다. 이런 멈춤은 죽은 게 아니라서 감시기가 알아채지 못했다.)
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const KEEP_BACKUPS = 30, BACKUP_HOUR = 4, ALERT_GAP_MS = 10 * 60 * 1000;

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 오늘 백업이 필요한가: 새벽 4시가 지났고 오늘 날짜 파일이 아직 없으면
function backupDue(dir, now) {
    if (now.getHours() < BACKUP_HOUR) return false;
    return !fs.existsSync(path.join(dir, `poker_stats-${ymd(now)}.json.gz`));
}
// src 파일을 오늘 날짜로 묶어 두고, 오래된 것은 지운다. 반환: 만든 파일 경로(또는 null)
function backupNow(src, dir, now) {
    if (!fs.existsSync(src)) return null;
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `poker_stats-${ymd(now)}.json.gz`);
    fs.writeFileSync(out + '.tmp', zlib.gzipSync(fs.readFileSync(src)));
    fs.renameSync(out + '.tmp', out);
    pruneBackups(dir, KEEP_BACKUPS);
    return out;
}
function pruneBackups(dir, keep) {
    const files = fs.readdirSync(dir).filter(f => /^poker_stats-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort();
    files.slice(0, Math.max(0, files.length - keep)).forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} });
    return files.length > keep ? files.length - keep : 0;
}

// 같은 종류(key)는 gap 안에 한 번만 — 반복되는 오류로 폰이 울리지 않게
function makeLimiter(gap) {
    const last = new Map();
    return (key, now) => { if (last.has(key) && now - last.get(key) < gap) return false; last.set(key, now); return true; };
}

function createOps({ dataDir, dataFile, flush, topic, log = console.log }) {
    const allow = makeLimiter(ALERT_GAP_MS);
    const alert = (key, msg) => {
        log('🔔 [알림] ' + msg);
        if (!topic || !allow(key, Date.now())) return;
        try {
            fetch('https://ntfy.sh/' + encodeURIComponent(topic), { method: 'POST', body: '징칡홀덤: ' + msg, signal: AbortSignal.timeout(8000) }).catch(() => {});
        } catch (e) {}
    };
    // 비정상 종료 감지
    const marker = path.join(dataDir, '.running');
    const crashedBefore = fs.existsSync(marker);
    try { fs.writeFileSync(marker, String(Date.now())); } catch (e) {}
    if (crashedBefore) alert('restart', '서버가 갑자기 꺼졌다가 다시 켜졌습니다(정상 종료가 아님). 미니 PC 의 server.log 를 확인하세요.');
    const cleanExit = () => { try { fs.unlinkSync(marker); } catch (e) {} };

    // 백업: 한 시간마다 확인
    const backupDir = path.join(dataDir, 'backup');
    const tryBackup = () => {
        try {
            if (!backupDue(backupDir, new Date())) return;
            try { flush(); } catch (e) {}
            const out = backupNow(dataFile, backupDir, new Date());
            if (out) log('💾 [백업] ' + out);
        } catch (e) { alert('backup', '전적 백업 실패: ' + (e && e.message)); }
    };
    setTimeout(tryBackup, 60 * 1000).unref();
    setInterval(tryBackup, 60 * 60 * 1000).unref();

    // 멈춤 감시: 본 스레드는 1초마다 맥박을 찍고, 감시 스레드가 60초 넘게 맥박이 없으면 알리고 끝낸다
    const startWatchdog = (limitMs = 60000) => {
        try {
            const { Worker } = require('worker_threads');
            const sab = new SharedArrayBuffer(8), beat = new Float64Array(sab);
            beat[0] = Date.now();
            setInterval(() => { beat[0] = Date.now(); }, 1000).unref();
            const w = new Worker(`
                const { workerData } = require('worker_threads');
                const beat = new Float64Array(workerData.sab);
                setInterval(() => {
                    const stuck = Date.now() - beat[0];
                    if (stuck < workerData.limit) return;
                    const msg = '서버가 ' + Math.round(stuck / 1000) + '초 동안 멈춰 있어서 껐습니다(감시기가 다시 띄웁니다).';
                    try { require('fs').appendFileSync(workerData.log, new Date().toLocaleString('ko-KR') + ' 🚨 [멈춤 감시] ' + msg + '\\n'); } catch (e) {}
                    const done = () => process.kill(workerData.pid);
                    if (!workerData.topic) return done();
                    fetch('https://ntfy.sh/' + encodeURIComponent(workerData.topic), { method: 'POST', body: '징칡홀덤: ' + msg, signal: AbortSignal.timeout(5000) }).catch(() => {}).finally(done);
                }, 5000);
            `, { eval: true, workerData: { sab, limit: limitMs, pid: process.pid, topic, log: path.join(dataDir, 'watchdog.log') } });
            w.unref();
            return w;
        } catch (e) { log('⚠️ 멈춤 감시를 켜지 못했습니다: ' + (e && e.message)); return null; }
    };
    return { alert, cleanExit, crashedBefore, startWatchdog, tryBackup };
}

module.exports = { createOps, backupDue, backupNow, pruneBackups, makeLimiter, ymd };
