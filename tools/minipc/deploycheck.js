// 🚀 배포 확인 — git push 뒤에 실행한다.
//    ① 미니 PC 서버의 /version 이 내 커밋(HEAD)과 같아질 때까지 기다린다(감시기가 2분마다 GitHub 를 보고, 대회 중이면 최대 4시간 미룬다).
//    ② 실제로 접속해 봇 2명과 판을 돌려 보고 정상인지 본다(점검 계정 "배포확인…" 은 서버가 켜질 때 자동으로 지워진다).
//    사용: node tools/minipc/deploycheck.js            (서버 주소: 환경변수 GAME_URL, 기본 http://192.168.0.148:3000)
//          node tools/minipc/deploycheck.js --no-wait  (버전 기다리지 않고 ②만)
const { execSync } = require('child_process');
const { io } = require('socket.io-client');
const URL = process.env.GAME_URL || 'http://192.168.0.148:3000';
const WAIT_MS = Number(process.env.DEPLOY_WAIT_MS) || 6 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitVersion() {
    const head = execSync('git rev-parse HEAD', { cwd: __dirname, encoding: 'utf8' }).trim().slice(0, 12);
    const t0 = Date.now(); let last = '';
    while (Date.now() - t0 < WAIT_MS) {
        try { last = (await (await fetch(URL + '/version', { signal: AbortSignal.timeout(5000) })).text()).trim(); } catch (e) { last = '응답 없음(' + (e.cause && e.cause.code || e.message) + ')'; }
        if (last === head) { console.log(`✅ 서버가 이 커밋으로 돌고 있습니다: ${head} (${Math.round((Date.now() - t0) / 1000)}초)`); return true; }
        await sleep(10000);
    }
    console.log(`❌ ${WAIT_MS / 60000}분 안에 반영되지 않았습니다 — 서버 ${last} / 내 커밋 ${head}`);
    console.log('   (진행 중인 대회가 있으면 끝날 때까지 미뤄진다 · 미니 PC 의 C:\\jingchik-data\\runner.log 확인)');
    return false;
}

function playCheck() {
    return new Promise(done => {
        const S = io(URL, { transports: ['websocket'], timeout: 20000 });
        const N = '배포확인' + process.pid;
        let joined = false, hands = 0, botActs = 0, errs = [], stages = new Set(), myTurns = 0;
        S.on('connect_error', e => errs.push('연결 실패: ' + e.message));
        S.on('connect', () => S.emit('login', { nickname: N, pin: '1234' }));
        S.on('loginSuccess', () => {
            if (S._s) return; S._s = true;
            S.emit('joinRoom', { roomId: '배포' + process.pid, settings: { mode: 'tournament', startingChips: 10000, blindUpInterval: 9999, turnTimeLimit: 15, maxRebuys: 0 } });
        });
        S.on('joinRoomSuccess', () => { joined = true; setTimeout(() => { S.emit('addBot'); S.emit('addBot'); }, 600); setTimeout(() => S.emit('startFirstHand'), 1800); });
        S.on('actionSound', a => { if (a.nick && a.nick.startsWith('🤖')) botActs++; });
        S.on('gameResult', () => hands++);
        S.on('updateTable', d => {
            stages.add(d.gameStage);
            const me = d.players[N]; if (!me || d.turnPlayerId !== N) return;
            myTurns++;
            setTimeout(() => S.emit('action', { type: d.currentHighestBet - me.currentBet > 0 ? 'call' : 'check' }), 100);
        });
        setTimeout(() => {
            console.log(`서버 ${URL} · 입장 ${joined} · 내 차례 ${myTurns}회 · 봇 액션 ${botActs}회 · 끝난 판 ${hands} · 스트리트 ${[...stages].sort().join(',')}`);
            if (errs.length) console.log('❌ ' + errs.join(' | '));
            const ok = joined && botActs >= 4 && hands >= 1;
            console.log(ok ? '✅ 서버에서 봇이 정상 플레이 중' : '❌ 플레이 확인 실패');
            S.close(); done(ok);
        }, 75000);
    });
}

(async () => {
    const vOk = process.argv.includes('--no-wait') ? true : await waitVersion();
    const pOk = await playCheck();
    process.exit(vOk && pOk ? 0 : 1);
})();
