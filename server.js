process.on('uncaughtException', (err) => {
    console.error('🚨 [서버 크래시 방어] Uncaught Exception:', err);
    // 메모리 손상 전에 전적 긴급 저장 시도 (MockDB가 초기화된 경우만)
    try { if (typeof MockDB !== 'undefined' && MockDB.flush) MockDB.flush(); } catch (e) {}
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 [서버 크래시 방어] Unhandled Rejection:', reason);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Hand = require('pokersolver').Hand;
const Pots = require('./lib/pots'); // 💰 팟/사이드팟 분배 순수 로직 (테스트로 보존성 검증)
// 🔐 검증 가능한 결정적 셔플 (commit-reveal) 순수 로직 — 테스트로 결정성·공정성 검증
const { makeServerSeed, commitHash, seededShuffle } = require('./lib/shuffle');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 🩺 헬스체크 / 킵얼라이브 — UptimeRobot가 5분마다 가볍게 노크해 무료 인스턴스가 잠들지 않게 (271KB HTML 대신 "ok"만 응답)
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────
const NICK_REGEX = /^[가-힣a-zA-Z0-9_]{2,12}$/;

function sanitizeNick(raw) {
    const s = String(raw || '').trim().slice(0, 12);
    return NICK_REGEX.test(s) ? s : null;
}

function clampInt(v, min, max, def) {
    v = parseInt(v);
    if (isNaN(v)) return def;
    return Math.max(min, Math.min(max, v));
}

// 🔒 4자리 PIN 검증 + 해시 (단방향 SHA-256, 평문 저장 안 함)
function isValidPin(pin) {
    return typeof pin === 'string' && /^\d{4}$/.test(pin);
}
function hashPin(pin) {
    return crypto.createHash('sha256').update('jchpoker:' + pin).digest('hex');
}

// 💾 영구 전적 DB — 파일 저장으로 서버 재시작에도 전적 유지
// 💾 전적 DB 저장 위치 — 배포 시 영구 디스크 경로(DATA_DIR)로 지정 (Render 등은 재배포마다 로컬 FS가 초기화됨)
//    로컬 개발에선 DATA_DIR 미설정 → 프로젝트 폴더(__dirname)에 그대로 저장.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('DATA_DIR 생성 실패:', e.message); }
const DATA_FILE = path.join(DATA_DIR, 'poker_stats.json');

// 🏆 시즌: 월 단위 (예: 2026-06). 월이 바뀌면 시즌 포인트 자동 리셋
function getCurrentSeason() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const CURRENT_SEASON = getCurrentSeason();

// 🏅 업적 카탈로그
const ACHIEVEMENTS = {
    first_win:    { icon: '🏆', name: '첫 승리',       desc: '토너먼트 첫 우승' },
    royal:        { icon: '👑', name: '로얄로더',      desc: '로얄 플러시 완성' },
    quads:        { icon: '💎', name: '포카드 사냥꾼',  desc: '포카드 이상 족보로 승리' },
    comeback:     { icon: '🔥', name: '불사조',        desc: '리바이 후 토너먼트 우승' },
    allin_master: { icon: '💥', name: '올인의 달인',    desc: '올인 5회 누적 승리' },
    whale:        { icon: '🐋', name: '고래',          desc: '단일 팟 50,000칩 이상 획득' },
    grinder:      { icon: '⚙️', name: '그라인더',      desc: '누적 100핸드 플레이' },
    bluffer:      { icon: '🎭', name: '허풍선이',      desc: '폴드 유도 기권승 10회' }
};

const MockDB = {
    users: new Map(),
    deviceOwners: new Map(), // 🔒 [#5] deviceId → 소유 닉네임
    _saveTimer: null,
    load() {
        // 손상 대비: 메인 → 실패 시 백업(.bak) 순으로 시도
        const tryLoad = (file) => {
            if (!fs.existsSync(file)) return null;
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!raw || typeof raw !== 'object') throw new Error('형식 이상');
            return raw;
        };
        // 직전 저장이 rename 직전에 죽어 남은 임시파일 정리
        try { if (fs.existsSync(DATA_FILE + '.tmp')) fs.unlinkSync(DATA_FILE + '.tmp'); } catch (e) {}

        let raw = null, source = '메인';
        try {
            raw = tryLoad(DATA_FILE);
        } catch (e) {
            console.error(`전적 DB 메인 파일 손상(${e.message}) — 백업 복구 시도`);
            try { raw = tryLoad(DATA_FILE + '.bak'); source = '백업'; }
            catch (e2) { console.error('백업도 로드 실패:', e2.message); }
        }
        if (raw) {
            Object.values(raw).forEach(u => { if (u && u.nickname) this.users.set(u.nickname, u); });
            this.users.forEach(u => { if (u.deviceId) this.deviceOwners.set(u.deviceId, u.nickname); });
            console.log(`💾 전적 DB 로드(${source}): ${this.users.size}명`);
            // 백업에서 복구했다면 즉시 정상 파일로 다시 저장
            if (source === '백업') this.flush();
        }
    },
    bindDevice(deviceId, nickname) {
        this.deviceOwners.set(deviceId, nickname);
    },
    save() { // 디바운스 저장 (잦은 디스크 IO 방지)
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.flush(), 800);
    },
    // 💾 원자적 저장 — 임시파일에 쓰고 rename (쓰기 도중 죽어도 원본 안전)
    flush() {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        try {
            const obj = {};
            this.users.forEach((u, k) => { obj[k] = u; });
            const json = JSON.stringify(obj, null, 1);
            // 빈/손상 데이터 방어: 직렬화 결과가 비정상이면 저장 중단
            if (!json || json.length < 2) { console.error('💾 저장 중단: 직렬화 결과 이상'); return; }
            const tmp = DATA_FILE + '.tmp';
            fs.writeFileSync(tmp, json);
            // 기존 파일을 백업으로 보존 (다음 저장 전까지 1세대 백업)
            if (fs.existsSync(DATA_FILE)) {
                try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch (e) {}
            }
            fs.renameSync(tmp, DATA_FILE); // 원자적 교체
        } catch (e) { console.error('전적 DB 저장 실패:', e.message); }
    },
    async getUser(nickname) {
        if (!this.users.has(nickname)) {
            this.users.set(nickname, {
                nickname, totalChips: 100000, wins: 0,
                handsPlayed: 0, handsWon: 0, biggestPot: 0, vpipHands: 0,
                achievements: [], seasonId: CURRENT_SEASON, seasonPoints: 0,
                cashNet: 0, bestRank: '',
                pinHash: null, bankroll: 100000, deviceId: null,
                // 📊 포커 분석 지표 누적 카운터
                pfrHands: 0,        // 프리플랍 레이즈 핸드 (PFR)
                preflopOpps: 0,     // 프리플랍 액션 기회 (VPIP/PFR 분모)
                threeBetCount: 0,   // 3벳 횟수
                threeBetOpps: 0,    // 3벳 기회
                aggrBets: 0,        // 베팅/레이즈 횟수 (공격성 분자)
                aggrCalls: 0,       // 콜 횟수 (공격성 분모)
                foldToBet: 0,       // 상대 벳에 폴드한 횟수
                faceBet: 0,         // 상대 벳을 마주한 횟수
                wentToShowdown: 0,  // 쇼다운까지 간 횟수
                wonAtShowdown: 0,   // 쇼다운에서 이긴 횟수
                gtoScoreSum: 0,     // GTO 근접 점수 누적
                gtoScoreCount: 0    // GTO 평가 횟수
            });
            this.save();
        }
        const u = this.users.get(nickname);
        // 구버전 레코드 마이그레이션
        if (u.handsPlayed === undefined) { u.handsPlayed = 0; u.handsWon = 0; u.biggestPot = 0; }
        if (u.vpipHands === undefined) u.vpipHands = 0;
        if (!Array.isArray(u.achievements)) u.achievements = [];
        if (u.cashNet === undefined) u.cashNet = 0;
        if (u.bestRank === undefined) u.bestRank = '';
        if (u.pinHash === undefined) u.pinHash = null;        // 🔒 PIN 미설정(구버전)
        if (u.bankroll === undefined) u.bankroll = (u.totalChips != null ? u.totalChips : 100000); // 💰 뱅크롤
        if (u.deviceId === undefined) u.deviceId = null; // 🔒 기기 바인딩
        // 📊 포커 분석 지표 마이그레이션
        ['pfrHands','preflopOpps','threeBetCount','threeBetOpps','aggrBets','aggrCalls',
         'foldToBet','faceBet','wentToShowdown','wonAtShowdown','gtoScoreSum','gtoScoreCount']
            .forEach(k => { if (u[k] === undefined) u[k] = 0; });
        // 🏆 시즌 롤오버: 시즌이 바뀌면 시즌 포인트 리셋
        if (u.seasonId !== CURRENT_SEASON) { u.seasonId = CURRENT_SEASON; u.seasonPoints = 0; }
        if (u.seasonPoints === undefined) u.seasonPoints = 0;
        return u;
    },
    async addWin(nickname) {
        if (typeof nickname === 'string' && nickname.startsWith('🤖')) return; // 봇 제외
        const user = await this.getUser(nickname);
        user.wins = (user.wins || 0) + 1;
        user.totalChips += 50000;
        user.seasonPoints = (user.seasonPoints || 0) + 100; // 🏆 우승 시즌 포인트
        this.save();
    },
    // 📋 [세션 리포트] 현재 누적 지표의 스냅샷 — 세션 변화량 계산 기준점
    snapshotStats(u) {
        return {
            ts: Date.now(),
            bankroll: u.bankroll || 0,
            handsPlayed: u.handsPlayed || 0,
            handsWon: u.handsWon || 0,
            wins: u.wins || 0,
            biggestPot: u.biggestPot || 0,
            vpipHands: u.vpipHands || 0,
            preflopOpps: u.preflopOpps || 0,
            pfrHands: u.pfrHands || 0,
            threeBetCount: u.threeBetCount || 0,
            threeBetOpps: u.threeBetOpps || 0,
            aggrBets: u.aggrBets || 0,
            aggrCalls: u.aggrCalls || 0,
            foldToBet: u.foldToBet || 0,
            faceBet: u.faceBet || 0,
            wentToShowdown: u.wentToShowdown || 0,
            wonAtShowdown: u.wonAtShowdown || 0,
            gtoScoreSum: u.gtoScoreSum || 0,
            gtoScoreCount: u.gtoScoreCount || 0,
            achievements: (u.achievements || []).slice(),
            seasonPoints: u.seasonPoints || 0
        };
    },
    // 📅 [일/주/월 리포트] 지정 범위(일수)의 dailyLog를 합산
    aggregateRange(user, days) {
        const log = user.dailyLog || {};
        const now = new Date();
        const sum = { handsPlayed: 0, handsWon: 0, vpipHands: 0, preflopOpps: 0, pfrHands: 0, threeBetCount: 0, threeBetOpps: 0, aggrBets: 0, aggrCalls: 0, foldToBet: 0, faceBet: 0, wentToShowdown: 0, wonAtShowdown: 0, gtoScoreSum: 0, gtoScoreCount: 0 };
        const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
        Object.keys(log).forEach(key => {
            const [y, m, dd] = key.split('-').map(Number);
            const dt = new Date(y, m - 1, dd);
            if (dt >= cutoff) {
                const day = log[key];
                Object.keys(sum).forEach(f => { sum[f] += (day[f] || 0); });
            }
        });
        return sum;
    },
    // 📅 [일/주/월 리포트] 날짜키(YYYY-MM-DD)별 지표 누적
    //   유저 객체의 dailyLog에 일별로 핵심 지표를 쌓아 일/주/월 집계에 사용
    // 🎁 [출석] 하루 첫 접속 보너스 — 연속 출석일수에 따라 증가
    //   반환: { claimed:bool, reward, streak, alreadyToday:bool }
    async checkIn(nickname) {
        if (typeof nickname !== 'string' || nickname.startsWith('🤖')) return null;
        const u = await this.getUser(nickname);
        const today = this._todayKey();
        if (u.lastCheckIn === today) {
            return { claimed: false, alreadyToday: true, streak: u.checkInStreak || 1, reward: 0 };
        }
        // 어제 날짜 계산 → 연속 여부 판정
        const yd = new Date(); yd.setDate(yd.getDate() - 1);
        const yKey = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, '0')}-${String(yd.getDate()).padStart(2, '0')}`;
        u.checkInStreak = (u.lastCheckIn === yKey) ? (u.checkInStreak || 0) + 1 : 1;
        u.lastCheckIn = today;
        // 보상: 기본 1000 + 연속일수×500 (최대 7일치 = 5000), 7일 이상은 5000 고정
        const streak = u.checkInStreak;
        const reward = 1000 + Math.min(streak, 8) * 500;
        u.bankroll = (u.bankroll || 0) + reward;
        this.save();
        return { claimed: true, alreadyToday: false, streak, reward, bankroll: u.bankroll };
    },
    // 🎯 [일일 미션] 오늘의 미션 3종 + 달성/보상 상태
    //   미션은 dailyLog(오늘) 실측치로 진행도 계산. 보상은 1회만 수령.
    MISSIONS: [
        { id: 'play5', icon: '🃏', name: '오늘 5판 플레이', target: 5, stat: 'handsPlayed', reward: 1500 },
        { id: 'win3', icon: '🏆', name: '오늘 3판 승리', target: 3, stat: 'handsWon', reward: 2000 },
        { id: 'showdown2', icon: '🔥', name: '쇼다운 2번 승리', target: 2, stat: 'wonAtShowdown', reward: 2500 }
    ],
    async getMissions(nickname) {
        if (typeof nickname !== 'string' || nickname.startsWith('🤖')) return null;
        const u = await this.getUser(nickname);
        const today = this._todayKey();
        const day = (u.dailyLog && u.dailyLog[today]) || {};
        if (!u.missionClaims || u.missionClaims.date !== today) {
            u.missionClaims = { date: today, claimed: {} }; // 날짜 바뀌면 초기화
        }
        return this.MISSIONS.map(m => {
            const progress = Math.min(day[m.stat] || 0, m.target);
            const done = progress >= m.target;
            const claimed = !!u.missionClaims.claimed[m.id];
            return { id: m.id, icon: m.icon, name: m.name, target: m.target, progress, done, claimed, reward: m.reward };
        });
    },
    async claimMission(nickname, missionId) {
        if (typeof nickname !== 'string' || nickname.startsWith('🤖')) return { ok: false };
        const u = await this.getUser(nickname);
        const today = this._todayKey();
        const day = (u.dailyLog && u.dailyLog[today]) || {};
        const mission = this.MISSIONS.find(m => m.id === missionId);
        if (!mission) return { ok: false };
        if (!u.missionClaims || u.missionClaims.date !== today) u.missionClaims = { date: today, claimed: {} };
        if (u.missionClaims.claimed[missionId]) return { ok: false, reason: 'already' };
        const progress = day[mission.stat] || 0;
        if (progress < mission.target) return { ok: false, reason: 'incomplete' };
        u.missionClaims.claimed[missionId] = true;
        u.bankroll = (u.bankroll || 0) + mission.reward;
        this.save();
        return { ok: true, reward: mission.reward, bankroll: u.bankroll };
    },
    _todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    _bumpDaily(user, fields) {
        if (!user.dailyLog) user.dailyLog = {};
        const key = this._todayKey();
        if (!user.dailyLog[key]) {
            user.dailyLog[key] = { handsPlayed: 0, handsWon: 0, vpipHands: 0, preflopOpps: 0, pfrHands: 0, threeBetCount: 0, threeBetOpps: 0, aggrBets: 0, aggrCalls: 0, foldToBet: 0, faceBet: 0, wentToShowdown: 0, wonAtShowdown: 0, gtoScoreSum: 0, gtoScoreCount: 0, netChips: 0 };
        }
        const day = user.dailyLog[key];
        Object.keys(fields).forEach(f => { day[f] = (day[f] || 0) + fields[f]; });
        // 오래된 로그 정리 (40일 초과분 삭제 — 월간까지 커버)
        const keys = Object.keys(user.dailyLog);
        if (keys.length > 45) {
            keys.sort();
            keys.slice(0, keys.length - 45).forEach(k => delete user.dailyLog[k]);
        }
    },
    async recordHand(nickname, won, potWon, vpip, isLearn) {
        if (typeof nickname === 'string' && nickname.startsWith('🤖')) return; // 봇 제외
        const user = await this.getUser(nickname);
        if (isLearn) {
            // 🎓 학습 모드 — 실전 전적과 분리
            const L = user.learnStats || (user.learnStats = {});
            L.handsPlayed = (L.handsPlayed||0)+1;
            if (vpip) L.vpipHands = (L.vpipHands||0)+1;
            if (won) L.handsWon = (L.handsWon||0)+1;
            this.save();
            return;
        }
        user.handsPlayed++;
        const daily = { handsPlayed: 1 };
        if (vpip) { user.vpipHands = (user.vpipHands || 0) + 1; daily.vpipHands = 1; } // 자발적 참여(VPIP)
        if (won) {
            user.handsWon++;
            user.seasonPoints = (user.seasonPoints || 0) + 5; // 🏆 핸드 승리 시즌 포인트
            if (potWon > user.biggestPot) user.biggestPot = potWon;
            daily.handsWon = 1;
        }
        this._bumpDaily(user, daily);
        this.save();
    },
    async recordCashNet(nickname, delta) {
        if (typeof nickname === 'string' && nickname.startsWith('🤖')) return;
        const user = await this.getUser(nickname);
        user.cashNet = (user.cashNet || 0) + delta;
        this.save();
    },
    // 🏆 [MTT] 멀티테이블 토너먼트 우승 기록 (전용 명예의 전당)
    async addMttWin(nickname, entrants) {
        if (typeof nickname === 'string' && nickname.startsWith('🤖')) return;
        const user = await this.getUser(nickname);
        user.mttWins = (user.mttWins || 0) + 1;
        user.mttBestField = Math.max(user.mttBestField || 0, entrants || 0);
        user.seasonPoints = (user.seasonPoints || 0) + 300; // MTT 우승 시즌 보너스
        this.save();
    },
    async getMttChampions() {
        const all = Array.from(this.users.values())
            .filter(u => u.nickname && !u.nickname.startsWith('🤖') && (u.mttWins || 0) > 0);
        all.sort((a, b) => (b.mttWins || 0) - (a.mttWins || 0) || (b.mttBestField || 0) - (a.mttBestField || 0));
        return all.slice(0, 10).map(u => ({ nickname: u.nickname, mttWins: u.mttWins || 0, mttBestField: u.mttBestField || 0 }));
    },
    // 📊 액션 단위 포커 지표 기록 (사람만). isLearn=true면 학습 전용 통계에 별도 집계
    async recordActionStats(nickname, ev, isLearn) {
        if (typeof nickname !== 'string' || nickname.startsWith('🤖')) return;
        const u = await this.getUser(nickname);
        if (isLearn) {
            // 🎓 학습 모드 — 실전 통계와 분리해 learnStats에 누적
            const L = u.learnStats || (u.learnStats = {});
            if (ev.preflopOpp) L.preflopOpps = (L.preflopOpps||0)+1;
            if (ev.pfr) L.pfrHands = (L.pfrHands||0)+1;
            if (ev.threeBetOpp) L.threeBetOpps = (L.threeBetOpps||0)+1;
            if (ev.threeBet) L.threeBetCount = (L.threeBetCount||0)+1;
            if (ev.aggrBet) L.aggrBets = (L.aggrBets||0)+1;
            if (ev.aggrCall) L.aggrCalls = (L.aggrCalls||0)+1;
            if (ev.faceBet) L.faceBet = (L.faceBet||0)+1;
            if (ev.foldToBet) L.foldToBet = (L.foldToBet||0)+1;
            if (typeof ev.gtoScore === 'number') { L.gtoScoreSum = (L.gtoScoreSum||0)+ev.gtoScore; L.gtoScoreCount = (L.gtoScoreCount||0)+1; }
            this.save();
            return;
        }
        const daily = {};
        if (ev.preflopOpp) { u.preflopOpps++; daily.preflopOpps = 1; }
        if (ev.pfr) { u.pfrHands++; daily.pfrHands = 1; }
        if (ev.threeBetOpp) { u.threeBetOpps++; daily.threeBetOpps = 1; }
        if (ev.threeBet) { u.threeBetCount++; daily.threeBetCount = 1; }
        if (ev.aggrBet) { u.aggrBets++; daily.aggrBets = 1; }
        if (ev.aggrCall) { u.aggrCalls++; daily.aggrCalls = 1; }
        if (ev.faceBet) { u.faceBet++; daily.faceBet = 1; }
        if (ev.foldToBet) { u.foldToBet++; daily.foldToBet = 1; }
        if (typeof ev.gtoScore === 'number') { u.gtoScoreSum += ev.gtoScore; u.gtoScoreCount++; daily.gtoScoreSum = ev.gtoScore; daily.gtoScoreCount = 1; }
        this._bumpDaily(u, daily);
        this.save();
    },
    async recordShowdownStat(nickname, won, isLearn) {
        if (typeof nickname !== 'string' || nickname.startsWith('🤖')) return;
        const u = await this.getUser(nickname);
        if (isLearn) {
            const L = u.learnStats || (u.learnStats = {});
            L.wentToShowdown = (L.wentToShowdown||0)+1;
            if (won) L.wonAtShowdown = (L.wonAtShowdown||0)+1;
            this.save();
            return;
        }
        u.wentToShowdown++;
        const daily = { wentToShowdown: 1 };
        if (won) { u.wonAtShowdown++; daily.wonAtShowdown = 1; }
        this._bumpDaily(u, daily);
        this.save();
    },
    // 💰 뱅크롤 증감 (음수 방지) — 캐시/토너 바이인·정산에 사용
    async adjustBankroll(nickname, delta) {
        if (typeof nickname === 'string' && nickname.startsWith('🤖')) return 0;
        const user = await this.getUser(nickname);
        user.bankroll = Math.max(0, (user.bankroll || 0) + delta);
        this.save();
        return user.bankroll;
    },
    // 💸 [#1] 뱅크롤이 바닥나면 무료 보너스 지급 (파산 구제)
    async refillIfBroke(nickname, threshold = 0, amount = 10000) {
        if (typeof nickname === 'string' && nickname.startsWith('🤖')) return { refilled: false, bankroll: 0 };
        const user = await this.getUser(nickname);
        if ((user.bankroll || 0) <= threshold) {
            user.bankroll = amount;
            this.save();
            return { refilled: true, bankroll: amount };
        }
        return { refilled: false, bankroll: user.bankroll || 0 };
    },
    async setPin(nickname, pin) {
        const user = await this.getUser(nickname);
        user.pinHash = hashPin(pin);
        this.save();
    },
    // 🏅 업적 부여 — 신규 해금 시 배열 반환
    async grantAchievements(nickname, ids) {
        if (typeof nickname === 'string' && nickname.startsWith('🤖')) return [];
        const user = await this.getUser(nickname);
        const fresh = [];
        ids.forEach(id => {
            if (!user.achievements.includes(id)) { user.achievements.push(id); fresh.push(id); }
        });
        if (fresh.length) this.save();
        return fresh;
    },
    async getSeasonLeaders() {
        const all = Array.from(this.users.values()).filter(u => u.seasonId === CURRENT_SEASON && (u.seasonPoints || 0) > 0);
        all.sort((a, b) => (b.seasonPoints || 0) - (a.seasonPoints || 0));
        return all.slice(0, 10);
    },
    async getTopPlayers() {
        const all = Array.from(this.users.values());
        all.sort((a, b) => (b.wins || 0) - (a.wins || 0) || b.totalChips - a.totalChips);
        return all.slice(0, 10);
    },
    async getBankrollLeaders() {
        // 봇 제외, 뱅크롤(보유 칩) 내림차순
        const all = Array.from(this.users.values()).filter(u => u.nickname && !u.nickname.startsWith('🤖'));
        all.sort((a, b) => (b.bankroll || 0) - (a.bankroll || 0));
        return all.slice(0, 10).map(u => ({ nickname: u.nickname, bankroll: u.bankroll || 0, wins: u.wins || 0 }));
    }
};
MockDB.load();

function createSecureDeck() {
    const suits = ['s', 'h', 'd', 'c'];
    const values = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    let deck = [];
    for (let s of suits) for (let v of values) deck.push(v + s);
    for (let i = deck.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// 🔐 [무결성] 검증 가능한 셔플(Provably Fair)
//   1) 서버가 비밀 시드를 만들고 SHA256(commit)을 핸드 시작 전 공개 → 조작 불가 약속
//   2) 시드 + 클라이언트 엔트로피로 결정적 셔플
//   3) 핸드 종료 후 시드 공개 → 누구나 재현해서 검증

// 💬 [몰입] 봇 성격별 대사 — 부산 사투리 섞인 도발/리액션
const BOT_LINES = {
    '광폭': {
        join: ['오늘 다 쓸어담는다 🔥', '판돈 작네? 몸 좀 풀어볼까', '겁먹지 말고 덤벼라'],
        bigbet: ['올인 가자!!', '쫄리면 접든가 ㅋㅋ', '이 판 내가 먹는다', '다 걸어'],
        bluff: ['내 패 궁금하나? ㅋㅋ', '믿거나 말거나~', '느낌이 쎄하지?'],
        win: ['거봐 내가 먹는댔지 😎', '칩 잘 받았다 🤑', '이게 실력이다', '또 줍줍'],
        lose: ['에이 한 끗 차이네', '운 좋았다 인정', '다음 판 두고보자'],
        fold: ['이번엔 양보한다', '쓰레기패라 접는다 ㅋ']
    },
    '루즈-어그레시브': {
        join: ['반갑다 잘 부탁한데이~', '오늘 운 좀 따라줘봐라', '재밌게 쳐보자'],
        bigbet: ['압박 좀 넣어볼까', '이 정도는 받아주제?', '슬슬 가속한다'],
        bluff: ['진짜일까 뻥일까~ 😏', '한번 따라와봐라', '감으로 가는기다'],
        win: ['굿굿 잘 들어왔다 😁', '읽기 성공이네', '이 맛에 친다'],
        lose: ['아쉽다 잘 쳤다', '그 패를 콜하네 ㄷㄷ', '복수하러 온다'],
        fold: ['음 이건 접자', '다음 기회에']
    },
    '타이트-어그레시브': {
        join: ['정석대로 가보겠습니다', '잘 부탁드립니다', '깔끔하게 쳐봅시다'],
        bigbet: ['밸류 받으러 갑니다', '계산상 베팅합니다', '이 정도가 적정선이죠'],
        bluff: ['...', '블록 베팅입니다', '레인지상 베팅이에요'],
        win: ['잘 짜였네요 👍', '계산대로입니다', '좋은 핸드였습니다'],
        lose: ['좋은 콜이었어요', '어쩔 수 없죠', '분산이네요'],
        fold: ['폴드가 맞네요', '여기선 접습니다']
    },
    '콜링스테이션': {
        join: ['콜이 제맛이지~', '난 잘 안 접는다 ㅋㅋ', '끝까지 봐야제'],
        bigbet: ['그래도 콜!', '궁금하니까 본다', '에라 모르겠다'],
        bluff: ['음... 콜할까말까', '난 못 접어~'],
        win: ['콜이 답이었네 ㅋㅋ', '거봐 봐야된다니까', '럭키~'],
        lose: ['아 그래도 봤어야지', '미련 없다', '한번 더!'],
        fold: ['이건 진짜 못 가겠다', '오늘 처음 접는다 ㅋ']
    },
    '초타이트': {
        join: ['신중하게 가겠습니다', '...', '조용히 칩니다'],
        bigbet: ['확실할 때만 갑니다', '이건 너트급이죠'],
        bluff: ['...', '믿으셔도 됩니다'],
        win: ['기다린 보람이 있네요', '프리미엄 핸드였습니다'],
        lose: ['드물게 졌네요', '그럴 수 있죠'],
        fold: ['접습니다', '아닌 건 아니죠', '쉽게 폴드']
    }
};

// 🔐 makeServerSeed / commitHash / seededShuffle 는 lib/shuffle.js 로 추출 (상단 require)

// 💡 [신규] 올인 런아웃 실시간 승률 계산용 전체 덱
const FULL_DECK = (() => {
    const suits = ['s', 'h', 'd', 'c'];
    const values = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    const d = [];
    for (let s of suits) for (let v of values) d.push(v + s);
    return d;
})();

// ═══════════ 🎯 포지션별 프리플랍 레인지 시스템 (AI + 학습조언 공유) ═══════════
// 핸드 두 장 → 169칸 표기 (예: 'AKs','AJo','TT')
function handToCode(hand) {
    const order = '23456789TJQKA';
    const r1 = hand[0][0], r2 = hand[1][0];
    const v1 = order.indexOf(r1), v2 = order.indexOf(r2);
    const hi = v1 >= v2 ? r1 : r2, lo = v1 >= v2 ? r2 : r1;
    if (r1 === r2) return hi + lo;                 // 페어
    const suited = hand[0][1] === hand[1][1];
    return hi + lo + (suited ? 's' : 'o');
}
// 핸드의 "강도 순위" 점수 (레인지 임계값 비교용, 0~100). Chen 변형 + 승률 근사 혼합.
function handRangeScore(code) {
    const order = '23456789TJQKA';
    const a = order.indexOf(code[0]), b = order.indexOf(code[1]);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    const pair = code[0] === code[1];
    const suited = code[2] === 's';
    const gap = hi - lo;
    let s;
    if (pair) {
        s = 50 + hi * 4;                            // 22=50 ... AA=98
    } else {
        s = 18 + hi * 2.6 + lo * 1.4;               // 하이/로우 가중
        if (suited) s += 7;
        if (gap === 1) s += 6;                      // 커넥터
        else if (gap === 2) s += 3;
        else if (gap === 3) s += 1;
        else if (gap >= 5) s -= 4;                  // 큰 갭 페널티
        // 수딧 커넥터/원갭퍼는 낮은 카드여도 플레이성 보너스 (54s~JTs류 BTN 오픈)
        if (suited && gap === 1 && lo >= 2) s += 4; // 43s 이상 수딧 커넥터
        if (suited && gap === 2 && lo >= 3) s += 2; // 수딧 원갭퍼
        // A는 별도 보너스(너트 잠재력)
        if (hi === 12) s += suited ? 5 : 2;
        // 오프수트 약한 갭 핸드 추가 페널티 (J8o, T8o, K5o 류 — 플레이성 낮음)
        if (!suited && gap >= 2 && hi < 12) s -= 3;
        // 매우 낮은 오프수트(둘 다 9 이하)는 더 페널티
        if (!suited && hi <= 7 && gap >= 2) s -= 2;
    }
    return Math.max(0, Math.min(100, Math.round(s)));
}
// 포지션별 오픈(레이즈) 임계값 — 차트에 없는 핸드의 보조 판단용
const POSITION_OPEN_THRESHOLD = {
    'UTG': 60, 'UTG+1': 60, 'UTG+2': 59, 'LJ': 59, 'HJ': 58, 'CO': 55, 'BTN': 49, 'SB': 51, 'BB': 44
};
function openThreshold(position) {
    if (POSITION_OPEN_THRESHOLD[position] !== undefined) return POSITION_OPEN_THRESHOLD[position];
    if (position && position.startsWith('UTG')) return 64;
    return 58;
}

// 📊 표준 6맥스 RFI(Raise First In) 오픈 레인지 차트 — GTO 솔버 근사, 학습 정확도용
const PREFLOP_OPEN_RANGE = {
  'UTG': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','QJs','QTs','JTs','J9s','T9s','98s','87s','76s','65s','54s','AKo','AQo','AJo','KQo']),
  'HJ': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','QJs','QTs','Q9s','JTs','J9s','T9s','T8s','98s','97s','87s','76s','65s','54s','AKo','AQo','AJo','ATo','KQo','KJo','QJo']),
  'CO': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s','QJs','QTs','Q9s','Q8s','JTs','J9s','J8s','T9s','T8s','98s','97s','87s','76s','65s','54s','43s','AKo','AQo','AJo','ATo','A9o','KQo','KJo','KTo','QJo','QTo','JTo']),
  'BTN': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s','K4s','K3s','K2s','QJs','QTs','Q9s','Q8s','Q7s','Q6s','Q5s','Q4s','JTs','J9s','J8s','J7s','J6s','T9s','T8s','T7s','T6s','98s','97s','96s','87s','86s','85s','76s','75s','65s','64s','54s','53s','43s','AKo','AQo','AJo','ATo','A9o','A8o','A7o','A6o','A5o','A4o','A3o','A2o','KQo','KJo','KTo','K9o','K8o','QJo','QTo','Q9o','JTo','J9o','T9o','98o','87o','76o']),
  'SB': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s','K4s','K3s','K2s','QJs','QTs','Q9s','Q8s','Q7s','Q6s','Q5s','JTs','J9s','J8s','J7s','T9s','T8s','T7s','98s','97s','87s','76s','65s','54s','43s','AKo','AQo','AJo','ATo','A9o','A8o','A7o','A5o','KQo','KJo','KTo','K9o','QJo','QTo','Q9o','JTo','J9o','T9o'])
};
function rangeKeyFor(position) {
    if (!position) return 'CO';
    if (PREFLOP_OPEN_RANGE[position]) return position;
    if (position.startsWith('UTG')) return 'UTG';
    if (position === 'LJ') return 'HJ';
    return 'CO';
}
function isInOpenRange(code, position) {
    const set = PREFLOP_OPEN_RANGE[rangeKeyFor(position)];
    return set ? set.has(code) : false;
}
// 차트 기반 분류 — 오픈 레인지에 있으면 raise, 약간 밑이면 call, 아니면 fold
function preflopRangeTier(code, position, facingRaise) {
    const score = handRangeScore(code);
    const inRange = isInOpenRange(code, position);
    // AK/AA/KK/QQ는 항상 3벳급 프리미엄 (점수와 무관하게 명시)
    const isPremium3bet = (code === 'AKs' || code === 'AKo' || code === 'AA' || code === 'KK' || code === 'QQ' || code === 'JJ');
    if (facingRaise) {
        if (isPremium3bet) return { tier: 'raise', label: '3벳/밸류', score };
        if (inRange) {
            // 차트 내 핸드라도 레이즈 직면 시엔 "디펜스 콜" — 점수 충분해야 콜, 약하면 폴드
            if (score >= 85) return { tier: 'raise', label: '3벳/밸류', score };
            if (score >= 66) return { tier: 'call', label: '콜', score };  // 콜 디펜스
            return { tier: 'fold', label: '폴드', score };  // 오픈은 되지만 디펜스엔 약함
        }
        // 차트 밖 — 어지간히 강하지 않으면 폴드
        if (score >= 70) return { tier: 'call', label: '콜', score };
        return { tier: 'fold', label: '폴드', score };
    }
    if (inRange) return { tier: 'raise', label: '오픈 레이즈', score };
    const th = openThreshold(position);
    if (score >= th - 6) return { tier: 'call', label: '마지널', score };
    return { tier: 'fold', label: '폴드', score };
}

class GameRoom {
    constructor(roomId, settings) {
        this.roomId = roomId;
        // 💡 [수정 #7] 방 설정값 검증 (비정상 값으로 인한 게임 붕괴 방지)
        this.startingChips = clampInt(settings.startingChips, 1000, 1000000, 10000);
        this.blindUpInterval = clampInt(settings.blindUpInterval, 60, 3600, 600);
        this.turnTimeLimit = clampInt(settings.turnTimeLimit, 5, 60, 20);
        this.maxRebuys = clampInt(settings.maxRebuys, 0, 3, 1); // 💡 리바이 허용 횟수 (블라인드 레벨 2까지)
        this._rebuyGraceActive = false;
        // 💵 게임 모드: 'tournament'(기본) | 'cash'
        this.mode = settings.mode === 'cash' ? 'cash' : 'tournament';
        this.cashBlind = clampInt(settings.cashBlind, 1, 100000, 100); // 캐시 빅블라인드 고정값
        this.hostNickname = null;

        this.players = {};
        this.playerOrder = [];
        this.deck = [];
        this.communityCards = [];
        this.gameStage = 0;
        this.pot = 0;
        this.currentHighestBet = 0;
        this.lastFullRaiseAmount = 0;
        this.raiseCountThisStreet = 0; // 📊 핸드 시작 — 레이즈 카운트 리셋
        this.turnIndex = -1;
        this.dealerIndex = 0;
        this.handId = 0;
        this.handHistory = []; // 📜 최근 핸드 기록 (최대 30개)

        // 🧠 [#2 AI고도화] 방 내 상대 성향 추적 — 봇이 익스플로잇에 사용
        //   nick → { faceBet, foldToBet, aggrActs, totalActs, vpipHands, pfHands, showdownAgg }
        this.oppStats = {};

        this.tournamentStarted = false;
        this.blindLevel = 0;
        this.timeRemaining = this.blindUpInterval;
        this.tournamentTimer = null;

        this.turnEndTime = 0;
        this.turnTimeout = null;
        this.pendingStageTimeout = null;

        this.blindStructure = [
            { level: 1, sb: 50, bb: 100, ante: 0 },
            { level: 2, sb: 100, bb: 200, ante: 200 },
            { level: 3, sb: 200, bb: 400, ante: 400 },
            { level: 4, sb: 500, bb: 1000, ante: 1000 },
            { level: 5, sb: 1000, bb: 2000, ante: 2000 },
            { level: 6, sb: 2000, bb: 4000, ante: 4000 }
        ];

        // 💵 캐시게임: 블라인드업 없이 고정 — 단일 레벨 구조로 교체
        if (this.mode === 'cash') {
            const bb = this.cashBlind;
            this.blindStructure = [{ level: 1, sb: Math.max(1, Math.floor(bb / 2)), bb: bb, ante: 0 }];
        }
    }

    // 💡 [신규] 올인 런아웃 실시간 승률 — 몬테카를로 시뮬레이션
    computeEquities() {
        const contenders = this.playerOrder.filter(n => {
            const p = this.players[n];
            return p && !p.isFolded && p.hand && p.hand.length === 2;
        });
        if (contenders.length < 2) return null;

        const known = new Set(this.communityCards);
        contenders.forEach(n => this.players[n].hand.forEach(c => known.add(c)));
        const remaining = FULL_DECK.filter(c => !known.has(c));
        const need = 5 - this.communityCards.length;

        const wins = {};
        contenders.forEach(n => { wins[n] = 0; });
        const ITER = need === 0 ? 1 : (contenders.length <= 2 ? 600 : 400);

        for (let it = 0; it < ITER; it++) {
            const sample = [];
            if (need > 0) {
                const pool = remaining.slice();
                for (let k = 0; k < need; k++) {
                    const j = k + Math.floor(Math.random() * (pool.length - k));
                    [pool[k], pool[j]] = [pool[j], pool[k]];
                    sample.push(pool[k]);
                }
            }
            const board = this.communityCards.concat(sample);
            const hands = contenders.map(n => {
                const h = Hand.solve(this.players[n].hand.concat(board));
                h.playerId = n;
                return h;
            });
            const ws = Hand.winners(hands);
            ws.forEach(w => { wins[w.playerId] += 1 / ws.length; });
        }

        const eq = {};
        contenders.forEach(n => { eq[n] = Math.round((wins[n] / ITER) * 1000) / 10; });
        return eq;
    }

    emitEquity() {
        try {
            const eq = this.computeEquities();
            if (eq) io.to(this.roomId).emit('equityUpdate', { equities: eq, stage: this.gameStage });
        } catch (e) { console.error('equity error:', e); }
    }

    sendState() {
        try {
            const activeNonAllIn = this.playerOrder.filter(n => this.players[n] && !this.players[n].isFolded && !this.players[n].isAllIn);
            const isAllInShowdown = (activeNonAllIn.length <= 1 && this.turnIndex === -1);

            Object.values(this.players).forEach(recipient => {
                const sanitizedPlayers = {};
                Object.keys(this.players).forEach(nick => {
                    const p = this.players[nick];
                    const isMe = (p.id === recipient.id);

                    const showHand = isMe || ((this.gameStage === 5 || isAllInShowdown) && !p.isFolded && !p.isMucked);

                    const safeHand = p.hand || [];
                    let currentRankName = '';

                    if (showHand && safeHand.length === 2 && safeHand[0] !== '?') {
                        if (this.communityCards.length >= 3) {
                            try {
                                const evalCards = safeHand.concat(this.communityCards);
                                const solved = Hand.solve(evalCards);
                                currentRankName = solved.name;
                            } catch(e) {}
                        } else if (this.communityCards.length === 0) {
                            if (safeHand[0][0] === safeHand[1][0]) currentRankName = 'Pair';
                        }
                    }

                    sanitizedPlayers[nick] = {
                        ...p,
                        hand: showHand ? safeHand : (safeHand.length > 0 ? ['?', '?'] : []),
                        currentRank: currentRankName
                    };
                    delete sanitizedPlayers[nick]._disconnectTimer; // 타이머 객체 직렬화 방지
                    delete sanitizedPlayers[nick]._botTimer;
                });

                io.to(recipient.socketId).emit('updateTable', {
                    players: sanitizedPlayers,
                    communityCards: this.communityCards,
                    gameStage: this.gameStage,
                    pot: this.pot,
                    currentHighestBet: this.currentHighestBet,
                    lastRaiseAmount: this.lastFullRaiseAmount,
                    turnPlayerId: this.turnIndex === -1 ? null : (this.playerOrder[this.turnIndex] || null),
                    tournamentInfo: (this.tournamentStarted || this.mode === 'cash') ? this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)] : null,
                    gameMode: this.mode,
                    timeRemaining: this.timeRemaining,
                    turnEndTime: this.turnEndTime,
                    turnTimeLimit: this.turnTimeLimit, // 💡 [수정 #4] 클라이언트 타임바 동기화용
                    handId: this.handId,
                    hostNickname: this.hostNickname,
                    startingChips: this.startingChips,
                    playerOrder: this.playerOrder
                });
            });
        } catch(e) { console.error("sendState error:", e); }
    }

    startTournamentTimer() {
        if (this.tournamentTimer) clearInterval(this.tournamentTimer);
        this.tournamentTimer = setInterval(() => {
            if (this.timeRemaining > 0) {
                this.timeRemaining--;
                io.to(this.roomId).emit('updateTimer', this.timeRemaining);
            } else {
                if (this.blindLevel < this.blindStructure.length - 1) this.blindLevel++;
                this.timeRemaining = this.blindUpInterval;
                const bl = this.blindStructure[this.blindLevel];
                io.to(this.roomId).emit('gameMessage', `🚨 블라인드 레벨 업! (${bl.sb}/${bl.bb})`);
                this.sendState();
            }
        }, 1000);
    }

    startTurnTimer() {
        if (this.turnTimeout) clearTimeout(this.turnTimeout);
        const msLimit = this.turnTimeLimit * 1000;
        this.turnEndTime = Date.now() + msLimit;
        io.to(this.roomId).emit('updateTurnTimer', this.turnEndTime);

        const expectedNick = this.playerOrder[this.turnIndex];

        this.turnTimeout = setTimeout(() => {
            if (this.turnIndex === -1 || this.playerOrder[this.turnIndex] !== expectedNick) return;

            const p = this.players[expectedNick];
            if (p && !p.isFolded && !p.isAllIn) {
                const callAmount = this.currentHighestBet - p.currentBet;
                if (callAmount === 0) {
                    p.hasActed = true;
                    io.to(this.roomId).emit('gameMessage', `⏳ ${expectedNick} 자동 체크`);
                    io.to(this.roomId).emit('actionSound', { nick: expectedNick, type: 'check' });
                } else {
                    p.isFolded = true;
                    p.hasActed = true;
                    io.to(this.roomId).emit('gameMessage', `⏳ ${expectedNick} 시간 초과 (자동 폴드)`);
                    io.to(this.roomId).emit('actionSound', { nick: expectedNick, type: 'fold' });
                }
                this.nextTurn();
            }
        }, msLimit);

        this.maybeScheduleBot(expectedNick); // 🤖 현재 턴이 봇이면 자동 행동 예약

        // 🎓 [학습모드] 사람 차례면 GTO 권장 액션 분석을 본인에게만 전송
        if (this._learnMode) {
            const cp = this.players[expectedNick];
            if (cp && !cp.isBot && !cp.isFolded && !cp.isAllIn && cp.socketId) {
                try {
                    const advice = this.getGtoAdvice(expectedNick);
                    if (advice) io.to(cp.socketId).emit('gtoAdvice', advice);
                } catch (e) {}
            }
        }
    }

    // 🤖 [신규] 봇 두뇌 — 핸드 강도 + 팟 오즈 기반 의사결정
    maybeScheduleBot(nick) {
        const p = this.players[nick];
        if (!p || !p.isBot || p.isFolded || p.isAllIn) return;
        const expectedNick = nick;
        // 사람처럼 0.9~2.0초 생각 후 행동
        const thinkMs = 900 + Math.floor(Math.random() * 1100);
        if (p._botTimer) clearTimeout(p._botTimer);
        p._botTimer = setTimeout(() => {
            // 그 사이 턴이 바뀌었으면 취소
            if (this.turnIndex === -1 || this.playerOrder[this.turnIndex] !== expectedNick) return;
            const decision = this.botDecide(expectedNick);
            // 💬 큰 베팅/올인/레이즈면 도발 멘트
            const pp = this.players[expectedNick];
            const potNow = this.pot + Object.values(this.players).reduce((s, x) => s + (x.currentBet || 0), 0);
            if (decision.type === 'allin' || (decision.type === 'raise' && decision.amount > potNow * 0.6)) {
                // 약한 핸드로 큰 베팅 = 블러프 멘트, 강하면 빅벳 멘트
                const eqGuess = this._lastBotEquity != null ? this._lastBotEquity : 0.5;
                this.botSay(expectedNick, eqGuess < 0.45 ? 'bluff' : 'bigbet');
            }
            const ok = this.applyAction(expectedNick, decision.type, decision.amount);
            // 🛡️ 무효 결정 방어 — 봇이 잘못된 레이즈 등으로 막히면 안전 액션으로 폴백 (테이블 멈춤 방지)
            if (ok === false) {
                const pl = this.players[expectedNick];
                if (pl && !pl.isFolded && !pl.isAllIn && this.playerOrder[this.turnIndex] === expectedNick) {
                    const toCall = this.currentHighestBet - pl.currentBet;
                    this.applyAction(expectedNick, toCall > 0 ? 'call' : 'check');
                }
            }
        }, thinkMs);
    }

    // 🤖 봇 의사결정: 몬테카를로 승률 추정 → 팟 오즈와 비교 (+ 보드텍스처 + 상대성향 익스플로잇)
    botDecide(nick) {
        const p = this.players[nick];
        const toCall = Math.min(this.currentHighestBet - p.currentBet, p.chips);
        const totalPot = this.pot + Object.values(this.players).reduce((s, pl) => s + pl.currentBet, 0);
        const bb = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;

        // 성격 아키타입 (봇마다 고정) — 플레이 스타일을 결정
        const persona = p._persona || (p._persona = this.assignPersona(nick, p.difficulty));

        // 1) 승률 추정 (프리플랍 간이식 / 포스트플랍 몬테카를로)
        let rawEquity = this.estimateBotEquity(nick);
        // 🎚️ [난이도] 초보일수록 승률 판단에 노이즈 추가 (오판)
        const noise = persona.equityNoise || 0;
        if (noise > 0) rawEquity += (Math.random() * 2 - 1) * noise;
        let equity = Math.max(0, Math.min(1, rawEquity * persona.equityBias));
        this._lastBotEquity = equity; // 💬 도발 멘트 판단용 (블러프/밸류 구분)

        const callable = toCall <= p.chips;
        const potOdds = toCall > 0 ? toCall / (totalPot + toCall) : 0.0;
        const street = this.gameStage; // 1=preflop, 2=flop, 3=turn, 4=river
        const r = Math.random();
        const boardCount = this.communityCards.length;
        const isLastToAct = this.isLikelyLastAggressor(nick);
        const skill = persona.skillFactor != null ? persona.skillFactor : 0.8; // 🎚️ 봇 실력 계수 (레인지 판단에 사용)

        // 🎯 [프리플랍 포지션 레인지] 봇은 포지션별 레인지로 raise-or-fold(정석) — 림프 최소화, 레인지면 오픈 레이즈
        if (street === 1 && p.hand && p.hand.length === 2) {
            try {
                const code = handToCode(p.hand);
                const facingRaise = toCall > 0 && this.currentHighestBet > bb;
                const rt = preflopRangeTier(code, p.position || '', facingRaise);
                const isBB = p.role && p.role.includes('BB');

                // 표준 오픈 사이즈로 "raise to" 금액 계산 (2.4~3.1bb, 최소레이즈·스택 보정)
                const openRaiseDecision = () => {
                    const openTo = Math.round(bb * (2.4 + Math.random() * 0.7));
                    const minRaiseTo = this.currentHighestBet + (this.lastFullRaiseAmount || bb);
                    const target = Math.min(p.currentBet + p.chips, Math.max(openTo, minRaiseTo));
                    return (target > this.currentHighestBet) ? { type: 'raise', amount: target } : { type: 'call' };
                };

                if (!facingRaise && toCall > 0) {
                    // ── 오픈/아이소 기회 (아직 레이즈 없음, 콜=블라인드 한 개) — 정석은 raise-or-fold ──
                    if (rt.tier === 'raise') {
                        if (r < 0.90 * skill + 0.08) return openRaiseDecision(); // 대부분 오픈 (가끔만 림프=밸런스)
                    } else if (rt.tier === 'call') {
                        // 마지널 — 늦은 포지션은 자주 오픈(스틸), 아니면 폴드 (림프 지양)
                        const late = (p.position === 'BTN' || p.position === 'CO' || p.position === 'SB');
                        if (r < (late ? 0.55 : 0.28) * (0.5 + skill * 0.6)) return openRaiseDecision();
                        if (!(isBB && toCall <= bb * 0.5)) return { type: 'fold' };
                        equity *= 0.85;
                    } else {
                        // 레인지 밖 — 폴드 (BB의 싼 콜만 예외적으로 아래 로직 허용)
                        if (!(isBB && toCall <= bb * 0.5) && r < 0.90 * skill + 0.08) return { type: 'fold' };
                        equity *= 0.75;
                    }
                } else if (facingRaise) {
                    // ── 레이즈 직면 — 3벳/콜/폴드 ──
                    if (rt.tier === 'fold') {
                        if (!(isBB && toCall <= bb * 0.5) && r < 0.88 * skill + 0.1) return { type: 'fold' };
                        equity *= 0.78;
                    } else if (rt.tier === 'raise') {
                        equity = Math.min(1, equity * 1.10); // 프리미엄 — 3벳 경향 강화
                    }
                    // rt.tier === 'call' 이면 통과 (아래 로직에서 콜/가끔 3벳)
                } else {
                    // ── toCall === 0 (BB 무료 체크 또는 림프 팟) ──
                    if (rt.tier === 'fold') { if (!isBB && r < 0.92) return { type: 'check' }; equity *= 0.85; }
                    else if (rt.tier === 'raise') equity = Math.min(1, equity * 1.08); // 강하면 아래에서 레이즈(아이소)
                }
            } catch (e) {}
        }

        // 🎚️ [난이도] 랜덤 실수 — 초보는 가끔 비합리적 액션 (오버콜/근거없는 폴드)
        if (persona.mistakeChance && Math.random() < persona.mistakeChance) {
            if (toCall === 0) return { type: Math.random() < 0.5 ? 'check' : 'raise', amount: Math.min(p.currentBet + p.chips, p.currentBet + Math.max(bb, Math.round(totalPot * 0.5))) };
            if (callable && Math.random() < 0.7) return { type: 'call' }; // 손해여도 콜
            return { type: 'fold' };
        }

        // 🌊 [#2] 보드 텍스처 분석 — 웻(드로우 많음)/드라이/페어드
        const board = this.analyzeBoardTexture();

        // 🧠 [#2] 상대 성향 읽기 — 현재 핸드의 주요 상대(가장 많이 베팅한 액티브 상대)
        const oppRead = this.getPrimaryOpponentRead(nick);

        // 블러프/밸류 빈도를 보드텍스처 + 상대성향으로 동적 조정 (난이도가 낮으면 약하게 반영)
        let bluffMod = 1.0, valueMod = 1.0;
        if (board) {
            if (board.dry) bluffMod += 0.35 * skill;
            if (board.wet) bluffMod -= 0.25 * skill;
            if (board.paired) bluffMod += 0.15 * skill;
        }
        if (oppRead) {
            // 잘 폴드하는 상대 → 블러프 ↑ / 콜링스테이션(안 폴드) → 블러프 ↓, 밸류 ↑ (스킬팩터로 감쇠)
            if (oppRead.foldToBet !== null) {
                if (oppRead.foldToBet > 0.6) bluffMod += 0.5 * skill;
                else if (oppRead.foldToBet < 0.3) { bluffMod -= 0.4 * skill; valueMod += 0.2 * skill; }
            }
            if (oppRead.aggression !== null && oppRead.aggression > 0.45) valueMod += 0.1 * skill;
        }
        bluffMod = Math.max(0.2, Math.min(2.2, bluffMod));
        valueMod = Math.max(0.6, Math.min(1.6, valueMod));

        const sizeBet = (mult) => {
            // 웻 보드에선 더 크게(드로우 차단), 드라이에선 작게
            let texMult = board ? (board.wet ? 1.15 : board.dry ? 0.85 : 1.0) : 1.0;
            const frac = persona.sizeBase * mult * texMult * (0.85 + Math.random() * 0.3);
            return Math.max(bb, Math.round(totalPot * frac));
        };

        // ─── 체크 가능 상황 (콜 비용 0) ───
        if (toCall === 0) {
            if (equity > persona.valueThresh) {
                const target = Math.min(p.currentBet + p.chips, p.currentBet + sizeBet(1.0));
                if (target > this.currentHighestBet && r < Math.min(0.95, persona.valueBetFreq * valueMod)) return { type: 'raise', amount: target };
                return { type: 'check' };
            }
            let bluffChance = persona.bluffFreq * bluffMod;
            if (isLastToAct) bluffChance += 0.08;
            if (board && board.dry && equity < 0.35) bluffChance += 0.06;
            if (r < bluffChance && p.chips > bb * 3) {
                const target = Math.min(p.currentBet + p.chips, p.currentBet + sizeBet(0.85));
                if (target > this.currentHighestBet) return { type: 'raise', amount: target };
            }
            return { type: 'check' };
        }

        // ─── 콜 비용이 있는 상황 ───
        const margin = equity - potOdds;

        // 🎯 [GTO 올인 콜] 콜 비용이 내 스택의 큰 비중(올인성)이면 팟오즈 기준 엄격 판단
        //    토너먼트 생존이 걸린 콜이므로, equity가 팟오즈를 충분히 상회할 때만 콜
        const callCostRatio = p.chips > 0 ? toCall / p.chips : 1;
        const isBigCall = callable && (callCostRatio >= 0.7 || toCall >= p.chips); // 스택 70%+ 또는 올인
        if (isBigCall) {
            // 실제 콜 시점의 정확한 팟오즈 (이미 위에서 potOdds 계산됨)
            // GTO 기본: equity > potOdds 면 +EV 콜. 단 토너먼트 생존 가치(ICM) 반영해 약간의 여유(+0.03) 요구
            const requiredEdge = (toCall >= p.chips) ? 0.04 : 0.02; // 풀 올인은 더 엄격
            if (equity >= potOdds + requiredEdge) {
                // 매우 강하면 레이즈(재올인), 아니면 콜
                if (equity > 0.72 && p.chips > toCall) {
                    const target = Math.min(p.currentBet + p.chips, this.currentHighestBet + sizeBet(1.1));
                    if (target >= this.currentHighestBet + this.lastFullRaiseAmount && target > this.currentHighestBet) {
                        return { type: 'raise', amount: target };
                    }
                }
                return { type: 'call' };
            }
            // 블러프 캐치: 상대가 매우 어그레시브하고 마진이 경계면 가끔만 콜
            const suspectBluff = oppRead && oppRead.aggression !== null && oppRead.aggression > 0.55;
            if (suspectBluff && equity >= potOdds - 0.04 && Math.random() < 0.35) return { type: 'call' };
            return { type: 'fold' };
        }

        // 충분히 강함 → 레이즈/밸류
        if (equity > persona.raiseThresh && callable) {
            if (r < Math.min(0.95, persona.raiseFreq * valueMod)) {
                const target = Math.min(p.currentBet + p.chips, this.currentHighestBet + sizeBet(1.1));
                if (target >= this.currentHighestBet + this.lastFullRaiseAmount && target > this.currentHighestBet) {
                    return { type: 'raise', amount: target };
                }
            }
            return { type: 'call' };
        }

        // 승률이 팟 오즈보다 확실히 낮음 → 폴드 (단, 세미블러프 가능)
        if (margin < -0.05) {
            const semiBluff = persona.bluffFreq * bluffMod * 0.7;
            // 웻 보드에서 드로우성(중간 에퀴티) 세미블러프 강화
            const drawBoost = (board && board.wet && equity > 0.3) ? 1.4 : 1.0;
            if (r < semiBluff * drawBoost && equity > 0.28 && callable && street < 4 && p.chips > bb * 4) {
                const target = Math.min(p.currentBet + p.chips, this.currentHighestBet + sizeBet(1.0));
                if (target >= this.currentHighestBet + this.lastFullRaiseAmount) return { type: 'raise', amount: target };
            }
            // 콜링스테이션 성격 or 상대가 어그레시브해서 블러프 의심되면 콜다운
            const suspectBluff = oppRead && oppRead.aggression !== null && oppRead.aggression > 0.5;
            if ((persona.callSticky || suspectBluff) && margin > -0.14 && r < 0.55) return { type: 'call' };
            return { type: 'fold' };
        }

        // 마진이 애매한 구간 (0 근처) → 주로 콜, 가끔 레이즈
        if (margin >= -0.05 && margin < 0.1) {
            if (r < persona.thinRaiseFreq * valueMod && callable) {
                const target = Math.min(p.currentBet + p.chips, this.currentHighestBet + sizeBet(0.9));
                if (target >= this.currentHighestBet + this.lastFullRaiseAmount && target > this.currentHighestBet) {
                    return { type: 'raise', amount: target };
                }
            }
            return { type: 'call' };
        }

        // 마진 양호 → 콜 (가끔 레이즈)
        if (r < persona.raiseFreq * 0.6 * valueMod && callable) {
            const target = Math.min(p.currentBet + p.chips, this.currentHighestBet + sizeBet(1.0));
            if (target >= this.currentHighestBet + this.lastFullRaiseAmount && target > this.currentHighestBet) {
                return { type: 'raise', amount: target };
            }
        }
        return { type: 'call' };
    }

    // 🌊 [#2] 보드 텍스처 분석 — 드로우/페어/하이카드 구조 파악
    analyzeBoardTexture() {
        const cc = this.communityCards;
        if (!cc || cc.length < 3) return null;
        const order = '23456789TJQKA';
        const ranks = cc.map(c => order.indexOf(c[0])).filter(v => v >= 0);
        const suits = cc.map(c => c[1]);

        // 페어드 보드
        const rankCounts = {};
        ranks.forEach(v => rankCounts[v] = (rankCounts[v] || 0) + 1);
        const paired = Object.values(rankCounts).some(c => c >= 2);

        // 플러시 드로우 가능성 (같은 무늬 3+)
        const suitCounts = {};
        suits.forEach(s => suitCounts[s] = (suitCounts[s] || 0) + 1);
        const flushy = Object.values(suitCounts).some(c => c >= 3);
        const flushDraw = Object.values(suitCounts).some(c => c === 2 && cc.length <= 4);

        // 스트레이트 드로우 가능성 (랭크 간격 좁음)
        const uniq = [...new Set(ranks)].sort((a, b) => a - b);
        let connected = false;
        for (let i = 0; i + 1 < uniq.length; i++) {
            if (uniq[i + 1] - uniq[i] <= 2) connected = true;
        }
        const span = uniq.length >= 2 ? uniq[uniq.length - 1] - uniq[0] : 99;
        const straighty = connected && span <= 4;

        // 하이카드 보드 (브로드웨이)
        const highCards = ranks.filter(v => v >= 9).length; // T 이상

        const wet = flushy || straighty || (flushDraw && connected);
        const dry = !wet && !paired && highCards <= 1 && span >= 5;

        return { paired, flushy, flushDraw, straighty, wet, dry, highCards };
    }

    // 🧠 [#2] 현재 핸드의 주요 상대(가장 공격적인 액티브 상대) 성향 읽기
    getPrimaryOpponentRead(myNick) {
        const actives = this.playerOrder.filter(n => n !== myNick && !this.players[n].isFolded);
        let best = null, bestSamples = -1;
        for (const n of actives) {
            const read = this.getOpponentRead(n);
            if (read && read.samples > bestSamples) { best = read; bestSamples = read.samples; }
        }
        return best;
    }

    // 🤖 봇 성격 아키타입 — 닉네임 해시로 고정 배정 (봇마다 다른 스타일)
    assignPersona(nick, difficulty) {
        const h = this.hashNick(nick);
        const diff = ['easy', 'normal', 'hard'].includes(difficulty) ? difficulty : 'normal';
        // 이름 힌트가 있으면 우선 반영
        let key;
        if (nick.includes('올인') || nick.includes('타짜') || nick.includes('도박')) key = 'maniac';
        else if (nick.includes('콜콜')) key = 'station';
        else if (nick.includes('폴드')) key = 'nit';
        else if (nick.includes('레이즈') || nick.includes('블러프')) key = 'lag';
        else key = ['tag', 'lag', 'nit', 'station', 'maniac', 'tag'][h % 6];

        // 고수는 정석(TAG/LAG) 위주로 배정 (약한 성격 배제)
        if (diff === 'hard' && (key === 'station' || key === 'maniac')) {
            key = (h % 2 === 0) ? 'tag' : 'lag';
        }

        const P = {
            tag:     { equityBias: 1.00, valueThresh: 0.60, raiseThresh: 0.68, valueBetFreq: 0.78, raiseFreq: 0.62, thinRaiseFreq: 0.12, bluffFreq: 0.14, sizeBase: 0.62, callSticky: false, label: '타이트-어그레시브' },
            lag:     { equityBias: 1.10, valueThresh: 0.52, raiseThresh: 0.58, valueBetFreq: 0.82, raiseFreq: 0.70, thinRaiseFreq: 0.22, bluffFreq: 0.26, sizeBase: 0.70, callSticky: false, label: '루즈-어그레시브' },
            nit:     { equityBias: 0.88, valueThresh: 0.68, raiseThresh: 0.76, valueBetFreq: 0.70, raiseFreq: 0.50, thinRaiseFreq: 0.04, bluffFreq: 0.05, sizeBase: 0.55, callSticky: false, label: '초타이트' },
            station: { equityBias: 1.05, valueThresh: 0.62, raiseThresh: 0.74, valueBetFreq: 0.55, raiseFreq: 0.35, thinRaiseFreq: 0.06, bluffFreq: 0.06, sizeBase: 0.5, callSticky: true,  label: '콜링스테이션' },
            maniac:  { equityBias: 1.18, valueThresh: 0.46, raiseThresh: 0.5,  valueBetFreq: 0.88, raiseFreq: 0.8,  thinRaiseFreq: 0.3,  bluffFreq: 0.34, sizeBase: 0.85, callSticky: false, label: '광폭' }
        };
        const persona = Object.assign({}, P[key]);
        // 같은 아키타입이라도 개체별 미세 변주 (랜덤성)
        const j = ((h >> 4) % 21 - 10) / 100; // -0.10 ~ +0.10
        persona.bluffFreq = Math.max(0, persona.bluffFreq + j * 0.5);
        persona.raiseFreq = Math.max(0.2, Math.min(0.95, persona.raiseFreq + j));
        persona.sizeBase = Math.max(0.35, persona.sizeBase + j * 0.5);

        // 🎚️ [난이도] 실력 보정
        persona.difficulty = diff;
        if (diff === 'easy') {
            // 초보: 승률 판단 오차 큼(noisy), 손해보는 콜 잦음, 익스플로잇/상대읽기 약함
            persona.equityNoise = 0.18;      // 승률 추정에 ±18% 노이즈
            persona.skillFactor = 0.55;      // 익스플로잇·텍스처 반영 약함
            persona.mistakeChance = 0.18;    // 18% 확률로 비합리적 액션
            persona.callSticky = true;       // 잘 안 접음
            persona.bluffFreq *= 0.6;        // 블러프 어설픔(적음)
        } else if (diff === 'hard') {
            // 고수: 정확한 승률, 강한 익스플로잇, 실수 거의 없음
            persona.equityNoise = 0.02;
            persona.skillFactor = 1.0;
            persona.mistakeChance = 0.0;
            persona.valueBetFreq = Math.min(0.95, persona.valueBetFreq + 0.08);
            persona.thinRaiseFreq = Math.min(0.4, persona.thinRaiseFreq + 0.06);
        } else {
            // 중수: 약간의 노이즈, 보통 실력
            persona.equityNoise = 0.08;
            persona.skillFactor = 0.8;
            persona.mistakeChance = 0.06;
        }
        return persona;
    }

    // 후행 포지션(마지막 공격자 가능성) 추정 — 블러프 빈도 가산용
    isLikelyLastAggressor(nick) {
        const active = this.playerOrder.filter(n => !this.players[n].isFolded && !this.players[n].isAllIn);
        if (active.length <= 1) return true;
        // 내 뒤에 액션할 사람이 적을수록 후행
        const myPos = active.indexOf(nick);
        return myPos >= active.length - 2;
    }

    // 💬 [몰입] 봇 채팅 — 성격별 말투/도발 멘트
    botSay(nick, event, extra) {
        const p = this.players[nick];
        if (!p || !p.isBot) return;
        const persona = p._persona || (p._persona = this.assignPersona(nick, p.difficulty));
        const arche = persona.label; // 성격 라벨로 말투 분기
        // 빈도 제한 (너무 수다스럽지 않게)
        const now = Date.now();
        if (event !== 'join' && now - (p._lastChat || 0) < 8000) return;
        // 성격별 발화 확률
        const chatChance = { '광폭': 0.6, '루즈-어그레시브': 0.45, '타이트-어그레시브': 0.25, '콜링스테이션': 0.3, '초타이트': 0.15 }[arche] || 0.3;
        // 입장 멘트는 60%만 발화(여러 봇 추가 시 도배 방지), 승리/그 외는 확률 적용
        if (event === 'join') { if (Math.random() > 0.6) return; }
        else if (event !== 'win' && Math.random() > chatChance) return;

        const L = BOT_LINES[arche] || BOT_LINES['타이트-어그레시브'];
        const pool = L[event];
        if (!pool || pool.length === 0) return;
        let msg = pool[Math.floor(Math.random() * pool.length)];
        if (extra) Object.keys(extra).forEach(k => { msg = msg.replace('{' + k + '}', extra[k]); });
        p._lastChat = now;
        // 입장은 더 넓게 분산(0.4~2.4초), 그 외는 0.4~1.2초 지연 후 발화
        const delay = event === 'join' ? (400 + Math.random() * 2000) : (400 + Math.random() * 800);
        setTimeout(() => {
            if (rooms.get(this.roomId)) io.to(this.roomId).emit('chatMessage', { nick, msg, bot: true });
        }, delay);
    }

    hashNick(nick) {
        let h = 0;
        for (let i = 0; i < nick.length; i++) h = (h * 31 + nick.charCodeAt(i)) >>> 0;
        return h;
    }

    addBot(difficulty) {
        const pool = ['김봇식', '이서봇', '박올인', '최콜콜', '정레이즈', '한판봇', '강타짜', '윤폴드', '조블러프', '도박봇'];
        const used = new Set(this.playerOrder);
        let name = null;
        for (const base of pool) { if (!used.has('🤖' + base)) { name = '🤖' + base; break; } }
        if (!name) name = '🤖봇' + (this.playerOrder.length + 1);

        const diff = ['easy', 'normal', 'hard'].includes(difficulty) ? difficulty : 'normal';

        this.players[name] = {
            id: name, socketId: null, isBot: true,
            chips: this.startingChips,
            currentBet: 0, totalInvested: 0,
            isFolded: false, hasActed: false, role: '', isAllIn: false,
            isDisconnected: false, isMucked: false, hand: [], lastEmoteTime: 0,
            isSpectator: false, rebuysUsed: 0, difficulty: diff
        };
        this.playerOrder.push(name);
        const persona = this.assignPersona(name, diff);
        this.players[name]._persona = persona;
        const diffLabel = { easy: '🟢초보', normal: '🟡중수', hard: '🔴고수' }[diff];
        io.to(this.roomId).emit('gameMessage', `🤖 ${name} 님이 참가했습니데이! (${diffLabel} · ${persona.label})`);
        // 입장 도발 멘트
        this.botSay(name, 'join');
        this.sendState();
    }

    removeBot(botNick) {
        const p = this.players[botNick];
        if (!p || !p.isBot) return;
        if (p._botTimer) clearTimeout(p._botTimer);
        delete this.players[botNick];
        this.playerOrder = this.playerOrder.filter(n => n !== botNick);
        io.to(this.roomId).emit('gameMessage', `🤖 ${botNick} 님이 퇴장했습니데이.`);
        this.sendState();
    }

    // 🤖 봇 전용 승률 추정 (자기 핸드를 알기에 직접 시뮬레이션)
    estimateBotEquity(nick) {
        const p = this.players[nick];
        if (!p.hand || p.hand.length !== 2) return 0.3;

        const opponents = this.playerOrder.filter(n => n !== nick && !this.players[n].isFolded).length;
        if (opponents === 0) return 1;

        // 프리플랍: 간이 핸드 강도 (Chen 공식 변형)
        if (this.communityCards.length === 0) {
            return this.preflopStrength(p.hand) / Math.sqrt(opponents);
        }

        // 포스트플랍: 몬테카를로
        const known = new Set([...this.communityCards, ...p.hand]);
        const pool = FULL_DECK.filter(c => !known.has(c));
        const need = 5 - this.communityCards.length;
        const ITER = 500; // 120→500: 표준편차 0.041→0.017로 안정화 (GTO 평가 정확도 ↑)
        let win = 0;

        for (let it = 0; it < ITER; it++) {
            const shuffled = pool.slice();
            for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
            let idx = 0;
            const board = this.communityCards.concat(shuffled.slice(idx, idx += need));
            const oppHands = [];
            for (let o = 0; o < opponents; o++) oppHands.push([shuffled[idx++], shuffled[idx++]]);

            try {
                const mine = Hand.solve(p.hand.concat(board));
                const all = [mine, ...oppHands.map(oh => Hand.solve(oh.concat(board)))];
                const winners = Hand.winners(all);
                if (winners.includes(mine)) win += 1 / winners.length;
            } catch (e) { win += 0.3; }
        }
        return win / ITER;
    }

    // 프리플랍 핸드 강도 0~1
    preflopStrength(hand) {
        const order = '23456789TJQKA';
        const v1 = order.indexOf(hand[0][0]), v2 = order.indexOf(hand[1][0]);
        const hi = Math.max(v1, v2), lo = Math.min(v1, v2);
        const suited = hand[0][1] === hand[1][1];
        const pair = v1 === v2;
        const gap = hi - lo;

        let s = 0;
        if (pair) s = 0.5 + hi * 0.035;            // 페어: 22=0.5 ~ AA=0.92
        else {
            s = 0.18 + hi * 0.028 + lo * 0.012;    // 하이카드 가중
            if (suited) s += 0.07;
            if (gap === 1) s += 0.05;              // 커넥터
            else if (gap === 2) s += 0.02;
            else if (gap > 4) s -= 0.05;
        }
        return Math.max(0.05, Math.min(0.95, s));
    }

    stopTurnTimer() {
        if (this.turnTimeout) clearTimeout(this.turnTimeout);
        this.turnTimeout = null;
        this.turnEndTime = 0;
    }

    stopAllTimers() {
        this.stopTurnTimer();
        if (this.tournamentTimer) clearInterval(this.tournamentTimer);
        if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
        if (this._autoResumeTimer) clearTimeout(this._autoResumeTimer);
        Object.values(this.players).forEach(p => {
            if (p._disconnectTimer) clearTimeout(p._disconnectTimer);
            if (p._botTimer) clearTimeout(p._botTimer);
        });
    }

    findNextActiveIndex(startFrom) {
        for (let i = 0; i < this.playerOrder.length; i++) {
            const idx = (startFrom + i) % this.playerOrder.length;
            const nick = this.playerOrder[idx];
            if (this.players[nick] && !this.players[nick].isFolded && !this.players[nick].isAllIn) return idx;
        }
        return -1;
    }

    calculateSidePots() {
        // 💰 순수 로직은 lib/pots.js로 분리 (단위 테스트로 칩 보존성 검증). 여기선 입력만 구성해 위임.
        const contributions = this.playerOrder
            .filter(nick => this.players[nick] && this.players[nick].totalInvested > 0)
            .map(nick => ({ nick, invested: this.players[nick].totalInvested }));
        return Pots.calculateSidePots(contributions);
    }

    startNextHand() {
        this.stopTurnTimer();


        // 💵 [#3] 나가기 예약된 플레이어 처리 — 보유 칩을 뱅크롤로 정산 후 퇴장
        this.processPendingLeaves();

        // 💡 [수정 #5] 딜러 버튼 회전: "직전 딜러의 다음 생존자"를 정확히 찾기 위해 직전 좌석 순서 보존
        const oldOrder = [...this.playerOrder];
        const prevDealerSeat = oldOrder.length > 0 ? (this.dealerIndex % oldOrder.length) : -1;

        Object.keys(this.players).forEach(nick => {
            if (this.players[nick].isDisconnected && this.players[nick].chips <= 0) {
                if (this.players[nick]._disconnectTimer) clearTimeout(this.players[nick]._disconnectTimer);
                delete this.players[nick];
            } else {
                this.players[nick].hand = [];
                this.players[nick].currentBet = 0;
                this.players[nick].totalInvested = 0;
                this.players[nick].isFolded = false;
                this.players[nick].isAllIn = false;
                this.players[nick].isMucked = false;
                this.players[nick].hasActed = false;
                this.players[nick].role = '';

                if (this.players[nick].chips <= 0 && (this.tournamentStarted || this.mode === 'cash')) {
                    // 🎓 [학습모드] 칩 0이면 자동 리필 (사람·봇 모두) — 연습이 끊기지 않게
                    if (this._learnMode) {
                        this.players[nick].chips = this.startingChips;
                        this.players[nick].isSpectator = false;
                        if (!this.players[nick].isBot && this.players[nick].socketId) {
                            io.to(this.players[nick].socketId).emit('gameMessage', '🎓 칩이 자동 충전됐습니데이! 계속 연습하이소.');
                        }
                    } else {
                        this.players[nick].isSpectator = true;
                        if (this.mode === 'cash') {
                            this.offerCashBuyin(nick); // 💵 캐시: 언제든 재바이인 안내
                        } else if (this._mtt) {
                            // 🏆 [MTT] 리바이 없음 — 즉시 탈락 처리
                            this._mtt.onPlayerEliminated(this.roomId, nick);
                        } else {
                            this.players[nick]._rebuyOfferSent = false; // 매 핸드 다시 권유
                            this.offerRebuy(nick); // 💡 리바이 가능하면 개인 안내
                        }
                    }
                }
            }
        });

        // 🏆 [MTT] 칩 0이 된 플레이어를 매니저에 탈락 통보 (콜백 누락 방지)
        if (this._mtt) {
            this.playerOrder.forEach(nick => {
                if (this.players[nick] && this.players[nick].chips <= 0) {
                    this._mtt.onPlayerEliminated(this.roomId, nick);
                }
            });
        }

        this.playerOrder = this.playerOrder.filter(nick => this.players[nick] && this.players[nick].chips > 0);
        Object.keys(this.players).forEach(nick => {
            if (this.players[nick].chips > 0 && !this.playerOrder.includes(nick)) this.playerOrder.push(nick);
        });

        // 🪑 [버그픽스] 풀방 대기 관전자 좌석 배정 — 자리가 났으면 바이인 후 이번 핸드부터 합류.
        //    예전엔 _fullRoomSpectator 플래그를 세팅만 하고 한 번도 읽지 않아,
        //    "자리가 나면 다음 핸드부터 참여" 안내가 실제로는 지켜지지 않았다.
        //    진행 중 토너먼트는 중간에 풀스택으로 합류하면 공정성이 깨지므로 제외(캐시/미시작 방만).
        if (!this._mtt && !(this.mode === 'tournament' && this.tournamentStarted)) {
            const TABLE_SIZE = 6;
            let openSeats = TABLE_SIZE - this.playerOrder.length;
            if (openSeats > 0) {
                const waiting = Object.keys(this.players).filter(n => {
                    const p = this.players[n];
                    return p && p._fullRoomSpectator && p.isSpectator && !p.isDisconnected;
                });
                for (const nick of waiting) {
                    if (openSeats <= 0) break;
                    const p = this.players[nick];
                    p.chips = this.startingChips;
                    p.isSpectator = false;
                    p._fullRoomSpectator = false;
                    // 💵 캐시: 첫 실착석 = 첫 바이인 → 뱅크롤 차감(토너먼트는 아래 바이인 루프가 처리하므로 제외)
                    if (this.mode === 'cash' && !p.isBot) {
                        MockDB.recordCashNet(nick, -this.startingChips);
                        MockDB.adjustBankroll(nick, -this.startingChips).then(nb => {
                            if (p.socketId) io.to(p.socketId).emit('bankrollUpdate', { bankroll: nb || 0 });
                        });
                    }
                    if (!this.playerOrder.includes(nick)) this.playerOrder.push(nick);
                    if (p.socketId) io.to(p.socketId).emit('gameMessage', '🪑 자리가 나서 합류했습니데이! 이번 핸드부터 플레이합니데이.');
                    io.to(this.roomId).emit('gameMessage', `🪑 ${nick} 님이 관전석에서 테이블로 합류했습니다.`);
                    openSeats--;
                }
            }
        }

        // 💡 [수정 #5] 직전 딜러가 파산했어도 버튼이 정확히 한 칸씩 전진하도록 개선
        if (this.playerOrder.length > 0 && prevDealerSeat !== -1) {
            let newDealerNick = null;
            for (let i = 1; i <= oldOrder.length; i++) {
                const cand = oldOrder[(prevDealerSeat + i) % oldOrder.length];
                if (this.playerOrder.includes(cand)) { newDealerNick = cand; break; }
            }
            this.dealerIndex = newDealerNick ? this.playerOrder.indexOf(newDealerNick) : 0;
        } else {
            this.dealerIndex = 0;
        }

        if (this.playerOrder.length === 1) {
            if (this.mode === 'cash') {
                this.gameStage = 0;
                io.to(this.roomId).emit('gameMessage', '💵 캐시 테이블 — 플레이어를 기다리는 중입니다...');
                this.sendState();
                this.tryAutoResume();
                return;
            }
            // 🏆 [MTT] 테이블에 1명만 남음 → 우승 선언 대신 매니저가 재배치/병합 판단
            if (this._mtt) {
                this.gameStage = 0;
                this.sendState();
                this._mtt.tick();
                return;
            }
            if (this.tournamentStarted) {
                // 💡 리바이 유예: 재구매 가능자가 있으면 우승 확정을 8초 보류
                const rebuyables = Object.keys(this.players).filter(n => {
                    const p = this.players[n];
                    return p && p.chips <= 0 && !p.isDisconnected && this.canRebuy(n);
                });
                if (rebuyables.length > 0 && !this._rebuyGraceActive) {
                    this._rebuyGraceActive = true;
                    io.to(this.roomId).emit('gameMessage', '⏳ 리바이 대기 8초! 재구매하면 토너먼트가 계속됩니데이!');
                    rebuyables.forEach(n => this.offerRebuy(n));
                    if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
                    this.pendingStageTimeout = setTimeout(() => { this._rebuyGraceActive = false; this.startNextHand(); }, 8000);
                    this.sendState();
                    return;
                }
                const winner = this.playerOrder[0];
                this.gameStage = 0;
                this.tournamentStarted = false;
                if (this.tournamentTimer) clearInterval(this.tournamentTimer);

                MockDB.addWin(winner);
                // 💰 상금풀을 우승자 뱅크롤로 지급 (봇 우승이면 소멸)
                const prize = this.prizePool || (this.startingChips * Object.keys(this.players).length);
                if (!this.players[winner].isBot) {
                    MockDB.adjustBankroll(winner, prize).then(newBankroll => {
                        const wSock = this.players[winner] && this.players[winner].socketId;
                        if (wSock) io.to(wSock).emit('bankrollUpdate', { bankroll: newBankroll || 0 });
                    });
                    io.to(this.roomId).emit('gameMessage', `💰 ${winner} 님이 상금 ${prize.toLocaleString()} 칩을 획득했습니다!`);
                }
                this.prizePool = 0;

                // 🏅 우승 업적: 첫 승리 + 불사조(리바이 후 우승)
                const wAch = ['first_win'];
                if ((this.players[winner].rebuysUsed || 0) > 0) wAch.push('comeback');
                this.checkAchievements(winner, wAch);

                io.to(this.roomId).emit('tournamentEnd', {
                    winner,
                    chips: this.players[winner].chips
                });
                io.to(this.roomId).emit('gameMessage', `🏆 토너먼트 우승: ${winner} (${this.players[winner].chips.toLocaleString()} 칩)`);

                Object.keys(this.players).forEach(nick => {
                    this.players[nick].chips = this.startingChips;
                    this.players[nick].currentBet = 0;
                    this.players[nick].totalInvested = 0;
                    this.players[nick].isFolded = false;
                    this.players[nick].isAllIn = false;
                    this.players[nick].isMucked = false;
                    this.players[nick].hasActed = false;
                    this.players[nick].hand = [];
                    this.players[nick].role = '';
                    this.players[nick].isSpectator = false;
                });

                this.pot = 0;
                this.communityCards = [];
                this.playerOrder = Object.keys(this.players).filter(nick => !this.players[nick].isDisconnected);

                this.sendState();
                return;
            } else {
                this.gameStage = 0;
                io.to(this.roomId).emit('gameMessage', '플레이어 대기 중...');
                this.sendState();
                return;
            }
        }

        if (this.playerOrder.length < 2) {
            this.gameStage = 0;
            this.tournamentStarted = false;
            if (this.tournamentTimer) clearInterval(this.tournamentTimer);
            io.to(this.roomId).emit('gameMessage', '플레이어 부족 — 대기 중...');
            this.sendState();
            if (this.mode === 'cash') this.tryAutoResume();
            return;
        }

        // 💡 [수정] 캐시모드: 활성 플레이어에 사람이 한 명도 없으면(봇만 남음) 진행 중단
        //    — 봇끼리 무한 플레이 방지 + 사람이 재바이인할 때까지 대기
        if (this.mode === 'cash') {
            const humansInPlay = this.playerOrder.filter(n => this.players[n] && !this.players[n].isBot).length;
            if (humansInPlay === 0) {
                this.gameStage = 0;
                io.to(this.roomId).emit('gameMessage', '💵 캐시 테이블 — 플레이어가 돌아오길 기다리는 중입니다...');
                this.sendState();
                this.tryAutoResume();
                return;
            }
        }

        if (!this.tournamentStarted) {
            this.tournamentStarted = true;
            this.blindLevel = 0;
            if (this.mode !== 'cash') { // 💵 캐시는 블라인드업 없음
                this.timeRemaining = this.blindUpInterval;
                this.startTournamentTimer();
                // 🏆 [MTT] 테이블은 뱅크롤 차감/상금풀 없이 진행 (MTT 매니저가 우승 처리)
                if (!this._mttFreeChips) {
                    // 💰 토너먼트 바이인: 사람 참가자 뱅크롤에서 시작칩 차감 → 상금풀 적립
                    this.prizePool = 0;
                    this.playerOrder.forEach(nick => {
                        const p = this.players[nick];
                        if (p && !p.isBot) {
                            MockDB.adjustBankroll(nick, -this.startingChips).then(newBankroll => {
                                if (p.socketId) io.to(p.socketId).emit('bankrollUpdate', { bankroll: newBankroll || 0 });
                            });
                        }
                        this.prizePool += this.startingChips;
                    });
                    io.to(this.roomId).emit('gameMessage', `💰 토너먼트 시작! 상금풀 ${this.prizePool.toLocaleString()} 칩 (바이인 ${this.startingChips.toLocaleString()})`);
                }
            }
        }

        this.handId++;
        // 🔐 [무결성] 검증 가능한 셔플 — 시드 생성 → 커밋 공개 → 시드로 셔플
        this._serverSeed = makeServerSeed();
        this._commitHash = commitHash(this._serverSeed);
        // 클라이언트 엔트로피: 직전 핸드 시드 해시 일부(예측 불가성 추가)
        this._clientEntropy = (this._prevSeedHash || '') + ':' + Date.now();
        this.deck = seededShuffle(this._serverSeed, this._clientEntropy);
        // 핸드 시작 전 커밋 공개 (조작 불가 약속)
        io.to(this.roomId).emit('shuffleCommit', { handId: this.handId, commit: this._commitHash, entropy: this._clientEntropy });

        this.vpipThisHand = new Set(); // 💡 이번 핸드 자발적 참여자(VPIP)
        this.communityCards = [];
        this.gameStage = 1;
        this.pot = 0;

        // 🎬 [리플레이] 이번 핸드의 액션 로그 + 시작 시점 스택 스냅샷
        this.actionLog = [];
        this.handStartStacks = {};
        this.handStartBlinds = null;

        const bl = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)];
        this.currentHighestBet = bl.bb;
        this.lastFullRaiseAmount = bl.bb;

        this.playerOrder.forEach(nick => {
            this.players[nick].hand = [this.deck.pop(), this.deck.pop()];

            if (bl.ante > 0) {
                const antePaid = Math.min(bl.ante, this.players[nick].chips);
                this.players[nick].chips -= antePaid;
                this.players[nick].totalInvested += antePaid;
                this.pot += antePaid;
                if (this.players[nick].chips === 0) this.players[nick].isAllIn = true;
            }
        });

        const n = this.playerOrder.length;

        let sbIndex, bbIndex;
        if (n === 2) {
            sbIndex = this.dealerIndex;
            bbIndex = (this.dealerIndex + 1) % n;
            this.players[this.playerOrder[sbIndex]].role = 'D / SB';
            this.players[this.playerOrder[bbIndex]].role = 'BB';
        } else {
            sbIndex = (this.dealerIndex + 1) % n;
            bbIndex = (this.dealerIndex + 2) % n;
            this.players[this.playerOrder[this.dealerIndex]].role = 'Dealer';
            this.players[this.playerOrder[sbIndex]].role = 'SB';
            this.players[this.playerOrder[bbIndex]].role = 'BB';
        }

        // 🎯 포지션 라벨: 표준 표기 — UTG, UTG+1, …, LJ, HJ, CO, BTN, SB, BB
        //    버튼 기준 상대 포지션. GTO 레인지·조언·봇 의사결정이 이 라벨로 정확한 오픈 레인지를 고른다.
        //    (이전 버그 #1: BTN/SB/BB에 라벨 미부여→CO 레인지로 폴백, #2: 얼리 라벨 off-by-one으로 CO 누락)
        this.playerOrder.forEach(nick => { this.players[nick].position = ''; });
        const _setPos = (idx, label) => { const pl = this.players[this.playerOrder[idx]]; if (pl) pl.position = label; };
        if (n === 2) {
            // 헤즈업: 딜러가 버튼(SB 겸), 상대가 BB
            _setPos(sbIndex, 'BTN');
            _setPos(bbIndex, 'BB');
        } else {
            _setPos(this.dealerIndex, 'BTN');
            _setPos(sbIndex, 'SB');
            _setPos(bbIndex, 'BB');
            // BB 다음(UTG)부터 버튼 직전(CO)까지 — 버튼에 가까울수록 넓은 레인지
            const afterBB = (bbIndex + 1) % n;
            const m = (this.dealerIndex - afterBB + n) % n; // 블라인드·버튼 제외 좌석 수
            for (let i = 0; i < m; i++) {
                const fromEnd = m - 1 - i; // 0 = 버튼 직전(CO)
                let label;
                if (fromEnd === 0) label = 'CO';
                else if (fromEnd === 1) label = 'HJ';
                else if (fromEnd === 2 && m >= 5) label = 'LJ';
                else label = (i === 0) ? 'UTG' : `UTG+${i}`;
                _setPos((afterBB + i) % n, label);
            }
        }

        const sbPlayer = this.players[this.playerOrder[sbIndex]];
        if (!sbPlayer.isAllIn) {
            const sbCost = Math.min(bl.sb, sbPlayer.chips);
            sbPlayer.chips -= sbCost;
            sbPlayer.currentBet += sbCost;
            sbPlayer.totalInvested += sbCost;
            if (sbPlayer.chips === 0) sbPlayer.isAllIn = true;
        }

        const bbPlayer = this.players[this.playerOrder[bbIndex]];
        if (!bbPlayer.isAllIn) {
            const bbCost = Math.min(bl.bb, bbPlayer.chips);
            bbPlayer.chips -= bbCost;
            bbPlayer.currentBet += bbCost;
            bbPlayer.totalInvested += bbCost;
            if (bbPlayer.chips === 0) bbPlayer.isAllIn = true;
        }

        const utg = (n === 2) ? sbIndex : (this.dealerIndex + 3) % n;
        this.turnIndex = this.findNextActiveIndex(utg);

        // 🎬 [리플레이] 시작 스택·블라인드·홀카드 스냅샷
        this.handStartBlinds = { sb: bl.sb, bb: bl.bb, ante: bl.ante, level: bl.level };
        this.playerOrder.forEach(nick => {
            const pl = this.players[nick];
            this.handStartStacks[nick] = pl.chips + pl.currentBet + (pl.totalInvested - pl.currentBet);
        });
        // 블라인드 포스팅 자체도 로그에 남김
        this.logAction(this.playerOrder[sbIndex], 'sb', bl.sb, 1);
        this.logAction(this.playerOrder[bbIndex], 'bb', bl.bb, 1);

        this.sendState();

        // 💡 [수정 #1 - 치명] 블라인드/앤티로 전원 올인 시 게임이 멈추던 버그 수정
        if (this.turnIndex !== -1) {
            this.startTurnTimer();
        } else {
            if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
            this.emitEquity();
            // 🃏 올인 성립 → 홀카드 먼저 공개, 2초 뒤 플랍부터 런아웃 시작
            this.pendingStageTimeout = setTimeout(() => this.nextStage(), 2000);
        }
    }

    nextStage() {
        this.stopTurnTimer();
        this.playerOrder.forEach(nick => {
            this.pot += this.players[nick].currentBet;
            this.players[nick].currentBet = 0;
            this.players[nick].hasActed = false;
        });

        this.currentHighestBet = 0;
        this.lastFullRaiseAmount = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;
        this.raiseCountThisStreet = 0; // 📊 새 스트리트 — 레이즈 카운트 리셋

        if (this.gameStage === 1) { this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.gameStage = 2; }
        else if (this.gameStage === 2) { this.communityCards.push(this.deck.pop()); this.gameStage = 3; }
        else if (this.gameStage === 3) { this.communityCards.push(this.deck.pop()); this.gameStage = 4; }
        else if (this.gameStage === 4) { this.gameStage = 5; this.evaluateWinner(); return; }

        const actionPlayers = this.playerOrder.filter(n => !this.players[n].isFolded && !this.players[n].isAllIn);
        if (actionPlayers.length <= 1) {
            this.turnIndex = -1;
            this.sendState();
            this.emitEquity();
            if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
            // 🃏 [#2] 올인 쇼다운 런아웃 — 다음 카드 오픈을 3초 간격으로 (긴장감)
            this.pendingStageTimeout = setTimeout(() => this.nextStage(), 3000);
            return;
        }

        this.turnIndex = this.findNextActiveIndex((this.dealerIndex + 1) % this.playerOrder.length);
        this.sendState();
        if (this.turnIndex !== -1) this.startTurnTimer();
    }

    // 💡 [신규] 사람·봇 공유 액션 적용 — 검증 통과 시 베팅 반영 후 nextTurn
    applyAction(nick, type, amount) {
        if (this.playerOrder[this.turnIndex] !== nick) return false;
        if (!['fold', 'check', 'call', 'raise', 'allin'].includes(type)) return false;

        const p = this.players[nick];
        if (!p || p.isFolded || p.isAllIn) return false;

        // 📊 액션 전 상태 캡처 (지표 계산용)
        const beforeBet = p.currentBet;
        const beforeHighest = this.currentHighestBet;
        const raisesBeforeAction = this.raiseCountThisStreet || 0;

        // 🎓 [학습모드] 사람 액션 전 GTO 조언 캡처 (액션 후 채점에 사용)
        let _learnAdvice = null;
        if (this._learnMode && p && !p.isBot) {
            try { _learnAdvice = this.getGtoAdvice(nick); } catch (e) {}
        }

        let finalAction = type;

        if (type === 'fold') {
            this.stopTurnTimer();
            p.isFolded = true;
            p.hasActed = true;
        } else if (type === 'check') {
            if (p.currentBet !== this.currentHighestBet) return false;
            this.stopTurnTimer();
            p.hasActed = true;
        } else if (type === 'call') {
            this.stopTurnTimer();
            const callAmt = Math.min(this.currentHighestBet - p.currentBet, p.chips);
            p.chips -= callAmt;
            p.currentBet += callAmt;
            p.totalInvested += callAmt;
            if (p.chips === 0) { p.isAllIn = true; finalAction = 'allin'; }
            p.hasActed = true;
        } else if (type === 'raise' || type === 'allin') {
            let reqAmount = Math.floor(Number(amount));
            if (type === 'raise' && (isNaN(reqAmount) || reqAmount <= 0)) return false;

            const totalPot = this.pot + Object.values(this.players).reduce((sum, pl) => sum + pl.currentBet, 0);
            const maxPotRaise = p.currentBet + (totalPot * 3);
            const maxBet = (type === 'allin') ? (p.currentBet + p.chips) : Math.min(p.currentBet + p.chips, maxPotRaise);
            const targetBet = (type === 'allin') ? maxBet : Math.min(reqAmount, maxBet);
            const minRaise = this.currentHighestBet + this.lastFullRaiseAmount;

            if (type === 'raise' && targetBet < minRaise && targetBet < p.currentBet + p.chips) return false;
            if (targetBet <= p.currentBet) return false;

            this.stopTurnTimer();
            const cost = targetBet - p.currentBet;
            p.chips -= cost;
            p.currentBet += cost;
            p.totalInvested += cost;
            p.hasActed = true;

            if (p.chips === 0) { p.isAllIn = true; finalAction = 'allin'; }
            else if (type === 'allin') { finalAction = 'raise'; }

            if (p.currentBet > this.currentHighestBet) {
                const raiseDiff = p.currentBet - this.currentHighestBet;
                this.currentHighestBet = p.currentBet;
                this.raiseCountThisStreet = (this.raiseCountThisStreet || 0) + 1; // 📊 3벳 감지
                if (raiseDiff >= this.lastFullRaiseAmount) {
                    this.lastFullRaiseAmount = raiseDiff;
                    this.playerOrder.forEach(n => {
                        if (n !== nick && !this.players[n].isFolded && !this.players[n].isAllIn) {
                            this.players[n].hasActed = false;
                        }
                    });
                }
            }
        }

        if (this.gameStage === 1 && ['call', 'raise', 'allin'].includes(type) && this.vpipThisHand) {
            this.vpipThisHand.add(nick);
        }

        // 📊 포커 분석 지표 수집 (봇 제외)
        if (!p.isBot) {
            try { this.collectActionStats(nick, type, p, beforeBet, beforeHighest, raisesBeforeAction); } catch (e) {}
        }

        // 🧠 [#2] 상대 성향 추적 (봇 익스플로잇용) — 사람·봇 전부 기록
        try { this.trackOpponentAction(nick, type, beforeBet, beforeHighest); } catch (e) {}

        // 🎬 [리플레이] 이 액션을 GTO 점수와 함께 로그에 기록
        try {
            let gscore = null;
            const toCallForGto = beforeHighest - beforeBet;
            try { gscore = this.gtoProximity(nick, type, p, Math.max(0, toCallForGto)); } catch (e) {}
            this.logAction(nick, finalAction, p.currentBet, this.gameStage, gscore);

            // 🎓 [학습모드] 사람 액션 즉각 채점 피드백
            if (this._learnMode && _learnAdvice && p && !p.isBot && p.socketId) {
                try {
                    const grade = this.gradeAction(_learnAdvice, type, gscore);
                    if (grade) io.to(p.socketId).emit('actionGrade', grade);
                } catch (e) {}
            }
        } catch (e) {}

        io.to(this.roomId).emit('actionSound', { nick, type: finalAction });
        this.nextTurn();
        return true;
    }

    // 🧠 [#2] 상대 성향 추적 — 봇이 읽어서 익스플로잇
    trackOpponentAction(nick, type, beforeBet, beforeHighest) {
        const s = this.oppStats[nick] || (this.oppStats[nick] = {
            faceBet: 0, foldToBet: 0, aggrActs: 0, totalActs: 0,
            preflopCalls: 0, preflopRaises: 0, preflopActs: 0, samples: 0
        });
        const facingBet = (beforeHighest - beforeBet) > 0;
        s.totalActs++;
        s.samples++;
        if (type === 'raise' || type === 'allin') s.aggrActs++;
        if (facingBet) {
            s.faceBet++;
            if (type === 'fold') s.foldToBet++;
        }
        if (this.gameStage === 1) {
            s.preflopActs++;
            if (type === 'call') s.preflopCalls++;
            else if (type === 'raise' || type === 'allin') s.preflopRaises++;
        }
    }

    // 🧠 [#2] 특정 상대의 성향 요약 (봇 의사결정 입력)
    getOpponentRead(nick) {
        const s = this.oppStats[nick];
        if (!s || s.samples < 6) return null; // 표본 부족 시 기본 전략
        return {
            foldToBet: s.faceBet >= 3 ? s.foldToBet / s.faceBet : null,  // 벳에 폴드하는 비율 (높으면 블러프 잘 먹힘)
            aggression: s.totalActs >= 5 ? s.aggrActs / s.totalActs : null, // 공격성 (높으면 콜다운 가치 ↑)
            loose: s.preflopActs >= 4 ? (s.preflopCalls + s.preflopRaises) / s.preflopActs : null, // 루즈함
            samples: s.samples
        };
    }

    nextTurn() {
        this.stopTurnTimer();
        const active = this.playerOrder.filter(n => !this.players[n].isFolded);
        const actioners = active.filter(n => !this.players[n].isAllIn);

        if (active.length === 1) { this.handleWin(active[0]); return; }

        const allMatched = active.every(n => this.players[n].currentBet === this.currentHighestBet || this.players[n].isAllIn);
        const allActed = actioners.every(n => this.players[n].hasActed);

        if (allMatched && allActed) { this.nextStage(); return; }

        if (actioners.length > 0) {
            const nextIdx = this.findNextActiveIndex(this.turnIndex + 1);
            if (nextIdx === -1) { this.nextStage(); return; }
            this.turnIndex = nextIdx;
        } else {
            this.turnIndex = -1;
            this.sendState();
            if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
            this.pendingStageTimeout = setTimeout(() => this.nextStage(), 1800);
            this.emitEquity();
            return;
        }

        this.sendState();
        if (this.turnIndex !== -1) this.startTurnTimer();
    }

    evaluateWinner() {
        this.stopTurnTimer();
        const active = this.playerOrder.filter(n => !this.players[n].isFolded);
        if (active.length === 1) { this.handleWin(active[0]); return; }

        const sidePots = this.calculateSidePots();
        const sidePotsTotal = sidePots.reduce((s, sp) => s + sp.amount, 0);
        const diff = this.pot - sidePotsTotal;
        if (diff > 0 && sidePots.length > 0) {
            sidePots[sidePots.length - 1].amount += diff;
        }

        // 폴드한 적격자만 남은 상위 사이드팟 → 하위 팟으로 롤다운 (lib/pots.js)
        Pots.rollDownFoldedPots(sidePots, n => this.players[n].isFolded);

        const messages = [];
        const allWinnerIds = new Set();
        const potResults = []; // 💡 클라이언트 결과창 렌더링용 구조화 데이터

        const rankKorMap = {
            'High Card': '하이카드', 'Pair': '원페어', 'Two Pair': '투페어', 'Three of a Kind': '트리플',
            'Straight': '스트레이트', 'Flush': '플러시', 'Full House': '풀하우스', 'Four of a Kind': '포카드',
            'Straight Flush': '스트레이트 플러시', 'Royal Flush': '로얄 플러시'
        };

        const formatCard = (c) => {
            if (!c || c === '?') return '?';
            const val = c[0] === 'T' ? '10' : c[0];
            const sym = { s:'♠', h:'♥', d:'♦', c:'♣' }[c[1]];
            return sym + val;
        };

        sidePots.forEach((sp, idx) => {
            if (sp.amount <= 0) return;
            const eligibleActive = sp.eligible.filter(n => !this.players[n].isFolded);
            if (eligibleActive.length === 0) return;

            const hands = eligibleActive.map(nick => {
                const solved = Hand.solve(this.players[nick].hand.concat(this.communityCards));
                solved.playerId = nick;
                return solved;
            });

            const winners = Hand.winners(hands);
            const { perWinner, remainder } = Pots.splitAmount(sp.amount, winners.length); // 홀수 칩은 winners[0]에게

            winners.forEach((w, i) => {
                this.players[w.playerId].chips += perWinner + (i === 0 ? remainder : 0);
                allWinnerIds.add(w.playerId);
            });

            const label = sidePots.length > 1 ? (idx === 0 ? '[메인팟]' : `[사이드팟 ${idx}]`) : '[최종 팟]';

            const winnerStrs = winners.map(w => {
                const pCards = this.players[w.playerId].hand.map(formatCard).join(', ');
                const rankStr = rankKorMap[w.name] || w.name;
                return `🥇 ${w.playerId} ➔ 🃏[${pCards}] (${rankStr})`;
            });

            potResults.push({
                label, amount: sp.amount,
                winners: winners.map((w, i) => ({
                    nick: w.playerId,
                    cards: this.players[w.playerId].hand.slice(),
                    rank: rankKorMap[w.name] || w.name,
                    won: perWinner + (i === 0 ? remainder : 0),
                    // 🌟 승리 조합 5장 (커뮤니티+홀카드 중 실제 사용된 카드)
                    best5: w.cards.map(c => ((c.value === '10' ? 'T' : c.value) + c.suit))
                }))
            });

            messages.push(`💰 ${label} ${sp.amount.toLocaleString()} 칩\n${winnerStrs.join('\n')}`);
        });

        this.playerOrder.forEach(nick => {
            if (!allWinnerIds.has(nick)) {
                this.players[nick].isMucked = true;
            }
        });

        // 💬 봇 승/패 멘트 (쇼다운까지 간 봇만)
        this.playerOrder.forEach(nick => {
            const pl = this.players[nick];
            if (pl && pl.isBot && !pl.isFolded) {
                this.botSay(nick, allWinnerIds.has(nick) ? 'win' : 'lose');
            }
        });

        // 📊 전적 집계 + 📜 핸드 히스토리
        const totalPotAll = potResults.reduce((s, p) => s + p.amount, 0);
        const wonByNick = {};
        potResults.forEach(p => p.winners.forEach(w => { wonByNick[w.nick] = (wonByNick[w.nick] || 0) + w.won; }));
        this.playerOrder.forEach(nick => {
            MockDB.recordHand(nick, allWinnerIds.has(nick), wonByNick[nick] || 0, this.vpipThisHand && this.vpipThisHand.has(nick), !!this._learnMode);
            // 📊 쇼다운 도달 통계 (폴드하지 않고 카드를 깐 플레이어)
            const pl = this.players[nick];
            if (pl && !pl.isFolded && !pl.isBot) {
                MockDB.recordShowdownStat(nick, allWinnerIds.has(nick), !!this._learnMode);
            }
        });

        // 🏅 쇼다운 업적: 족보·팟 크기·올인 누적·그라인더
        potResults.forEach(p => p.winners.forEach(w => {
            const ids = [];
            if (w.rank === '로얄 플러시') ids.push('royal');
            if (['포카드', '스트레이트 플러시', '로얄 플러시'].includes(w.rank)) ids.push('quads');
            if ((w.won || 0) >= 50000) ids.push('whale');
            const pl = this.players[w.nick];
            if (pl && pl.isAllIn) {
                pl._allinWins = (pl._allinWins || 0) + 1;
                if (pl._allinWins >= 5) ids.push('allin_master');
            }
            if (ids.length) this.checkAchievements(w.nick, ids);
        }));
        this.playerOrder.forEach(nick => {
            const u = MockDB.users.get(nick);
            if (u && u.handsPlayed >= 100) this.checkAchievements(nick, ['grinder']);
        });
        this.pushHistory({
            no: this.handId, type: 'showdown', pot: totalPotAll,
            board: this.communityCards.slice(),
            winners: potResults.flatMap(p => p.winners.map(w => ({ nick: w.nick, rank: w.rank, won: w.won }))),
            replay: this.buildReplay(potResults.flatMap(p => p.winners.map(w => ({ nick: w.nick, cards: w.cards, rank: w.rank }))))
        });
        this.revealShuffle(); // 🔐 셔플 검증 시드 공개

        io.to(this.roomId).emit('gameResult', {
            message: '🏆 [쇼다운 결과]\n\n' + messages.join('\n\n'),
            winners: [...allWinnerIds],
            pots: potResults,
            community: this.communityCards.slice()
        });

        this.sendState();

        setTimeout(() => {
            this.startNextHand();
        }, 8000);
    }

    // 💡 [신규] 리바이 — 블라인드 레벨 2(인덱스 1)까지, 방 설정 횟수만큼 재구매 허용
    canRebuy(nick) {
        const p = this.players[nick];
        // 💡 [수정 #3] 블라인드 레벨 제한 제거 — 설정한 횟수가 남아있으면 언제든 리바이 가능 (일관성)
        return !!p && this.tournamentStarted && this.maxRebuys > 0
            && (p.rebuysUsed || 0) < this.maxRebuys;
    }

    offerRebuy(nick) {
        const p = this.players[nick];
        if (!p) return;
        if (!this.canRebuy(nick)) {
            // 리바이 불가 사유를 본인에게 안내 (조용히 실패하지 않도록)
            if (p.socketId && this.maxRebuys > 0 && (p.rebuysUsed || 0) >= this.maxRebuys) {
                io.to(p.socketId).emit('gameMessage', `🔄 리바이 횟수를 모두 소진했습니데이 (최대 ${this.maxRebuys}회).`);
            }
            return;
        }
        if (p._rebuyOfferSent) return;
        p._rebuyOfferSent = true;
        if (p.socketId) {
            io.to(p.socketId).emit('rebuyOffer', {
                remaining: this.maxRebuys - (p.rebuysUsed || 0),
                stack: this.startingChips
            });
        }
    }

    doRebuy(nick) {
        if (!this.canRebuy(nick)) return false;
        const p = this.players[nick];
        if (p.chips > 0) return false;
        p.chips = this.startingChips;
        p.rebuysUsed = (p.rebuysUsed || 0) + 1;
        p.isSpectator = false;
        p._rebuyOfferSent = false;
        this._rebuyGraceActive = false;
        // 💰 리바이도 바이인 — 뱅크롤 차감 + 상금풀 적립
        if (!p.isBot) {
            MockDB.adjustBankroll(nick, -this.startingChips).then(nb => {
                if (p.socketId) io.to(p.socketId).emit('bankrollUpdate', { bankroll: nb || 0 });
            });
        }
        this.prizePool = (this.prizePool || 0) + this.startingChips;
        io.to(this.roomId).emit('gameMessage', `🔄 ${nick} 님이 리바이! (${p.chips.toLocaleString()} 칩 / 잔여 ${this.maxRebuys - p.rebuysUsed}회)`);
        this.sendState();
        return true;
    }

    // 💵 [신규] 캐시게임 바이인 — 횟수 제한 없음, 파산 시 언제든 재구매
    offerCashBuyin(nick) {
        const p = this.players[nick];
        if (!p || p.socketId == null) return; // 봇/연결없음 제외
        io.to(p.socketId).emit('cashBuyinOffer', { stack: this.startingChips });
    }

    doCashBuyin(nick) {
        if (this.mode !== 'cash') return false;
        const p = this.players[nick];
        if (!p || p.chips > 0) return false;
        p.chips = this.startingChips;
        p.isSpectator = false;
        p.totalBuyins = (p.totalBuyins || 1) + 1; // 첫 입장이 1회
        MockDB.recordCashNet(nick, -this.startingChips); // 💵 바이인 = 순익 -
        MockDB.adjustBankroll(nick, -this.startingChips); // 💰 뱅크롤에서 차감
        io.to(this.roomId).emit('gameMessage', `💵 ${nick} 님이 ${this.startingChips.toLocaleString()} 칩 바이인! (재입장)`);
        if (!this.playerOrder.includes(nick)) this.playerOrder.push(nick);
        this.sendState();
        this.tryAutoResume(); // 💵 조건 충족 시 자동 재개
        return true;
    }

    // 💵 [신규] 캐시 테이블 자동 재개 — 호스트/봇 권한과 무관하게 서버가 직접 판단
    //    사람 1명 이상 + 칩 보유 2명 이상이면 대기 상태에서 다음 핸드를 자동 시작
    tryAutoResume() {
        if (this.mode !== 'cash') return;
        if (!this._cashStarted) return; // 💵 [#2] 호스트가 한 번 [시작]을 눌러야 자동진행 시작
        if (this.gameStage !== 0) return; // 진행 중이면 불필요
        if (this._autoResumeTimer) clearTimeout(this._autoResumeTimer);
        this._autoResumeTimer = setTimeout(() => {
            if (this.gameStage !== 0) return;
            const seated = Object.keys(this.players).filter(n => this.players[n] && this.players[n].chips > 0 && !this.players[n].isDisconnected);
            const humansSeated = seated.filter(n => !this.players[n].isBot).length;
            if (seated.length >= 2 && humansSeated >= 1) {
                this.startNextHand();
            }
        }, 1500);
    }

    // 💵 [#3] 나가기 예약된 플레이어 처리 — 보유 칩을 뱅크롤로 환수하고 퇴장
    processPendingLeaves() {
        const leaving = this.playerOrder.filter(n => this.players[n] && this.players[n]._pendingLeave);
        leaving.forEach(nick => {
            const p = this.players[nick];
            if (!p) return;
            if (!p.isBot && p.chips > 0) {
                MockDB.recordCashNet(nick, p.chips);
                MockDB.adjustBankroll(nick, p.chips).then(nb => {
                    if (p.socketId) io.to(p.socketId).emit('bankrollUpdate', { bankroll: nb || 0 });
                });
            }
            const sock = p.socketId ? io.sockets.sockets.get(p.socketId) : null;
            const chipsOut = p.chips || 0;
            // 방장 승계
            if (this.hostNickname === nick) {
                const remain = Object.keys(this.players).filter(n => n !== nick && !this.players[n].isDisconnected && !this.players[n].isBot);
                this.hostNickname = remain[0] || null;
                if (this.hostNickname) io.to(this.roomId).emit('gameMessage', `👑 [${this.hostNickname}] 님이 새로운 방장이 되었습니다.`);
            }
            delete this.players[nick];
            this.playerOrder = this.playerOrder.filter(n => n !== nick);
            io.to(this.roomId).emit('gameMessage', `🚪 ${nick} 님이 ${chipsOut.toLocaleString()} 칩을 정산하고 나갔습니데이.`);
            if (sock) {
                sock.leave(this.roomId);
                sock.currentRoom = null;
                sock.emit('leftRoom');
                sock.emit('roomList', roomListArray());
                enterLobby(sock);
            }
        });
        // 🤖 [#1] 사람이 모두 정산 퇴장해 봇만 남으면 방 정리
        if (leaving.length) destroyIfNoHumans(this.roomId);
    }

    // 📊 [신규] 액션 단위 포커 지표 + GTO 근접도 수집
    collectActionStats(nick, type, p, beforeBet, beforeHighest, raisesBefore) {
        const ev = {};
        const toCall = beforeHighest - beforeBet;
        const facingBet = toCall > 0;
        const isRaise = (type === 'raise' || type === 'allin') && p.currentBet > beforeHighest;

        if (this.gameStage === 1) { // 프리플랍
            ev.preflopOpp = true;
            if (isRaise) ev.pfr = true;
            if (facingBet && raisesBefore >= 1) {
                ev.threeBetOpp = true;
                if (isRaise) ev.threeBet = true;
            }
        }

        if (isRaise) ev.aggrBet = true;
        else if (type === 'call' && facingBet) ev.aggrCall = true;

        if (facingBet) {
            ev.faceBet = true;
            if (type === 'fold') ev.foldToBet = true;
        }

        const gto = this.gtoProximity(nick, type, p, toCall);
        if (gto !== null) ev.gtoScore = gto;

        MockDB.recordActionStats(nick, ev, !!this._learnMode);
    }

    // 🎯 단순화된 GTO 근접도: 팟 오즈 대비 승률(에퀴티)로 행동 적정성 평가 (0~100)
    // 🎓 [학습모드] 현재 플레이어 상황에서 GTO 권장 액션 분석
    //   각 액션(폴드/체크/콜/레이즈)의 EV와 권장 빈도, 핸드 평가를 계산
    getGtoAdvice(nick) {
        const p = this.players[nick];
        if (!p || !p.hand || p.hand.length !== 2 || p.isFolded) return null;

        let equity;
        try { equity = this.estimateBotEquity(nick); } catch (e) { return null; }
        if (typeof equity !== 'number' || isNaN(equity)) return null;

        const toCall = Math.max(0, this.currentHighestBet - p.currentBet);
        const potBefore = this.pot + Object.values(this.players).reduce((s, x) => s + x.currentBet, 0) - p.currentBet;
        const potOdds = toCall > 0 ? toCall / (potBefore + toCall) : 0;
        const street = this.communityCards.length === 0 ? 'preflop' : (this.communityCards.length === 3 ? 'flop' : (this.communityCards.length === 4 ? 'turn' : 'river'));
        const opponents = this.playerOrder.filter(n => n !== nick && !this.players[n].isFolded).length;

        // 핸드 등급 (5단계)
        let tier, tierLabel, tierColor;
        if (equity >= 0.75) { tier = 5; tierLabel = '매우 강함'; tierColor = '#7bedaa'; }
        else if (equity >= 0.58) { tier = 4; tierLabel = '강함'; tierColor = '#a8e063'; }
        else if (equity >= 0.45) { tier = 3; tierLabel = '중간'; tierColor = '#ffd97a'; }
        else if (equity >= 0.30) { tier = 2; tierLabel = '약함'; tierColor = '#ffa94d'; }
        else { tier = 1; tierLabel = '매우 약함'; tierColor = '#ff6b6b'; }

        // 액션별 권장 빈도(%) — GTO 이론 기반 믹스
        let mix = {}; // {fold, check, call, raise, bet}
        let bestAction, reason;
        let posInfo = null;

        if (street === 'preflop') {
            // 🎯 프리플랍 — 포지션별 레인지 기반 (승률이 아닌 핸드 레인지로 판단)
            const code = handToCode(p.hand);
            // 🐛 [버그픽스] this.bigBlind 는 어디에도 정의된 적 없는 값(undefined)이라
            //    `currentHighestBet > undefined` 가 항상 false → 프리플랍 레이즈에 직면해도
            //    "미오픈"으로 오판해 3벳/콜/폴드 대신 "오픈 레이즈"를 권하던 버그.
            //    봇(botDecide)은 동일 로직을 올바른 bb로 계산해 영향 없었고, 사람 GTO 조언/채점만 틀렸다.
            const bb = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;
            const facingRaise = toCall > 0 && this.currentHighestBet > bb;
            const isBB = p.role && p.role.includes('BB');
            const rt = preflopRangeTier(code, p.position || '', facingRaise);
            posInfo = { position: p.position || '-', code, rangeScore: rt.score, rangeLabel: rt.label, threshold: openThreshold(p.position || '') };

            const canCheck = (toCall === 0); // BB 무료 체크 또는 림프 팟
            if (!facingRaise) {
                // 미오픈/오픈 기회 (아직 레이즈 없음) — 정석은 raise-or-fold, 림프 지양 (BB는 공짜 체크 가능)
                const late = (p.position === 'BTN' || p.position === 'CO' || p.position === 'SB');
                if (rt.tier === 'raise') {
                    mix = canCheck ? { check: 8, raise: 92 } : { fold: 6, raise: 94 };
                    bestAction = 'raise'; reason = `${p.position || ''} 오픈 레인지에 드는 핸드(${code}) — 오픈 레이즈가 정석입니데이.`;
                } else if (rt.tier === 'call') {
                    if (canCheck) {
                        mix = { check: 100 };
                        bestAction = 'check'; reason = `마지널 핸드(${code}) — 체크로 공짜 플랍을 보이소.`;
                    } else if (late) {
                        mix = { fold: 55, raise: 45 };
                        bestAction = 'fold'; reason = `늦은 포지션 마지널(${code}) — 림프 말고 스틸 오픈 아니면 폴드입니데이.`;
                    } else {
                        mix = { fold: 80, raise: 20 };
                        bestAction = 'fold'; reason = `마지널 핸드(${code}) — 앞 포지션에선 폴드가 정석(가끔만 오픈).`;
                    }
                } else {
                    mix = canCheck ? { check: 100 } : { fold: 92, raise: 8 };
                    bestAction = canCheck ? 'check' : 'fold';
                    reason = canCheck ? `약한 핸드(${code}) — 공짜로 플랍을 보이소.` : `오픈 레인지 밖(${code}) — 폴드가 정석입니데이(가끔 스틸).`;
                }
            } else {
                // 레이즈에 직면 — 3벳/콜/폴드
                if (rt.tier === 'raise') {
                    mix = { fold: 5, call: 35, raise: 60 };
                    bestAction = 'raise'; reason = `강한 핸드(${code}) — 3벳으로 밸류를 키우이소.`;
                } else if (rt.tier === 'call') {
                    mix = { fold: 35, call: 60, raise: 5 };
                    bestAction = 'call'; reason = `콜 가능한 핸드(${code}, 점수 ${rt.score}) — 콜로 플랍을 보이소.`;
                } else {
                    mix = { fold: 88, call: 12, raise: 0 };
                    bestAction = 'fold'; reason = `레이즈에 약한 핸드(${code}) — 폴드가 정석입니데이.`;
                }
            }
        } else if (toCall === 0) {
            // 포스트플랍 체크 가능 상황 (벳 or 체크) — 폴라라이즈 이론
            if (equity >= 0.68) {
                mix = { check: 25, bet: 75 };
                bestAction = 'bet'; reason = '강한 밸류 핸드 — 베팅으로 칩을 키우이소.';
            } else if (equity >= 0.50) {
                mix = { check: 55, bet: 45 };
                bestAction = 'check'; reason = '중상 핸드 — 얇은 밸류벳도 가능하지만 체크가 무난합니데이.';
            } else if (equity <= 0.28) {
                mix = { check: 60, bet: 40 };
                bestAction = 'check'; reason = '약한 핸드 — 가끔 블러프벳, 보통은 체크입니데이.';
            } else {
                mix = { check: 80, bet: 20 };
                bestAction = 'check'; reason = '쇼다운 가치는 있으나 밸류벳은 약함 — 체크가 최적.';
            }
        } else {
            // 포스트플랍 콜/폴드/레이즈 상황 — EV 비교
            const margin = equity - potOdds;
            if (margin >= 0.15) {
                mix = { fold: 0, call: 45, raise: 55 };
                bestAction = 'raise'; reason = `승률(${Math.round(equity*100)}%)이 팟오즈(${Math.round(potOdds*100)}%)보다 훨씬 높음 — 레이즈로 밸류!`;
            } else if (margin >= 0.02) {
                mix = { fold: 5, call: 75, raise: 20 };
                bestAction = 'call'; reason = `승률이 팟오즈보다 높아 콜은 +EV입니데이.`;
            } else if (margin >= -0.03) {
                mix = { fold: 55, call: 42, raise: 3 };
                bestAction = 'fold'; reason = `경계선 — 승률(${Math.round(equity*100)}%)이 팟오즈(${Math.round(potOdds*100)}%)와 비슷. 상대 블러프 의심되면 콜, 아니면 폴드.`;
            } else {
                mix = { fold: 80, call: 18, raise: 2 };
                bestAction = 'fold'; reason = `승률(${Math.round(equity*100)}%)이 팟오즈(${Math.round(potOdds*100)}%)보다 낮음 — 폴드가 정석.`;
            }
        }

        return {
            equity: Math.round(equity * 100),
            potOdds: Math.round(potOdds * 100),
            tier, tierLabel, tierColor,
            street, opponents, toCall,
            potSize: potBefore,
            mix, bestAction, reason,
            posInfo,
            handStr: p.hand.join(' ')
        };
    }

    // 🎓 [학습모드] 사람이 한 액션을 GTO 권장과 비교해 채점
    //   advice: 액션 전 캡처한 getGtoAdvice 결과, actualType: 실제 한 액션
    gradeAction(advice, actualType, gtoScore) {
        if (!advice) return null;
        // 실제 액션을 믹스 키로 정규화 (allin→raise, check→check, call→call, fold→fold)
        let actKey = actualType;
        if (actualType === 'allin') actKey = advice.mix.raise !== undefined ? 'raise' : (advice.mix.bet !== undefined ? 'bet' : 'raise');
        if (actualType === 'check' && advice.mix.check === undefined) actKey = 'call'; // 안전장치
        const recommendedPct = advice.mix[actKey] || 0;
        const isBest = (actKey === advice.bestAction);

        let grade, gradeColor, gradeIcon, msg;
        if (isBest || recommendedPct >= 40) {
            grade = '훌륭'; gradeColor = '#7bedaa'; gradeIcon = '✅';
            msg = isBest ? 'GTO 최적 선택입니데이!' : 'GTO상 충분히 좋은 선택입니데이.';
        } else if (recommendedPct >= 15) {
            grade = '무난'; gradeColor = '#ffd97a'; gradeIcon = '🟡';
            const actKo = { fold: '폴드', check: '체크', call: '콜', bet: '벳', raise: '레이즈' };
            msg = `나쁘진 않지만 GTO 권장은 "${actKo[advice.bestAction] || advice.bestAction}"였습니데이.`;
        } else {
            grade = '아쉬움'; gradeColor = '#ff6b6b'; gradeIcon = '⚠️';
            const actKo = { fold: '폴드', check: '체크', call: '콜', bet: '벳', raise: '레이즈' };
            msg = `GTO 권장은 "${actKo[advice.bestAction] || advice.bestAction}"였습니데이. ${advice.reason}`;
        }
        return {
            grade, gradeColor, gradeIcon, msg,
            recommendedPct, isBest,
            gtoScore: (typeof gtoScore === 'number') ? gtoScore : null,
            bestAction: advice.bestAction,
            equity: advice.equity, potOdds: advice.potOdds
        };
    }

    gtoProximity(nick, type, p, toCall) {
        const pl = this.players[nick];
        if (!pl || !pl.hand || pl.hand.length !== 2) return null;

        let equity;
        try { equity = this.estimateBotEquity(nick); } catch (e) { return null; }
        if (typeof equity !== 'number' || isNaN(equity)) return null;

        const potBefore = this.pot + Object.values(this.players).reduce((s, x) => s + x.currentBet, 0) - p.currentBet;
        const potOdds = toCall > 0 ? toCall / (potBefore + toCall) : 0;
        const didAggro = (type === 'raise' || type === 'allin');

        let score = 50;
        if (toCall === 0) {
            // 🎯 폴라라이즈 벳팅 이론: 강한 핸드(밸류)와 아주 약한 핸드(블러프)는 벳,
            //    중간 핸드(쇼다운밸류는 있으나 밸류벳은 약함)는 체크가 최적
            if (equity >= 0.68) {
                // 밸류 영역 — 벳/레이즈가 정석
                score = didAggro ? 95 : 60;          // 체크는 밸류 놓침(슬로우플레이 여지로 60)
            } else if (equity <= 0.30) {
                // 블러프 영역 — 약하니 벳으로 폴드 유도가 +EV (적정 빈도)
                score = didAggro ? 78 : 72;          // 벳(블러프)/체크(포기) 둘 다 합리적
            } else if (equity >= 0.50) {
                // 중상 핸드 — 얇은 밸류 가능하나 체크도 좋음
                score = didAggro ? 72 : 82;
            } else {
                // 중하 핸드(쇼다운밸류) — 체크가 최적, 벳은 어중간
                score = didAggro ? 50 : 88;
            }
        } else {
            // 🎯 콜/폴드/레이즈: equity 대 potOdds 의 EV 비교 (포커 수학 기본)
            const margin = equity - potOdds;
            if (margin >= 0.15) {
                // 확실한 +EV — 밸류 레이즈가 최선, 콜도 좋음, 폴드는 큰 실수
                if (type === 'fold') score = 12;
                else if (didAggro) score = 95;
                else score = 85;
            } else if (margin >= 0.02) {
                // 소폭 +EV — 콜이 정석, 레이즈는 상황따라, 폴드는 손해
                if (type === 'fold') score = 42;
                else if (type === 'call') score = 90;
                else score = 68;
            } else if (margin >= -0.05) {
                // 경계 영역(블러프 캐치) — 폴드/콜 모두 합리적, 레이즈는 약함
                // (팟오즈에 살짝 못 미치는 정도 — 상대 블러프 가능성으로 콜도 정당화)
                if (type === 'fold') score = 75;
                else if (type === 'call') score = 68;
                else score = 38;
            } else {
                // 명확한 -EV — 폴드가 정석, 콜/레이즈는 칩 손실
                if (type === 'fold') score = 95;
                else if (type === 'call') score = 28;
                else score = 18;
            }
        }
        return Math.round(score);
    }

    pushHistory(entry) {
        this.handHistory.unshift(entry);
        if (this.handHistory.length > 30) this.handHistory.pop();
    }

    // 🎬 [리플레이] 액션 1건을 로그에 기록 (스트리트·팟·GTO 점수 포함)
    logAction(nick, type, amount, street, gtoScore) {
        if (!this.actionLog) this.actionLog = [];
        const potNow = this.pot + Object.values(this.players).reduce((s, x) => s + (x.currentBet || 0), 0);
        this.actionLog.push({
            nick, type, amount: amount || 0, street,
            pot: potNow,
            board: this.communityCards.slice(),
            gto: (typeof gtoScore === 'number') ? gtoScore : null
        });
    }

    // 🎬 [리플레이] 액션로그 + 시작스택 + 공개 홀카드를 묶어 리플레이 데이터 생성
    buildReplay(showdownHands) {
        const revealed = {};
        (showdownHands || []).forEach(w => { if (w.cards) revealed[w.nick] = w.cards; });
        const seats = this.playerOrder.map(nick => ({
            nick,
            startStack: this.handStartStacks[nick] != null ? this.handStartStacks[nick] : (this.players[nick] ? this.players[nick].chips : 0),
            isBot: !!(this.players[nick] && this.players[nick].isBot),
            hole: revealed[nick] || null
        }));
        return {
            handNo: this.handId,
            blinds: this.handStartBlinds,
            seats,
            actions: (this.actionLog || []).slice(),
            finalBoard: this.communityCards.slice(),
            // 🔐 검증 정보: 이 시드+엔트로피로 seededShuffle하면 동일한 덱이 나옴
            fairness: { commit: this._commitHash, seed: this._serverSeed, entropy: this._clientEntropy }
        };
    }

    // 🔐 [무결성] 핸드 종료 시 서버 시드 공개 → 누구나 셔플 재현·검증 가능
    revealShuffle() {
        if (!this._serverSeed) return;
        io.to(this.roomId).emit('shuffleReveal', {
            handId: this.handId,
            commit: this._commitHash,
            seed: this._serverSeed,
            entropy: this._clientEntropy
        });
        // 다음 핸드 엔트로피에 직전 시드 해시 반영 (체인)
        this._prevSeedHash = commitHash(this._serverSeed).slice(0, 16);
    }

    // 🏅 [신규] 업적 해금 — 신규 획득 시 방 전체에 알림
    checkAchievements(nick, ids) {
        if (!nick || nick.startsWith('🤖')) return;
        MockDB.grantAchievements(nick, ids).then(fresh => {
            fresh.forEach(id => {
                const a = ACHIEVEMENTS[id];
                if (!a) return;
                io.to(this.roomId).emit('achievementUnlocked', { nick, id, icon: a.icon, name: a.name, desc: a.desc });
            });
        }).catch(() => {});
    }

    handleWin(winnerId) {
        this.stopTurnTimer();
        const winner = this.players[winnerId];

        let secondHighestBet = 0;
        this.playerOrder.forEach(n => {
            if (n !== winnerId && this.players[n].currentBet > secondHighestBet) {
                secondHighestBet = this.players[n].currentBet;
            }
        });

        if (winner && winner.currentBet > secondHighestBet) {
            const uncalled = winner.currentBet - secondHighestBet;
            winner.chips += uncalled;
            winner.currentBet -= uncalled;
            winner.totalInvested -= uncalled;
            io.to(this.roomId).emit('gameMessage', `💰 ${winnerId} 님이 언콜드 벳(${uncalled.toLocaleString()})을 돌려받았습니다.`);
        }

        this.playerOrder.forEach(n => { this.pot += this.players[n].currentBet; this.players[n].currentBet = 0; });
        if (winner) winner.chips += this.pot;
        if (winner) winner.isMucked = true;

        this.gameStage = 5;

        // 💬 봇 기권승 멘트
        if (this.players[winnerId] && this.players[winnerId].isBot) {
            this.botSay(winnerId, 'win');
        }

        // 📊 전적 집계 + 📜 핸드 히스토리
        this.playerOrder.forEach(n => MockDB.recordHand(n, n === winnerId, n === winnerId ? this.pot : 0, this.vpipThisHand && this.vpipThisHand.has(n), !!this._learnMode));

        // 🏅 기권승 업적: 허풍선이(폴드 유도 10회 누적) + 고래
        const wu = MockDB.users.get(winnerId);
        if (wu) {
            wu._foldWins = (wu._foldWins || 0) + 1;
            const ids = [];
            if (wu._foldWins >= 10) ids.push('bluffer');
            if (this.pot >= 50000) ids.push('whale');
            if (ids.length) this.checkAchievements(winnerId, ids);
        }
        this.pushHistory({
            no: this.handId, type: 'fold', pot: this.pot,
            board: this.communityCards.slice(),
            winners: [{ nick: winnerId, rank: '기권승', won: this.pot }],
            replay: this.buildReplay([{ nick: winnerId, cards: null, rank: '기권승' }])
        });
        this.revealShuffle(); // 🔐 셔플 검증 시드 공개

        io.to(this.roomId).emit('gameResult', {
            message: `😎 ${winnerId} 기권승!\n💰 획득: ${this.pot.toLocaleString()} 칩`,
            winners: [winnerId],
            foldWin: true,
            pots: [{ label: '팟', amount: this.pot, winners: [{ nick: winnerId, cards: null, rank: '기권승', won: this.pot }] }]
        });
        this.sendState();

        setTimeout(() => {
            this.startNextHand();
        }, 6000);
    }
}

const rooms = new Map();

// 📋 [세션 리포트] 닉네임 → 이번 세션 시작 시점의 지표 스냅샷 (재접속해도 유지)
const sessionSnapshots = new Map();

// 🎓 [코칭] 세션 지표를 포커 이론 기준으로 진단 → 약점 + 구체적 조언 생성
//   각 지표의 건강 범위는 6맥스 캐시/토너 기준 통념값
function buildCoaching(s, handsPlayed) {
    const issues = [];   // { area, severity, msg, tip }
    const strengths = [];
    if (handsPlayed < 10) {
        return { headline: '아직 표본이 적어 정밀 진단은 어렵습니데이. 좀 더 쳐보이소!', issues: [], strengths: [], sample: 'low' };
    }
    const { vpip, pfr, af, foldToBet, wtsd, wsd, gto } = s;

    // 1) VPIP (팟 참여율) — 건강범위 대략 18~28% (6맥스)
    if (vpip !== null) {
        if (vpip > 40) issues.push({ area: 'VPIP', severity: 'high', msg: `너무 많은 핸드로 팟에 참여합니다 (${vpip}%).`, tip: '프리플랍 핸드 선택을 좁히이소. 약한 오프수트(예: J5o, Q7o)는 폴드하고, 포지션이 나쁘면 더 타이트하게 가는 게 장기적으로 이득입니데이.' });
        else if (vpip < 14) issues.push({ area: 'VPIP', severity: 'mid', msg: `너무 타이트합니다 (${vpip}%).`, tip: '좋은 핸드만 기다리면 블라인드에 칩이 샙니다. 버튼·컷오프 같은 좋은 포지션에선 수딧 커넥터나 작은 페어도 적극적으로 들어가 보이소.' });
        else strengths.push(`팟 참여율(VPIP ${vpip}%)이 건강한 범위입니데이.`);
    }
    // 2) PFR vs VPIP 갭 — 갭이 크면 너무 수동적(콜만 많음)
    if (vpip !== null && pfr !== null) {
        const gap = vpip - pfr;
        if (pfr < 8 && vpip >= 18) issues.push({ area: 'PFR', severity: 'high', msg: `프리플랍에서 레이즈 없이 콜만 많습니다 (PFR ${pfr}%).`, tip: '들어갈 가치가 있는 핸드면 림프(콜) 대신 레이즈로 들어가이소. 주도권을 쥐면 상대를 폴드시키거나 팟을 키울 수 있습니데이.' });
        else if (gap > 18) issues.push({ area: '수동성', severity: 'mid', msg: `참여는 많은데 레이즈가 적습니다 (VPIP-PFR 갭 ${gap}).`, tip: '콜링 위주 플레이는 주도권을 내줍니다. 핸드가 좋으면 레이즈로 압박하고, 애매하면 차라리 폴드하는 양극화 전략이 좋습니데이.' });
        else if (pfr >= 12 && gap <= 12) strengths.push(`프리플랍 공격성(PFR ${pfr}%)이 좋습니데이.`);
    }
    // 3) AF (공격성) — 건강범위 약 1.5~3.5
    if (af !== null && af !== undefined) {
        if (af < 1.0) issues.push({ area: 'AF', severity: 'mid', msg: `포스트플랍이 수동적입니다 (AF ${af}).`, tip: '콜만 하지 말고 베팅·레이즈로 주도하이소. 좋은 핸드는 밸류 베팅으로 칩을 더 받아내고, 드로우는 세미블러프로 압박하는 게 정석입니데이.' });
        else if (af > 5) issues.push({ area: 'AF', severity: 'mid', msg: `너무 공격적입니다 (AF ${af}).`, tip: '블러프 빈도가 과합니다. 상대가 잡아내기 시작하면 칩이 샙니다. 밸류와 블러프의 균형을 맞추이소.' });
        else strengths.push(`포스트플랍 공격성(AF ${af})이 균형 잡혀 있습니데이.`);
    }
    // 4) Fold to Bet — 너무 높으면 호구처럼 쉽게 폴드(블러프 당함), 너무 낮으면 콜링스테이션
    if (foldToBet !== null) {
        if (foldToBet > 70) issues.push({ area: '폴드율', severity: 'mid', msg: `상대 베팅에 너무 자주 폴드합니다 (${foldToBet}%).`, tip: '쉽게 접으면 상대 블러프에 당합니다. 적당한 핸드로는 콜다운(블러프 캐치)도 하이소. 모든 베팅이 진짜 핸드는 아닙니데이.' });
        else if (foldToBet < 25 && wtsd !== null && wtsd > 35) issues.push({ area: '콜링스테이션', severity: 'high', msg: `잘 폴드하지 않습니다 (폴드율 ${foldToBet}%, 쇼다운 도달 ${wtsd}%).`, tip: '약한 핸드로 끝까지 보는 콜링스테이션 성향입니다. 진 게임은 일찍 접어 손실을 줄이이소. "궁금해서" 콜하는 칩이 제일 아깝습니데이.' });
    }
    // 5) WTSD / WSD — 쇼다운까지 갔을 때 이기는 비율
    if (wsd !== null && wtsd !== null && wtsd > 20) {
        if (wsd < 40) issues.push({ area: '쇼다운', severity: 'mid', msg: `쇼다운까지 가지만 자주 집니다 (승률 ${wsd}%).`, tip: '약한 핸드로 쇼다운을 너무 자주 봅니다. 강하지 않으면 리버에서 큰 베팅을 마주쳤을 때 접는 훈련을 하이소.' });
        else if (wsd > 55) strengths.push(`쇼다운 승률(${wsd}%)이 높습니다 — 핸드 선택이 좋습니데이.`);
    }
    // 6) GTO 종합
    if (gto !== null) {
        if (gto >= 75) strengths.push(`GTO 근접도 ${gto}점 — 의사결정이 이론에 매우 가깝습니데이! 👏`);
        else if (gto < 55) issues.push({ area: 'GTO', severity: 'mid', msg: `전반적 의사결정 점수가 낮습니다 (GTO ${gto}점).`, tip: '매 액션 전에 "내 승률 vs 팟 오즈"를 떠올리이소. 콜 비용보다 이길 확률이 높으면 콜, 낮으면 폴드가 기본입니데이.' });
    }

    // 우선순위: high > mid, 최대 3개만
    issues.sort((a, b) => (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1));
    const topIssues = issues.slice(0, 3);

    let headline;
    if (topIssues.length === 0) headline = '약점이 거의 안 보입니데이. 지금 페이스를 유지하이소! 🎯';
    else if (topIssues[0].severity === 'high') headline = `가장 시급한 개선점은 "${topIssues[0].area}"입니데이.`;
    else headline = '몇 가지 다듬으면 더 좋아질 부분이 있습니데이.';

    return { headline, issues: topIssues, strengths: strengths.slice(0, 3), sample: 'ok' };
}

// 🏆 [MTT] 멀티테이블 토너먼트 매니저 — 여러 GameRoom(테이블)을 조율
//   참가자를 테이블에 분배 → 탈락 추적 → 테이블 밸런싱/병합 → 최종 우승자
const mtts = new Map(); // mttId → MTTManager
class MTTManager {
    constructor(mttId, hostNick, settings) {
        this.mttId = mttId;
        this.hostNick = hostNick;
        this.tableSize = Math.max(2, Math.min(6, settings.tableSize || 6));
        this.startingChips = settings.startingChips || 5000;
        this.blindUpInterval = settings.blindUpInterval || 300;
        this.name = settings.name || mttId;
        this.entrants = [];        // { nick, socketId, isBot }
        this.tables = [];          // roomId 배열
        this.eliminated = [];      // 탈락 순서(나중일수록 높은 순위) — { nick, place }
        this.started = false;
        this.finished = false;
        this.totalEntrants = 0;
        this.tableCounter = 0;
        this._tickBusy = false;
        this._noHumanTicks = 0;
    }

    addEntrant(nick, socketId, isBot) {
        if (this.started) return false;
        if (this.entrants.find(e => e.nick === nick)) return false;
        this.entrants.push({ nick, socketId, isBot: !!isBot });
        this.broadcastLobby();
        return true;
    }

    removeEntrant(nick) {
        if (this.started) return;
        this.entrants = this.entrants.filter(e => e.nick !== nick);
        this.broadcastLobby();
    }

    addBot() {
        const pool = ['김봇식', '이서봇', '박올인', '최콜콜', '정레이즈', '한판봇', '강타짜', '윤폴드', '조블러프', '도박봇', '신털이', '배포커', '오막판', '서클럽'];
        const used = new Set(this.entrants.map(e => e.nick));
        let name = null;
        for (const base of pool) { if (!used.has('🤖' + base)) { name = '🤖' + base; break; } }
        if (!name) name = '🤖봇' + (this.entrants.length + 1);
        this.addEntrant(name, null, true);
    }

    broadcastLobby() {
        const payload = {
            mttId: this.mttId, name: this.name, hostNick: this.hostNick,
            tableSize: this.tableSize, startingChips: this.startingChips,
            entrants: this.entrants.map(e => e.nick),
            started: this.started
        };
        this.entrants.forEach(e => { if (e.socketId) io.to(e.socketId).emit('mttLobby', payload); });
    }

    // ─────────── 시작: 참가자를 균형있게 테이블 분배 ───────────
    start() {
        if (this.started || this.entrants.length < 2) return false;
        this.started = true;
        this.totalEntrants = this.entrants.length;

        const shuffled = this.entrants.slice();
        for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }

        // 테이블 수: 정원 기준, 단 모든 테이블에 최소 2명 보장
        const groups = this.splitIntoGroups(shuffled.map(e => ({ nick: e.nick, socketId: e.socketId, isBot: e.isBot, chips: this.startingChips })));
        groups.forEach(g => this.seatTable(g, false));

        this.entrants.forEach(e => { if (e.socketId) io.to(e.socketId).emit('mttStarted', { mttId: this.mttId, name: this.name }); });
        this.broadcastStatus();
        this.startHeartbeat();
        return true;
    }

    // 인원을 테이블 그룹으로 분할 (각 테이블 2~tableSize명, 균등)
    splitIntoGroups(players) {
        const n = players.length;
        if (n <= this.tableSize) return [players];
        let numTables = Math.ceil(n / this.tableSize);
        // 마지막 테이블이 1명만 남는 경우 방지 → 테이블 수 조정
        while (numTables > 1 && n - (numTables - 1) * this.tableSize < 2 && n < numTables * this.tableSize) {
            // 균등 분배로 해결되는지 확인: floor 분배 시 최소 인원
            if (Math.floor(n / numTables) >= 2) break;
            numTables--;
        }
        numTables = Math.max(1, Math.min(numTables, Math.floor(n / 2)));

        // 💰 [밸런싱] 칩 기준 스네이크(serpentine) 분배 — 빅스택이 한 테이블에 몰리지 않게
        //   칩 내림차순 정렬 후 1→N→1 지그재그로 배정하면 스택 합이 테이블마다 고르게 분산됨
        const sorted = players.slice().sort((a, b) => (b.chips || 0) - (a.chips || 0));
        const groups = Array.from({ length: numTables }, () => []);
        let dir = 1, t = 0;
        for (let i = 0; i < sorted.length; i++) {
            groups[t].push(sorted[i]);
            // 지그재그: 끝에 닿으면 방향 전환 (같은 테이블에 연속으로 안 넣음)
            if (dir === 1) {
                if (t === numTables - 1) dir = -1; else t++;
            } else {
                if (t === 0) dir = 1; else t--;
            }
        }
        return groups;
    }

    // ─────────── 테이블 생성 + 착석 ───────────
    seatTable(group, isFinal) {
        const tag = isFinal ? 'FINAL' : ('T' + (++this.tableCounter));
        const roomId = `${this.mttId}#${tag}`;
        const room = new GameRoom(roomId, {
            startingChips: this.startingChips, blindUpInterval: this.blindUpInterval,
            mode: 'tournament', maxRebuys: 0
        });
        room._mtt = this;
        room._mttFreeChips = true;
        if (isFinal) room._isFinalTable = true;
        rooms.set(roomId, room);
        this.tables.push(roomId);

        group.forEach(s => {
            const pl = makeFreshPlayer(s.nick, s.socketId, s.isBot, s.chips);
            pl.chips = s.chips;
            room.players[s.nick] = pl;
            if (s.isBot) room.players[s.nick]._persona = room.assignPersona(s.nick, 'hard');
            room.playerOrder.push(s.nick);
            if (s.socketId) {
                const sock = io.sockets.sockets.get(s.socketId);
                if (sock) {
                    if (sock.currentRoom && sock.currentRoom !== roomId) sock.leave(sock.currentRoom);
                    sock.join(roomId); sock.currentRoom = roomId;
                    // 실제로 다른 테이블로 옮긴 경우에만 moved 표시 (밸런싱 안내)
                    const actuallyMoved = s._prevRoom ? (s._prevRoom !== roomId) : false;
                    sock.emit('mttSeated', { roomId, mttId: this.mttId, finalTable: !!isFinal, moved: actuallyMoved });
                }
            }
        });
        room.hostNickname = group.find(s => !s.isBot)?.nick || null;
        room._cashStarted = false;
        if (isFinal) io.to(roomId).emit('gameMessage', '🏆 파이널 테이블! 마지막 승부입니데이!');
        // 첫 핸드 시작
        if (group.length >= 2) setTimeout(() => { if (rooms.has(roomId)) room.startNextHand(); }, isFinal ? 2500 : 2000);
        return room;
    }

    // ─────────── 탈락 통보 (즉시 피드백용; 순위 확정은 tick에서) ───────────
    onPlayerEliminated(roomId, nick) {
        if (this.finished) return;
        if (this.eliminated.find(e => e.nick === nick)) return;
        const place = this.totalEntrants - this.eliminated.length;
        this.eliminated.push({ nick, place });
        const room = rooms.get(roomId);
        if (room && room.players[nick] && room.players[nick].socketId) {
            io.to(room.players[nick].socketId).emit('mttEliminated', { place, total: this.totalEntrants });
        }
        io.to(roomId).emit('gameMessage', `💀 ${nick} 님 탈락 — ${place}위 / ${this.totalEntrants}명`);
        // 즉시 한 번 점검(빠른 반응) — 단 tick과 충돌 않도록 가드
        setTimeout(() => this.tick(), 600);
    }

    // ─────────── 생존자 조회 ───────────
    livePlayers() {
        const list = [];
        const seen = new Set();
        this.tables.forEach(rid => {
            const r = rooms.get(rid);
            if (!r) return;
            r.playerOrder.forEach(n => {
                const p = r.players[n];
                if (p && p.chips > 0 && !seen.has(n)) {
                    seen.add(n);
                    list.push({ nick: n, roomId: rid, chips: p.chips, isBot: p.isBot, socketId: p.socketId });
                }
            });
        });
        return list;
    }
    countAlive() { return this.livePlayers().length; }

    // ─────────── 하트비트: MTT의 유일한 권위. 모든 결정을 여기서 ───────────
    startHeartbeat() {
        if (this._heartbeat) clearInterval(this._heartbeat);
        this._heartbeat = setInterval(() => this.tick(), 4000);
        // 시작 직후 한 번
        setTimeout(() => this.tick(), 4000);
    }

    tick() {
        if (this.finished) { if (this._heartbeat) clearInterval(this._heartbeat); return; }
        if (this._tickBusy) return;
        this._tickBusy = true;
        try {
            this._tickInner();
        } catch (e) {
            console.error('[MTT tick 오류]', e && e.message);
        } finally {
            this._tickBusy = false;
        }
    }

    _tickInner() {
        // 1) 빈 테이블 제거
        this.tables.forEach(rid => {
            const r = rooms.get(rid);
            if (!r || r.playerOrder.filter(n => r.players[n] && r.players[n].chips > 0).length === 0) {
                if (rooms.has(rid)) destroyRoom(rid);
            }
        });
        this.tables = this.tables.filter(rid => rooms.has(rid));

        const live = this.livePlayers();

        // 2) 우승 판정 (생존자 1명) — 핸드 비진행 상태일 때만 확정
        if (live.length === 1) {
            const anyMidHand = this.tables.some(rid => { const r = rooms.get(rid); return r && r.gameStage >= 1 && r.gameStage < 5; });
            if (!anyMidHand) { this.finish(live[0]); return; }
            this.broadcastStatus();
            return;
        }
        if (live.length === 0) return; // 비정상(곧 정리됨)

        // 3) 봇만 남았는지 체크 (사람 전원 탈락) — 그래도 끝까지 진행해 우승 봇 확정
        //    단, 아무도 연결 안 됐고 봇도 없는 식의 완전 유령 상태는 과도한 자원낭비 방지로 정리
        const anyHumanConnected = live.some(p => !p.isBot && p.socketId && io.sockets.sockets.get(p.socketId));
        const anyBot = live.some(p => p.isBot);
        if (!anyHumanConnected && !anyBot) {
            // 사람도 봇도 없음 → 정리
            this._noHumanTicks = (this._noHumanTicks || 0) + 1;
            if (this._noHumanTicks >= 4) { this.abort(); return; }
        } else {
            this._noHumanTicks = 0;
        }

        // 4) 밸런싱 판단 (봇끼리도 계속 진행시킴)
        this.balanceTables(live);
    }

    // ─────────── 테이블 밸런싱 (필요할 때만 최소 개입) ───────────
    balanceTables(live) {
        const total = live.length;
        const idealTables = this.idealTableCount(total);

        // 현재 활성 테이블별 생존자
        const info = this.tables.map(rid => {
            const r = rooms.get(rid);
            const alive = r ? r.playerOrder.filter(n => r.players[n] && r.players[n].chips > 0) : [];
            return { rid, room: r, alive, stage: r ? r.gameStage : -1 };
        }).filter(t => t.room);

        // (A) 파이널 테이블로 합쳐야 하는 경우: 전원이 한 테이블에 들어감
        if (idealTables === 1) {
            if (info.length > 1) { this.consolidate(live, true); return; }
            // 이미 단일 테이블 → 멈춰있으면(대기0/핸드종료5) 재가동
            const t = info[0];
            if (t && (t.stage === 0 || t.stage === 5) && t.alive.length >= 2) this.kick(t.rid);
            this.broadcastStatus();
            return;
        }

        // (B) 1명만 남은 테이블(고아)이 있거나 테이블 수가 과다 → 재배치
        const hasOrphan = info.some(t => t.alive.length === 1);
        const tooManyTables = info.length > idealTables;
        if (hasOrphan || tooManyTables) {
            this.consolidate(live, false);
            return;
        }

        // (C) 균형 OK → 멈춘 테이블(대기0/핸드종료5) 재가동
        info.forEach(t => { if ((t.stage === 0 || t.stage === 5) && t.alive.length >= 2) this.kick(t.rid); });
        this.broadcastStatus();
    }

    // 적정 테이블 수 (각 테이블 최소 2명 보장)
    idealTableCount(total) {
        if (total <= this.tableSize) return 1;
        let nt = Math.ceil(total / this.tableSize);
        nt = Math.max(1, Math.min(nt, Math.floor(total / 2)));
        return nt;
    }

    // 멈춘 테이블 재가동 (가드 포함) — gameStage 0(대기) 또는 5(핸드종료) 둘 다 처리
    kick(rid) {
        const r = rooms.get(rid);
        if (!r) return;
        const aliveN = r.playerOrder.filter(n => r.players[n] && r.players[n].chips > 0).length;
        if (aliveN < 2) return;
        // 핸드종료(5) 상태면 쇼다운 결과 표시 시간 확보 후, 대기(0)면 짧게 재가동
        if (r.gameStage === 5) {
            const delay = 1500;
            setTimeout(() => { if (rooms.has(rid) && (r.gameStage === 5 || r.gameStage === 0)) r.startNextHand(); }, delay);
        } else if (r.gameStage === 0) {
            setTimeout(() => { if (rooms.has(rid) && r.gameStage === 0) r.startNextHand(); }, 1200);
        }
    }

    // 전체 생존자를 적정 테이블 수로 재배치 (칩 유지). isFinal이면 단일 파이널.
    consolidate(live, isFinal) {
        // 진행 중인 핸드가 있는 테이블이면 끝날 때까지 대기 (다음 tick에서 처리)
        const midHand = this.tables.some(rid => {
            const r = rooms.get(rid);
            return r && r.gameStage >= 1 && r.gameStage < 5;
        });
        if (midHand) { this.broadcastStatus(); return; }

        // 칩 스냅샷 (현재 시점 재조회) + 이전 테이블 기록
        const fresh = this.livePlayers();
        const survivors = fresh.map(p => ({ nick: p.nick, socketId: p.socketId, isBot: p.isBot, chips: p.chips, _prevRoom: p.roomId }));

        // 기존 테이블 전부 정리 (핸드 진행중 아님이 보장됨)
        this.tables.forEach(rid => { if (rooms.has(rid)) destroyRoom(rid); });
        this.tables = [];

        if (isFinal || survivors.length <= this.tableSize) {
            this.seatTable(survivors, true);
        } else {
            const groups = this.splitIntoGroups(survivors);
            groups.forEach(g => this.seatTable(g, false));
        }
        this.broadcastStatus();
    }

    // ─────────── 종료 ───────────
    finish(winner) {
        if (this.finished) return;
        this.finished = true;
        if (this._heartbeat) clearInterval(this._heartbeat);
        const champion = winner.nick;
        if (!winner.isBot) MockDB.addMttWin(champion, this.totalEntrants);

        // 누락된 탈락자 보완: entrants 중 우승자도, 탈락기록도 없는 사람을 채움
        //   (같은 핸드 동시 탈락 등으로 콜백이 일부 누락된 경우 대비)
        const recorded = new Set(this.eliminated.map(e => e.nick));
        recorded.add(champion);
        const missing = this.entrants.filter(e => !recorded.has(e.nick));
        // 누락자는 마지막에 탈락한 것으로 간주(가장 낮은 빈 순위부터 부여)
        missing.forEach(e => {
            const place = this.totalEntrants - this.eliminated.length;
            this.eliminated.push({ nick: e.nick, place });
        });

        const ranking = [{ place: 1, nick: champion }].concat(
            this.eliminated.slice().sort((a, b) => a.place - b.place).map(e => ({ place: e.place, nick: e.nick }))
        );
        this.tables.forEach(rid => {
            io.to(rid).emit('mttFinished', { champion, totalEntrants: this.totalEntrants, ranking });
            io.to(rid).emit('gameMessage', `🎉 ${champion} 님이 ${this.totalEntrants}명 MTT 우승!`);
        });
        setTimeout(() => {
            this.tables.forEach(rid => { if (rooms.has(rid)) destroyRoom(rid); });
            mtts.delete(this.mttId);
        }, 8000);
    }

    // 비정상 종료 (사람 전원 이탈 등)
    abort() {
        if (this.finished) return;
        this.finished = true;
        if (this._heartbeat) clearInterval(this._heartbeat);
        this.tables.forEach(rid => { if (rooms.has(rid)) destroyRoom(rid); });
        mtts.delete(this.mttId);
    }

    broadcastStatus() {
        const alive = this.countAlive();
        const tableCount = this.tables.filter(rid => {
            const r = rooms.get(rid);
            return r && r.playerOrder.some(n => r.players[n] && r.players[n].chips > 0);
        }).length;
        this.tables.forEach(rid => {
            io.to(rid).emit('mttStatus', { alive, totalEntrants: this.totalEntrants, tableCount, placesLeft: alive });
        });
    }
}

// 새 플레이어 객체 생성 헬퍼 (MTT 착석용)
function makeFreshPlayer(nick, socketId, isBot, chips) {
    return {
        id: nick, socketId: socketId || null, isBot: !!isBot,
        chips: chips, currentBet: 0, totalInvested: 0,
        isFolded: false, hasActed: false, role: '', isAllIn: false,
        isDisconnected: false, isMucked: false, hand: [], lastEmoteTime: 0,
        isSpectator: false, rebuysUsed: 0, totalBuyins: 1, position: ''
    };
}


// 🏛️ 로비 대기자 명단 — socketId → { nick }. 방에 입장하면 제거, 나오면 추가
const lobbyUsers = new Map();
function broadcastLobby() {
    io.to('lobby').emit('lobbyUsers', lobbyListArray());
}
function enterLobby(socket) {
    if (!socket.nickname) return;
    socket.join('lobby');
    lobbyUsers.set(socket.id, { nick: socket.nickname });
    broadcastLobby();
    socket.emit('roomList', roomListArray()); // 최신 방 목록 (모드/인원 포함)
    socket.emit('mttList', mttListArray());
}
function leaveLobby(socket) {
    socket.leave('lobby');
    if (lobbyUsers.has(socket.id)) { lobbyUsers.delete(socket.id); broadcastLobby(); }
}
function lobbyListArray() {
    const list = [];
    const seen = new Set();
    for (const info of lobbyUsers.values()) {
        if (info && info.nick && !seen.has(info.nick)) { seen.add(info.nick); list.push(info.nick); }
    }
    return list;
}

// 방/토너먼트 이름 정화 (XSS 차단 + 길이 제한)
function sanitizeRoomName(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/[<>"'`]/g, '').trim().slice(0, 20);
}

// 🏆 [MTT] 대기 중(미시작) 토너먼트 목록
function mttListArray() {
    const list = [];
    mtts.forEach(m => {
        if (!m.started && !m.finished) {
            list.push({ mttId: m.mttId, name: m.name, host: m.hostNick, entrants: m.entrants.length, tableSize: m.tableSize, startingChips: m.startingChips });
        }
    });
    return list;
}

// 🎮 [방 목록] 모드/인원/진행 정보를 포함한 방 목록 (MTT 하위 테이블 제외)
function roomListArray() {
    const list = [];
    rooms.forEach((room, roomId) => {
        if (room._mtt || roomId.includes('#')) return; // MTT 내부 테이블 제외
        const humans = Object.values(room.players).filter(p => p && !p.isBot).length;
        const bots = Object.values(room.players).filter(p => p && p.isBot).length;
        const playing = (room.gameStage >= 1 && room.gameStage < 5) || room.tournamentStarted || room._cashStarted;
        list.push({
            id: roomId,
            mode: room.mode || 'tournament',   // 'tournament' | 'cash'
            humans, bots,
            total: humans + bots,
            playing: !!playing
        });
    });
    return list;
}

// 💡 [수정 #6] 빈 방 정리 (메모리 누수 + 유령 방 목록 방지)
function destroyRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    // 💰 캐시 테이블 정리 시 사람 플레이어의 잔여 칩을 뱅크롤로 환수 (학습모드 제외)
    if (room.mode === 'cash' && !room._learnMode) {
        Object.keys(room.players).forEach(nick => {
            const p = room.players[nick];
            if (p && !p.isBot && p.chips > 0) {
                MockDB.recordCashNet(nick, p.chips);
                MockDB.adjustBankroll(nick, p.chips);
            }
        });
    }
    room.stopAllTimers();
    rooms.delete(roomId);
    io.emit('roomList', roomListArray());
    console.log(`🧹 방 정리됨: ${roomId}`);
}

// 🤖 [#1] 방에 사람이 한 명도 없으면(봇만 남으면) 방을 정리. 정리했으면 true 반환
function destroyIfNoHumans(roomId) {
    const room = rooms.get(roomId);
    if (!room) return true;
    if (room._mtt) return false; // 🏆 MTT 테이블은 봇만 남아도 유지 (토너먼트 진행)
    const humanCount = Object.values(room.players).filter(p => p && !p.isBot && !p.isDisconnected).length;
    if (humanCount === 0) {
        destroyRoom(roomId);
        return true;
    }
    return false;
}

io.on('connection', (socket) => {
    // 🛡️ [안정성] 모든 이벤트 핸들러를 try-catch로 자동 보호
    //   한 핸들러에서 예외가 나도 서버 전체나 다른 유저에게 전파되지 않게 격리
    const _rawOn = socket.on.bind(socket);
    socket.on = (event, handler) => {
        return _rawOn(event, async (...args) => {
            try {
                await handler(...args);
            } catch (e) {
                console.error(`🚨 [핸들러 오류:${event}] ${e && e.message}`);
                try { socket.emit('gameMessage', '⚠️ 처리 중 오류가 발생했습니데이. 다시 시도해 주이소.'); } catch (_) {}
            }
        });
    };

    socket.on('login', async (data) => {
        try {
            // 💡 [수정 #8] 닉네임 화이트리스트 검증 (한글/영문/숫자/_, 2~12자) → XSS 페이로드 원천 차단
            const safeNick = sanitizeNick(data && data.nickname);
            if (!safeNick) {
                socket.emit('loginError', '닉네임은 한글/영문/숫자/_(언더바)만 사용, 2~12자로 입력해주세요.');
                return;
            }

            // 🔒 4자리 PIN 검증 (재접속 자동 로그인은 PIN 생략 허용)
            const pin = data && data.pin;
            const isReconnect = data && data.reconnect === true;
            const existed = MockDB.users.has(safeNick);
            const user = await MockDB.getUser(safeNick);

            if (!isReconnect) {
                if (!isValidPin(pin)) {
                    socket.emit('loginError', '비밀번호는 숫자 4자리로 입력해주세요.');
                    return;
                }
                if (!user.pinHash) {
                    // 최초 로그인 → PIN 등록
                    await MockDB.setPin(safeNick, pin);
                } else if (user.pinHash !== hashPin(pin)) {
                    socket.emit('loginError', '비밀번호가 일치하지 않습니데이. 다시 확인해주세요.');
                    return;
                }
            } else if (!user.pinHash) {
                // 재접속인데 PIN 미설정 레코드면 거부 (정상 흐름 아님)
                socket.emit('loginError', '비밀번호 인증이 필요합니다. 다시 로그인해주세요.');
                return;
            }

            socket.nickname = user.nickname;

            // 📋 [세션 리포트] 신규 로그인이면 세션 시작 스냅샷 기록 (재접속은 기존 유지)
            if (!isReconnect || !sessionSnapshots.has(user.nickname)) {
                sessionSnapshots.set(user.nickname, MockDB.snapshotStats(user));
            }

            // 💸 [#1] 로비 입장(방 미참여) 시 뱅크롤이 0이면 무료 10,000 충전
            //    실제 충전은 방 합류 여부 확인 후 아래에서 처리

            let activeRoomId = null;
            for (const [roomId, room] of rooms.entries()) {
                if (room.players[safeNick]) {
                    activeRoomId = roomId;
                    const oldSocketId = room.players[safeNick].socketId;
                    room.players[safeNick].socketId = socket.id;

                    if (oldSocketId && oldSocketId !== socket.id) {
                        const oldSocket = io.sockets.sockets.get(oldSocketId);
                        if (oldSocket) {
                            oldSocket.emit('gameMessage', '🚨 다른 기기에서 접속하여 기존 연결이 끊어졌습니다.');
                            oldSocket.disconnect(true);
                        }
                    }
                    break;
                }
            }

            // 💸 [#1] 파산 구제: 뱅크롤 + 참여중인 테이블의 보유 칩 합계가 0이면 무료 10,000 충전
            //    방에 칩을 들고 있으면 충전 안 함 — 그 칩은 정산(캐시아웃) 시 뱅크롤로 환수되므로 0 표시는 정상.
            //    단, 캐시 테이블에서 파산(테이블 칩 0)한 채 재접속한 경우엔 0에 갇히지 않게 구제.
            let _tableChips = 0;
            if (activeRoomId) {
                const _aroom = rooms.get(activeRoomId);
                const _rp = _aroom && _aroom.players[safeNick];
                if (_rp && !_rp.isBot) _tableChips = _rp.chips || 0;
            }
            if ((user.bankroll || 0) <= 0 && _tableChips <= 0) {
                const refill = await MockDB.refillIfBroke(user.nickname, 0, 10000);
                if (refill.refilled) {
                    user.bankroll = refill.bankroll;
                }
            }

            socket.emit('loginSuccess', {
                nickname: user.nickname,
                chips: user.totalChips,
                bankroll: user.bankroll,
                rejoinedRoomId: activeRoomId
            });

            if (!activeRoomId) {
                socket.emit('roomList', roomListArray());
                enterLobby(socket); // 🏛️ 대기자 명단 + 로비 채팅 합류
            }
        } catch(e) { console.error("Login Error:", e); }
    });

    socket.on('joinRoom', (data) => {
        if (!socket.nickname) return;

        // 💡 [수정 #8] 방 이름 길이 제한
        const roomId = (typeof data === 'string' ? data : String(data.roomId || '')).trim().slice(0, 20);
        if (!roomId) return socket.emit('joinError', '방 이름을 정확히 입력해주세요.');

        if (!rooms.has(roomId)) {
            const settings = (data && data.settings) || {};
            rooms.set(roomId, new GameRoom(roomId, settings));
            io.emit('roomList', roomListArray());
        }

        const room = rooms.get(roomId);
        const nick = socket.nickname;

        // 🪑 플레이어 정원(6인) 초과 시 → 관전자로 입장 (거부하지 않음)
        const activePlayerCount = Object.values(room.players).filter(pl => pl && !pl.isSpectator).length;
        const joinAsSpectatorFull = (activePlayerCount >= 6 && !room.players[nick]);

        socket.join(roomId);
        socket.currentRoom = roomId;
        leaveLobby(socket); // 🏛️ 방 입장 → 대기자 명단에서 제거

        if (!room.hostNickname) {
            room.hostNickname = nick;
        }

        if (!room.players[nick]) {
            // 💵 캐시: 진행 중에도 칩 들고 바로 착석 / 🏆 토너먼트: 진행 중이면 관전 / 풀방: 관전
            const asSpectator = joinAsSpectatorFull || ((room.mode === 'tournament') && room.tournamentStarted);
            room.players[nick] = {
                id: nick, socketId: socket.id,
                chips: asSpectator ? 0 : room.startingChips,
                currentBet: 0, totalInvested: 0,
                isFolded: false, hasActed: false, role: '', isAllIn: false,
                isDisconnected: false, isMucked: false, hand: [], lastEmoteTime: 0,
                isSpectator: asSpectator,
                _fullRoomSpectator: joinAsSpectatorFull, // 풀방 관전 — 자리 나면 합류 가능
                rebuysUsed: 0, totalBuyins: 1
            };
            if (asSpectator) {
                const reason = joinAsSpectatorFull ? '(자리가 차서 관전석으로)' : '';
                io.to(roomId).emit('gameMessage', `👀 ${nick} 님이 관전자로 입장하셨습니다. ${reason}`);
                if (joinAsSpectatorFull) socket.emit('gameMessage', '👀 자리가 가득 차 관전자로 입장했습니데이. 자리가 나면 다음 핸드부터 참여할 수 있어예.');
            } else {
                io.to(roomId).emit('gameMessage', `👋 ${nick} 님이 방에 입장하셨습니다.`);
                if (room.mode === 'cash') { MockDB.recordCashNet(nick, -room.startingChips); MockDB.adjustBankroll(nick, -room.startingChips); } // 💵 최초 바이인
                // 캐시 진행 중 입장이면 다음 핸드부터 합류
                if (room.mode === 'cash' && room.gameStage !== 0 && !room.playerOrder.includes(nick)) {
                    room.playerOrder.push(nick);
                }
            }
        } else {
            room.players[nick].socketId = socket.id;
            room.players[nick].isDisconnected = false;
            if (room.players[nick]._disconnectTimer) {
                clearTimeout(room.players[nick]._disconnectTimer);
                delete room.players[nick]._disconnectTimer;
            }
            io.to(roomId).emit('gameMessage', `🔄 ${nick} 님이 테이블에 복귀하셨습니다.`);
        }

        if (room.gameStage === 0 && !room.playerOrder.includes(nick)) {
            if(!room.players[nick].isSpectator) room.playerOrder.push(nick);
        }

        socket.emit('joinRoomSuccess', roomId);
        room.sendState();
        io.to('lobby').emit('roomList', roomListArray()); // 로비에 인원/방 변동 반영
        if (room.mode === 'cash') room.tryAutoResume(); // 💵 입장으로 인원 충족되면 자동 시작
    });

    // 💡 [수정 #9] 방 나가기 → 로비 복귀 기능 추가
    socket.on('leaveRoom', () => {
        const roomId = socket.currentRoom;
        const room = rooms.get(roomId);
        if (!room || !socket.nickname) return;
        const nick = socket.nickname;
        const p = room.players[nick];
        if (!p) return;

        // 토너먼트 생존자(칩 보유)는 게임 붕괴 방지를 위해 이탈 차단 (캐시는 상시 이탈 허용)
        if (room.mode === 'tournament' && room.tournamentStarted && p.chips > 0 && !p.isSpectator) {
            socket.emit('gameMessage', '🚨 토너먼트 진행 중에는 나갈 수 없습니데이! (파산/관전 시에만 가능)');
            return;
        }

        // 💵 [#3] 캐시 진행 중 나가기 → 이번 핸드까지 보고 나가기 예약 (폴드 후 핸드 종료 시 캐시아웃)
        if (room.mode === 'cash' && room.gameStage > 0 && room.gameStage < 5 && !p.isFolded && !p.isSpectator) {
            const wasMyTurn = (room.playerOrder[room.turnIndex] === nick);
            p.isFolded = true; p.hasActed = true;
            p._pendingLeave = true; // 핸드 종료 시 자동 캐시아웃 이탈
            socket.emit('gameMessage', '🚪 이번 핸드가 끝나면 보유 칩을 정산하고 나갑니데이...');
            if (wasMyTurn) { io.to(roomId).emit('actionSound', { nick, type: 'fold' }); room.nextTurn(); }
            else room.sendState();
            return; // 즉시 이탈하지 않고 예약만
        }

        if (p._disconnectTimer) clearTimeout(p._disconnectTimer);
        if (room.mode === 'cash' && p.chips > 0) { MockDB.recordCashNet(nick, p.chips); MockDB.adjustBankroll(nick, p.chips); } // 💵 캐시아웃 → 뱅크롤 환수
        delete room.players[nick];
        room.playerOrder = room.playerOrder.filter(n => n !== nick);
        socket.leave(roomId);
        socket.currentRoom = null;

        if (room.hostNickname === nick) {
            // 💡 봇은 호스트가 될 수 없음 (startFirstHand 호출 불가 → 게임 멈춤) — 사람만 승계
            const remain = Object.keys(room.players).filter(n => !room.players[n].isDisconnected && !room.players[n].isBot);
            room.hostNickname = remain[0] || null;
            if (room.hostNickname) io.to(roomId).emit('gameMessage', `👑 [${room.hostNickname}] 님이 새로운 방장이 되었습니다.`);
        }

        io.to(roomId).emit('gameMessage', `👋 ${nick} 님이 방을 나갔습니다.`);

        // 🤖 [#1] 사람이 모두 나가면 방 정리 (플레이어 0이면 직접 삭제, 봇만 남아도 삭제)
        if (Object.keys(room.players).length === 0) {
            destroyRoom(roomId);
        } else if (destroyIfNoHumans(roomId)) {
            // 봇만 남아 정리됨
        } else {
            room.sendState();
            if (room.mode === 'cash') room.tryAutoResume();
        }
        io.to('lobby').emit('roomList', roomListArray()); // 로비에 방 변동 반영

        socket.emit('leftRoom');
        socket.emit('roomList', roomListArray());
        enterLobby(socket); // 🏛️ 로비 복귀 → 대기자 명단 합류
    });

    // 🎓 [학습모드] AI 5명과 1:5 GTO 연습 — 학습 방 생성 + 봇 5명 + 즉시 시작
    socket.on('createLearnMode', async (data) => {
        if (!socket.nickname) return;
        // 🎓 봇 수 선택 (1~5명, 사람 포함 최대 6인). 기본 5명
        let botCount = 5;
        if (data && typeof data.botCount === 'number') botCount = data.botCount;
        botCount = Math.max(1, Math.min(5, Math.round(botCount)));
        const roomId = `🎓학습_${socket.nickname}`;
        // 기존 학습방 있으면 정리
        if (rooms.has(roomId)) { try { destroyRoom(roomId); } catch (e) {} }
        const settings = { startingChips: 10000, blindUpInterval: 999999, turnTimeLimit: 60, mode: 'cash', cashBlind: 100 };
        const room = new GameRoom(roomId, settings);
        room._learnMode = true; // 🎓 학습 모드 플래그
        room._mttFreeChips = true; // 자유 칩 — 뱅크롤에 영향 없음 (순수 연습)
        rooms.set(roomId, room);

        // 사람 착석
        socket.join(roomId);
        socket.currentRoom = roomId;
        leaveLobby(socket);
        room.hostNickname = socket.nickname;
        const u = await MockDB.getUser(socket.nickname);
        room.players[socket.nickname] = {
            id: socket.nickname, socketId: socket.id, chips: settings.startingChips,
            currentBet: 0, totalInvested: 0, isFolded: false, hasActed: false, role: '',
            isAllIn: false, isDisconnected: false, isMucked: false, isSpectator: false,
            hand: [], lastEmoteTime: 0, isBot: false
        };
        room.playerOrder.push(socket.nickname);

        // AI 봇 추가 (고수) — 선택한 수만큼
        for (let i = 0; i < botCount; i++) room.addBot('hard');

        socket.emit('joinRoomSuccess', roomId);
        socket.emit('learnModeStarted');
        room.sendState();
        room._cashStarted = true;
        setTimeout(() => { if (rooms.has(roomId)) room.startNextHand(); }, 1200);
    });

    socket.on('startFirstHand', async () => {
        const room = rooms.get(socket.currentRoom);
        if (room && room.gameStage === 0 && !room.tournamentStarted) {
            if (room.hostNickname !== socket.nickname) return; // 💡 호스트 권한 검증
            const activeCount = room.playerOrder.filter(n => room.players[n] && !room.players[n].isDisconnected).length;
            if (activeCount < 2) {
                socket.emit('gameMessage', '🚨 혼자서는 토너먼트를 시작할 수 없습니데이! (최소 2명 필요)');
                return;
            }
            // 💰 캐시가 아닌 토너먼트는 사람 참가자 전원의 뱅크롤이 바이인 이상이어야 시작
            if (room.mode !== 'cash') {
                for (const n of room.playerOrder) {
                    const p = room.players[n];
                    if (!p || p.isBot) continue;
                    const u = await MockDB.getUser(n);
                    if ((u.bankroll || 0) < room.startingChips) {
                        io.to(room.roomId).emit('gameMessage', `🚨 ${n} 님의 보유 칩이 바이인(${room.startingChips.toLocaleString()})보다 적어 시작할 수 없습니데이!`);
                        return;
                    }
                }
            }
            room._cashStarted = true; // 💵 [#2] 캐시 자동진행 활성화 (이후 핸드 자동 연결)
            room.startNextHand();
            io.to('lobby').emit('roomList', roomListArray()); // 진행중 상태 반영
        }
    });

    // 🤖 봇 추가 (호스트 전용, 대기 중 + 6인 미만)
    socket.on('addBot', (data) => {
        const room = rooms.get(socket.currentRoom);
        if (!room || room.hostNickname !== socket.nickname) return;
        if (room.gameStage !== 0 || room.tournamentStarted) {
            socket.emit('gameMessage', '🤖 봇은 게임 시작 전 대기실에서만 추가할 수 있습니데이!');
            return;
        }
        if (room.playerOrder.length >= 6) {
            socket.emit('gameMessage', '🚨 자리가 가득 찼습니데이! (최대 6명)');
            return;
        }
        const difficulty = 'hard'; // AI는 고수 전용
        room.addBot(difficulty);
        io.to('lobby').emit('roomList', roomListArray()); // 로비에 인원 변동 반영
    });

    // 🤖 봇 제거 (호스트 전용)
    socket.on('removeBot', (botNick) => {
        const room = rooms.get(socket.currentRoom);
        if (!room || room.hostNickname !== socket.nickname) return;
        if (room.gameStage !== 0 || room.tournamentStarted) return;
        room.removeBot(botNick);
        io.to('lobby').emit('roomList', roomListArray());
    });

    socket.on('action', (data) => {
        try {
            const room = rooms.get(socket.currentRoom);
            if (!room || !data) return;
            const nick = socket.nickname;
            if (room.playerOrder[room.turnIndex] !== nick) return;
            room.applyAction(nick, data.type, data.amount);
        } catch(e) { console.error("Action Error:", e); }
    });

    socket.on('emote', (emoji) => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname) return;

        const p = room.players[socket.nickname];
        if (!p) return;

        const now = Date.now();
        if (now - (p.lastEmoteTime || 0) >= 10000) {
            p.lastEmoteTime = now;
            const allowed = ['😂', '😡', '😎'];
            const safeEmoji = allowed.includes(emoji) ? emoji : '😂'; // 💡 허용 이모지 화이트리스트
            io.to(socket.currentRoom).emit('playerEmote', { nick: socket.nickname, emoji: safeEmoji });
        }
    });

    socket.on('getHallOfFame', async () => {
        const topPlayers = await MockDB.getTopPlayers();
        socket.emit('hallOfFameData', topPlayers);
    });

    // 🏆 시즌 리더보드
    socket.on('getSeasonBoard', async () => {
        const leaders = await MockDB.getSeasonLeaders();
        socket.emit('seasonBoardData', { season: CURRENT_SEASON, leaders });
    });

    // 💰 뱅크롤(보유 칩) 순위
    socket.on('getBankrollBoard', async () => {
        const leaders = await MockDB.getBankrollLeaders();
        socket.emit('bankrollBoardData', { leaders });
    });

    // 🏆 [MTT] 멀티테이블 토너먼트 챔피언 명예의 전당
    socket.on('getMttChampions', async () => {
        const champions = await MockDB.getMttChampions();
        socket.emit('mttChampionsData', { champions });
    });

    // 🏆 [MTT] 생성 (호스트가 로비에서)
    socket.on('createMtt', (data) => {
        if (!socket.nickname || socket.currentRoom) return;
        const name = sanitizeRoomName(data && data.name) || `MTT-${socket.nickname}`;
        const mttId = 'mtt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const mtt = new MTTManager(mttId, socket.nickname, {
            name,
            tableSize: clampInt(data && data.tableSize, 2, 6, 6),
            startingChips: clampInt(data && data.startingChips, 1000, 1000000, 5000),
            blindUpInterval: clampInt(data && data.blindUpInterval, 60, 3600, 180)
        });
        mtts.set(mttId, mtt);
        mtt.addEntrant(socket.nickname, socket.id, false);
        socket._mttId = mttId;
        leaveLobby(socket);
        socket.emit('mttCreated', { mttId, name });
        mtt.broadcastLobby();
        io.emit('mttList', mttListArray());
    });

    // 🏆 [MTT] 참가
    socket.on('joinMtt', (data) => {
        if (!socket.nickname || socket.currentRoom) return;
        const mtt = mtts.get(data && data.mttId);
        if (!mtt || mtt.started) { socket.emit('gameMessage', '🚫 이미 시작했거나 없는 토너먼트입니데이.'); return; }
        if (mtt.entrants.length >= mtt.tableSize * 6) { socket.emit('gameMessage', '🚫 정원이 가득 찼습니데이.'); return; }
        if (mtt.addEntrant(socket.nickname, socket.id, false)) {
            socket._mttId = mtt.mttId;
            leaveLobby(socket);
            socket.emit('mttJoined', { mttId: mtt.mttId, name: mtt.name });
            io.emit('mttList', mttListArray());
        }
    });

    // 🏆 [MTT] 봇 추가 (호스트)
    socket.on('addMttBot', () => {
        const mtt = mtts.get(socket._mttId);
        if (!mtt || mtt.hostNick !== socket.nickname || mtt.started) return;
        if (mtt.entrants.length >= mtt.tableSize * 6) { socket.emit('gameMessage', '🚫 정원이 가득 찼습니데이.'); return; }
        mtt.addBot();
        io.emit('mttList', mttListArray());
    });

    // 🏆 [MTT] 시작 (호스트)
    socket.on('startMtt', () => {
        const mtt = mtts.get(socket._mttId);
        if (!mtt || mtt.hostNick !== socket.nickname || mtt.started) return;
        if (mtt.entrants.length < 2) { socket.emit('gameMessage', '🚫 최소 2명 필요합니데이.'); return; }
        mtt.start();
        io.emit('mttList', mttListArray());
    });

    // 🏆 [MTT] 대기 중 나가기
    socket.on('leaveMtt', () => {
        const mtt = mtts.get(socket._mttId);
        if (!mtt) return;
        if (!mtt.started) {
            mtt.removeEntrant(socket.nickname);
            // 호스트가 나가면 토너먼트 취소
            if (mtt.hostNick === socket.nickname) {
                mtt.entrants.forEach(e => { if (e.socketId) io.to(e.socketId).emit('mttCancelled'); });
                mtts.delete(mtt.mttId);
            }
            socket._mttId = null;
            enterLobby(socket);
            io.emit('mttList', mttListArray());
        }
    });

    // 🏆 [MTT] 목록 요청
    socket.on('getMttList', () => {
        socket.emit('mttList', mttListArray());
    });

    // 🎬 [리플레이] 특정 핸드 리플레이 데이터 요청
    socket.on('getReplay', (handNo) => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !room.handHistory) { socket.emit('replayData', null); return; }
        const entry = room.handHistory.find(h => h.no === handNo && h.replay);
        socket.emit('replayData', entry ? entry.replay : null);
    });

    // 🏛️ 대기자 명단 요청 — 로비에 없으면 합류시키고 현재 명단 응답
    socket.on('getLobbyUsers', () => {
        if (!socket.nickname) return;
        if (!socket.currentRoom && !lobbyUsers.has(socket.id)) {
            enterLobby(socket); // 누락된 경우 합류 (broadcast 포함)
        } else {
            socket.emit('lobbyUsers', lobbyListArray());
        }
    });

    // 📜 핸드 히스토리 조회 (방 참가자만)
    socket.on('rebuy', () => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname) return;
        room.doRebuy(socket.nickname);
    });

    socket.on('cashBuyin', () => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname) return;
        room.doCashBuyin(socket.nickname);
    });

    // 💰 뱅크롤 조회 (로비 표시 갱신)
    socket.on('getBankroll', async () => {
        if (!socket.nickname) return;
        // 💸 [#1] 방에 없을 때(로비) 뱅크롤 0이면 무료 충전
        if (!socket.currentRoom) {
            const refill = await MockDB.refillIfBroke(socket.nickname, 0, 10000);
            if (refill.refilled) {
                socket.emit('gameMessage', '💸 뱅크롤이 바닥나 무료 보너스 10,000 칩을 받았습니데이!');
                socket.emit('freeRefill', { bankroll: refill.bankroll });
            }
        }
        const u = await MockDB.getUser(socket.nickname);
        socket.emit('bankrollUpdate', { bankroll: u.bankroll || 0 });
    });

    // 👤 [신규] 플레이어 프로필 조회 (조회로 새 레코드가 생기지 않도록 has 체크)
    socket.on('getProfile', (nick) => {
        if (!socket.nickname) return;
        const safe = sanitizeNick(nick);
        if (!safe || !MockDB.users.has(safe)) { socket.emit('profileData', null); return; }
        const u = MockDB.users.get(safe);
        const ach = (u.achievements || []).map(id => ACHIEVEMENTS[id] ? { id, ...ACHIEVEMENTS[id] } : null).filter(Boolean);
        const hp = u.handsPlayed || 0;
        const pfOpps = u.preflopOpps || 0;
        const pct = (num, den) => den > 0 ? Math.round((num / den) * 100) : null;
        socket.emit('profileData', {
            nickname: u.nickname,
            wins: u.wins || 0,
            handsPlayed: hp,
            handsWon: u.handsWon || 0,
            vpipHands: u.vpipHands || 0,
            biggestPot: u.biggestPot || 0,
            seasonPoints: (u.seasonId === CURRENT_SEASON) ? (u.seasonPoints || 0) : 0,
            cashNet: u.cashNet || 0,
            achievements: ach,
            // 📊 포커 분석 지표
            stats: {
                vpip: pct(u.vpipHands || 0, pfOpps),                       // 자발적 팟 참여율
                pfr: pct(u.pfrHands || 0, pfOpps),                         // 프리플랍 레이즈율
                threeBet: pct(u.threeBetCount || 0, u.threeBetOpps || 0),  // 3벳 빈도
                af: (u.aggrCalls || 0) > 0 ? Math.round(((u.aggrBets || 0) / u.aggrCalls) * 10) / 10 : ((u.aggrBets || 0) > 0 ? null : 0), // 공격성 지수
                foldToBet: pct(u.foldToBet || 0, u.faceBet || 0),          // 벳 대응 폴드율
                wsd: pct(u.wonAtShowdown || 0, u.wentToShowdown || 0),     // 쇼다운 승률
                wtsd: pct(u.wentToShowdown || 0, hp),                      // 쇼다운 도달률
                gto: (u.gtoScoreCount || 0) > 0 ? Math.round((u.gtoScoreSum || 0) / u.gtoScoreCount) : null, // GTO 근접도
                sampleActions: u.gtoScoreCount || 0
            }
        });
    });

    socket.on('getHandHistory', () => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname || !room.players[socket.nickname]) return;
        socket.emit('handHistoryData', room.handHistory);
    });

    // 🎁 [출석/미션] 일일 보상 시스템
    socket.on('getDailyStatus', async () => {
        if (!socket.nickname) { socket.emit('dailyStatus', null); return; }
        const missions = await MockDB.getMissions(socket.nickname);
        const u = MockDB.users.get(socket.nickname);
        const today = MockDB._todayKey();
        socket.emit('dailyStatus', {
            checkedInToday: u && u.lastCheckIn === today,
            streak: (u && u.checkInStreak) || 0,
            missions: missions || []
        });
    });
    socket.on('claimCheckIn', async () => {
        if (!socket.nickname) return;
        const res = await MockDB.checkIn(socket.nickname);
        if (res) socket.emit('checkInResult', res);
        if (res && res.claimed) socket.emit('bankrollUpdate', res.bankroll);
    });
    socket.on('claimMission', async (data) => {
        if (!socket.nickname || !data || !data.id) return;
        const res = await MockDB.claimMission(socket.nickname, data.id);
        socket.emit('missionResult', { id: data.id, ...res });
        if (res.ok) {
            socket.emit('bankrollUpdate', res.bankroll);
            const missions = await MockDB.getMissions(socket.nickname);
            socket.emit('missionsRefresh', missions);
        }
    });

    // 📋 [세션 리포트] 이번 세션 동안의 성적표 — 시작 스냅샷 대비 변화량
    socket.on('getSessionReport', (data) => {
        if (!socket.nickname || !MockDB.users.has(socket.nickname)) { socket.emit('sessionReport', null); return; }
        const u = MockDB.users.get(socket.nickname);
        const range = (data && ['session', 'day', 'week', 'month', 'learn'].includes(data.range)) ? data.range : 'session';
        const pct = (num, den) => den > 0 ? Math.round((num / den) * 100) : null;

        let handsPlayed, handsWon, pfOpps, vpipH, pfrH, tbCount, tbOpps, aggrBets, aggrCalls, foldToBet, faceBet, wtsd, wsd, gtoSum, gtoCnt;
        let metaTop = {};

        if (range === 'learn') {
            // 🎓 학습 모드 누적 통계 (실전과 분리)
            const L = u.learnStats || {};
            handsPlayed = L.handsPlayed || 0; handsWon = L.handsWon || 0; pfOpps = L.preflopOpps || 0;
            vpipH = L.vpipHands || 0; pfrH = L.pfrHands || 0; tbCount = L.threeBetCount || 0; tbOpps = L.threeBetOpps || 0;
            aggrBets = L.aggrBets || 0; aggrCalls = L.aggrCalls || 0; foldToBet = L.foldToBet || 0; faceBet = L.faceBet || 0;
            wtsd = L.wentToShowdown || 0; wsd = L.wonAtShowdown || 0; gtoSum = L.gtoScoreSum || 0; gtoCnt = L.gtoScoreCount || 0;
            metaTop = { durationMin: null, bankrollStart: null, bankrollDelta: null, tourneyWins: null, seasonPointsGained: null, newAchievements: [] };
        } else if (range === 'session') {
            const snap = sessionSnapshots.get(socket.nickname);
            if (!snap) { socket.emit('sessionReport', null); return; }
            const d = (k) => Math.max(0, (u[k] || 0) - (snap[k] || 0));
            handsPlayed = d('handsPlayed'); handsWon = d('handsWon'); pfOpps = d('preflopOpps');
            vpipH = d('vpipHands'); pfrH = d('pfrHands'); tbCount = d('threeBetCount'); tbOpps = d('threeBetOpps');
            aggrBets = d('aggrBets'); aggrCalls = d('aggrCalls'); foldToBet = d('foldToBet'); faceBet = d('faceBet');
            wtsd = d('wentToShowdown'); wsd = d('wonAtShowdown'); gtoSum = d('gtoScoreSum'); gtoCnt = d('gtoScoreCount');
            const prevAch = new Set(snap.achievements || []);
            const newAch = (u.achievements || []).filter(id => !prevAch.has(id)).map(id => ACHIEVEMENTS[id] ? { id, ...ACHIEVEMENTS[id] } : null).filter(Boolean);
            metaTop = {
                durationMin: Math.max(1, Math.round((Date.now() - snap.ts) / 60000)),
                bankrollStart: snap.bankroll,
                bankrollDelta: (u.bankroll || 0) - (snap.bankroll || 0),
                tourneyWins: Math.max(0, (u.wins || 0) - (snap.wins || 0)),
                seasonPointsGained: Math.max(0, (u.seasonPoints || 0) - (snap.seasonPoints || 0)),
                newAchievements: newAch
            };
        } else {
            const days = range === 'day' ? 1 : (range === 'week' ? 7 : 30);
            const agg = MockDB.aggregateRange(u, days);
            handsPlayed = agg.handsPlayed; handsWon = agg.handsWon; pfOpps = agg.preflopOpps;
            vpipH = agg.vpipHands; pfrH = agg.pfrHands; tbCount = agg.threeBetCount; tbOpps = agg.threeBetOpps;
            aggrBets = agg.aggrBets; aggrCalls = agg.aggrCalls; foldToBet = agg.foldToBet; faceBet = agg.faceBet;
            wtsd = agg.wentToShowdown; wsd = agg.wonAtShowdown; gtoSum = agg.gtoScoreSum; gtoCnt = agg.gtoScoreCount;
            metaTop = { durationMin: null, bankrollStart: null, bankrollDelta: null, tourneyWins: null, seasonPointsGained: null, newAchievements: [] };
        }

        const report = {
            range,
            bankrollNow: u.bankroll || 0,
            handsPlayed, handsWon,
            winRate: pct(handsWon, handsPlayed),
            biggestPotNow: u.biggestPot || 0,
            ...metaTop,
            stats: {
                vpip: pct(vpipH, pfOpps),
                pfr: pct(pfrH, pfOpps),
                threeBet: pct(tbCount, tbOpps),
                af: aggrCalls > 0 ? Math.round((aggrBets / aggrCalls) * 10) / 10 : (aggrBets > 0 ? null : 0),
                foldToBet: pct(foldToBet, faceBet),
                wsd: pct(wsd, wtsd),
                wtsd: pct(wtsd, handsPlayed),
                gto: gtoCnt > 0 ? Math.round(gtoSum / gtoCnt) : null,
                sampleActions: gtoCnt
            }
        };
        report.coaching = buildCoaching(report.stats, handsPlayed);
        socket.emit('sessionReport', report);
    });

    socket.on('chatMessage', (data) => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname || !data) return;
        const safeMsg = String(data.msg).replace(/</g, '&lt;').replace(/>/g, '&gt;').trim().slice(0, 80);
        if (!safeMsg) return;
        io.to(socket.currentRoom).emit('chatMessage', { nick: socket.nickname, msg: safeMsg });
    });

    // 🏛️ 로비 채팅 (방에 들어가기 전 대기실 대화)
    socket.on('lobbyChat', (data) => {
        if (!socket.nickname || socket.currentRoom || !data) return; // 방에 있으면 로비 채팅 불가
        if (!lobbyUsers.has(socket.id)) return;
        const safeMsg = String(data.msg).replace(/</g, '&lt;').replace(/>/g, '&gt;').trim().slice(0, 80);
        if (!safeMsg) return;
        io.to('lobby').emit('lobbyChat', { nick: socket.nickname, msg: safeMsg });
    });

    socket.on('disconnect', () => {
        try {
            leaveLobby(socket); // 🏛️ 로비에 있었으면 대기자 명단에서 제거
            const roomId = socket.currentRoom;
            const room = rooms.get(roomId);
            if (room && socket.nickname && room.players[socket.nickname]) {
                if (room.players[socket.nickname].socketId !== socket.id) return;

                const wasMyTurn = (room.playerOrder[room.turnIndex] === socket.nickname);
                room.players[socket.nickname].isDisconnected = true;

                io.to(roomId).emit('gameMessage', `🔌 ${socket.nickname} 오프라인`);

                // 🔌 [무결성] 끊긴 사람 차례면 즉시 자동 처리 (모두가 타이머만큼 기다리지 않게)
                if (wasMyTurn && room.gameStage >= 1 && room.gameStage < 5) {
                    const dp = room.players[socket.nickname];
                    if (dp && !dp.isFolded && !dp.isAllIn) {
                        const callAmt = room.currentHighestBet - dp.currentBet;
                        if (callAmt === 0) {
                            dp.hasActed = true;
                            io.to(roomId).emit('gameMessage', `⏳ ${socket.nickname} 연결 끊김 — 자동 체크`);
                            io.to(roomId).emit('actionSound', { nick: socket.nickname, type: 'check' });
                        } else {
                            dp.isFolded = true; dp.hasActed = true;
                            io.to(roomId).emit('gameMessage', `⏳ ${socket.nickname} 연결 끊김 — 자동 폴드`);
                            io.to(roomId).emit('actionSound', { nick: socket.nickname, type: 'fold' });
                        }
                        if (room.turnTimeout) clearTimeout(room.turnTimeout);
                        room.nextTurn();
                    }
                }

                if (room.hostNickname === socket.nickname) {
                    const activeOnlines = Object.keys(room.players).filter(n => n !== socket.nickname && !room.players[n].isDisconnected && !room.players[n].isBot);
                    if(activeOnlines.length > 0) {
                        room.hostNickname = activeOnlines[0];
                        io.to(room.roomId).emit('gameMessage', `👑 방장이 오프라인이 되어 [${room.hostNickname}] 님이 새로운 방장이 되었습니다.`);
                    }
                }

                const nickRef = socket.nickname;
                room.players[nickRef]._disconnectTimer = setTimeout(() => {
                    const r = rooms.get(roomId);
                    if (!r || !r.players[nickRef]) return;
                    if (!r.players[nickRef].isDisconnected) return;

                    // 💡 [수정 #6] 사람이 전원 오프라인이면 방 통째로 정리 (봇만 남아도 정리)
                    const humans = Object.values(r.players).filter(pl => !pl.isBot);
                    const allHumansOffline = humans.length === 0 || humans.every(pl => pl.isDisconnected);
                    if (allHumansOffline) { destroyRoom(roomId); return; }

                    if (r.gameStage === 0) {
                        // 💰 [버그수정] 캐시 테이블 장기 미접속 자동 퇴장 시, 테이블 칩을 뱅크롤로 환수 (유실 방지)
                        const dp = r.players[nickRef];
                        if (r.mode === 'cash' && !r._learnMode && dp && !dp.isBot && (dp.chips || 0) > 0) {
                            MockDB.recordCashNet(nickRef, dp.chips);
                            MockDB.adjustBankroll(nickRef, dp.chips);
                        }
                        delete r.players[nickRef];
                        r.playerOrder = r.playerOrder.filter(n => n !== nickRef);
                        io.to(roomId).emit('gameMessage', `👋 ${nickRef} 장기 미접속으로 자동 퇴장되었습니다.`);
                        const humansLeft = Object.values(r.players).filter(pl => !pl.isBot);
                        if (humansLeft.length === 0) destroyRoom(roomId);
                        else r.sendState();
                    }
                }, 60000);

                // 💡 [버그픽스] 내 차례였던 경우는 위 블록에서 이미 자동 체크/폴드 + nextTurn() 으로 처리됨.
                //    예전엔 여기서 한 번 더 강제 폴드 + nextTurn() 을 호출해서:
                //      (1) 자동 체크한 플레이어가 곧바로 폴드로 뒤집히고,
                //      (2) turnIndex 가 두 번 전진해 바로 다음 플레이어의 턴이 통째로 건너뛰어졌다.
                //    그 외(내 차례가 아니었던 경우)에만 연결 끊김 상태를 반영해 화면을 갱신한다.
                if (!(wasMyTurn && room.gameStage >= 1 && room.gameStage < 5)) {
                    room.sendState();
                }
            }
        } catch(e) { console.error("Disconnect Error:", e); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ [Master Server] 치명 버그 수정 + 보안 패치 + 방 정리 시스템 적용 완료! (포트 ${PORT})`);
});

// 🛡️ [안정성] 주기적 자동저장 (디바운스가 놓친 변경분까지 60초마다 안전 저장)
setInterval(() => { try { MockDB.flush(); } catch (e) {} }, 60000);

// 🧹 [안정성] 주기적 빈 방 청소 — 사람이 아무도 없는 방(봇만/유령) 자동 정리
//   호출이 누락되는 경로가 있어도 30초마다 한 번씩 확실히 청소 (MTT 테이블은 제외)
setInterval(() => {
    try {
        for (const roomId of Array.from(rooms.keys())) {
            const room = rooms.get(roomId);
            if (!room || room._mtt) continue; // MTT 테이블은 매니저가 관리
            const connectedHumans = Object.values(room.players).filter(p => {
                if (!p || p.isBot) return false;
                if (!p.socketId) return false;
                const sock = io.sockets.sockets.get(p.socketId);
                return !!sock; // 실제 연결된 사람만
            }).length;
            if (connectedHumans === 0) destroyRoom(roomId);
        }
    } catch (e) {}
}, 30000);

// 🛡️ [안정성] 우아한 종료 — 종료 시그널 시 대기 중인 저장을 즉시 디스크에 반영 후 종료
let _shuttingDown = false;
function gracefulShutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log(`\n🛑 ${signal} 수신 — 전적 저장 후 종료합니다...`);
    try { MockDB.flush(); } catch (e) { console.error('종료 저장 실패:', e.message); }
    // 새 연결 차단 후 정리
    try { server.close(() => { console.log('✅ 안전하게 종료되었습니다.'); process.exit(0); }); } catch (e) { process.exit(0); }
    // 소켓이 안 닫혀 hang되는 경우 대비 강제 종료 타임아웃
    setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));