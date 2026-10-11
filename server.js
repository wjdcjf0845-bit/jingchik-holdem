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
// 💾 원격 영속화 (Turso) — TURSO_DATABASE_URL 설정 시에만 활성화, 미설정이면 로컬 파일만 사용
const { createRemoteStorage } = require('./lib/storage');
// 🎰 봇 베팅 사이징 (이산 GTO 버킷 + 체크레이즈 사이징) — 순수 모듈, 테스트로 분포 검증
const { pickBetFraction, raiseToAmount } = require('./lib/betsizing');
const { classifyBetPlan, barrelFrequency } = require('./lib/botplan'); // 🧠 봇 스트리트 플랜 (배럴/의도 유지)
const RIT = require('./lib/runittwice'); // 🎲 런잇트와이스 (올인 시 보드 2번) — 캐시 전용
const HandRead = require('./lib/handread'); // 🔍 상대 레인지 추정 (핸드 리딩)
const Defense = require('./lib/defense'); // 🛡️ 벳 직면 시 콜 문턱 (임플라이드 오즈 + 상대 익스플로잇)
const Blockers = require('./lib/blockers'); // 🃏 블로커 기반 블러프 선택 (넛 차단 시 블러프 ↑)
const Showdown = require('./lib/showdown'); // 💰 쇼다운 팟 분배 파이프라인 (돈 로직 — 시나리오 테스트로 방어)
const { chipChop } = require('./lib/chop'); // 🤝 토너먼트 합의 종료 칩 찹 분배 (돈 로직 — 보존성 테스트로 방어)
const Postflop = require('./lib/postflop'); // 🎯 레인지 기반 포스트플랍 전략 (C벳·MDF·블러프캐치·SPR)
const RangeEq = require('./lib/rangeeq'); // 🎯 "벳하는 상대의 레인지" 대비 내 핸드 강도
const TABLE_SEATS = 6;           // 🪑 테이블 정원 — 클라이언트 좌석 레이아웃(pos-0~pos-5)과 반드시 일치
// 🔬 DEV_FAST_HANDS: 봇끼리 수천 판을 돌려 전략을 재는 측정 전용 스위치(연출 대기를 없앤다). 운영에선 설정하지 않는다.
const DEV_FAST = !!process.env.DEV_FAST_HANDS;
const SHOWDOWN_REVEAL_MS = DEV_FAST ? 40 : 3000; // 🃏 올인 쇼다운 — 카드 한 장을 보고 나서 다음 장까지의 간격
const MUCK_CHOICE_MS = 6000;     // 🃏 진 사람이 패를 공개할지 정하는 시간
const END_VOTE_MS = 30000; // 🗳️ 합의 종료 투표 제한시간
const TIME_BANK_MS = 15000;      // ⏳ 타임뱅크 — 핸드당 1회, 더 쓸 수 있는 시간
// 🏆 새 계정이 받는 토큰. 운영에선 0 — 시뮬레이션에서만 DEV_START_TOKENS 로 넣어 구매 흐름을 검증한다.
const START_TOKENS = Math.max(0, parseInt(process.env.DEV_START_TOKENS, 10) || 0);
// 🏆 토큰은 "사람" 이 이만큼 이상 참가한 토너먼트에서만 준다.
//    봇만 앉혀 놓고 혼자 우승을 찍어내면 토큰이 우승의 증표가 못 된다.
const TOKEN_MIN_HUMANS = 3;
const THROW_ITEMS = ['🍅', '🌹', '🥚', '👏']; // 🍅 상대에게 던질 수 있는 것 (연출 전용)
const PHOTO_MAX_BYTES = 24000;   // 📷 프로필 사진 원본 상한 (클라가 128px 로 줄여 보내면 5~10KB)
const PHOTO_MAX_B64 = 40000;     // 📷 data URL 문자열 상한 — 파싱 전에 먼저 걸러낸다
const photoRate = new Map();     // 📷 닉네임 → 마지막 업로드 시각 (도배 방지)
// 🛡️ 관리자 계정 닉네임. 이 닉네임으로 로그인하면 게임이 아니라 관리자 페이지로 간다.
const ADMIN_NICK = (process.env.ADMIN_USER || 'admin');
let adminRouter = null;          // 아래에서 /admin 을 붙일 때 채워진다

// 🎨 [상점] 우승 토큰으로 사는 꾸미기 — 카드 뒷면 / 아바타 / 칭호. (price = 토큰 개수)
//    뱅크롤로 팔면 캐시에서 딴 돈으로 다 사버려 "우승의 증표"가 못 된다. 토너먼트 1승 = 토큰 1개.
//    kind 별로 하나씩만 장착된다. price 0 은 기본 지급품이라 따로 살 필요가 없다.
//    ⚠️ id 는 클라이언트 CSS(public/skins/<id>.webp)와 1:1로 묶여 있으니 바꾸지 말 것.
const COSMETICS = {
    // ── 카드 뒷면 (이미지: public/skins/<id>.webp)
    back_classic: { kind: 'back', name: '기본 문양',   price: 0,      desc: '처음부터 주어지는 기본 뒷면' },
    back_verm:    { kind: 'back', name: '버밀리언 데코', price: 1,  desc: '주홍 잉크로 찍어낸 아르데코 태양' },
    back_jade:    { kind: 'back', name: '옥빛 물결',   price: 1,  desc: '청해파 문양을 새긴 목판화' },
    back_noir:    { kind: 'back', name: '느와르',      price: 2,  desc: '1920년대 흑백 개츠비' },
    back_peony:   { kind: 'back', name: '목단',        price: 2, desc: '겨자빛 모란이 만발한 뒷면' },
    back_star:    { kind: 'back', name: '별자리',      price: 3, desc: '한밤의 은빛 천문도' },
    back_royal:   { kind: 'back', name: '황금 왕관',   price: 5, desc: '감청 바탕에 금박을 올린 세공' },
    // ── 아바타
    av_none:   { kind: 'avatar', name: '이니셜',  price: 0,      desc: '닉네임 첫 글자' },
    av_fox:    { kind: 'avatar', name: '여우',    price: 1,  desc: '얍삽한 블러퍼' },
    av_cat:    { kind: 'avatar', name: '고양이',  price: 1,  desc: '표정을 안 주는 쪽' },
    av_owl:    { kind: 'avatar', name: '올빼미',  price: 1,  desc: '길게 보고 판단하는 쪽' },
    av_wolf:   { kind: 'avatar', name: '늑대',    price: 2,  desc: '물면 안 놓는다' },
    av_shark:  { kind: 'avatar', name: '상어',    price: 3, desc: '테이블의 포식자' },
    av_dragon: { kind: 'avatar', name: '용',      price: 5, desc: '아무나 못 다는 것' },
    // ── 🏅 등급 테두리 (살 수 없다 — 등급이 오르면 열린다. rank = 필요한 등급 번호)
    fr_none:   { kind: 'frame', price: 0, noBuy: true, rank: 0, name: '없음',      desc: '기본 테두리' },
    fr_bronze: { kind: 'frame', price: 0, noBuy: true, rank: 1, name: '구릿빛',    desc: '동네 고수의 증표' },
    fr_silver: { kind: 'frame', price: 0, noBuy: true, rank: 2, name: '은빛',      desc: '선수 소리 듣는 사람' },
    fr_gold:   { kind: 'frame', price: 0, noBuy: true, rank: 3, name: '금빛',      desc: '타짜의 자리' },
    fr_legend: { kind: 'frame', price: 0, noBuy: true, rank: 4, name: '무지개',    desc: '전설 — 아무나 못 답니다' },
    // ── 📷 직접 올린 프로필 사진 (사진이 있을 때만 장착 가능)
    av_photo:  { kind: 'avatar', price: 0, noBuy: true, photo: true, name: '내 사진', desc: '직접 올린 프로필 사진' },
    // ── 칭호 (이미지 없음 — 닉네임 옆에 붙는다)
    ti_none:  { kind: 'title', name: '없음',        price: 0,      text: '', desc: '칭호를 떼어 둡니다' },
    // 🔷 코어(컴까기에서만 나오는 재화)로 사는 것들 — cur: 'core'
    back_circuit: { kind: 'back',   cur: 'core', price: 6,  name: '회로 기판',   desc: '푸른 회로가 흐르는 뒷면' },
    back_neon:    { kind: 'back',   cur: 'core', price: 12, name: '네온 그리드', desc: '신스웨이브 네온 뒷면' },
    av_robot:     { kind: 'avatar', cur: 'core', price: 5,  name: '로봇',        desc: '컴까기 입문 기념' },
    av_cyborg:    { kind: 'avatar', cur: 'core', price: 10, name: '사이보그',    desc: '반은 사람, 반은 기계' },
    av_aicore:    { kind: 'avatar', cur: 'core', price: 18, name: 'AI 코어',     desc: '보스의 심장' },
    ti_hunter:    { kind: 'title',  cur: 'core', price: 4,  name: '봇 사냥꾼',   text: '🔧 봇 사냥꾼',   desc: '봇 잡는 게 취미' },
    ti_breaker:   { kind: 'title',  cur: 'core', price: 15, name: '기계 파괴자', text: '⚡ 기계 파괴자', desc: '고수 봇도 부순다' },
    // 🤖 컴까기 10단계를 전부 깨면 열린다 (살 수 없다)
    ti_bot:   { kind: 'title', name: '컴까기 정복자', price: 0, noBuy: true, challenge: true, text: '🤖 컴까기 정복자', desc: '컴까기 보스전을 깬 사람' },
    ti_rookie:{ kind: 'title', name: '입문자',    price: 1,  text: '🌱 입문자', desc: '이제 막 판에 앉았습니다' },
    ti_bluff: { kind: 'title', name: '블러프 장인', price: 2,  text: '🎭 블러프 장인', desc: '없는 패로 이기는 사람' },
    ti_allin: { kind: 'title', name: '올인 러버',  price: 2,  text: '🔥 올인 러버', desc: '고민은 짧게, 베팅은 크게' },
    ti_rock:  { kind: 'title', name: '바위',      price: 2,  text: '🪨 바위', desc: '좋은 패만 골라 칩니다' },
    ti_shark: { kind: 'title', name: '테이블 상어', price: 3, text: '🦈 테이블 상어', desc: '앉은 자리가 곧 사냥터' },
    ti_king:  { kind: 'title', name: '판의 지배자', price: 6, text: '👑 판의 지배자', desc: '뱅크롤로 증명하는 자리' }
};
const COSMETIC_DEFAULTS = { back: 'back_classic', avatar: 'av_none', title: 'ti_none', frame: 'fr_none' };

// 🏅 [등급] 돈으로 살 수 없는 것 — 우승 횟수나 "최고로 모았던 뱅크롤"로만 열린다.
//    판정 기준과 임계값은 lib/rank.js 에 있다 (단위 테스트로 오름차순을 지킨다).
const { RANKS, rankIndexOf, rankNeedText } = require('./lib/rank');
const ShortStack = require('./lib/shortstack'); // 🤖 숏스택 푸시/폴드 · 올인 콜 레인지
const OppModel = require('./lib/oppmodel');     // 🧠 상대 읽기 — 세션 표본 + 계정 누적 전적
const Challenge = require('./lib/challenge');   // 🤖 컴까기(AI 도장깨기) 단계표·보상
const Rogue = require('./lib/roguerun');        // 🍀 증강 컴까기(로그라이크 런) — 층·증강·정산
const { Capacity } = require('./lib/capacity');  // 🚦 서버 정원 · 입장 대기열
const Blunder = require('./lib/blunder');       // 💥 리포트의 '치명적 플레이' 기록
const Ranges = require('./lib/ranges');         // 📊 프리플랍 범위표(레이즈를 받았을 때 패마다 3벳·콜·폴드 빈도)
const Jam = require('./lib/jam');               // 🧨 프리플랍 올인 승부(푸시·리쉬브)를 패 대 패 승률표로 직접 푼 균형
const Icm = require('./lib/icm');               // 🏆 대회 상금 기준(ICM) — 입상권 근처의 올인 콜
const EvLoss = require('./lib/evloss');         // 📉 결정마다 잃은 기대값(bb) — 실력 점수의 단위
const Freqs = require('./lib/freqs');           // 📊 상황별 빈도(오픈·방어·3벳·c벳…)를 기준과 비교
const VRange = require('./lib/vrange');         // 🔍 상대의 프리플랍 행동 → 들고 있을 만한 패의 무게
const FlopSolve = require('./lib/flopsolve');   // 🧮 솔버로 미리 풀어 둔 플랍 전략 조회
const RiverSolve = require('./lib/riversolve'); // 🌊 리버를 범위 대 범위로 그 자리에서 푼다
const RangeTrack = require('./lib/rangetrack'); // 🧭 리버까지 쳐 온 행동으로 양쪽 범위를 만든다
// 고수 봇의 블라인드 방어에 범위표를 쓸지. 📊 맞대결 실측(2026-10-09, 100bb 하드 봇 5명, 각 약 3만 핸드, BOT_AB6):
//   범위표 봇 +27.2 vs 예전 봇 −0.6 bb/100, 우승 50:39. 플랍을 솔버 자료로 치기 전에는 넓은 방어가 −9.9 vs +37.1 로 해로웠다(위 botDecide 주석).
const BOT_CHART_DEFAULT = true;
// 고수 봇이 턴에도 솔버 자료를 쓸지. 📊 맞대결(턴 자료를 쓰는 봇 − 안 쓰는 봇, bb/100, 테이블별 표준오차):
//   ① −27.6 ± 16.3 (6만 핸드, 턴 자료 22보드) ② −9.9 ± 7.7 (15만 핸드, 22보드) ③ +11.3 ± 9.3 (12만 핸드, 솔버를 멈추고 · 턴 자료 995개 상황 전부)
//   어느 것도 오차를 뚜렷이 넘지 못했다 — 예전에 "해롭다"고 본 것은 근거가 약했다. 자료를 넓힌 지금 구성(③)에서 해롭다는 증거가 없어 켠다(2026-10-10).
//   조언대로 치는 가상 플레이어도 턴 조언 켬 − 끔 = 헤즈업 −0.6 ± 5.8 · 6인 −12.6 ± 14.1 로 차이가 확인되지 않았다.
const BOT_TURN_DEFAULT = true;
// 🧨 봇이 푸시/리쉬브를 "직접 푼 균형"(lib/jam.js)으로 칠지 — 예전 어림표(lib/shortstack.js)와의 맞대결 스위치는 BOT_AB10.
//   측정(2026-10-11, 20bb 시작 · 1분 레벨 · 24테이블 277,175핸드): 새 − 옛 = +0.5 ± 2.6 bb/100 — 차이가 확인되지 않았다(해롭지도 않다).
//   조언·채점·문제와 같은 계산을 쓰게 하려고 켠다.
const BOT_JAM_DEFAULT = true;
const OPEN_PRIOR = {};                          // 자리별 오픈 범위(패마다 여는 확률) — jamInfo 가 채워 쓴다
const BOT_RIVER_DEFAULT = false;                // 고수 봇이 리버 계산을 쓸지 — 맞대결 측정 전(botV9)
const GtoAdvice = require('./lib/gtoadvice');   // 🎓 학습모드 조언 — 상대 수·포지션·스택 깊이별
const Quiz = require('./lib/gtoquiz');          // 🧠 GTO 문제 학습
// 칭호는 화면에 그대로 찍히는 문구라 id 대신 문구를 내려보낸다 (클라이언트에 카탈로그 사본을 두지 않으려고)
// ⚠️ COSMETICS 는 평범한 객체라 COSMETICS['__proto__'] 같은 상속 키가 걸려든다.
//    클라이언트가 보낸 id 는 반드시 이 함수로만 조회할 것 (자기 소유 키만 통과).
function cosItem(id) {
    if (typeof id !== 'string') return null;
    return Object.prototype.hasOwnProperty.call(COSMETICS, id) ? COSMETICS[id] : null;
}
function cosTitleText(id) { const it = cosItem(id); return (it && it.text) || ''; }

// 🎨 꾸미기 레코드 정규화 — 구버전 계정/손상된 값이 들어와도 항상 온전한 형태를 돌려준다.
function normalizeCosmetics(u) {
    const c = (u.cosmetics && typeof u.cosmetics === 'object') ? u.cosmetics : {};
    if (!Array.isArray(c.owned)) c.owned = [];
    // 기본 지급품은 항상 보유 상태
    Object.values(COSMETIC_DEFAULTS).forEach(id => { if (!c.owned.includes(id)) c.owned.push(id); });
    // 카탈로그에서 사라진 id 는 버린다
    c.owned = c.owned.filter(id => cosItem(id));
    ['back', 'avatar', 'title'].forEach(kind => {
        const cur = c[kind];
        const cit = cosItem(cur);
        const ok = cit && cit.kind === kind && c.owned.includes(cur);
        if (!ok) c[kind] = COSMETIC_DEFAULTS[kind];
    });
    // 📷 사진 아바타는 owned 목록이 아니라 "사진이 실제로 있느냐"로 판정한다
    if (c.avatar === 'av_photo' && !hasPhoto(u)) c.avatar = 'av_none';

    // 🏅 테두리는 등급이 곧 소유권이다. 한 번도 직접 고른 적이 없으면(frameAuto)
    //    등급이 오를 때마다 가장 높은 테두리로 알아서 갈아 끼워준다.
    const maxRank = rankIndexOf(u);
    const fit = cosItem(c.frame);
    const frameOk = fit && fit.kind === 'frame' && fit.rank <= maxRank;
    if (c.frameAuto !== false || !frameOk) {
        c.frame = RANKS[maxRank].frame;
        if (c.frameAuto === undefined) c.frameAuto = true;
    }
    u.cosmetics = c;
    return c;
}
function hasPhoto(u) { return !!(u && u.photo && u.photo.b64); }

// 🤖 봇도 밋밋하지 않게 — 이름에서 뽑은 고정 값으로 뒷면/아바타를 준다 (구매와 무관한 연출).
const BOT_BACKS = ['back_classic', 'back_verm', 'back_jade', 'back_noir', 'back_peony'];
const BOT_AVATARS = ['av_fox', 'av_cat', 'av_owl', 'av_wolf', 'av_shark'];
function botCosmetics(nick) {
    let h = 0;
    for (let i = 0; i < nick.length; i++) h = (h * 31 + nick.charCodeAt(i)) >>> 0;
    return { back: BOT_BACKS[h % BOT_BACKS.length], avatar: BOT_AVATARS[(h >>> 5) % BOT_AVATARS.length], title: '', frame: 'fr_none', ph: 0 };
}

const app = express();
// 🛡️ Render 등은 앞단 프록시를 거친다. 이걸 켜야 req.ip / req.secure 가 실제 값이 된다.
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server);

// 🩺 헬스체크 / 킵얼라이브 — UptimeRobot가 5분마다 가볍게 노크해 무료 인스턴스가 잠들지 않게 (271KB HTML 대신 "ok"만 응답)
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// 🛗 승강설비 현장조회 — /manual 만 Basic 인증 (MANUAL_USER / MANUAL_PASS).
//    환경변수 미설정 시 503으로 막히고 포커 게임(/)은 그대로 인증 없이 열린다.
app.use('/manual', require('./manual'));

app.use(express.static(path.join(__dirname, 'public')));

// 📷 [프로필 사진] /avatar/<닉네임>?v=<버전>
//    ⚠️ 사용자가 올린 바이트를 그대로 돌려주는 곳이다. 업로드 때 매직바이트로 이미지인지 확인하고,
//       여기선 nosniff + sandbox 로 브라우저가 HTML/스크립트로 해석할 여지를 없앤다.
app.get('/avatar/:nick', (req, res) => {
    let nick = '';
    try { nick = decodeURIComponent(req.params.nick || ''); } catch (e) { return res.status(400).end(); }
    const u = MockDB.users.get(nick);
    if (!u || !u.photo || !u.photo.b64) return res.status(404).end();
    let buf;
    try { buf = Buffer.from(u.photo.b64, 'base64'); } catch (e) { return res.status(404).end(); }
    res.set('Content-Type', u.photo.mime || 'image/jpeg');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'inline');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // 버전이 바뀌면 URL이 바뀐다
    res.send(buf);
});

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
// 🛡️ 관리자 비밀번호 확인 — 게임 로그인과 /admin 로그인 폼이 같이 쓴다.
//    ADMIN_PASS 환경변수가 있으면 그 값, 없으면 admin 계정에 처음 등록된 비밀번호(해시).
function verifyAdmin(pin) {
    const { safeEqual } = require('./lib/adminauth');
    if (typeof pin !== 'string' || !pin) return false;
    if (process.env.ADMIN_PASS) return safeEqual(pin, process.env.ADMIN_PASS);
    const au = MockDB.users.get(ADMIN_NICK);
    if (!au || !au.pinHash || !isValidPin(pin)) return false;
    return safeEqual(au.pinHash, hashPin(pin));
}
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

// 📋 [접속 기록] 관리자 페이지에서 보는 로그. 전적 DB 와 파일을 분리한다 —
//    로그는 자주 쌓이고 성격도 달라서(개인정보 포함) 같이 두면 서로 발목을 잡는다.
const ACCESS_FILE = path.join(DATA_DIR, 'access_log.json');
const { AccessLog, shortUA } = require('./lib/accesslog');
const accessLog = new AccessLog({ max: 3000, maxAgeMs: 60 * 24 * 3600 * 1000 });
try {
    if (fs.existsSync(ACCESS_FILE)) {
        accessLog.load(JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8')));
        console.log(`📋 접속 기록 로드: ${accessLog.events.length}건`);
    }
} catch (e) { console.error('접속 기록 로드 실패:', e.message); }

// 🌐 [버그픽스] 접속 기록이 배포할 때마다 사라졌다. 로컬 파일에만 저장했는데, 무료 호스팅은 영구 디스크가 없어
//    재배포·재시작마다 파일이 초기화되기 때문이다(전적 DB 는 이미 원격에 저장해서 멀쩡했다).
//    → 전적 DB 와 같은 원격 저장소에 'access_log' 키로 따로 저장한다. (저장소는 비공개 DB — 깃에는 올라가지 않는다)
//    전적과 같은 안전 규칙: 원격 로드에 성공하기 전에는 원격에 쓰지 않는다(빈 기록으로 덮어쓰는 사고 방지).
const accessRemote = createRemoteStorage('access_log');
let _accessRemoteOk = false, _accessPushing = false, _accessPushAgain = false;
function pushAccessRemote() {
    if (!accessRemote || !_accessRemoteOk) return;
    if (_accessPushing) { _accessPushAgain = true; return; }
    _accessPushing = true;
    accessRemote.save(JSON.stringify(accessLog.toJSON()))
        .catch(e => console.error('🌐 접속 기록 원격 저장 실패(다음 저장 때 재시도):', e.message))
        .finally(() => { _accessPushing = false; if (_accessPushAgain) { _accessPushAgain = false; pushAccessRemote(); } });
}
async function initAccessRemote() {
    if (!accessRemote) return;
    try {
        const json = await accessRemote.load();
        const before = accessLog.events.length;
        if (json) accessLog.merge(JSON.parse(json));
        _accessRemoteOk = true;
        console.log(`🌐 접속 기록 원격 로드: ${accessLog.events.length}건 (서버 시작 후 쌓인 ${before}건 포함)`);
        accessLog.dirty = true;
        flushAccessLog();
    } catch (e) {
        console.error(`🌐 접속 기록 원격 로드 실패(${e.message}) — 30초 후 재시도. 성공 전까지 원격 저장은 비활성.`);
        setTimeout(initAccessRemote, 30000);
    }
}
async function flushAccessRemoteNow(timeoutMs = 3000) {
    if (!accessRemote || !_accessRemoteOk) return;
    await Promise.race([
        accessRemote.save(JSON.stringify(accessLog.toJSON())),
        new Promise(res => setTimeout(res, timeoutMs))
    ]).catch(e => console.error('🌐 종료 시 접속 기록 원격 저장 실패:', e.message));
}

// 기록할 때마다 디스크를 때리면 손해라 15초마다 모아서 쓴다.
function flushAccessLog() {
    if (!accessLog.dirty) return;
    accessLog.dirty = false;
    try {
        const tmp = ACCESS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(accessLog.toJSON()));
        fs.renameSync(tmp, ACCESS_FILE); // 원자적 교체
    } catch (e) { console.error('접속 기록 저장 실패:', e.message); }
    pushAccessRemote();
}
setInterval(flushAccessLog, 15000);
initAccessRemote();

// 소켓에서 진짜 접속 IP 뽑기 (프록시를 거치면 handshake.address 는 프록시 주소다)
function socketIp(socket) {
    try {
        const h = socket.handshake || {};
        const xf = (h.headers && h.headers['x-forwarded-for']) || '';
        let ip = xf ? String(xf).split(',')[0].trim() : (h.address || '');
        if (ip.startsWith('::ffff:')) ip = ip.slice(7);
        if (ip === '::1') ip = '127.0.0.1';
        return ip;
    } catch (e) { return ''; }
}

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
    // 💾 원격 영속화 (Turso) — env 미설정이면 null (로컬 파일만)
    _remote: createRemoteStorage(),
    _remoteLoadOk: false,   // ⚠️ 원격 로드 성공 전엔 절대 원격에 쓰지 않음 (빈 데이터 덮어쓰기 방지)
    _remotePushing: false,  // 푸시 직렬화 (동시 upsert 방지)
    _remoteDirty: false,    // 푸시 중 새 변경 발생 시 재푸시 예약

    // 🧹 [통계 기점] 운영자 요청(2026-10-06)으로 플레이 통계를 이 시점부터 새로 센다.
    //    · 0으로 돌리는 것: 핸드 수·승수, VPIP/PFR 등 지표, GTO 점수, 실수 유형·치명적 플레이, 일별 기록, 학습 모드 통계
    //    · 그대로 두는 것: 뱅크롤, 우승·토큰·코어, 꾸미기, 업적, 상대전적, 컴까기·런 진행, 문제 풀이 기록
    //    · 이전 값은 지우지 않고 statsArchive 에 보관한다(되돌릴 수 있게). 계정마다 한 번만 적용된다.
    STATS_EPOCH: '2026-10-11',    // 운영자 요청으로 실력 점수를 새로 시작(대회 연습 점수 포함 — 상금 기준(ICM) 채점을 넣은 날). 앞선 기점: 2026-10-09(EV 손실 방식 도입)
    // 🧹 배포 점검 스크립트(scratch/livecheck.js)가 만든 계정(이름이 "배포확인"으로 시작)을 지운다. 부팅 때마다 돌아서 점검 계정이 쌓이지 않는다.
    purgeCheckAccounts() {
        let n = 0;
        Array.from(this.users.keys()).forEach(k => {
            if (!k.startsWith('배포확인')) return;
            const u = this.users.get(k);
            if (u && u.deviceId && this.deviceOwners.get(u.deviceId) === k) this.deviceOwners.delete(u.deviceId);
            this.users.delete(k); n++;
        });
        if (n) { console.log(`🧹 배포 점검 계정 ${n}개 삭제`); this.save(); }
        return n;
    },
    STAT_FIELDS: ['handsPlayed', 'handsWon', 'vpipHands', 'preflopOpps', 'pfrHands', 'threeBetCount', 'threeBetOpps', 'aggrBets', 'aggrCalls',
        'foldToBet', 'faceBet', 'wentToShowdown', 'wonAtShowdown', 'gtoScoreSum', 'gtoScoreCount', 'gtoW', 'seatSum', 'seatCnt', 'netBB', 'netHands'],
    // 🪑 인원 보정 값(evLossN)이 생기기 전에 쌓인 기록을 한 번 맞춰 준다 — 평균 인원으로 환산해 채운다(판별 인원은 남아 있지 않아 근사).
    migrateEvNorm() {
        let n = 0;
        const fix = (t, avgSeats) => {
            if (!t || !(t.evHands > 0) || t.evLossN != null) return;
            const k = Math.max(2, Math.min(6, avgSeats || 6)) / 6;
            t.evLossN = Math.round((t.evLoss || 0) * k * 1e4) / 1e4; t.evLossNSq = Math.round((t.evLossSq || 0) * k * k * 1e4) / 1e4;
            t.evSeats = Math.round((avgSeats || 6) * t.evHands); n++;
        };
        this.users.forEach(u => {
            if (!u || !u.nickname) return;
            const avg = t => (t && t.seatCnt > 0 ? t.seatSum / t.seatCnt : (u.seatCnt > 0 ? u.seatSum / u.seatCnt : 6));
            fix(u, avg(u));
            Object.values(u.dailyLog || {}).forEach(d => fix(d, avg(d)));
            fix(u.learnStats, avg(u.learnStats));
        });
        if (n) { console.log(`🪑 인원 보정: 기록 ${n}묶음을 6인 기준으로 환산해 채움`); this.save(); }
        return n;
    },
    applyStatsEpoch() {
        let n = 0;
        this.users.forEach(u => {
            if (!u || !u.nickname || u.nickname.startsWith('🤖') || u.statsEpoch === this.STATS_EPOCH) return;
            const totals = {};
            this.STAT_FIELDS.forEach(k => { if (u[k]) totals[k] = u[k]; u[k] = 0; });
            Object.keys(u).filter(k => k.startsWith('lk') || k.startsWith('gq') || k.startsWith('ev') || k.startsWith('fq')).forEach(k => { totals[k] = u[k]; delete u[k]; });
            delete u.recentDec;
            const had = Object.keys(totals).length || (u.dailyLog && Object.keys(u.dailyLog).length);
            if (had) {
                u.statsArchive = (Array.isArray(u.statsArchive) ? u.statsArchive : []).slice(-1);
                u.statsArchive.push({ until: this.STATS_EPOCH, at: Date.now(), totals, dailyLog: u.dailyLog || {} });
            }
            if (u.fnStats && Object.keys(u.fnStats).length) { totals.fnStats = u.fnStats; if (!had) { u.statsArchive = (Array.isArray(u.statsArchive) ? u.statsArchive : []).slice(-1); u.statsArchive.push({ until: this.STATS_EPOCH, at: Date.now(), totals, dailyLog: {} }); } }
            { const keep = {}; Object.keys(u.fnStats || {}).filter(k => /^fn(Games|PlaceSum|Itm|Wins)$/.test(k)).forEach(k => { keep[k] = u.fnStats[k]; }); u.fnStats = keep; }   // 대회 연습 점수도 새로 시작 — 대회 성적(나간 횟수·입상·순위)과 결과 목록·복기는 그대로
            u.dailyLog = {};
            u.blunders = [];
            u.learnStats = {};
            delete u.quizMine;
            u.statsEpoch = this.STATS_EPOCH;
            n++;
        });
        if (n) { console.log(`🧹 통계 기점(${this.STATS_EPOCH}) 적용: ${n}개 계정의 플레이 통계를 새로 시작 (이전 값은 statsArchive 에 보관)`); this.save(); }
        return n;
    },

    // 🌐 원격 로드 — 부팅 시 1회 호출. 원격에 데이터가 있으면 그것이 진실(로컬 덮어씀).
    //    원격이 비어있으면(최초 연결) 현재 로컬 데이터를 원격에 올려 시드한다.
    //    로드 실패 시 30초 간격 재시도 — 성공할 때까지 원격 쓰기는 잠긴 상태 유지.
    async initRemote() {
        if (!this._remote) return;
        try {
            const json = await this._remote.load();
            if (json) {
                const raw = JSON.parse(json);
                this.users.clear();
                this.deviceOwners.clear();
                Object.values(raw).forEach(u => { if (u && u.nickname) this.users.set(u.nickname, u); });
                this.users.forEach(u => { if (u.deviceId) this.deviceOwners.set(u.deviceId, u.nickname); });
                console.log(`🌐 원격 전적 DB 로드(Turso): ${this.users.size}명 — 원격이 기준으로 적용됨`);
                // 원격 기준 데이터를 로컬 파일에도 반영 (아래 flush가 다시 원격 푸시하지만 내용 동일 — 무해)
                this._remoteLoadOk = true;
                this.purgeCheckAccounts(); this.applyStatsEpoch(); this.migrateEvNorm();
                this.flush();
            } else {
                // 최초 연결: 원격이 빔 → 로컬 데이터로 시드
                this._remoteLoadOk = true;
                console.log(`🌐 원격 전적 DB 최초 연결 — 로컬 ${this.users.size}명 데이터를 원격에 시드합니다`);
                this._pushRemote();
            }
        } catch (e) {
            console.error(`🌐 원격 전적 DB 로드 실패(${e.message}) — 30초 후 재시도. 성공 전까지 원격 저장은 비활성.`);
            setTimeout(() => this.initRemote(), 30000);
        }
    },

    // 🌐 원격 푸시 (fire-and-forget, 직렬화) — flush()에서 호출됨
    _pushRemote() {
        if (!this._remote || !this._remoteLoadOk) return; // ⚠️ 로드 성공 전 쓰기 금지
        if (this._remotePushing) { this._remoteDirty = true; return; }
        this._remotePushing = true;
        const obj = {};
        this.users.forEach((u, k) => { obj[k] = u; });
        const json = JSON.stringify(obj);
        this._remote.save(json)
            .catch(e => console.error('🌐 원격 저장 실패(다음 flush에서 재시도):', e.message))
            .finally(() => {
                this._remotePushing = false;
                if (this._remoteDirty) { this._remoteDirty = false; this._pushRemote(); }
            });
    },

    // 🌐 종료 시 원격 저장 완료 대기 (타임아웃 포함) — gracefulShutdown 에서 사용
    async flushRemoteNow(timeoutMs = 3000) {
        if (!this._remote || !this._remoteLoadOk) return;
        const obj = {};
        this.users.forEach((u, k) => { obj[k] = u; });
        const json = JSON.stringify(obj);
        await Promise.race([
            this._remote.save(json),
            new Promise(res => setTimeout(res, timeoutMs))
        ]).catch(e => console.error('🌐 종료 원격 저장 실패:', e.message));
    },
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
        // ⚡ 0.8초 → 3초: 저장은 전적 전체(1MB 넘음)를 한 번에 쓰느라 그동안 서버가 멈춘다. 액션마다 0.8초 뒤에 멈추면 다음 사람 버튼이 씹힌다.
        //    (종료 신호를 받으면 즉시 저장하므로 재배포 때 잃지 않는다)
        this._saveTimer = setTimeout(() => this.flush(), 3000);
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
        // 🌐 로컬 저장 후 원격(Turso)에도 푸시 (비동기, 로드 성공 전엔 자동 무시)
        try { this._pushRemote(); } catch (e) {}
    },
    async getUser(nickname) {
        if (!this.users.has(nickname)) {
            this.users.set(nickname, {
                nickname, totalChips: 100000, wins: 0,
                handsPlayed: 0, handsWon: 0, biggestPot: 0, vpipHands: 0,
                achievements: [], seasonId: CURRENT_SEASON, seasonPoints: 0,
                cashNet: 0, bestRank: '',
                pinHash: null, bankroll: 100000, deviceId: null,
                cosmetics: { owned: [], back: 'back_classic', avatar: 'av_none', title: 'ti_none', frame: 'fr_none', frameAuto: true }, // 🎨 꾸미기
                peakBankroll: 100000, // 🏅 등급 판정용 — 지금까지 모았던 최고 뱅크롤
                tokens: START_TOKENS, // 🏆 우승 토큰 — 꾸미기는 이걸로만 산다
                cores: START_TOKENS,  // 🔷 코어 — 컴까기에서만 얻는다 (개발용 시작값은 토큰과 같은 스위치를 쓴다)
                photo: null,          // 📷 직접 올린 프로필 사진 {b64, mime, ver}
                h2h: {},              // ⚔️ 상대별 쇼다운 전적 {닉: {w, l}}
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
                gtoScoreCount: 0,   // GTO 평가 횟수
                statsEpoch: this.STATS_EPOCH
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
        // 🏅 등급: 예전 계정은 최고 기록을 남긴 적이 없다. 다들 10만으로 시작했으니
        //    최소 10만은 찍었다고 보고, 지금 잔고가 그보다 크면 그 값을 쓴다.
        if (typeof u.peakBankroll !== 'number') u.peakBankroll = Math.max(u.bankroll || 0, 100000);
        if (u.photo === undefined) u.photo = null;                                 // 📷 프로필 사진
        // 🏆 토큰은 우승할 때마다 1개. 이 기능이 생기기 전에 한 우승도 인정해 소급 지급한다.
        if (typeof u.tokens !== 'number') u.tokens = (u.wins || 0) + (u.mttWins || 0);
        // 🔷 코어가 생기기 전에 깬 단계도 인정한다 (첫 클리어 = 단계 번호만큼 → 1+2+…+best)
        if (typeof u.cores !== 'number') u.cores = Challenge.progressOf(u).cleared.reduce((a, n) => a + n, 0);
        if (!u.h2h || typeof u.h2h !== 'object') u.h2h = {};                       // ⚔️ 상대전적
        normalizeCosmetics(u); // 🎨 꾸미기 — 구버전/손상 레코드 복구
        // 📊 포커 분석 지표 마이그레이션
        ['pfrHands','preflopOpps','threeBetCount','threeBetOpps','aggrBets','aggrCalls',
         'foldToBet','faceBet','wentToShowdown','wonAtShowdown','gtoScoreSum','gtoScoreCount','gtoW']
            .forEach(k => { if (u[k] === undefined) u[k] = 0; });
        // 🏆 시즌 롤오버: 시즌이 바뀌면 시즌 포인트 리셋
        if (u.seasonId !== CURRENT_SEASON) { u.seasonId = CURRENT_SEASON; u.seasonPoints = 0; }
        if (u.seasonPoints === undefined) u.seasonPoints = 0;
        return u;
    },
    // ⚔️ [상대전적] 이긴 사람/진 사람 양쪽 레코드에 한 번씩 적는다.
    recordH2H(winner, loser) {
        if (!winner || !loser || winner === loser) return;
        const w = this.users.get(winner), l = this.users.get(loser);
        if (!w || !l) return;
        if (!w.h2h || typeof w.h2h !== 'object') w.h2h = {};
        if (!l.h2h || typeof l.h2h !== 'object') l.h2h = {};
        const a = w.h2h[loser] || (w.h2h[loser] = { w: 0, l: 0 });
        const b = l.h2h[winner] || (l.h2h[winner] = { w: 0, l: 0 });
        a.w++; b.l++;
    },
    async addWin(nickname, giveToken) {
        if (typeof nickname === 'string' && nickname.startsWith('🤖')) return; // 봇 제외
        const user = await this.getUser(nickname);
        user.wins = (user.wins || 0) + 1;
        if (giveToken) user.tokens = (user.tokens || 0) + 1; // 🏆 우승 토큰 (사람 3명 이상일 때만)
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
            gtoW: u.gtoW || 0,
            achievements: (u.achievements || []).slice(),
            seasonPoints: u.seasonPoints || 0,
            seatSum: u.seatSum || 0, seatCnt: u.seatCnt || 0,
            // 실수 유형별 누적 (lkN_*, lkB_*)
            ...Object.fromEntries(Object.keys(u).filter(k => k.startsWith('lk') || k.startsWith('gq') || k.startsWith('ev') || k.startsWith('fq')).map(k => [k, u[k] || 0]))
        };
    },
    // 📅 [일/주/월 리포트] 지정 범위(일수)의 dailyLog를 합산
    aggregateRange(user, days) {
        const log = user.dailyLog || {};
        const now = new Date();
        const sum = { handsPlayed: 0, handsWon: 0, vpipHands: 0, preflopOpps: 0, pfrHands: 0, threeBetCount: 0, threeBetOpps: 0, aggrBets: 0, aggrCalls: 0, foldToBet: 0, faceBet: 0, wentToShowdown: 0, wonAtShowdown: 0, gtoScoreSum: 0, gtoScoreCount: 0, gtoW: 0 };
        const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
        Object.keys(log).forEach(key => {
            const [y, m, dd] = key.split('-').map(Number);
            const dt = new Date(y, m - 1, dd);
            if (dt >= cutoff) {
                const day = log[key];
                Object.keys(sum).forEach(f => { sum[f] += (day[f] || 0); });
                Object.keys(day).forEach(f => { if (f.startsWith('lk') || f.startsWith('gq') || f.startsWith('ev') || f.startsWith('fq') || f === 'seatSum' || f === 'seatCnt' || f === 'netBB' || f === 'netHands') sum[f] = (sum[f] || 0) + (day[f] || 0); });
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
            user.dailyLog[key] = { handsPlayed: 0, handsWon: 0, vpipHands: 0, preflopOpps: 0, pfrHands: 0, threeBetCount: 0, threeBetOpps: 0, aggrBets: 0, aggrCalls: 0, foldToBet: 0, faceBet: 0, wentToShowdown: 0, wonAtShowdown: 0, gtoScoreSum: 0, gtoScoreCount: 0, gtoW: 0, netChips: 0 };
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
            const L = this.statBox(user, isLearn);
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
    async addMttWin(nickname, entrants, giveToken) {
        if (typeof nickname === 'string' && nickname.startsWith('🤖')) return;
        const user = await this.getUser(nickname);
        user.mttWins = (user.mttWins || 0) + 1;
        if (giveToken) user.tokens = (user.tokens || 0) + 1; // 🏆 우승 토큰 (사람 3명 이상일 때만)
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
            const L = this.statBox(u, isLearn);
            if (ev.preflopOpp) L.preflopOpps = (L.preflopOpps||0)+1;
            if (ev.seats) { L.seatSum = (L.seatSum||0)+ev.seats; L.seatCnt = (L.seatCnt||0)+1; }
            if (ev.pfr) L.pfrHands = (L.pfrHands||0)+1;
            if (ev.threeBetOpp) L.threeBetOpps = (L.threeBetOpps||0)+1;
            if (ev.threeBet) L.threeBetCount = (L.threeBetCount||0)+1;
            if (ev.aggrBet) L.aggrBets = (L.aggrBets||0)+1;
            if (ev.aggrCall) L.aggrCalls = (L.aggrCalls||0)+1;
            if (ev.faceBet) L.faceBet = (L.faceBet||0)+1;
            if (ev.foldToBet) L.foldToBet = (L.foldToBet||0)+1;
            if (typeof ev.gtoScore === 'number') { const w = ev.gtoWeight || 1; L.gtoScoreSum = (L.gtoScoreSum||0)+ev.gtoScore*w; L.gtoW = (L.gtoW||0)+w; L.gtoScoreCount = (L.gtoScoreCount||0)+1; }
            this._gqFields(ev).forEach(([k, v]) => { L[k] = Math.round(((L[k] || 0) + v) * 100) / 100; });
            this.save();
            return;
        }
        const daily = {};
        if (ev.preflopOpp) { u.preflopOpps++; daily.preflopOpps = 1; }
        if (ev.seats) { u.seatSum = (u.seatSum || 0) + ev.seats; u.seatCnt = (u.seatCnt || 0) + 1; daily.seatSum = ev.seats; daily.seatCnt = 1; }
        if (ev.pfr) { u.pfrHands++; daily.pfrHands = 1; }
        if (ev.threeBetOpp) { u.threeBetOpps++; daily.threeBetOpps = 1; }
        if (ev.threeBet) { u.threeBetCount++; daily.threeBetCount = 1; }
        if (ev.aggrBet) { u.aggrBets++; daily.aggrBets = 1; }
        if (ev.aggrCall) { u.aggrCalls++; daily.aggrCalls = 1; }
        if (ev.faceBet) { u.faceBet++; daily.faceBet = 1; }
        if (ev.foldToBet) { u.foldToBet++; daily.foldToBet = 1; }
        if (typeof ev.gtoScore === 'number') { const w = ev.gtoWeight || 1; u.gtoScoreSum += ev.gtoScore * w; u.gtoW = (u.gtoW || 0) + w; u.gtoScoreCount++; daily.gtoScoreSum = ev.gtoScore * w; daily.gtoW = w; daily.gtoScoreCount = 1; }
        this._gqFields(ev).forEach(([k, v]) => { u[k] = Math.round(((u[k] || 0) + v) * 100) / 100; daily[k] = v; });
        this._bumpDaily(u, daily);
        this.save();
    },
    // 💥 실수 한 건 기록 — 유형별 횟수·손실(bb) 누적 + 손실이 큰 플레이는 상황째로 보관. 보관한 기록 객체를 돌려준다(핸드가 끝나면 결과를 덧붙임).
    recordBlunder(nickname, rec, kind, costBB, isLearn) {
        if (typeof nickname !== 'string' || nickname.startsWith('🤖')) return null;
        const u = this.users.get(nickname);
        if (!u) return null;
        const nK = 'lkN_' + kind, bK = 'lkB_' + kind;
        if (isLearn) {
            const L = this.statBox(u, isLearn);
            L[nK] = (L[nK] || 0) + 1; L[bK] = Math.round(((L[bK] || 0) + costBB) * 100) / 100;
            if (rec) L.blunders = Blunder.add(L.blunders, rec);
        } else {
            u[nK] = (u[nK] || 0) + 1; u[bK] = Math.round(((u[bK] || 0) + costBB) * 100) / 100;
            this._bumpDaily(u, { [nK]: 1, [bK]: costBB });
            if (rec) u.blunders = Blunder.add(u.blunders, rec);
        }
        this.save();
        return rec;
    },
    // 🗂️ 통계 상자: isLearn 이 'fn' 이면 파이널나인 연습 전용(fnStats), 그 밖의 참이면 학습 모드(learnStats).
    //    두 상자 모두 본 기록(실력 점수·랭킹)과 섞이지 않는다.
    statBox(u, isLearn) {
        const k = isLearn === 'fn' ? 'fnStats' : 'learnStats';
        return u[k] || (u[k] = {});
    },
    // 🏁 [파이널나인 연습] 대회 한 번의 결과(순위)를 남긴다 — 최근 60번
    recordFnResult(nickname, r) {
        const u = this.users.get(nickname);
        if (!u || typeof nickname !== 'string' || nickname.startsWith('🤖')) return;
        const F = this.statBox(u, 'fn');
        F.fnGames = (F.fnGames || 0) + 1; F.fnPlaceSum = (F.fnPlaceSum || 0) + r.place;
        if (r.place <= r.paid) F.fnItm = (F.fnItm || 0) + 1;
        if (r.place === 1) F.fnWins = (F.fnWins || 0) + 1;
        u.fnResults = (Array.isArray(u.fnResults) ? u.fnResults : []).concat([r]).slice(-60);
        const rv = (u.fnReviews || []).find(x => x.id === r.id);
        if (rv) { rv.place = r.place; rv.agreed = !!r.agreed; }
        this.save();
    },
    // 🎞️ [대회 복기] 연습 대회에서 친 판을 결정째로 남긴다 — 최근 3개 대회, 대회당 400판까지.
    //    쓰레기 패를 맞게 접은 판처럼 볼 것이 없는 판은 개수만 센다(trivial).
    recordFnHand(nickname, mttId, rec, trivial) {
        const u = this.users.get(nickname);
        if (!u || typeof nickname !== 'string' || nickname.startsWith('🤖')) return;
        if (!Array.isArray(u.fnReviews)) u.fnReviews = [];
        let rv = u.fnReviews.find(x => x.id === mttId);
        if (!rv) { rv = { id: mttId, t: Date.now(), hands: [], skipped: 0, played: 0 }; u.fnReviews.push(rv); u.fnReviews = u.fnReviews.slice(-3); }
        rv.played = (rv.played || 0) + 1;
        if (trivial) rv.skipped = (rv.skipped || 0) + 1;
        else if (rv.hands.length < 400) { rec.n = rv.played; rv.hands.push(rec); }
        this.save();
    },
    // 📉 EV 손실 집계 — 이름이 ev 로 시작하는 칸에 더한다(일별 기록에도). 판 단위(evLoss·evLossSq·evHands)와 결정 단위(evG_등급·evC_스트리트·evS_스트리트)를 같이 쓴다.
    recordEv(nickname, fields, isLearn) {
        const u = this.users.get(nickname);
        if (!u || typeof nickname !== 'string' || nickname.startsWith('🤖')) return;
        const box = isLearn ? this.statBox(u, isLearn) : u;
        const daily = {};
        Object.keys(fields).forEach(k => {
            const v = fields[k];
            if (!Number.isFinite(v) || v === 0) return;
            box[k] = Math.round(((box[k] || 0) + v) * 1e4) / 1e4; daily[k] = v;
        });
        if (!isLearn) this._bumpDaily(u, daily);
    },
    // 🔎 점수의 근거로 보여줄 세부 집계 — 스트리트별(가중 합·가중치·건수), 점수 구간별 건수, 점수에서 뺀 뻔한 폴드 수
    _gqFields(ev) {
        const out = [];
        if (ev.gtoEasy) out.push(['gqEasy', 1]);
        if (typeof ev.gtoScore !== 'number') return out;
        const w = ev.gtoWeight || 1, st = ev.gtoStreet || 'preflop';
        out.push(['gqS_' + st, ev.gtoScore * w], ['gqW_' + st, w], ['gqC_' + st, 1]);
        out.push(['gqN_' + (ev.gtoScore >= 95 ? 'best' : ev.gtoScore >= 60 ? 'ok' : ev.gtoScore >= 30 ? 'weak' : 'bad'), 1]);
        return out;
    },
    // 📒 실제 성적 — 한 판에서 칩이 얼마나 늘거나 줄었나(bb). 실력 점수가 실제 결과와 같은 방향인지 견주어 보려고 쌓는다.
    recordNet(nickname, netBB, isLearn) {
        const u = this.users.get(nickname);
        if (!u || nickname.startsWith('🤖') || !Number.isFinite(netBB)) return;
        if (isLearn) { const L = this.statBox(u, isLearn); L.netBB = Math.round(((L.netBB || 0) + netBB) * 10) / 10; L.netHands = (L.netHands || 0) + 1; return; }
        u.netBB = Math.round(((u.netBB || 0) + netBB) * 10) / 10; u.netHands = (u.netHands || 0) + 1;
        this._bumpDaily(u, { netBB, netHands: 1 });
    },
    // 최근 결정 기록(계정당 40건) — "이 결정이 몇 점이었나"를 본인이 직접 확인할 수 있게
    recordDecision(nickname, rec, isLearn) {
        const u = this.users.get(nickname);
        if (!u || nickname.startsWith('🤖')) return;
        const box = isLearn ? this.statBox(u, isLearn) : u;
        box.recentDec = (Array.isArray(box.recentDec) ? box.recentDec : []).concat([rec]).slice(-40);
    },
    async recordShowdownStat(nickname, won, isLearn) {
        if (typeof nickname !== 'string' || nickname.startsWith('🤖')) return;
        const u = await this.getUser(nickname);
        if (isLearn) {
            const L = this.statBox(u, isLearn);
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
        // 🏅 등급은 "최고로 모았던" 금액 기준 — 한 판 잃었다고 테두리가 사라지면 안 된다
        if (user.bankroll > (user.peakBankroll || 0)) user.peakBankroll = user.bankroll;
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
        bluff: ['내 패 궁금해? ㅋㅋ', '믿거나 말거나~', '느낌이 쎄하지?'],
        win: ['거봐 내가 먹는댔지 😎', '칩 잘 받았다 🤑', '이게 실력이다', '또 줍줍'],
        lose: ['에이 한 끗 차이네', '운 좋았다 인정', '다음 판 두고보자'],
        fold: ['이번엔 양보한다', '쓰레기패라 접는다 ㅋ', '오냐 가져가라'],
        tank: ['어허... 이거 애매한데', '너 뭐 들었냐', '재밌네 진짜 ㅋㅋ', '가? 말어?'],
        call: ['안 믿는다 콜', '그래 까봐', '뻥이지? 콜'],
        taunt: ['{nick} 뭐 해 빨리 좀', '고민 길다 ㅋㅋ 티 난다', '타이머 다 간다', '그거 접을 패다 그냥 접어라']
    },
    '루즈-어그레시브': {
        join: ['반갑다 잘 부탁해~', '오늘 운 좀 따라줘봐라', '재밌게 쳐보자'],
        bigbet: ['압박 좀 넣어볼까', '이 정도는 받아주지?', '슬슬 가속한다'],
        bluff: ['진짜일까 뻥일까~ 😏', '한번 따라와봐라', '감으로 가는 거다'],
        win: ['굿굿 잘 들어왔다 😁', '읽기 성공이네', '이 맛에 친다'],
        lose: ['아쉽다 잘 쳤다', '그 패를 콜하네 ㄷㄷ', '복수하러 온다'],
        fold: ['음 이건 접자', '다음 기회에', '여기까지 하자'],
        tank: ['흐음~ 어렵네 이거', '느낌이 좀 이상한데', '한 대 맞은 건가', '잠깐만 생각 좀'],
        call: ['궁금해서 콜', '따라가본다', '한번 믿어보지 뭐'],
        taunt: ['{nick} 오래 걸리네~', '좋은 패면 빨리 치지 ㅋ', '천천히 해라 기다려줄게', '표정 다 읽힌다']
    },
    '타이트-어그레시브': {
        join: ['정석대로 가보겠습니다', '잘 부탁드립니다', '깔끔하게 쳐봅시다'],
        bigbet: ['밸류 받으러 갑니다', '계산상 베팅합니다', '이 정도가 적정선이죠'],
        bluff: ['...', '블록 베팅입니다', '레인지상 베팅이에요'],
        win: ['잘 짜였네요 👍', '계산대로입니다', '좋은 핸드였습니다'],
        lose: ['좋은 콜이었어요', '어쩔 수 없죠', '분산이네요'],
        fold: ['폴드가 맞네요', '여기선 접습니다', '레인지상 접습니다'],
        tank: ['...잠시만요', '경계선이네요', '오즈가 빠듯합니다', '레인지를 좀 더 봐야겠네요'],
        call: ['오즈상 콜합니다', '받아보겠습니다', '블러프 빈도를 보면 콜이죠'],
        taunt: ['{nick} 님 시간 많이 쓰시네요', '어려운 스팟인가 보네요', '타이밍 텔 나옵니다', '천천히 하셔도 됩니다']
    },
    '콜링스테이션': {
        join: ['콜이 제맛이지~', '난 잘 안 접는다 ㅋㅋ', '끝까지 봐야지'],
        bigbet: ['그래도 콜!', '궁금하니까 본다', '에라 모르겠다'],
        bluff: ['음... 콜할까말까', '난 못 접어~'],
        win: ['콜이 답이었네 ㅋㅋ', '거봐 봐야된다니까', '럭키~'],
        lose: ['아 그래도 봤어야지', '미련 없다', '한번 더!'],
        fold: ['이건 진짜 못 가겠다', '오늘 처음 접는다 ㅋ'],
        tank: ['어... 이거 콜인가', '접을까... 아니 못 접겠다', '아 모르겠다 진짜', '심장 떨리네 ㅋㅋ'],
        call: ['콜! 봐야지', '못 참는다 콜', '어차피 볼 거 콜'],
        taunt: ['{nick} 빨리 쳐라~ 궁금해 죽겠다', '뭘 그리 고민하냐 ㅋㅋ', '나 같으면 벌써 콜했다']
    },
    '초타이트': {
        join: ['신중하게 가겠습니다', '...', '조용히 칩니다'],
        bigbet: ['확실할 때만 갑니다', '이건 너트급이죠'],
        bluff: ['...', '믿으셔도 됩니다'],
        win: ['기다린 보람이 있네요', '프리미엄 핸드였습니다'],
        lose: ['드물게 졌네요', '그럴 수 있죠'],
        fold: ['접습니다', '아닌 건 아니죠', '쉽게 폴드'],
        tank: ['...', '음.', '조금만 더 생각하겠습니다', '미묘하군요'],
        call: ['받겠습니다', '여기선 콜이죠'],
        taunt: ['...', '{nick} 님, 천천히 하세요', '긴 고민이네요']
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

// 🎯 프리플랍 GTO 레인지 로직 — lib/preflop.js 로 추출 (봇 botDecide + 학습모드 getGtoAdvice 가 같은 출처 공유)
const { handToCode, handRangeScore, openThreshold, preflopRangeTier, isInOpenRange } = require('./lib/preflop');

class GameRoom {
    constructor(roomId, settings) {
        this.roomId = roomId;
        // 💡 [수정 #7] 방 설정값 검증 (비정상 값으로 인한 게임 붕괴 방지)
        this.startingChips = clampInt(settings.startingChips, 1000, 1000000, 10000);
        this.blindUpInterval = clampInt(settings.blindUpInterval, 60, 3600, 600);
        this.turnTimeLimit = clampInt(settings.turnTimeLimit, 5, 60, 20);
        this.maxRebuys = clampInt(settings.maxRebuys, 0, 3, 1); // 💡 리바이 허용 횟수 (블라인드 레벨 2까지)
        this._rebuyGraceActive = false;
        // 게임 모드: 'tournament'(기본). 'cash'(블라인드 고정)는 GTO 학습 모드가 내부에서만 쓴다 — 캐시 게임 방은 만들 수 없다
        this.mode = settings.mode === 'cash' ? 'cash' : 'tournament';
        this.cashBlind = clampInt(settings.cashBlind, 1, 100000, 100); // 캐시 빅블라인드 고정값
        // 🎲 런잇트와이스 — 올인 시 보드를 두 번 깔아 분산을 줄인다.
        //    TDA 규정상 토너먼트는 금지 → 캐시 모드에서만 켤 수 있다.
        this.runItTwice = this.mode === 'cash' && !!settings.runItTwice;
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
            // 🐛 [치명] 레벨 2부터 "앤티"가 빅블라인드와 같은 금액으로 걸려 있었고, 그걸 블라인드가 아닌 사람까지 전원이 매 판 냈다.
            //    6명이면 한 바퀴에 블라인드 1.5bb 외에 6bb 가 더 나가서, 아무것도 안 해도 스택이 빠르게 녹았다
            //    (실측: 레벨 2~3에서 블라인드가 아닌 자리로 시작한 143판 전부에서 빅블라인드 한 개씩 빠짐).
            //    → "빅블라인드 앤티"(정식 토너먼트 방식)로 바꿨다: 레벨 2부터 BB 한 사람만 빅블라인드 한 개를 앤티로 더 낸다.
            //      테이블 전체로는 한 판에 1bb — 사람 수와 무관하다. 여기의 ante 는 "BB 가 내는 앤티 금액"이다.
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

            // 🎨 [꾸미기] 이 테이블 사람들의 장착 상태를 한 번만 모아서 모든 수신자에게 같이 보낸다.
            //    카드 뒷면은 "그 카드 주인"의 것으로 그려야 하므로 남의 것도 알아야 한다.
            const cosMap = {};
            Object.keys(this.players).forEach(nick => {
                if (this.players[nick].isBot) { cosMap[nick] = botCosmetics(nick); return; }
                const u = MockDB.users.get(nick);
                if (!u) return;
                const c = normalizeCosmetics(u);
                // 📷 사진은 무거워서 상태에 싣지 않는다 — 버전 번호만 보내고 실제 그림은 /avatar 로 따로 받는다
                cosMap[nick] = { back: c.back, avatar: c.avatar, title: cosTitleText(c.title), frame: c.frame, ph: hasPhoto(u) ? u.photo.ver : 0 };
            });

            const chInfo = this._challenge ? {
                stage: this._challenge.stage || 0, coop: !!this._challenge.coop, waiting: !!this._challenge.waiting,
                boss: this._challenge.run ? !!this._challenge.boss : this._challenge.stage === Challenge.STAGES.length, total: Challenge.STAGES.length,
                // 🍀 증강 런이면 층·목표·기한·증강을 같이 보낸다 (혼자 치는 방이라 엿보기 카드도 여기 실어도 된다)
                run: this._challenge.run ? {
                    floor: this._challenge.run.floor, total: Rogue.FLOORS.length, name: this._challenge.floorName,
                    quota: this._challenge.quota, hands: this._challenge.hands, handsLeft: Math.max(0, this._challenge.hands - this._challenge.handsPlayed),
                    augments: this._challenge.run.augments.map(Rogue.describe), mull: this._challenge.mullLeft, revive: this._challenge.run.revive,
                    peek: this._challenge.peek, over: !!this._challenge.done
                } : null,
                maxStage: this._challenge.waiting ? this.challengeMaxStage() : 0, host: this.hostNickname,
                botsLeft: Object.values(this.players).filter(x => x.isBot && x.chips > 0).length
            } : null;

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

                    // 🃏 [폴드 패 공개] 죽은 사람이 "보여주기"를 고른 카드는 핸드가 끝난 뒤에 깐다.
                    //    핸드가 살아 있는 동안 까면 남은 사람들에게 정보를 주게 되므로(예: 에이스가 죽었다)
                    //    규칙상으로도 안 된다. 그래서 선택은 미리 받고 공개는 종료 시점에 한다.
                    let handOut;
                    if (showHand) handOut = safeHand;
                    else if (safeHand.length === 0) handOut = [];
                    else {
                        const rc = (this.gameStage === 5 && p._revealCards) ? p._revealCards : null;
                        handOut = rc
                            ? [rc[0] ? safeHand[0] : '?', rc[1] ? safeHand[1] : '?']
                            : ['?', '?'];
                    }

                    sanitizedPlayers[nick] = {
                        ...p,
                        hand: handOut,
                        currentRank: currentRankName
                    };
                    // 🔒 내부 전용 필드(_로 시작) 전부 제거 — 타이머 직렬화 방지 + 봇 전략 정보 유출 차단
                    //    (_persona: 봇 성향/블러프빈도, _trapStreet: 체크레이즈 트랩 중 = 초강력 핸드 텔)
                    Object.keys(sanitizedPlayers[nick]).forEach(k => { if (k[0] === '_') delete sanitizedPlayers[nick][k]; });
                });

                io.to(recipient.socketId).emit('updateTable', {
                    players: sanitizedPlayers,
                    communityCards: this.communityCards,
                    gameStage: this.gameStage,
                    pot: this.pot,
                    currentHighestBet: this.currentHighestBet,
                    lastRaiseAmount: this.lastFullRaiseAmount,
                    turnPlayerId: this.turnIndex === -1 ? null : (this.playerOrder[this.turnIndex] || null),
                    // 🚫 [언더레이즈 규칙] 현재 턴 플레이어가 이미 행동했다면(언더레이즈 올인만 있었음) 레이즈 금지 → 클라이언트 버튼 잠금용
                    turnRaiseLocked: (() => { const tn = this.turnIndex !== -1 ? this.playerOrder[this.turnIndex] : null; return !!(tn && this.players[tn] && this.players[tn].hasActed); })(),
                    tournamentInfo: (this.tournamentStarted || this.mode === 'cash') ? this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)] : null,
                    gameMode: this.mode,
                    canEndVote: this.endVoteEligible(), // 🗳️ 합의 종료 투표 가능 여부 (나가기 메뉴 노출용)
                    youSpectate: !!recipient._wantSpectate, // 👀 내가 "관전으로 입장"을 고른 상태인가
                    youRevealFold: recipient._revealCards ? recipient._revealCards.slice() : null, // 🃏 폴드 패 공개 선택
                    youTimeBank: !recipient._tbUsed, // ⏳ 이번 핸드에 타임뱅크가 남았나
                    seatsUsed: this.playerOrder.length, seatsMax: TABLE_SEATS,
                    cos: cosMap, // 🎨 자리에 앉은 사람들의 꾸미기 (뒷면/아바타/칭호)
                    challenge: chInfo, // 🤖 컴까기 방이면 단계·보스 여부·협동 대기 상태
                    endVote: this.endVoteSnapshot(),
                    timeRemaining: this.timeRemaining,
                    turnEndTime: this.turnEndTime,
                    serverNow: Date.now(), // ⏱ 타임바 보정용 — 폰 시계가 서버와 몇 초 어긋나면 바가 처음부터 비거나 안 줄었다
                    turnTimeLimit: this.turnTimeLimit, // 💡 [수정 #4] 클라이언트 타임바 동기화용
                    handId: this.handId,
                    hostNickname: this.hostNickname,
                    startingChips: this.startingChips,
                    // 🪑 대기 화면에 보여 줄 방 설정 요약 (시작 전 일반 토너먼트 방에서만)
                    lobby: (this.gameStage === 0 && !this.tournamentStarted && this.mode === 'tournament' && !this.mttId && !this._challenge)
                        ? { sb: this.blindStructure[0].sb, bb: this.blindStructure[0].bb, levelSec: this.blindUpInterval, rebuys: this.maxRebuys, turnSec: this.turnTimeLimit } : null,
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

    // 🤖 [컴까기] 협동 대기방에서 고를 수 있는 가장 높은 단계 (가장 덜 깬 사람 기준)
    challengeMaxStage() {
        const us = Object.keys(this.players).filter(n => !this.players[n].isBot).map(n => MockDB.users.get(n)).filter(Boolean);
        return Challenge.partyMaxStage(us);
    }

    // 🤖 [컴까기] 도전 종료 — 혼자/협동 공용. 협동이면 참가한 사람 전원에게 각자 기준으로 보상한다.
    finishChallenge(win) {
        const ch = this._challenge;
        if (!ch || ch.done) return;
        if (ch.run) { this.finishRunFloor(win); return; }   // 🍀 증강 런은 단계표가 아니라 층 규칙으로 끝난다
        ch.done = true;
        this.gameStage = 0;
        this.tournamentStarted = false;
        if (this.tournamentTimer) clearInterval(this.tournamentTimer);
        if (this.turnTimeout) clearTimeout(this.turnTimeout);
        this.turnIndex = -1;
        const stage = ch.stage;
        const stageInfo = Challenge.STAGES[stage - 1];
        const members = ch.coop ? (ch.members || []) : [ch.nick];
        members.forEach(nick => {
            const pl = this.players[nick];
            const u = MockDB.users.get(nick);
            let payload = { win: false, stage, name: stageInfo.name, coop: !!ch.coop };
            if (win && u) {
                const r = Challenge.applyClear(u, stage);   // 뱅크롤 보상·코어·진행도 (코어는 여기서 이미 적립된다)
                if (r) {
                    if (r.allClear) {
                        const c = normalizeCosmetics(u);
                        if (!c.owned.includes(Challenge.CLEAR_TITLE)) c.owned.push(Challenge.CLEAR_TITLE);
                    }
                    payload = Object.assign({ win: true, name: stageInfo.name, coop: !!ch.coop, coresNow: u.cores || 0 }, r);
                    MockDB.adjustBankroll(nick, r.reward).then(nb => {
                        if (pl && pl.socketId) io.to(pl.socketId).emit('bankrollUpdate', { bankroll: nb || 0 });
                    });
                }
            }
            if (pl && pl.socketId) io.to(pl.socketId).emit('challengeResult', payload);
        });
        MockDB.save();
        if (ch.coop) this.resetCoop();
        this.sendState();
    }

    // 🍀 [증강 런] 핸드와 핸드 사이 — 직전 핸드의 증강 수당을 주고, 목표 달성/실패를 판정한다.
    //    층이 끝났으면 true (새 핸드를 돌리지 않는다).
    runBetweenHands() {
        const ch = this._challenge, run = ch.run, p = this.players[ch.nick];
        if (!p) { this.finishRunFloor(false, true); return true; }
        if (!this.tournamentStarted) return false;          // 아직 첫 핸드 전
        if (ch.settledHandId !== this.handId) {             // 한 핸드에 한 번만 (startNextHand 가 겹쳐 불려도)
            ch.settledHandId = this.handId;
            const start = this.handStartStacks ? this.handStartStacks[ch.nick] : null;
            if (start != null) {
                let rank = 0;
                if (!p.isFolded && this.communityCards.length === 5 && p.hand && p.hand.length === 2) {
                    try { rank = Hand.solve(p.hand.concat(this.communityCards)).rank; } catch (e) {}
                }
                // 카드를 받을 때 준 보너스(포켓·블라인드 환급)는 "번 칩"에서 뺀다 — 폴드한 핸드가 이긴 걸로 계산되지 않게
                const r = Rogue.afterHand(run, { start: start + (ch.dealBonus || 0), now: p.chips, hand: p.hand, rank, allIn: !!p.isAllIn || p.chips <= 0,
                    vpip: !!(this.vpipThisHand && this.vpipThisHand.has(ch.nick)), rng: Math.random });
                if (r.bonus > 0) {
                    p.chips += r.bonus;
                    if (p.socketId) io.to(p.socketId).emit('runBonus', { bonus: r.bonus, notes: r.notes });
                }
            }
        }
        const botsAlive = Object.values(this.players).some(x => x.isBot && x.chips > 0);
        if (p.chips >= ch.quota || (!botsAlive && p.chips > 0)) { this.finishRunFloor(true); return true; }
        if (p.chips <= 0 || ch.handsPlayed >= ch.hands) { this.finishRunFloor(false); return true; }
        return false;
    }

    // 🍀 [증강 런] 카드를 돌린 직후 — 기한 한 핸드 소모, 블라인드 환급·포켓 보너스, 엿보기
    runOnDeal(sbIndex, bbIndex) {
        const ch = this._challenge, p = this.players[ch.nick];
        ch.dealBonus = 0; ch.peek = null;
        if (!p || !this.playerOrder.includes(ch.nick)) return;
        ch.handsPlayed += 1;
        const me = this.playerOrder.indexOf(ch.nick);
        const r = Rogue.onDeal(ch.run, { hand: p.hand, blindPaid: (me === sbIndex || me === bbIndex) ? p.currentBet : 0 });
        if (r.bonus > 0) {
            p.chips += r.bonus; ch.dealBonus = r.bonus;
            if (p.socketId) io.to(p.socketId).emit('runBonus', { bonus: r.bonus, notes: r.notes });
        }
        if (Rogue.has(ch.run, 'peek')) {
            const opp = this.playerOrder.filter(n => n !== ch.nick && this.players[n] && this.players[n].hand.length === 2);
            if (opp.length) { const n = opp[Math.floor(Math.random() * opp.length)]; ch.peek = { nick: n, card: this.players[n].hand[Math.floor(Math.random() * 2)] }; }
        }
    }

    // 🍀 [증강 런] 층 종료 — 깼으면 다음 증강 3택, 실패면 (네잎클로버가 있으면 재도전) 런 정산
    finishRunFloor(win, abandon) {
        const ch = this._challenge;
        if (!ch || !ch.run || ch.done) return;
        ch.done = true;
        this.gameStage = 0;
        this.tournamentStarted = false;
        if (this.tournamentTimer) clearInterval(this.tournamentTimer);
        this.stopTurnTimer();
        this.turnIndex = -1;
        const run = ch.run, nick = ch.nick;
        run.inFloor = false;
        const pl = this.players[nick];
        const sock = (pl && pl.socketId) ? io.sockets.sockets.get(pl.socketId) : null;
        if (win) {
            const chips = pl ? pl.chips : 0;
            const r = Rogue.clearFloor(run, { chips, quota: ch.quota, handsLeft: Math.max(0, ch.hands - ch.handsPlayed) }, Math.random);
            if (r.done) endRun(nick, run, sock);
            else {
                saveRun(nick, run);
                if (sock) sock.emit('runOffer', runOfferPayload(run, { clearedFloor: run.cleared, chips, quota: ch.quota, earned: r.coins }));
            }
        } else if (!abandon && run.revive > 0 && sock) {
            run.revive -= 1;
            const i = run.augments.indexOf('revive'); if (i !== -1) run.augments.splice(i, 1);   // 쓴 클로버는 사라진다
            saveRun(nick, run);
            sock.emit('runRevive', { floor: run.floor });
            setTimeout(() => { if (runs.get(nick) === run && sock.connected) launchRunFloor(sock, run); }, 2600);
        } else {
            endRun(nick, run, sock);
        }
        this.sendState();
    }

    // 🤖 [컴까기 협동] 한 판이 끝나면 봇을 치우고 대기 상태로 돌아간다 — 같은 멤버로 바로 다음 단계를 갈 수 있게
    resetCoop() {
        const ch = this._challenge;
        Object.keys(this.players).forEach(n => { if (this.players[n].isBot) delete this.players[n]; });
        this.playerOrder = Object.keys(this.players);
        this.playerOrder.forEach(n => {
            const p = this.players[n];
            p.chips = this.startingChips; p.currentBet = 0; p.totalInvested = 0; p.hand = [];
            p.isFolded = false; p.isAllIn = false; p.isSpectator = false; p.hasActed = false; p.role = ''; p.isMucked = false;
        });
        this.pot = 0; this.communityCards = []; this.currentHighestBet = 0; this.blindLevel = 0;
        ch.waiting = true; ch.done = false; ch.stage = 0; ch.members = [];
        io.emit('roomList', roomListArray());
    }

    // ⏳ 시간 만료 시 자동 처리 (체크 가능하면 체크, 아니면 폴드)
    //    타임뱅크로 타이머를 다시 걸 수 있게 클로저가 아닌 메서드로 둔다.
    _autoAct(expectedNick) {
        if (this.turnIndex === -1 || this.playerOrder[this.turnIndex] !== expectedNick) return;
        const p = this.players[expectedNick];
        if (!p || p.isFolded || p.isAllIn) return;
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

    // ⏳ [타임뱅크] 지금 턴의 남은 시간에 더 얹는다. 턴이 이미 넘어갔으면 아무것도 안 한다.
    extendTurn(addMs) {
        if (this.turnIndex === -1) return false;
        const nick = this.playerOrder[this.turnIndex];
        if (!nick) return false;
        const remain = Math.max(0, this.turnEndTime - Date.now()) + addMs;
        this.turnEndTime = Date.now() + remain;
        if (this.turnTimeout) clearTimeout(this.turnTimeout);
        this.turnTimeout = setTimeout(() => this._autoAct(nick), remain);
        io.to(this.roomId).emit('serverClock', Date.now()); // ⏱ 타임바 시계 보정
        io.to(this.roomId).emit('updateTurnTimer', this.turnEndTime);
        io.to(this.roomId).emit('gameMessage', `⏳ ${nick} 님이 시간을 ${Math.round(addMs / 1000)}초 더 씁니다`);
        return true;
    }

    startTurnTimer() {
        if (this.turnTimeout) clearTimeout(this.turnTimeout);
        const _turnNick = this.playerOrder[this.turnIndex];
        const _tp = this.players[_turnNick];
        // 🔌 [끊김 무결성] 턴 대상이 끊긴 사람이면 풀 타이머 대신 1초 후 자동 체크/폴드.
        //    끊긴 좌석은 매 핸드 좌석을 유지하는데(칩 보유 중), 예전엔 그의 턴마다
        //    전체가 턴 타임리밋(기본 20초)을 통째로 기다렸다. 재접속하면 다시 정상 타이머.
        //    (0ms가 아닌 1초: 끊긴 사람이 연달아 있어도 스택 재귀 없이 순차 처리 + 흐름 자연스러움)
        const msLimit = (_tp && !_tp.isBot && _tp.isDisconnected) ? 1000 : this.turnTimeLimit * 1000;
        this.turnEndTime = Date.now() + msLimit;
        io.to(this.roomId).emit('serverClock', Date.now()); // ⏱ 타임바 시계 보정
        io.to(this.roomId).emit('updateTurnTimer', this.turnEndTime);

        const expectedNick = _turnNick;

        this.turnTimeout = setTimeout(() => this._autoAct(expectedNick), msLimit);

        this.maybeScheduleBot(expectedNick); // 🤖 현재 턴이 봇이면 자동 행동 예약

        // 💬 [심리전] 사람이 한참 고민하면 봇이 슬쩍 찔러본다 (제한시간이 넉넉할 때만)
        if (this._tauntTimer) clearTimeout(this._tauntTimer);
        if (_tp && !_tp.isBot && !_tp.isDisconnected && msLimit >= 12000) {
            this._tauntTimer = setTimeout(() => {
                if (this.turnIndex === -1 || this.playerOrder[this.turnIndex] !== expectedNick) return;
                const bots = this.playerOrder.filter(n => {
                    const b = this.players[n];
                    return b && b.isBot && !b.isFolded && !b.isAllIn;
                });
                if (!bots.length) return;
                this.botSay(bots[Math.floor(Math.random() * bots.length)], 'taunt', { nick: expectedNick });
            }, Math.floor(msLimit * 0.5));
        }

        // 🎓 사람 차례면 GTO 조언을 "차례가 온 순간"에 미리 계산해 둔다.
        //    ⚡ 예전엔 사람이 버튼을 누른 뒤에(액션 처리 직전에) 계산해서, 그 시간만큼(플랍 이후 수십~수백 ms, 서버가 느리면 더) 버튼 반응이 늦었다.
        //    이제 생각하는 동안 계산해 두고 액션 때는 꺼내 쓰기만 한다. 학습 모드는 그 조언을 화면에도 보낸다(채점과 화면의 조언이 같은 값이 된다).
        this._advCache = null;
        {
            const cp = this.players[expectedNick];
            if (cp && !cp.isBot && !cp.isFolded && !cp.isAllIn) {
                const key = this.advKey(expectedNick);
                const run = () => {
                    if (this.playerOrder[this.turnIndex] !== expectedNick || this.advKey(expectedNick) !== key) return;
                    try {
                        const advice = this.getGtoAdvice(expectedNick);
                        this._advCache = { nick: expectedNick, key, advice };
                        if ((this._learnMode || process.env.DEV_ADVICE === '1') && advice && cp.socketId) io.to(cp.socketId).emit('gtoAdvice', advice);   // DEV_ADVICE: 검증용(일반 방에서도 조언을 내보냄)
                    } catch (e) {}
                };
                if (this._learnMode) run(); else setTimeout(run, 40);      // 일반 게임은 화면 갱신을 먼저 내보낸 뒤에 계산
            }
        }
    }
    // 조언을 계산한 시점의 상황과 지금이 같은지 확인하는 열쇠
    advKey(nick) {
        const p = this.players[nick];
        return [this.handId, this.gameStage, this.currentHighestBet, p ? p.currentBet : 0, this.pot, this.communityCards.length].join('|');
    }

    // 🤖 [신규] 봇 두뇌 — 핸드 강도 + 팟 오즈 기반 의사결정
    // 🤖 사람처럼 "고민하는" 시간. 아슬아슬한 결정일수록, 걸린 칩이 클수록 오래 끈다.
    //    (예전엔 어떤 상황이든 0.9~2.0초 고정이라 전부 스냅콜·즉시폴드처럼 보였다)
    botThinkTime(nick, decision, toCall, potNow) {
        if (process.env.BOT_FAST) return 1;
        const p = this.players[nick];
        const persona = p._persona || (p._persona = this.assignPersona(nick, p.difficulty));
        const bb = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;
        const facing = toCall > 0;

        let ms = 700 + Math.random() * 700; // 기본 리듬 0.7~1.4초

        // 1) 승률이 콜 문턱에 딱 붙어 있을수록 = 진짜 고민되는 스팟 (최대 +3.6초)
        const edge = this._lastBotEdge;
        if (facing && edge != null) {
            const closeness = Math.max(0, 1 - Math.min(1, Math.abs(edge) / 0.12));
            ms += closeness * (1400 + Math.random() * 2200);
        }
        // 2) 내 스택에서 차지하는 비중이 클수록 신중해진다 (최대 +2.4초)
        const stack = p.chips + (p.currentBet || 0);
        if (stack > 0) ms += Math.min(1, toCall / stack) * (800 + Math.random() * 1600);
        // 3) 팟 대비 큰 벳을 맞았을 때
        if (potNow > 0 && toCall > potNow * 0.5) ms += 300 + Math.random() * 700;
        // 4) 명백한 스팟은 툭툭 — 체크, 프리플랍 쓰레기패 폴드
        if (!facing && decision && decision.type === 'check') ms *= 0.55;
        if (decision && decision.type === 'fold' && this.gameStage === 1 && toCall <= bb) ms *= 0.45;
        // 5) 성격 — 광폭은 즉흥적, 초타이트는 돌다리도 두들긴다
        ms *= ({ '광폭': 0.7, '루즈-어그레시브': 0.85, '콜링스테이션': 0.95, '타이트-어그레시브': 1.15, '초타이트': 1.3 }[persona.label] || 1);
        // 6) 사람다운 변덕 — 쉬운 패에 괜히 뜸을 들이기도, 어려운 패를 툭 던지기도 한다
        const r = Math.random();
        if (r < 0.08) ms += 1500 + Math.random() * 2000;
        else if (r > 0.93) ms = 400 + Math.random() * 300;

        // 턴 제한시간에 걸려 자동 폴드당하지 않게 여유를 둔다
        const cap = Math.max(900, this.turnTimeLimit * 1000 * 0.55);
        return Math.round(Math.max(350, Math.min(cap, ms)));
    }

    maybeScheduleBot(nick) {
        const p = this.players[nick];
        if (!p || !p.isBot || p.isFolded || p.isAllIn) return;
        const expectedNick = nick;

        // 결정을 먼저 내린다 — "얼마나 어려운 결정이었는지"를 알아야 그만큼 뜸을 들일 수 있다.
        // 봇 차례엔 다른 누구도 액션할 수 없으므로, 미리 계산해도 그 사이 상태가 바뀌지 않는다.
        let decision = null;
        try { decision = this.botDecide(expectedNick); } catch (e) { decision = null; }
        const toCall = Math.max(0, this.currentHighestBet - (p.currentBet || 0));
        const potNow = this.pot + Object.values(this.players).reduce((s, x) => s + (x.currentBet || 0), 0);
        const thinkMs = this.botThinkTime(expectedNick, decision, toCall, potNow);

        if (p._botTimer) clearTimeout(p._botTimer);
        if (p._botTankTimer) clearTimeout(p._botTankTimer);

        // 💬 오래 고민할 땐 도중에 한마디 — 사람이 장고하며 흘리는 혼잣말
        if (thinkMs > 2600) {
            p._botTankTimer = setTimeout(() => {
                if (this.turnIndex === -1 || this.playerOrder[this.turnIndex] !== expectedNick) return;
                this.botSay(expectedNick, 'tank');
            }, Math.floor(thinkMs * 0.35));
        }

        p._botTimer = setTimeout(() => {
            // 그 사이 턴이 바뀌었으면 취소
            if (this.turnIndex === -1 || this.playerOrder[this.turnIndex] !== expectedNick) return;
            let d = decision || { type: toCall > 0 ? 'call' : 'check' };
            // 🐛 [버그픽스] 봇의 "올인"이 올인이 아니었다. 봇은 올인을 '레이즈(금액 = 스택 전부)'로 내는데,
            //    레이즈는 팟의 3배 상한에 걸려서 10bb 푸시가 5bb 레이즈로 깎였다(실측: 1,000칩 봇이 500만 넣고 500을 남김).
            //    숏스택 푸시/폴드와 리쉬브가 전부 어정쩡한 레이즈가 되어, 접을 수도 없는 크기로 칩을 흘렸다.
            //    스택 전부를 넣으려는 레이즈는 상한이 없는 올인 액션으로 바꿔 준다.
            if (d.type === 'raise' && d.amount >= (p.currentBet || 0) + p.chips) d = { type: 'allin' };

            // 💬 상황별 한마디 — 큰 벳은 도발/블러프, 큰 콜은 "안 믿는다", 큰 레이다운은 폴드 멘트
            if (d.type === 'allin' || (d.type === 'raise' && d.amount > potNow * 0.6)) {
                // 약한 핸드로 큰 베팅 = 블러프 멘트, 강하면 빅벳 멘트
                const eqGuess = this._lastBotEquity != null ? this._lastBotEquity : 0.5;
                this.botSay(expectedNick, eqGuess < 0.45 ? 'bluff' : 'bigbet');
            } else if (d.type === 'call' && toCall > potNow * 0.45) {
                this.botSay(expectedNick, 'call');
            } else if (d.type === 'fold' && toCall > potNow * 0.35) {
                this.botSay(expectedNick, 'fold');
            }

            const ok = this.applyAction(expectedNick, d.type, d.amount);
            // 🛡️ 무효 결정 방어 — 봇이 잘못된 레이즈 등으로 막히면 안전 액션으로 폴백 (테이블 멈춤 방지)
            if (ok === false) {
                const pl = this.players[expectedNick];
                if (pl && !pl.isFolded && !pl.isAllIn && this.playerOrder[this.turnIndex] === expectedNick) {
                    const tc = this.currentHighestBet - pl.currentBet;
                    this.applyAction(expectedNick, tc > 0 ? 'call' : 'check');
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
        // 🤖 [생각 시간] 이 결정이 얼마나 아슬아슬한지 — 아래 콜 판단부에서 더 정밀한 값으로 덮어쓴다
        this._lastBotEdge = toCall > 0 ? (equity - potOdds) : null;
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
                // 🎯 디펜스 폭 조정 컨텍스트: 살아있는 인원 수 + 리레이즈(3벳+) 여부
                //    인원 적을수록(HU/3way) 넓게, 단일 오픈보다 리레이즈엔 타이트하게 방어
                const _numActive = this.playerOrder.filter(n => !this.players[n].isFolded).length;
                // 🔬 운영에선 항상 고쳐진 카운터. BOT_AB 측정 때만 "옛 봇"이 고치기 전 값을 본다.
                const _rc = this.botV2(nick) ? (this.raiseCountThisStreet || 0) : (this._legacyRaiseCount || 0);
                const _threeBetPlus = _rc >= 2;
                const isBB = p.role && p.role.includes('BB');
                // ⚔️ [헤즈업 — 고수 봇] 둘만 남은 테이블에서는 6인 기준표가 너무 좁다.
                //    예전엔 헤즈업 BB가 버튼 오픈의 74%를 접어서, 사람이 버튼마다 최소 레이즈만 해도 이득이었다
                //    (2bb 걸어 1.5bb 먹기는 57%만 접혀도 본전). 버튼도 42%만 열어 블라인드를 그냥 내줬다.
                //    → BB는 약 65%로 지키고, 버튼은 약 76%를 연다 (학습 조언·문제와 같은 기준).
                const _huBot = persona.proStrategy && this.playerOrder.length === 2;
                // 📚 [자리별 방어 — 고수] 오픈을 받을 때 "누가 열었나"를 본다(학습 조언과 같은 기준표: 공개된 솔버 범위에 맞춘 값).
                //    예전엔 살아 있는 인원 수만 봐서 BB가 버튼 스틸에도 UTG 오픈에도 비슷하게 좁게 방어했다.
                const _v4 = persona.proStrategy && !_huBot && facingRaise && this.botV4(nick);
                let _opnPos = '';
                if (_v4) {
                    const _o = this.playerOrder.find(n => n !== nick && this.players[n] && !this.players[n].isFolded
                        && (this.players[n].currentBet || 0) === this.currentHighestBet && this.currentHighestBet > bb);
                    _opnPos = _o ? (this.players[_o].position || '') : '';
                }
                const _study = _v4 && !!_opnPos && (isBB || p.position === 'SB');      // 블라인드 방어에만 적용(콜드콜 자리는 예전 기준)
                let _chartPick = null;
                let rt = preflopRangeTier(code, p.position || '', facingRaise,
                    { numActive: _numActive, threeBetPlus: _threeBetPlus, headsUp: _huBot, closing: _huBot && !!isBB });
                // 📊 [맞대결 실측 — 2026-10-06, 100bb 하드 봇 5명, 각 약 3만 핸드]
                //    · 기준표를 통째로 적용(넓은 콜 방어 포함): 새 −9.9 vs 옛 +37.1 bb/100, 우승 32:58 — 뚜렷하게 약해짐.
                //      솔버의 넓은 방어는 플랍 이후를 솔버처럼 칠 때 성립한다. 봇의 포스트플랍으로는 약한 패를 포지션 없이 끌고 가다 샌다.
                //    · 3벳 폭만 적용(+ SB는 3벳 아니면 폴드): 새 13.3 vs 옛 15.4 bb/100, 우승 42:47 — 차이 없음(노이즈 범위).
                //    → 운영에는 "3벳 폭만" 적용한다. 콜 방어 폭은 예전 그대로. (BOT_V4MODE=full 은 다시 재 볼 때 쓰는 스위치)
                if (_study) {
                    const rtNew = preflopRangeTier(code, p.position || '', facingRaise, { numActive: _numActive, threeBetPlus: _threeBetPlus, openerPos: _opnPos, closing: !!isBB });
                    if (rtNew.tier === 'raise' && process.env.BOT_V4MODE !== 'full') rt = rtNew;
                    else if (process.env.BOT_V4MODE === 'full') rt = rtNew;
                    // 📊 [범위표 — 측정 스위치 BOT_AB6] 단일 오픈을 받는 블라인드: lib/ranges.js 의 빈도대로 3벳·콜·폴드를 고른다(가격 보정 포함).
                    //    플랍을 솔버 자료로 치게 된 뒤라 넓은 방어가 이제는 성립하는지 다시 잰다.
                    if (!_threeBetPlus && this.botV6(nick)) {
                        const rtC = preflopRangeTier(code, p.position || '', true, { chart: true, raises: 1, openerPos: _opnPos, closing: !!isBB, potOdds });
                        if (rtC.freq) {
                            const x = Math.random() * 100;
                            const t = x < rtC.freq.raise ? 'raise' : x < rtC.freq.raise + rtC.freq.call ? 'call' : 'fold';
                            rt = { tier: t, label: t, score: rtC.score };
                            _chartPick = t;
                        }
                    }
                }
                // 📊 [먼저 여는 범위 — 고수 봇] 솔버 프리플랍 자료의 오픈 빈도대로 연다(UTG~SB). 측정 스위치는 블라인드 방어 범위표와 같다(botV6).
                if (!facingRaise && persona.proStrategy && !_huBot && !isBB && toCall > 0 && this.botV6(nick)) {
                    const _of = Ranges.openFreq(p.position || '', code);
                    const _limped = this.playerOrder.some(n => n !== nick && this.players[n] && !this.players[n].isFolded && (this.players[n].currentBet || 0) === bb && !(this.players[n].role && /SB|BB/.test(this.players[n].role)));
                    if (_of != null && !_limped) { const t = Math.random() * 100 < _of ? 'raise' : 'fold'; rt = { tier: t, label: t === 'raise' ? '오픈 레이즈' : '폴드', score: rt.score }; }
                }
                if (_huBot && !facingRaise && rt.tier !== 'raise' && rt.score > Quiz.HU_OPEN_SCORE) rt = { tier: 'raise', label: '오픈 레이즈', score: rt.score };

                // 🤖 [반복 올인 대응 — 초보·중수] 이 방에서 올인을 남발한 사람의 올인은 "그 사람이 실제로 미는 빈도"로 받는다.
                //    (고수는 아래 숏스택 로직이 같은 읽기를 쓴다.) 예전엔 난이도 낮은 봇이 올인에 거의 다 접어서
                //    매 핸드 올인하면 블라인드를 공짜로 쓸어 갔다.
                if (!persona.proStrategy && facingRaise && toCall > 0) {
                    const _jam = this.playerOrder.find(n => n !== nick && this.players[n] && !this.players[n].isFolded && this.players[n].isAllIn && (this.players[n].currentBet || 0) === this.currentHighestBet);
                    if (_jam) {
                        const js = this.jamStat(_jam);
                        if (js.j >= 2 && js.h >= 3 && js.j / js.h >= 0.3) {
                            const res = ShortStack.shouldCallShove(code, Math.min(1, js.j / js.h), toCall / (totalPot + toCall), 0.03);
                            return res.call ? { type: 'call' } : { type: 'fold' };
                        }
                    }
                }

                // 🤖 [숏스택·올인] 스택이 짧거나 올인을 마주하면 일반 로직보다 먼저 푸시/폴드 판단을 한다
                if (persona.proStrategy && this.botV2(nick)) {
                    const ssd = this.shortStackDecision(nick, { code, toCall, bb, totalPot, facingRaise, isBB });
                    if (ssd) return ssd;
                }

                // 표준 오픈 사이즈로 "raise to" 금액 계산 (2.4~3.1bb, 최소레이즈·스택 보정)
                const _v3 = this.botV3(nick);
                const openRaiseDecision = () => {
                    // 림퍼(블라인드가 아닌데 bb 만 넣고 남은 사람)가 있으면 한 명마다 1bb 더 — 같은 크기로 열면 모두 싸게 따라온다 (학습 조언과 같은 기준)
                    const limpers = _v3 ? this.playerOrder.filter(n => { const o = this.players[n]; return n !== nick && o && !o.isFolded && (o.currentBet || 0) === bb && !(o.role && o.role.includes('BB')); }).length : 0;
                    const openTo = Math.round(bb * (2.4 + Math.random() * 0.7 + Math.min(4, limpers)));
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
                    //    3벳은 프리미엄(밸류)과 블로커 좋은 마지널(블러프)로 양극화하는 게 정석.
                    //    예전엔 equity만 살짝 올려 아래 로직에 맡겨서 3벳 빈도가 4%에 그쳤다(프로 6~10%).
                    const _late = (p.position === 'BTN' || p.position === 'CO' || p.position === 'SB');
                    const threeBetTo = () => {
                        // 포지션 있으면 작게, 없으면 크게 (정석). 이미 콜한 사람이 있으면 한 명마다 한 배 더(스퀴즈)
                        const callers = _v3 ? Math.max(0, this.playerOrder.filter(n => { const o = this.players[n]; return n !== nick && o && !o.isFolded && (o.currentBet || 0) === this.currentHighestBet; }).length - 1) : 0;
                        const mult = (_late ? 3.0 : 3.6) + Math.min(2, callers);
                        const want = Math.round(this.currentHighestBet * mult);
                        const minRaiseTo = this.currentHighestBet + (this.lastFullRaiseAmount || bb);
                        const target = Math.min(p.currentBet + p.chips, Math.max(want, minRaiseTo));
                        return (target > this.currentHighestBet) ? { type: 'raise', amount: target } : { type: 'call' };
                    };
                    const _singleRaise = _rc <= 1 && persona.proStrategy;
                    if (rt.tier === 'fold') {
                        if (!(isBB && toCall <= bb * 0.5) && r < 0.88 * skill + 0.1) return { type: 'fold' };
                        equity *= 0.78;
                    } else if (rt.tier === 'raise') {
                        if (_singleRaise && (_chartPick === 'raise' || r < 0.55 * skill + 0.15)) return threeBetTo(); // 밸류 3벳 (범위표로 고른 3벳은 그대로 친다)
                        equity = Math.min(1, equity * 1.10);
                    } else if (_singleRaise && _late && r < 0.13 * skill) {
                        return threeBetTo(); // 🃏 블러프 3벳 — 늦은 포지션 마지널 일부를 섞어 레인지를 숨긴다
                    } else if (_study && (process.env.BOT_V4MODE === 'full' || _chartPick === 'call') && rt.tier === 'call' && _rc <= 1 && toCall <= bb * 3.5 && toCall < p.chips * 0.25 && r < 0.9 * skill + 0.08) {
                        return { type: 'call' };   // 기준표상 방어할 패 — 아래의 일반 승률 계산에 맡기면 넓은 방어 범위의 아래쪽을 다시 접어 버린다
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
        // 🧲 [콜링 스테이션 응징 — 고수] 벳에 거의 안 접는 상대(폴드율 20% 미만)는 아무 패로나 따라온다.
        //    실측: 전부 콜만 하는 상대가 헤즈업에서 100핸드당 155bb 밖에 안 잃었다 — 봇이 밸류벳을 너무 좁게, 너무 작게 쳤기 때문.
        //    그런 상대에겐 ① 블러프를 끊고 ② 승률이 절반을 조금만 넘어도 벳하고 ③ 크게 친다(접지 않으니 큰 벳이 그대로 이득).
        const _nOppIn = this.playerOrder.filter(n => n !== nick && this.players[n] && !this.players[n].isFolded).length;
        const station = !!(persona.proStrategy && process.env.BOT_NOSTATION !== '1' && street >= 2 && oppRead && oppRead.foldToBet != null && oppRead.foldToBet < 0.20);
        if (station) { bluffMod = Math.min(bluffMod, 0.2); valueMod = Math.max(valueMod, 1.35); }
        const valueLine = station ? Math.max(0.53 + 0.04 * Math.max(0, _nOppIn - 1), persona.valueThresh - 0.10) : persona.valueThresh;

        const sizeBet = (mult) => {
            // 🎯 [사이징 개선] 이산 GTO 버킷 (33%/55%/78%/리버 오버벳 115%) — lib/betsizing.js
            //    드라이=작게(레인지벳), 웻=크게(드로우 과금), 밸류·블러프 동일 분포(밸런스)
            //    mult는 기존 호출부 의미 보존용 미세 조정 (0.85~1.1)
            const { frac } = pickBetFraction({ street, board, sizeBase: persona.sizeBase });
            return Math.max(bb, Math.round(totalPot * frac * (mult || 1)));
        };

        // 🧮 [솔버 조회 — 고수 봇] 미리 풀어 둔 플랍 상황(오픈 → BB 콜로 둘만 남음)이면 솔버의 빈도대로 고른다.
        //    학습 조언과 같은 자료(lib/solverdata.json). 전부 콜하는 상대를 응징하는 중(station)에는 쓰지 않는다 — 그건 솔버 밖의 익스플로잇이다.
        if (persona.proStrategy && (street === 2 || (street === 3 && this.botV7(nick))) && !station && p.hand && p.hand.length === 2 && this.botV5(nick)) {
            try {
                const _o = this.playerOrder.filter(n => n !== nick && this.players[n] && !this.players[n].isFolded);
                if (_o.length === 1) {
                    const _v = this.players[_o[0]];
                    const _eff = Math.min(p.chips + p.currentBet, _v.chips + (_v.currentBet || 0)) / bb;
                    // BOT_AB8(측정용): 절반의 봇은 처음 풀었던 22보드만 쓴다 — 보드를 늘린 효과를 잰다
                    const _ab8 = process.env.BOT_AB8, _bit8 = ((this.hashNick(nick) >> 4) & 1) === 1;
                    const _sr = this.solverLookup(nick, toCall, totalPot - p.currentBet, _eff, !!_ab8 && (_ab8 === '2' ? _bit8 : !_bit8));
                    if (_sr) {
                        const f = _sr.freqs, x = Math.random() * (f.reduce((a, c) => a + c, 0) || 1);
                        const allIn = p.currentBet + p.chips;
                        if (toCall === 0) {
                            if (x < f[0]) return { type: 'check' };
                            const small = f.length === 3 ? x < f[0] + f[1] : true;
                            const target = Math.min(allIn, this.currentHighestBet + Math.max(bb, Math.round(totalPot * (_sr.turnClass ? 0.66 : small ? 0.33 : 0.75))));
                            p._plan = { betStreet: street, type: classifyBetPlan({ equity, board }), eqAtBet: equity };
                            return { type: 'raise', amount: target };
                        }
                        if (x < f[0]) return { type: 'fold' };
                        if (x < f[0] + f[1] || p.chips <= toCall) return { type: 'call' };
                        // 레이즈: 솔버 트리와 같은 크기(콜한 뒤 팟의 절반만큼 더)
                        const target = Math.min(allIn, Math.round(this.currentHighestBet + 0.5 * (totalPot + toCall)));
                        if (target >= this.currentHighestBet + this.lastFullRaiseAmount || target >= allIn) return { type: 'raise', amount: target };
                        return { type: 'call' };
                    }
                }
            } catch (e) {}
        }

        // 🌊 [리버 계산 — 고수 봇, 측정 스위치 BOT_AB9] 둘만 남은 리버는 범위 대 범위로 푼 빈도대로 친다.
        //    아주 강한 패로 벳을 받은 자리(레이즈할 패)는 계산 나무에 레이즈가 없어 예전 로직에 맡긴다.
        if (persona.proStrategy && street === 4 && !station && this.botV9(nick) && !(toCall > 0 && equity > 0.88)) {
            try {
                const rr = this.riverAdvice(nick, toCall);
                if (rr) {
                    const x = Math.random();
                    if (!rr.facing) {
                        if (x >= rr.freq) return { type: 'check' };
                        return { type: 'raise', amount: Math.min(p.currentBet + p.chips, this.currentHighestBet + Math.max(bb, Math.round(rr.bet))) };
                    }
                    return x < rr.freq ? { type: 'call' } : { type: 'fold' };
                }
            } catch (e) {}
        }

        // ─── 체크 가능 상황 (콜 비용 0) ───
        if (toCall === 0) {
            if (equity > valueLine) {
                // 🪤 [체크레이즈 트랩] 매우 강한 핸드 + 내 뒤에 벳할 사람이 남아있으면 일부러 체크.
                //    이번 스트리트에 벳이 들어오면 아래 트랩 발동 로직이 레이즈로 응징한다.
                //    드라이 보드(상대가 블러프하기 좋은 판)에서 빈도 ↑, 스킬 비례.
                const veryStrong = equity > persona.raiseThresh + 0.04;
                const trapStreetOk = (street >= 2 && street < 4) || (street === 4 && board && board.dry); // 리버는 드라이 보드만(무료카드 리스크 없음)
                // 내 뒤에 아직 행동 안 한 활성 플레이어가 있어야 트랩 의미 있음 (체크 후 벳을 받을 수 있는 상황)
                //   ※ isLikelyLastAggressor 휴리스틱은 2인 팟에서 항상 true라 HU 체크레이즈(교과서 상황)를 막아버림 — hasActed로 정확 판정
                const someoneBehind = this.playerOrder.some(n => n !== nick && this.players[n] && !this.players[n].isFolded && !this.players[n].isAllIn && !this.players[n].hasActed);
                if (veryStrong && someoneBehind && trapStreetOk && !station) {   // 벳을 안 하는 스테이션에겐 함정 체크가 공짜 카드만 준다
                    const trapFreq = (board && board.dry ? 0.34 : 0.24) * skill;
                    if (Math.random() < trapFreq) {
                        p._trapStreet = this.gameStage;
                        return { type: 'check' };
                    }
                }
                // 안 접는 상대에겐 강할수록 크게(팟의 75~100%), 얇은 밸류는 절반 — 평소엔 텍스처 기반 균형 사이즈
                const _vAmt = station
                    ? Math.max(bb, Math.round(totalPot * (equity > persona.raiseThresh ? (street >= 4 ? 1.0 : 0.8) : (equity > persona.valueThresh ? 0.66 : 0.45))))
                    : sizeBet(1.0);
                const target = Math.min(p.currentBet + p.chips, p.currentBet + _vAmt);
                if (target > this.currentHighestBet && r < Math.min(0.95, persona.valueBetFreq * valueMod)) {
                    // 🧠 밸류 벳 — 의도 기록 (다음 스트리트도 계속 밸류로 이어감)
                    p._plan = { betStreet: street, type: classifyBetPlan({ isValue: true }), eqAtBet: equity };
                    return { type: 'raise', amount: target };
                }
                const _rb = this.planRangeBet(nick, { equity, board, persona, skill, street, totalPot, bb, oppRead });
                if (_rb) return _rb;
                return { type: 'check' };
            }
            // ── 약~중 핸드: 블러프/세미블러프 + 🧠 스트리트 플랜 배럴(연속 벳) ──
            let bluffChance = persona.bluffFreq * bluffMod;
            if (isLastToAct) bluffChance += 0.08;
            if (board && board.dry && equity < 0.35) bluffChance += 0.06;

            // 🧠 [스트리트 플랜] 직전 스트리트에 내가 벳한 어그레서면 "배럴" — 한 번 시작한 공격을 이어감.
            //    포기하고 체크하면 상대에게 무료 카드 + 주도권을 공짜로 넘기므로, 상황이 좋으면 계속 벳.
            const activeOpp = this.playerOrder.filter(n => n !== nick && !this.players[n].isFolded && !this.players[n].isAllIn).length;
            const barrel = barrelFrequency({ plan: p._plan, street, board, oppRead, skill, activeOpp, equity });
            if (barrel > 0) bluffChance = Math.max(bluffChance, barrel);

            // 🃏 [블로커] 넛(넛플러시·탑카드)을 차단하는 카드를 쥐면 상대가 넛일 확률이 낮다 →
            //    블러프가 더 잘 통하므로 빈도 상향. skill 비례(초보는 못 읽음).
            bluffChance *= Blockers.bluffBlockerMult(p.hand, this.communityCards, skill);

            if (station) bluffChance = Math.min(bluffChance, 0.03);
            if (r < bluffChance && p.chips > bb * 3) {
                const target = Math.min(p.currentBet + p.chips, p.currentBet + sizeBet(0.85));
                if (target > this.currentHighestBet) {
                    // 🧠 플랜 갱신 — 다음 스트리트 배럴 판단의 근거가 된다
                    p._plan = { betStreet: street, type: classifyBetPlan({ equity, board }), eqAtBet: equity };
                    return { type: 'raise', amount: target };
                }
            }
            // 🎯 기존 로직이 체크로 끝났어도, 레인지가 유리한 보드면 고수는 친다
            const _rb2 = this.planRangeBet(nick, { equity, board, persona, skill, street, totalPot, bb, oppRead });
            if (_rb2) return _rb2;
            // 배럴 안 함 → 공격 플랜 종료(손절), 체크
            if (p._plan && p._plan.betStreet === street - 1) p._plan = null;
            return { type: 'check' };
        }

        // ─── 콜 비용이 있는 상황 ───

        // 🛡️ [방어] 콜에 필요한 최소 승률 — 임플라이드 오즈(드로우+딥스택) + 상대 성향 익스플로잇.
        //    유효 스택(콜 후 남는 내/상대 중 작은 쪽)으로 임플라이드 크기를 잡는다.
        const maxOppChips = Math.max(0, ...this.playerOrder
            .filter(n => n !== nick && !this.players[n].isFolded)
            .map(n => this.players[n].chips + (this.players[n].currentBet || 0)));
        const effBehind = Math.max(0, Math.min(p.chips - toCall, maxOppChips));
        const sprBehind = totalPot + toCall > 0 ? effBehind / (totalPot + toCall) : 0;
        // 드로우 판정: 예전엔 "보드가 젖었고 승률이 22~50%"면 드로우로 쳤다 — 내 패에 드로우가 없어도 임플라이드 오즈를 받았다.
        //   고수 봇은 실제로 내 카드로 된 8아웃 이상 드로우만 인정하고, 보드 3장 + 낮은 카드 한 장짜리 플러시 드로우는 뺀다.
        const _v3p = persona.proStrategy && this.botV3(nick);
        let isDraw = Defense.looksLikeDraw(board, equity, street);
        if (_v3p && street >= 2 && street < 4) {
            const _d = GtoAdvice.detectDraws(p.hand, this.communityCards);
            isDraw = !!(_d && _d.outs >= 8 && !_d.weak) && equity <= 0.55;
        }
        const oppAggr = oppRead && oppRead.aggression != null ? oppRead.aggression : null;
        let callThresh = Defense.requiredEquity({ potOdds, isDraw, sprBehind, oppAggression: oppAggr, skill });
        // 🛡️ [최소 방어 빈도 MDF] 작은 벳에 과하게 접으면 상대가 아무 패로나 블러프해서 공짜로 번다.
        //    하프팟 벳엔 67%, 1/3팟 벳엔 75%를 방어해야 한다. 벳이 작을수록 요구 승률을 낮춰 넓게 받는다.
        if (persona.proStrategy && street >= 2 && toCall > 0) {
            const potBefore = Math.max(bb, totalPot - toCall);
            const relaxed = Postflop.defendThreshold({ potOdds, betFrac: toCall / potBefore, skill });
            callThresh = Math.min(callThresh, relaxed);
        }
        // 🎯 [에퀴티 실현율] 승률 30%라고 그 30%를 다 가져가는 게 아니다.
        //    포지션이 없으면 다음 스트리트에 또 벳을 맞아 접게 되고, 멀티웨이면 더 깎인다.
        //    이걸 무시했더니 봇이 벳에 9%밖에 안 접는 호구가 됐다(실측). 리버·올인은 100% 실현.
        //    ※ 실현율은 "콜할까 접을까"에만 쓴다. 레이즈 판단은 패 자체의 강도(raw equity)로 한다.
        const _nOppLive = this.playerOrder.filter(n => n !== nick && this.players[n] && !this.players[n].isFolded && !this.players[n].isAllIn).length;
        let eqReal = persona.proStrategy ? equity * Postflop.realizationFactor({
            street, inPosition: this.isInPosition(nick), nOpp: _nOppLive,
            hasDraw: isDraw, allIn: toCall >= p.chips
        }) : equity;

        // 🎯 [벳 레인지 대비] 상대가 벳을 했으면 그 레인지 대비로 다시 잰다.
        //    몬테카를로는 "상대가 아무 패나 들고, 카드를 공짜로 다 본다"를 가정해 과하게 낙관적이다.
        //    플랍·턴은 드로우 몫을 남기려 몬테카를로와 섞고, 리버는 레인지 강도를 그대로 쓴다.
        if (persona.proStrategy && street >= 2 && toCall > 0 && this.communityCards.length >= 3) {
            try {
                const _bf = toCall / Math.max(bb, totalPot - toCall);
                const _ag = HandRead.summarizeVillain(this.actionLog, this.lastAggressorBefore(street + 1) || '').aggroStreets || 1;
                const _mc = _v3p ? this.equityVsRangeMC(nick, _bf, _ag) : null;
                if (_mc != null) {
                    // 벳 범위의 패 하나하나와 끝까지 깔아 본 승률 — 드로우 몫이 제대로 들어간다(예전 혼합식은 턴 플러시 드로우를 15%로 봤다).
                    // 벳한 사람 말고도 남은 상대가 있으면 그 사람들도 이겨야 한다. 포지션·남은 스트리트에 따른 실현율은 그대로 깎는다.
                    const _oppAll = this.playerOrder.filter(n => n !== nick && this.players[n] && !this.players[n].isFolded).length;
                    const _others = Math.max(0, _oppAll - 1);
                    const _vs = _others > 0 ? _mc * Math.pow(Math.max(0.01, Math.min(1, rawEquity)), _others / _oppAll) : _mc;
                    eqReal = _vs * Postflop.realizationFactor({ street, inPosition: this.isInPosition(nick), nOpp: 1, hasDraw: isDraw, allIn: toCall >= p.chips });
                } else {
                    const share = this.equityVsBettingRange(nick, _bf, _ag);
                    if (share != null) eqReal = RangeEq.blendWithDraws(share, eqReal, street);
                }
            } catch (e) {}
        }
        const margin = eqReal - potOdds;
        this._lastBotEdge = eqReal - callThresh; // 🤖 콜 문턱과의 거리 = 고민의 깊이 (생각 시간에 반영)

        // 🎯 [GTO 올인 콜] 콜 비용이 내 스택의 큰 비중(올인성)이면 팟오즈 기준 엄격 판단
        //    토너먼트 생존이 걸린 콜이므로, equity가 팟오즈를 충분히 상회할 때만 콜
        const callCostRatio = p.chips > 0 ? toCall / p.chips : 1;
        const isBigCall = callable && (callCostRatio >= 0.7 || toCall >= p.chips); // 스택 70%+ 또는 올인
        if (isBigCall) {
            // 실제 콜 시점의 정확한 팟오즈 (이미 위에서 potOdds 계산됨)
            // GTO 기본: equity > potOdds 면 +EV 콜. 단 토너먼트 생존 가치(ICM) 반영해 약간의 여유(+0.03) 요구
            const requiredEdge = (toCall >= p.chips) ? 0.04 : 0.02; // 풀 올인은 더 엄격(생존 가치)
            // 🛡️ 방어 문턱(상대 성향 반영) + ICM 여유. 올인이라 유효스택≈0 → 임플라이드는 자동 0.
            if (equity >= callThresh + requiredEdge) {
                // 매우 강하면 레이즈(재올인), 아니면 콜
                if (equity > (persona.proStrategy ? Postflop.stackOffThreshold(sprBehind) : 0.72) && p.chips > toCall) {
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

        // 🪤 [트랩 발동] 이번 스트리트에 체크레이즈를 노리고 체크했는데 벳이 들어옴 → 응징 레이즈
        //    (표준 사이징: 상대 벳의 ~3배 + 팟 고려. 85%는 레이즈, 15%는 콜 유지로 밸런스)
        if (p._trapStreet === this.gameStage && equity > persona.valueThresh && callable) {
            p._trapStreet = -1; // 1회성 — 발동 후 해제
            if (Math.random() < 0.85) {
                const minRaiseTo = this.currentHighestBet + this.lastFullRaiseAmount;
                const target = Math.min(p.currentBet + p.chips, raiseToAmount(this.currentHighestBet, this.pot, minRaiseTo));
                if (target >= minRaiseTo && target > this.currentHighestBet) {
                    return { type: 'raise', amount: target };
                }
            }
            return { type: 'call' };
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
            // 🃏 블로커 반영 — 넛 차단 카드를 쥐면 세미블러프 레이즈도 더 통한다
            const semiBluff = persona.bluffFreq * bluffMod * 0.7 * Blockers.bluffBlockerMult(p.hand, this.communityCards, skill);
            // 웻 보드에서 드로우성(중간 에퀴티) 세미블러프 강화
            const drawBoost = (board && board.wet && equity > 0.3) ? 1.4 : 1.0;
            if (r < semiBluff * drawBoost && equity > 0.28 && callable && street < 4 && p.chips > bb * 4) {
                const target = Math.min(p.currentBet + p.chips, this.currentHighestBet + sizeBet(1.0));
                if (target >= this.currentHighestBet + this.lastFullRaiseAmount) return { type: 'raise', amount: target };
            }
            // 🛡️ [방어] 팟오즈엔 못 미쳐도 방어 문턱(임플라이드 오즈/블러프 캐치)을 넘으면 콜.
            //    딥스택 드로우 추격, 공격적 상대의 벳 콜다운이 여기서 살아난다.
            if (callable && eqReal >= callThresh) return { type: 'call' };
            // 🃏 [리버 블러프캐치] 리버엔 드로우가 없다 — 이겼거나 졌거나다.
            //    상대가 공격적일수록 블러프 비중이 높고, 내가 넛을 막고 있으면 상대 밸류가 적다.
            //    고수의 콜다운이 여기서 나온다.
            if (street >= 4 && callable && persona.proStrategy) {
                const need = Postflop.bluffCatch({
                    potOdds, oppAggression: oppAggr, skill,
                    blockerMult: Blockers.bluffBlockerMult(p.hand, this.communityCards, skill)
                });
                if (equity >= need) return { type: 'call' };
            }
            // 콜링스테이션 성격이면 여전히 끈적하게 콜(성격 반영)
            if (persona.callSticky && margin > -0.14 && r < 0.5) return { type: 'call' };
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
            // 🛡️ [익스플로잇] 좀처럼 안 치는 정직한 상대가 큰 벳을 하면 방어 문턱이 올라간다 —
            //    승률이 그에 못 미치면 마진이 양수여도 폴드. 고수 봇일수록 이 절제를 잘 한다.
            if (callable && eqReal < callThresh - 0.02 && r < 0.7 * skill) return { type: 'fold' };
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

    // 🃏 쇼다운 공개 순서 (정식 규칙).
    //    마지막 스트리트에 벳/레이즈가 있었으면 그 마지막 공격자가 먼저 깐다.
    //    없었으면(체크로 끝났으면) 딜러 다음 자리의 생존자부터. 이후 시계방향.
    showdownOrder() {
        const n = this.playerOrder.length;
        if (n === 0) return [];
        const live = this.playerOrder.filter(x => this.players[x] && !this.players[x].isFolded);
        if (live.length === 0) return [];
        const liveSet = new Set(live);

        let startIdx = -1;
        const log = this.actionLog || [];
        for (let i = log.length - 1; i >= 0; i--) {
            const a = log[i];
            if (a && (a.type === 'raise' || a.type === 'allin') && liveSet.has(a.nick)) {
                startIdx = this.playerOrder.indexOf(a.nick);
                break;
            }
        }
        if (startIdx < 0) {
            for (let i = 0; i < n; i++) {
                const idx = (this.dealerIndex + 1 + i) % n;
                if (liveSet.has(this.playerOrder[idx])) { startIdx = idx; break; }
            }
        }
        if (startIdx < 0) startIdx = 0;

        const order = [];
        for (let i = 0; i < n; i++) {
            const nick = this.playerOrder[(startIdx + i) % n];
            if (liveSet.has(nick)) order.push(nick);
        }
        return order;
    }

    // 🎯 [벳 레인지 대비 강도] 상대가 벳을 했다면 아무 패나 들고 있는 게 아니다.
    //    이 보드에서 벳할 만한 패(상위 N%)만 상대로 내 핸드가 몇 %를 이기는지 센다.
    //    몬테카를로(랜덤 상대 가정)는 7-8-2 보드의 AK 하이를 52.7%로 평가한다 — 그래서
    //    봇이 벳에 5~13%밖에 안 접었다. 벳 레인지 대비로 재면 24%로 떨어진다.
    //    반환: 0~1, 계산 불가(보드 없음 등)면 null.
    // 🔬 A/B 측정용 스위치. BOT_AB 가 없으면(운영) 고수 봇 전원이 새 전략을 쓴다.
    //    BOT_AB=1 이면 닉네임 해시 비트로 절반만, 2 면 반대쪽 절반만 — 같은 테이블에서 신·구 전략을 맞붙여 잰다.
    // 🔬 학습 조언 점검(드로우 판정·벳 범위 상대 승률·림퍼 크기)을 봇에 옮긴 것의 측정 스위치. 운영에선 항상 켜짐.
    botV3(nick) {
        const ab = process.env.BOT_AB3;
        if (!ab) return true;
        const bit = ((this.hashNick(nick) >> 4) & 1) === 1;
        return ab === '2' ? !bit : bit;
    }

    // 🔬 외부 솔버 자료에 맞춘 방어 기준(BB 방어·3벳 폭, SB 3벳-폴드)을 고수 봇에 옮긴 것의 측정 스위치. 운영에선 항상 켜짐.
    botV4(nick) {
        const ab = process.env.BOT_AB4;
        if (!ab) return true;
        const bit = ((this.hashNick(nick) >> 4) & 1) === 1;
        return ab === '2' ? !bit : bit;
    }

    // 🔬 프리플랍 범위표(블라인드 방어)를 고수 봇에 쓰는 것의 측정 스위치. 측정 결과에 따라 BOT_CHART_DEFAULT 로 운영 기본값을 정한다.
    botV6(nick) {
        const ab = process.env.BOT_AB6;
        if (!ab) return BOT_CHART_DEFAULT;
        const bit = ((this.hashNick(nick) >> 4) & 1) === 1;
        return ab === '2' ? !bit : bit;
    }
    botV10(nick) {
        const ab = process.env.BOT_AB10;
        if (!ab) return BOT_JAM_DEFAULT;
        const bit = ((this.hashNick(nick) >> 4) & 1) === 1;
        return ab === '2' ? !bit : bit;
    }
    // 🧨 [올인 계산] 지금 자리에서 내가 올인하면: 그 패의 기대값(bb, 접는 것 대비) · 기대값 순위(위에서 몇 %) · 균형에서 미는 범위.
    //    아직 아무도 안 열었으면 푸시, 한 명이 열었으면 리쉬브(연 사람은 그 자리의 오픈 범위를 들고 있다고 본다). 그 밖(3벳 이상·이미 올인한 사람 있음)은 null.
    jamInfo(nick, code) {
        if (!Jam.load()) return null;
        const p = this.players[nick], bb = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;
        const raises = this.raiseCountThisStreet || 0;
        if (!p || raises >= 2) return null;
        const idx = this.playerOrder.indexOf(nick), n = this.playerOrder.length, callers = [], hu = n === 2;
        for (let k = 1; k < n; k++) {
            const q = this.players[this.playerOrder[(idx + k) % n]];
            if (!q || q.isFolded) continue;
            if (q.isAllIn || q.chips <= 0) return null;
            const opener = (q.currentBet || 0) === this.currentHighestBet && this.currentHighestBet > bb;
            let prior = null, tag = '';
            if (opener) {
                tag = 'o' + (hu ? 'HU' : Ranges.dataPos(q.position || ''));
                prior = OPEN_PRIOR[tag];
                if (!prior) {
                    const x = hu ? 0.76 : ShortStack.openPct(q.position || '');
                    prior = Float64Array.from(Ranges.ALL.map(c => { const f = hu ? null : Ranges.openFreq(q.position || '', c); return f != null ? f / 100 : (ShortStack.handPercentile(c) <= x ? 1 : 0); }));
                    OPEN_PRIOR[tag] = prior;
                }
            }
            callers.push({ stack: (q.chips + (q.currentBet || 0)) / bb, posted: (q.currentBet || 0) / bb, prior, tag });
        }
        if (!callers.length || callers.length > 5) return null;
        if (raises === 1 && !callers.some(c => c.prior)) return null;
        const pot = (this.pot + Object.keys(this.players).reduce((a, k) => a + (this.players[k].currentBet || 0), 0)) / bb;
        const res = Jam.solveCached({ pot, hero: { stack: (p.chips + (p.currentBet || 0)) / bb, posted: (p.currentBet || 0) / bb }, callers });
        if (!res) return null;
        return { ev: res.ev[Jam.load().idx[code]], rank: Jam.rankOf(res, code), range: res.jamPct, res };
    }
    // 🔬 리버 계산을 고수 봇에 쓰는 것의 측정 스위치(BOT_AB9). 측정 결과로 BOT_RIVER_DEFAULT 를 정한다.
    botV9(nick) {
        const ab = process.env.BOT_AB9;
        if (!ab) return BOT_RIVER_DEFAULT;
        const bit = ((this.hashNick(nick) >> 4) & 1) === 1;
        return ab === '2' ? !bit : bit;
    }
    // 🔬 솔버 턴 자료를 고수 봇에 쓰는 것의 측정 스위치(BOT_AB7). 측정 결과로 BOT_TURN_DEFAULT 를 정한다.
    botV7(nick) {
        const ab = process.env.BOT_AB7;
        if (!ab) return BOT_TURN_DEFAULT;
        const bit = ((this.hashNick(nick) >> 4) & 1) === 1;
        return ab === '2' ? !bit : bit;
    }
    // 🔬 솔버 플랍 자료를 고수 봇에 쓰는 것의 측정 스위치. 운영에선 항상 켜짐.
    botV5(nick) {
        const ab = process.env.BOT_AB5;
        if (ab === 'off') return false;
        if (!ab) return true;
        const bit = ((this.hashNick(nick) >> 4) & 1) === 1;
        return ab === '2' ? !bit : bit;
    }

    botV2(nick) {
        const ab = process.env.BOT_AB;
        if (!ab) return true;
        const bit = ((this.hashNick(nick) >> 4) & 1) === 1;
        return ab === '2' ? !bit : bit;
    }

    // 🤖 [반복 올인 읽기] 프리플랍에 깊은 스택으로 올인한 횟수 / 받은 핸드 수.
    //    예전엔 30bb 올인을 늘 "아주 좁은 레인지"로 읽어 거의 다 접었다 → 매 핸드 올인하면 블라인드를 공짜로 가져갔다.
    //    증강 런에서는 층이 바뀌어도(방이 새로 생겨도) 이어지도록 런에 적어 둔다.
    // 🏆 [ICM] 입상이 걸린 대회(파이널나인 연습)에서 "더 이상 벳이 없는 콜"(내가 올인되거나 상대가 올인)의 상금 기준 필요 승률.
    //    칩 기준 필요 승률(팟오즈)과의 차이(tax)가 곧 상금 압박이다. 대상이 아니면 null.
    //    potAfter: 콜한 뒤 이긴 쪽이 가져갈 팟(내 콜 포함). 상금 비율은 Icm.payoutsFor(입상 인원) — 3명이면 50/30/20(가정값).
    icmCall(nick, toCall, potAfter) {
        const m = this._mtt, p = this.players[nick];
        if (!m || !(m.paid > 0) || !p || !(toCall > 0)) return null;
        if (m.rebuyMax > 0 && m.blindLevel < m.rebuyUntilLevel) return null;    // 리바인이 열려 있는 동안은 탈락이 끝이 아니다
        const vn = this.playerOrder.find(n => n !== nick && this.players[n] && !this.players[n].isFolded && (this.players[n].currentBet || 0) === this.currentHighestBet);
        const v = vn ? this.players[vn] : null;
        if (!v || !(toCall >= p.chips || v.chips === 0)) return null;            // 뒤에 벳이 더 남는 콜은 이 계산의 대상이 아니다
        const others = [];
        (m.tables || []).forEach(rid => {
            const r = rooms.get(rid); if (!r) return;
            r.playerOrder.forEach(n => { if (n === nick || n === vn) return; const q = r.players[n], s = q ? (q.chips || 0) + (q.currentBet || 0) : 0; if (s > 0) others.push(s); });
        });
        if (others.length > 40) return null;
        const r = Icm.callReq({ hero: p.chips, vill: v.chips, toCall, potAfter, others, payouts: Icm.payoutsFor(m.paid) });
        return { req: r.req, chip: r.chip, tax: r.tax, alive: others.length + 2, paid: m.paid };
    }

    // 🏆 [ICM] 내가 먼저 올인(푸시)하는 범위가 상금 기준으로 몇 배가 되나(1 = 그대로). 대상이 아니면 null.
    //    base: 칩 기준 푸시 범위(0~1), behind: 내 뒤에 남은 사람들. 계산은 lib/icm.js 의 pushShift(칩 기준·상금 기준을 같은 모형으로 풀어 그 비율만 쓴다).
    icmPush(nick, base, behind) {
        const m = this._mtt, p = this.players[nick];
        if (!m || !(m.paid > 0) || !p || !behind || !behind.length) return null;
        if (m.rebuyMax > 0 && m.blindLevel < m.rebuyUntilLevel) return null;
        const inHand = new Set([nick].concat(behind)), others = [];
        (m.tables || []).forEach(rid => {
            const r = rooms.get(rid); if (!r) return;
            r.playerOrder.forEach(n => { if (inHand.has(n) && r === this) return; const q = r.players[n], s = q ? (q.chips || 0) + (r === this ? 0 : (q.currentBet || 0)) : 0; if (s > 0) others.push(s); });
        });
        if (others.length + behind.length + 1 <= 2 || others.length > 40) return null;      // 헤즈업은 차이가 없다
        const dead = this.pot + Object.keys(this.players).reduce((a, n) => a + (this.players[n].currentBet || 0), 0);
        if (!this._icmHands) this._icmHands = Ranges.ALL.map(code => ({ code, w: Ranges.combos(code) }));
        const r = Icm.pushShift({ stack: p.chips + (p.currentBet || 0), posted: p.currentBet || 0, dead,
            callers: behind.map(n => ({ stack: this.players[n].chips + (this.players[n].currentBet || 0), posted: this.players[n].currentBet || 0 })),
            others, payouts: Icm.payoutsFor(m.paid), base, hands: this._icmHands, eqVs: ShortStack.equityVs });
        const ratio = Math.max(0.35, Math.min(2.5, r.ratio));
        if (process.env.DEV_ICMLOG) console.log('ICMLOG push ' + JSON.stringify({ n: nick, base: Math.round(base * 100), chip: Math.round(r.chip * 100), icm: Math.round(r.icm * 100), ratio: Math.round(ratio * 100) / 100, alive: others.length + behind.length + 1 }));
        return { ratio, alive: others.length + behind.length + 1, paid: m.paid };
    }

    jamStat(nick) {
        const ch = this._challenge;
        if (ch && ch.run && ch.nick === nick) return (ch.run.jam = ch.run.jam || { h: 0, j: 0 });
        const p = this.players[nick];
        if (!p) return { h: 0, j: 0 };
        return (p._jam = p._jam || { h: 0, j: 0 });
    }

    // 🤖 [숏스택 푸시/폴드 + 올인 콜]
    //    반환: 결정 객체, 또는 null(일반 프리플랍 로직에 맡김)
    shortStackDecision(nick, c) {
        const p = this.players[nick];
        const { code, toCall, bb, totalPot, facingRaise, isBB } = c;
        const live = this.playerOrder.filter(n => n !== nick && this.players[n] && !this.players[n].isFolded);
        if (!live.length) return null;
        const stackOf = n => this.players[n].chips + (this.players[n].currentBet || 0);
        const myStack = p.chips + p.currentBet;
        const effBB = Math.min(myStack, Math.max(...live.map(stackOf))) / bb;
        const pct = ShortStack.handPercentile(code);
        const allInTo = p.currentBet + p.chips;
        const shove = () => (allInTo > this.currentHighestBet ? { type: 'raise', amount: allInTo } : { type: 'call' });
        const isTourney = this.mode !== 'cash';
        const raises = this.raiseCountThisStreet || 0;

        // 마지막으로 레이즈한 사람(=지금 최고액을 낸 사람)
        const aggr = live.find(n => (this.players[n].currentBet || 0) === this.currentHighestBet && this.currentHighestBet > bb) || null;
        const aggrP = aggr ? this.players[aggr] : null;
        const aggrAllIn = !!(aggrP && (aggrP.isAllIn || aggrP.chips === 0));

        // ── (가) 올인(또는 내 스택의 큰 몫)을 받아야 하는 상황 ──
        //    "아무 패 상대 승률"이 아니라 "올인하는 사람의 레인지 상대 승률"로 판단한다.
        if (facingRaise && toCall > 0 && (toCall >= p.chips * 0.4 || (aggrAllIn && toCall >= bb * 3))) {
            const aggrBB = aggr ? stackOf(aggr) / bb : effBB;
            let x;
            if (aggrAllIn) x = ShortStack.shoverPct(aggrBB, Math.max(1, live.length), raises);
            else x = raises >= 3 ? 0.03 : raises === 2 ? 0.07 : ShortStack.openPct(aggrP ? aggrP.position : '');
            // 상대 성향 반영: 평소에 많이 넣는 사람은 레인지가 넓다
            const rd = this.getPrimaryOpponentRead ? this.getPrimaryOpponentRead(nick) : null;
            if (rd && rd.aggression != null) x *= rd.aggression > 0.55 ? 1.3 : (rd.aggression < 0.2 ? 0.8 : 1);
            // 이 방에서 실제로 본 올인 빈도가 더 넓으면 그쪽을 믿는다 (두 번 이상 밀었고 세 핸드 이상 봤을 때부터)
            if (aggr && aggrAllIn) { const js = this.jamStat(aggr); if (js.j >= 2 && js.h >= 3) x = Math.max(x, Math.min(1, js.j / js.h)); }
            const potOdds = toCall / (totalPot + toCall);
            // 토너먼트는 탈락하면 끝이라 조금 더 요구한다. 뒤에 사람이 남았으면 더.
            const behind = live.filter(n => n !== aggr && !this.players[n].isAllIn && !this.players[n].hasActed).length;
            // 🏆 입상이 걸린 대회에서는 봇도 상금 기준(ICM)으로 받는다 — 버블에서 아무 올인이나 받아 주지 않게
            let icmTax = 0;
            try { const tc = Math.min(toCall, p.chips), ic = this.icmCall(nick, tc, totalPot + tc); if (ic) icmTax = Math.max(0, ic.tax); if (ic && process.env.DEV_ICMLOG) console.log('ICMLOG bot ' + JSON.stringify(Object.assign({ n: nick, call: tc, chips: p.chips }, ic))); } catch (e) {}
            const edge = Math.max(isTourney ? 0.025 : 0, icmTax) + behind * 0.02;
            const res = ShortStack.shouldCallShove(code, Math.min(1, x), potOdds, edge);
            this._lastBotEdge = res.equity - potOdds - edge;
            if (!res.call) return { type: 'fold' };
            // 받을 만한 패인데 내 칩이 남으면 — 아주 강할 때만 얹어 올인, 아니면 콜
            if (p.chips > toCall && res.equity > 0.60) return shove();
            return { type: 'call' };
        }

        // ── (나) 12bb 이하: 올인 아니면 폴드 ──
        if (effBB <= 12) {
            if (!facingRaise) {
                const behind = Math.max(1, live.filter(n => !this.players[n].hasActed && !this.players[n].isAllIn).length);
                const limped = live.some(n => (this.players[n].currentBet || 0) >= bb && this.players[n].hasActed);
                let range = ShortStack.pushPct(effBB, behind) * (limped ? 0.8 : 1), rank = pct;
                // 🧨 어림표 대신 지금 스택·앤티·뒤 사람들의 칩으로 직접 푼 균형을 쓴다
                if (this.botV10(nick)) { try { const ji = this.jamInfo(nick, code); if (ji) { range = ji.range * (limped ? 0.8 : 1); rank = ji.rank; } } catch (e) {} }
                // 🏆 입상이 걸린 대회에서는 상금 기준으로 범위를 넓히거나 좁힌다
                try { const ip = this.icmPush(nick, range, live.filter(n => !this.players[n].hasActed && !this.players[n].isAllIn)); if (ip && Math.abs(ip.ratio - 1) >= 0.12) range = Math.max(0.03, Math.min(1, range * ip.ratio)); } catch (e) {}
                if (rank <= range) return shove();
                if (toCall === 0) return { type: 'check' };              // BB 무료 체크
                if (isBB && toCall <= bb * 0.5) return null;              // 거의 공짜면 평소대로
                return { type: 'fold' };
            }
            // 오픈을 마주함 → 리쉬브 아니면 폴드 (숏스택 콜은 플랍에서 할 수 있는 게 없다)
            const openX = raises >= 2 ? 0.07 : ShortStack.openPct(aggrP ? aggrP.position : '');
            let jr = null;
            if (this.botV10(nick)) { try { jr = this.jamInfo(nick, code); } catch (e) {} }
            if (jr ? jr.ev > 0 : pct <= ShortStack.reshovePct(openX, effBB)) return shove();
            if (isBB && toCall <= bb * 1.5 && effBB >= 6) return null;    // BB 는 싸게 볼 수 있으면 평소 방어
            return { type: 'fold' };
        }

        // ── (다) 13~20bb: 늦은 포지션 스틸에 리쉬브 (스택 대비 팟이 커서 접게 만들면 큰 이득) ──
        if (effBB <= 25 && facingRaise && raises <= 1 && aggrP && !aggrAllIn) {
            let jr = null;
            if (this.botV10(nick)) { try { jr = this.jamInfo(nick, code); } catch (e) {} }
            if (jr) { if (jr.ev > (effBB <= 20 ? 0.3 : 1) && Math.random() < 0.85) return shove(); }
            else if (effBB <= 20) {
                const openX = ShortStack.openPct(aggrP.position);
                if (pct <= ShortStack.reshovePct(openX, effBB) && Math.random() < 0.75) return shove();
            }
        }
        return null;
    }

    equityVsBettingRange(nick, betFrac, aggroStreets) {
        const p = this.players[nick];
        const cc = this.communityCards;
        if (!p || !p.hand || p.hand.length !== 2 || !cc || cc.length < 3) return null;
        const known = new Set([...cc, ...p.hand]);
        const pool = FULL_DECK.filter(c => !known.has(c));
        const ORDER = '23456789TJQKA';
        const score = cards => {
            const h = Hand.solve(cards);
            return RangeEq.handScore(h.rank, h.cards.map(c => ORDER.indexOf(c.value === '10' ? 'T' : c.value)));
        };
        let mine;
        try { mine = score(p.hand.concat(cc)); } catch (e) { return null; }
        // 후보 조합 표본 (전수는 990개라 비싸다 — 무작위 220개면 충분히 안정적)
        const SAMPLES = 220;
        const opp = [];
        for (let i = 0; i < SAMPLES; i++) {
            const a = pool[Math.floor(Math.random() * pool.length)];
            let b = pool[Math.floor(Math.random() * pool.length)];
            if (a === b) continue;
            try { opp.push(score([a, b].concat(cc))); } catch (e) {}
        }
        if (opp.length < 40) return null;
        const top = RangeEq.bettingRangeTop({ street: this.gameStage, betFrac, aggroStreets });
        return RangeEq.shareBeaten(mine, opp, top);
    }

    // 🎓 [학습 조언용] 벳하는 범위를 상대로 한 "진짜 승률" — 남은 카드를 실제로 깔아 본다.
    //    예전엔 "지금 이 순간 상대 범위를 이기는 비율"에 아무 패 상대 승률을 조금 섞었다. 그 계산은 드로우를 거의 0으로 쳐서,
    //    턴의 플러시 드로우(9아웃, 실제 약 18~20%)가 15%로 나왔다. 여기서는 상대 범위의 패 하나하나와 끝까지 가 본다.
    //    상대 범위 = 지금 보드에서 강한 순 상위 top(벳 크기·스트리트에 따라) + 그 밖의 패 일부(블러프·드로우).
    // 🧮 지금이 솔버로 풀어 둔 상황인가 → { spot, node } 또는 null. (풀어 둔 상황 목록: tools/solver/spots.js)
    //    공통 조건: 플랍 · 둘만 남음 · 둘 다 올인 아님.
    //    · 단일 레이즈 팟(오픈 → BB 콜): 뒷자리(btn) · 앞자리(utg) · 헤즈업(hu), 스택 깊이별(100 / 40 / 25bb)
    //    · 블라인드 대결(sbb): SB 오픈 → BB 콜 — 오픈한 SB 가 먼저 행동한다
    //    · 3벳 팟: 3벳한 쪽이 먼저 행동(tbo) · 나중에 행동(tbi) · 헤즈업(hutb)
    solverSpot(nick, toCall, potBefore, effBB) {
        const stg = this.gameStage;
        if (process.env.NO_SOLVER || (stg !== 2 && stg !== 3) || this.communityCards.length !== stg + 1 || effBB < 18) return null;
        if (stg === 3 && process.env.NO_SOLVER_TURN) return null;
        const live = this.playerOrder.filter(n => this.players[n] && !this.players[n].isFolded);
        if (live.length !== 2 || !live.includes(nick)) return null;
        const vill = live.find(n => n !== nick), log = this.actionLog || [];
        if (this.players[nick].isAllIn || this.players[vill].isAllIn) return null;
        const raisers = log.filter(a => a.street === 1 && (a.type === 'raise' || a.type === 'allin')).map(a => a.nick);
        if (!raisers.length || raisers.length > 2 || raisers.some(n => n !== nick && n !== vill)) return null;
        const role = n => (this.players[n].role || ''), hu = this.playerOrder.length === 2;
        const depth = effBB >= 70 ? '' : effBB >= 32 ? '40' : '25';
        const oopNick = this.isInPosition(nick) ? vill : nick;        // 플랍에서 먼저 행동하는 사람
        let spot = null;
        if (raisers.length === 1) {
            const opener = raisers[0], caller = opener === nick ? vill : nick;
            if (!role(caller).includes('BB')) return null;
            if (hu) spot = 'hu' + depth;
            else if (role(opener).includes('SB')) spot = 'sbb' + depth;
            else if (role(opener).includes('BB')) return null;
            else { const op = this.players[opener].position || ''; spot = ((op.indexOf('UTG') === 0 || op === 'HJ' || op === 'LJ' || op === 'MP') ? 'utg' : op === 'CO' ? 'co' : 'btn') + depth; }
        } else {
            if (raisers[0] === raisers[1] || depth !== '') return null;     // 3벳 팟은 깊은 스택만 풀어 두었다
            const threeBettor = raisers[1];
            spot = hu ? (threeBettor === oopNick ? 'hutb' : null) : (threeBettor === oopNick ? 'tbo' : 'tbi');
        }
        if (!spot) return null;
        const seq = st => log.filter(a => a.street === st).map(a => (a.nick === nick ? 'H' : 'V') + (a.type === 'check' ? 'x' : (a.type === 'raise' || a.type === 'allin') ? 'b' : a.type === 'call' ? 'c' : 'f')).join(' ');
        const fl = seq(2);
        const big = toCall > 0 && toCall / Math.max(1, potBefore - toCall) > 0.5;
        let node = null;
        if (stg === 3) {
            // 턴: 플랍이 "체크-체크" 또는 "체크-벳-콜"로 지나간 판만 풀어 두었다
            const me = nick === oopNick ? 'O' : 'I';
            const rel = fl.split(' ').map(x => (x[0] === 'H' ? me : (me === 'O' ? 'I' : 'O')) + x[1]).join(' ');
            let line = null;
            if (rel === 'Ox Ix') line = 'xx';
            else if (rel === 'Ox Ib Oc') {
                const b = log.filter(a => a.street === 2)[1];
                line = b && b.amount / Math.max(1, (b.pot || 0) - b.amount) > 0.5 ? 'xbc_b' : 'xbc_s';
            }
            if (!line) return null;
            const tl = seq(3);
            if (nick === oopNick) { if (tl === '' && toCall === 0) node = 't_oop'; else if (tl === 'Hx Vb') node = 't_oop_vs'; }
            else { if (tl === 'Vx' && toCall === 0) node = 't_ip'; else if (tl === 'Vb') node = 't_ip_vs'; }
            return node ? { spot, node, line, turn: true } : null;
        }
        if (nick === oopNick) {                    // 내가 먼저 행동
            if (fl === '' && toCall === 0) node = 'oop_root';
            else if (fl === 'Hx Vb') node = big ? 'oop_vs_b' : 'oop_vs_s';
        } else {                                   // 내가 나중에 행동
            if (fl === 'Vx' && toCall === 0) node = 'ip_cbet';
            else if (fl === 'Vb') node = big ? 'ip_vs_b' : 'ip_vs_s';
            else if (fl === 'Vx Hb Vb') node = 'ip_xr';
        }
        return node ? { spot, node } : null;
    }
    // 🌊 [리버 계산] 둘만 남은 리버에서 양쪽 범위를 만들어 그 자리에서 푼다 → 내 패의 빈도와 액션별 기대값(칩).
    //    범위 = 프리플랍 행동으로 낸 무게 × 플랍·턴에 한 행동마다 "그 종류의 패가 그렇게 칠 확률"(lib/rangetrack.js).
    //    다루는 자리: 내가 먼저(체크/벳) · 상대 체크 뒤(체크/벳) · 벳 받기(폴드/콜). 레이즈가 낀 리버는 다루지 않는다.
    riverAdvice(nick, toCall) {
        // 📊 실측(2026-10-10, scratch/verify.sh): 켜면 나빠진다 — 조언대로 치는 가상 플레이어(헤즈업, 각 약 7만 판) 켬 − 끔 = −13.7 ± 5.0 bb/100 (6인은 +4.3 ± 14.6),
        //    봇 맞대결은 −10.4 ± 8.6 · −6.9 ± 8.3 으로 두 번 다 나쁜 쪽. 계산 자체는 교과서 문제를 정확히 풀지만(test/riversolve.test.js)
        //    넣어 주는 양쪽 범위가 행동만으로는 거의 좁혀지지 않는다(아무 패 대비 1.6배). 그래서 꺼 둔다(RIVER_SOLVER=1 로 켜서 다시 잴 수 있다).
        if ((process.env.RIVER_SOLVER !== '1' && !process.env.DEV_RLOG) || this.gameStage !== 4 || this.communityCards.length !== 5) return null;
        const p = this.players[nick];
        const live = this.playerOrder.filter(n => this.players[n] && !this.players[n].isFolded);
        if (!p || !p.hand || p.hand.length !== 2 || live.length !== 2 || !live.includes(nick)) return null;
        const vill = live.find(n => n !== nick), v = this.players[vill];
        if (p.isAllIn || v.isAllIn || !(this.pot > 0)) return null;
        const key = this.advKey(nick);
        if (this._riverCache && this._riverCache.key === key && this._riverCache.nick === nick) return this._riverCache.res;
        const oopNick = this.isInPosition(nick) ? vill : nick, meO = nick === oopNick;
        const log = this.actionLog || [];
        const seqOf = st => log.filter(a => a.street === st && (a.nick === nick || a.nick === vill) && ['check', 'call', 'raise', 'allin', 'fold'].includes(a.type)).map(a => {
            const bet = a.type === 'raise' || a.type === 'allin';
            return { who: a.nick === oopNick ? 'O' : 'I', type: a.type === 'check' ? 'x' : bet ? 'b' : a.type === 'call' ? 'c' : 'f', frac: bet ? a.amount / Math.max(1, (a.pot || 0) - a.amount) : 0 };
        });
        const rv = seqOf(4).map(a => a.who + a.type).join(' ');
        let node = null;
        if (meO) { if (rv === '' && toCall === 0) node = 'N0'; else if (rv === 'Ox Ib' && toCall > 0) node = 'N3'; }
        else { if (rv === 'Ox' && toCall === 0) node = 'N1'; else if (rv === 'Ob' && toCall > 0) node = 'N2'; }
        if (!node) return null;
        const fl = RangeTrack.actsOfStreet('flop', seqOf(2)), tn = RangeTrack.actsOfStreet('turn', seqOf(3));
        const side = n => (n === oopNick ? 'O' : 'I');
        const rangeOf = (n, mine) => RangeTrack.build({ board: this.communityCards, dead: mine ? [] : p.hand, pre: this.villainRangeWeights(n) || null,
            acts: fl[side(n)].concat(tn[side(n)]), keep: mine ? p.hand : null, max: 80 }, handToCode);
        // 🔬 [검증용 · DEV_RLOG] 범위 추정이 맞는가: 상대의 실제 패에 준 확률을 "아무 패"·"프리플랍만"·"플랍·턴 행동까지" 세 가지로 견준다
        if (process.env.DEV_RLOG && (v.hand || []).length === 2) {
            try {
                const pre = this.villainRangeWeights(vill) || null, acts = fl[side(vill)].concat(tn[side(vill)]);
                const full = RangeTrack.build({ board: this.communityCards, dead: p.hand, pre, acts, max: 2000 }, handToCode);
                const preOnly = RangeTrack.build({ board: this.communityCards, dead: p.hand, pre, acts: [], max: 2000 }, handToCode);
                const is = h => (h[0] === v.hand[0] && h[1] === v.hand[1]) || (h[0] === v.hand[1] && h[1] === v.hand[0]);
                const pOf = r => { const e = r.find(x => is(x.hand)); return e ? e.w : 1e-5; };
                const bbR = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb, stackR = Math.min(p.chips + (p.currentBet || 0), v.chips + (v.currentBet || 0));
                const pl0 = (this.actionLog || []).filter(x => x.street === 1), rs = pl0.filter(x => x.type === 'raise' || x.type === 'allin').map(x => x.nick);
                console.log('RLOG ' + JSON.stringify({ bot: !!v.isBot, lvl: v.isBot ? (v.difficulty || '') : '', n: full.length, u: 1 / 990, pre: pOf(preOnly), full: pOf(full),
                    acts: acts.map(a => a.street[0] + (a.oop ? 'O' : 'I') + (a.facing || '-') + a.act).join(' '), node,
                    vh: v.hand, hh: p.hand, bd: this.communityCards, A: acts, hu: this.playerOrder.length === 2, vPos: v.position || '', vBB: !!(v.role && v.role.includes('BB')), hBB: !!(p.role && p.role.includes('BB')),
                    opener: rs[0] === vill ? 'v' : rs[0] === nick ? 'h' : 'x', raises: rs.length, openerPos: rs[0] && this.players[rs[0]] ? (this.players[rs[0]].position || '') : '',
                    line: VRange.lineFromLog(pl0, vill, bbR, n => (this.players[n] && this.players[n].position) || ''), vInPos: this.isInPosition(vill), effBB: Math.round(stackR / bbR) }));
            } catch (e) {}
        }
        const mineR = rangeOf(nick, true), villR = rangeOf(vill, false);
        if (mineR.length < 5 || villR.length < 5) return null;
        const P = this.pot, stack = Math.min(p.chips + (p.currentBet || 0), v.chips + (v.currentBet || 0));
        const sol = RiverSolve.solve({ board: this.communityCards, pot: P, stack, bet: toCall > 0 ? toCall : undefined, oop: meO ? mineR : villR, ip: meO ? villR : mineR, iters: 220 });
        if (!sol) return null;
        const mineS = meO ? sol.oop : sol.ip, villS = meO ? sol.ip : sol.oop;
        const e = mineS.find(x => (x.hand[0] === p.hand[0] && x.hand[1] === p.hand[1]) || (x.hand[0] === p.hand[1] && x.hand[1] === p.hand[0]));
        if (!e) return null;
        const avg = (xs, f) => xs.reduce((s, x) => s + x.w * f(x), 0);
        const res = { node, bet: sol.bet, pot: P, facing: toCall > 0,
            freq: toCall > 0 ? e.sCall : e.sBet,                                           // 적극 쪽(콜 또는 벳) 빈도
            ev: toCall > 0 ? { fold: 0, call: e.evCall } : { check: e.evCheck, bet: e.evBet },
            rangeFreq: toCall > 0 ? avg(mineS, x => x.sCall) : avg(mineS, x => x.sBet),      // 내 범위 전체가 그 액션을 고르는 비율
            villBetFreq: avg(villS, x => x.sBet), nMine: mineR.length, nVill: villR.length };
        this._riverCache = { key, nick, res };
        return res;
    }
    // 🧮 풀어 둔 상황이면 솔버 자료에서 이 패의 빈도를 찾아 온다(플랍·턴). 없으면 null.
    solverLookup(nick, toCall, potBefore, effBB, baseOnly) {
        const p = this.players[nick], ss = this.solverSpot(nick, toCall, potBefore, effBB);
        if (!ss || !p || !p.hand || p.hand.length !== 2) return null;
        const r = ss.turn ? FlopSolve.lookupTurn({ spot: ss.spot, line: ss.line, node: ss.node, hand: p.hand, board: this.communityCards })
            : FlopSolve.lookup({ spot: ss.spot, node: ss.node, hand: p.hand, board: this.communityCards, baseOnly: !!baseOnly });
        return r && r.dist <= 6 ? r : null;
    }
    // 🔍 상대(v)가 이번 판 프리플랍에 한 행동으로 본 범위 — 패 코드 → 무게(0~1). 기록이 없으면 null.
    villainRangeWeights(v) {
        const pl = this.players[v];
        if (!pl) return null;
        const bb = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;
        const acts = VRange.lineFromLog((this.actionLog || []).filter(a => a.street === 1), v, bb, n => (this.players[n] && this.players[n].position) || '');
        if (!acts.length) return null;
        return VRange.weightFn({ pos: pl.position || '', headsUp: this.playerOrder.length === 2, inPosition: this.isInPosition(v), acts });
    }
    //   weightFn(선택): 상대의 프리플랍 범위 무게. 주면 "아무 두 장"이 아니라 그 범위에서 상대 패를 뽑는다(학습 조언·채점용. 봇은 주지 않는다).
    equityVsRangeMC(nick, betFrac, aggroStreets, weightFn) {
        const p = this.players[nick];
        const cc = this.communityCards;
        if (!p || !p.hand || p.hand.length !== 2 || !cc || cc.length < 3) return null;
        const known = new Set([...cc, ...p.hand]);
        const pool = FULL_DECK.filter(c => !known.has(c));
        const ORDER = '23456789TJQKA';
        const score = cards => {
            const h = Hand.solve(cards);
            return RangeEq.handScore(h.rank, h.cards.map(c => ORDER.indexOf(c.value === '10' ? 'T' : c.value)));
        };
        const cand = [];
        for (let i = 0, tries = 0; i < 600 && tries < 9000; tries++) {   // 표본을 넉넉히 — 조언을 보여줄 때와 채점할 때 값이 흔들리지 않게
            const a = pool[Math.floor(Math.random() * pool.length)], b = pool[Math.floor(Math.random() * pool.length)];
            if (a === b) continue;
            if (weightFn && Math.random() > weightFn(handToCode([a, b]))) continue;      // 범위 밖의 패는 그 무게만큼만 뽑힌다
            i++;
            try { cand.push({ h: [a, b], s: score([a, b].concat(cc)) }); } catch (e) {}
        }
        if (cand.length < 60) return null;
        cand.sort((x, y) => y.s - x.s);
        const top = RangeEq.bettingRangeTop({ street: this.gameStage, betFrac, aggroStreets });
        let nTop = Math.max(8, Math.ceil(cand.length * top));
        if (weightFn) {
            // 벳에 필요한 패의 세기는 예전과 같은 기준(아무 두 장의 상위 top)으로 두고, 상대 범위 안에서 그 기준을 넘는 패만 벳 범위로 본다.
            //   (범위를 좁힌 뒤에 또 "그중 상위 top"만 남기면 이중으로 좁혀져서 상대가 세트·투페어만 들고 있는 것처럼 계산된다 — 실측)
            const base = [];
            for (let i = 0; i < 300; i++) {
                const a = pool[Math.floor(Math.random() * pool.length)], b2 = pool[Math.floor(Math.random() * pool.length)];
                if (a === b2) continue;
                try { base.push(score([a, b2].concat(cc))); } catch (e) {}
            }
            if (base.length >= 60) {
                base.sort((x, y) => y - x);
                const thr = base[Math.min(base.length - 1, Math.max(0, Math.ceil(base.length * top) - 1))];
                nTop = Math.max(8, cand.filter(c => c.s >= thr).length);
            }
        }
        const range = cand.slice(0, nTop);
        // 블러프·드로우 몫: 범위 밖의 패를 벳 범위의 25%만큼 섞는다 (리버는 20%)
        const rest = cand.slice(nTop), nBluff = Math.min(rest.length, Math.round(nTop * (this.gameStage >= 4 ? 0.20 : 0.25)));
        for (let i = 0; i < nBluff; i++) range.push(rest[Math.floor(Math.random() * rest.length)]);
        const need = 5 - cc.length;
        let win = 0, n = 0;
        for (const v of range) {
            for (let rep = 0; rep < (need > 0 ? 3 : 1); rep++) {
                const deck = pool.filter(c => c !== v.h[0] && c !== v.h[1]);
                const board = cc.slice();
                for (let k = 0; k < need; k++) board.push(deck.splice(Math.floor(Math.random() * deck.length), 1)[0]);
                try {
                    const mine = Hand.solve(p.hand.concat(board)), his = Hand.solve(v.h.concat(board));
                    const w = Hand.winners([mine, his]);
                    if (w.length === 2) win += 0.5; else if (w[0] === mine) win += 1;
                    n++;
                } catch (e) {}
            }
        }
        return n >= 40 ? win / n : null;
    }

    // 🎯 포스트플랍에서 내가 마지막에 행동하는가(포지션). 액션은 딜러 다음 자리부터 시작하므로
    //    딜러에 가까울수록 늦게 친다. 포지션은 고수 전략의 핵심 입력이다.
    isInPosition(nick) {
        const n = this.playerOrder.length;
        if (n < 2) return true;
        const rel = seat => (seat - this.dealerIndex - 1 + n) % n; // 클수록 늦게 행동
        const me = this.playerOrder.indexOf(nick);
        if (me < 0) return false;
        const myRel = rel(me);
        for (let i = 0; i < n; i++) {
            const other = this.playerOrder[i];
            if (other === nick) continue;
            const p = this.players[other];
            if (!p || p.isFolded || p.isAllIn) continue;
            if (rel(i) > myRel) return false;
        }
        return true;
    }

    // 🎯 직전 스트리트까지의 마지막 공격자 = 이번 스트리트의 주도권자.
    //    플랍이 체크로 넘어갔으면 프리플랍 레이저가 계속 주도권을 갖는다(정석).
    lastAggressorBefore(street) {
        const log = this.actionLog || [];
        for (let i = log.length - 1; i >= 0; i--) {
            const a = log[i];
            if (!a || a.street >= street) continue;
            if (a.type === 'raise' || a.type === 'allin') return a.nick;
        }
        return null;
    }

    // 🎯 [고수 전략] 레인지 기반 C벳/배럴.
    //    "내 패가 센가"가 아니라 "이 보드가 내 레인지에 유리한가"로 친다.
    //    A 하이 마른 보드에서 프리플랍 레이저는 상대보다 AA/AK를 훨씬 많이 들고 있으므로
    //    패와 무관하게 작게 전부 친다. 낮은 연결 보드는 콜러에게 유리해 체크가 많다.
    //    양극화: 강한 패 + 승산 없지만 폴드에퀴티 있는 패를 치고, 어중간한 패는 체크해 쇼다운을 본다.
    //    벳하기로 결정했을 때만 액션을 반환하고, 아니면 null(기존 로직으로 폴백)이다.
    planRangeBet(nick, ctx) {
        const p = this.players[nick];
        const { equity, board, persona, skill, street, totalPot, bb } = ctx;
        if (!p || street < 2 || p.chips <= bb * 2) return null;
        if (!persona.proStrategy) return null;              // 초·중수는 이 정석을 모른다
        if (this.lastAggressorBefore(street) !== nick) return null; // 주도권 없으면 C벳 아님

        const nOpp = this.playerOrder.filter(n => n !== nick && this.players[n] && !this.players[n].isFolded && !this.players[n].isAllIn).length;
        if (nOpp < 1) return null;

        const adv = Postflop.rangeAdvantage(this.communityCards);
        const inPosition = this.isInPosition(nick);
        const freq = Postflop.cbetFrequency({ street, adv, nOpp, inPosition, skill });

        const hasDraw = !!(board && (board.wet || board.flushDraw)) && equity >= 0.26;
        const kind = Postflop.classifyForBet({ equity, valueLine: persona.valueThresh, hasDraw });

        // 사이즈를 먼저 정한다 — 블러프를 얼마나 섞을지는 사이즈가 결정한다
        const thin = (kind === 'value' && equity < persona.valueThresh + 0.12);
        const frac = Postflop.cbetSize({ adv, board, street, kind: thin ? 'thin' : null, overbet: street >= 4 && kind === 'value' && Math.random() < 0.12 });

        // 🃏 블러프 빈도 = 벳 레인지 중 s/(1+s) 까지 × 상대·인원수 보정 × 블로커.
        //    예전엔 쓰레기 패의 58%를 블러프해서(이론값 17~25%) 맞대결에서 칩을 크게 잃었다.
        //    안 접는 상대·멀티웨이에선 순수 블러프를 접고 밸류만 친다 — 그게 고수다.
        const oppFold = ctx.oppRead && ctx.oppRead.foldToBet != null ? ctx.oppRead.foldToBet : null;
        const bluffTake = freq
            * Postflop.bluffShareForSize(frac)
            * Postflop.bluffAdjust({ nOpp, oppFoldToBet: oppFold, skill })
            * Blockers.bluffBlockerMult(p.hand, this.communityCards, skill);

        let take;
        if (kind === 'value') take = Math.min(0.92, freq + 0.20);
        else if (kind === 'semibluff') take = Math.min(0.75, freq * 0.8); // 드로우는 에퀴티가 있어 더 자주
        else if (kind === 'airbluff') take = bluffTake;
        else take = freq * 0.15;                            // 어중간 — 대부분 체크다운
        if (Math.random() >= take) return null;
        const amount = Math.max(bb, Math.round(totalPot * frac));
        const target = Math.min(p.currentBet + p.chips, p.currentBet + amount);
        if (target <= this.currentHighestBet) return null;
        p._plan = { betStreet: street, type: classifyBetPlan({ isValue: kind === 'value', equity, board }), eqAtBet: equity };
        return { type: 'raise', amount: target };
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
        // 🎯 레인지 기반 고급 전략(C벳 정책·MDF·에퀴티 실현율·블러프캐치·SPR 스택오프)은
        //    고수 봇 전용. 초·중수는 예전의 "내 패 강도" 판단을 그대로 써서 난이도 차이를 만든다.
        persona.proStrategy = (diff === 'hard');
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
        if (event !== 'join' && now - (p._lastChat || 0) < 6000) return;
        // 성격별 발화 확률
        const chatChance = { '광폭': 0.6, '루즈-어그레시브': 0.45, '타이트-어그레시브': 0.25, '콜링스테이션': 0.3, '초타이트': 0.15 }[arche] || 0.3;
        // 장고 혼잣말·도발은 심리전의 핵심이라 조금 더 자주 나오게
        const evChance = (event === 'tank' || event === 'taunt') ? Math.min(0.75, chatChance + 0.25) : chatChance;
        // 입장 멘트는 60%만 발화(여러 봇 추가 시 도배 방지), 승리/그 외는 확률 적용
        if (event === 'join') { if (Math.random() > 0.6) return; }
        else if (event !== 'win' && Math.random() > evChance) return;

        const L = BOT_LINES[arche] || BOT_LINES['타이트-어그레시브'];
        const pool = L[event];
        if (!pool || pool.length === 0) return;
        let msg = pool[Math.floor(Math.random() * pool.length)];
        // 직전과 같은 줄이면 한 번 다시 뽑는다 (똑같은 말 반복 = 봇 티)
        if (pool.length > 1 && msg === p._lastLine) msg = pool[Math.floor(Math.random() * pool.length)];
        p._lastLine = msg;
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
        io.to(this.roomId).emit('gameMessage', `🤖 ${name} 님이 참가했습니다! (${diffLabel} · ${persona.label})`);
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
        io.to(this.roomId).emit('gameMessage', `🤖 ${botNick} 님이 퇴장했습니다.`);
        this.sendState();
    }

    // 🤖 봇 전용 승률 추정 (자기 핸드를 알기에 직접 시뮬레이션)
    estimateBotEquity(nick) {
        const p = this.players[nick];
        if (!p.hand || p.hand.length !== 2) return 0.3;

        const oppNicks = this.playerOrder.filter(n => n !== nick && !this.players[n].isFolded);
        const opponents = oppNicks.length;
        if (opponents === 0) return 1;

        // 프리플랍: 간이 핸드 강도 (Chen 공식 변형)
        if (this.communityCards.length === 0) {
            return this.preflopStrength(p.hand) / Math.sqrt(opponents);
        }

        // 🔍 [핸드 리딩] 상대별로 이번 핸드 액션에서 레인지 임계값을 뽑아둔다.
        //    3벳/배럴한 상대는 강한 레인지로 좁혀지고, 체크만 한 상대는 랜덤 그대로.
        //    실력 낮은 봇은 임계값이 0에 수렴 → 기존 랜덤 가정과 동일하게 동작한다.
        //    (봇이 아니면 persona가 없다 — 사람의 승률 조회(학습모드 등)는 리딩 없이 랜덤 가정)
        const persona = p.isBot ? (p._persona || (p._persona = this.assignPersona(nick, p.difficulty))) : null;
        const skill = (persona && persona.skillFactor != null) ? persona.skillFactor : 0;
        const oppMinStrength = oppNicks.map(n =>
            HandRead.villainMinStrength(HandRead.summarizeVillain(this.actionLog, n), skill));

        // 포스트플랍: 몬테카를로
        const known = new Set([...this.communityCards, ...p.hand]);
        const pool = FULL_DECK.filter(c => !known.has(c));
        const need = 5 - this.communityCards.length;
        const ITER = 500; // 120→500: 표준편차 0.041→0.017로 안정화 (GTO 평가 정확도 ↑)
        const MAX_TRIES = 4; // 레인지 표본 재추첨 상한 — 못 찾으면 그냥 수용 (성능·표본 고갈 방지)
        let win = 0;

        for (let it = 0; it < ITER; it++) {
            const shuffled = pool.slice();
            for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
            let idx = 0;
            const board = this.communityCards.concat(shuffled.slice(idx, idx += need));

            // 상대 핸드를 레인지에 맞게 추첨 (거절 샘플링, 시도 횟수 제한)
            const oppHands = [];
            for (let o = 0; o < opponents; o++) {
                const min = oppMinStrength[o];
                let hand = null;
                for (let t = 0; t < MAX_TRIES; t++) {
                    if (idx + 1 >= shuffled.length) break; // 덱 소진 — 마지막 후보 사용
                    const cand = [shuffled[idx++], shuffled[idx++]];
                    hand = cand;
                    if (min <= 0) break; // 안 좁히는 상대 → 첫 추첨 그대로 (기존 동작)
                    if (HandRead.acceptOppHand(this.preflopStrength(cand), min)) break;
                }
                oppHands.push(hand || [shuffled[idx++], shuffled[idx++]]);
            }

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
        if (this._tauntTimer) { clearTimeout(this._tauntTimer); this._tauntTimer = null; }
        this.turnTimeout = null;
        this.turnEndTime = 0;
    }

    stopAllTimers() {
        this.stopTurnTimer();
        this.clearEndVote();
        if (this.tournamentTimer) clearInterval(this.tournamentTimer);
        if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
        if (this._autoResumeTimer) clearTimeout(this._autoResumeTimer);
        if (this._nextHandTimer) { clearTimeout(this._nextHandTimer); this._nextHandTimer = null; }
        Object.values(this.players).forEach(p => {
            if (p._disconnectTimer) clearTimeout(p._disconnectTimer);
            if (p._botTimer) clearTimeout(p._botTimer);
            if (p._botTankTimer) clearTimeout(p._botTankTimer);
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

    // ⏭️ 다음 핸드 예약 — 중복 예약 금지. 여러 경로(결과창 타이머 / MTT 재가동 / 좌석배정)가
    //    각자 setTimeout을 걸어 두면, 늦게 도착한 쪽이 이미 시작된 판을 덮어써 버린다.
    scheduleNextHand(ms) {
        if (!rooms.has(this.roomId)) return false;
        if (this._nextHandTimer) return false; // 이미 누가 예약함
        if (DEV_FAST) ms = Math.min(ms, 120);
        this._nextHandTimer = setTimeout(() => {
            this._nextHandTimer = null;
            this.startNextHand();
        }, ms);
        return true;
    }

    startNextHand() {
        // 방이 파기된 뒤 늦게 도착한 호출(결과창 8초 타이머 등)은 무시 — 죽은 방에서 딜·타이머가 다시 돌지 않게
        if (!rooms.has(this.roomId)) return;
        // 🛡️ [버그픽스] 이미 핸드가 진행 중이면 새로 딜하지 않는다.
        //    MTT에서 결과창 8초 타이머와 매니저의 테이블 재가동(1.5초)이 겹쳐,
        //    늦게 온 쪽이 진행 중이던 판을 통째로 날리고 새 핸드를 돌렸다.
        //    (실측: 스트리트 1~3 진행 중에 결과 없이 handId가 바뀜 — 그 판의 블라인드·베팅 칩은 소멸)
        if (this.gameStage >= 1 && this.gameStage <= 4) return;
        // 🏆 [MTT] 테이블을 합쳐야 할 때(파이널 테이블 구성 등)는 새 판을 돌리지 않고 기다린다 — 매니저가 합친 뒤 다시 시작시킨다
        if (this._mtt && (this._mtt.hold || this._mtt._endAgreed) && !this._mtt.finished) return;
        // 🤖 [컴까기] 끝난 도전방은 더 딜하지 않는다. 사람이 칩을 다 잃었으면 봇끼리 계속 칠 이유가 없으니 바로 실패 처리.
        if (this._challenge) {
            if (this._challenge.done || this._challenge.waiting) return;
            if (this._challenge.run) { if (this.runBetweenHands()) return; }
            else if (this.tournamentStarted) {
                // 협동이면 한 명이라도 살아 있으면 계속, 봇이 다 죽으면 사람끼리 싸울 것 없이 바로 클리어
                const all = Object.values(this.players);
                if (!all.some(x => !x.isBot && x.chips > 0)) { this.finishChallenge(false); return; }
                if (!all.some(x => x.isBot && x.chips > 0)) { this.finishChallenge(true); return; }
            }
        }
        if (this._nextHandTimer) { clearTimeout(this._nextHandTimer); this._nextHandTimer = null; }
        // 🗳️ 합의 종료가 확정됐으면 새 핸드 대신 정산 — 직전 핸드의 팟이 칩으로 정리된 뒤라 정확
        if (this._endAgreed) { this.settleAgreedEnd(); return; }
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
                this.players[nick]._revealCards = null; // 🃏 폴드 패 공개 선택 초기화
                this.players[nick]._tbUsed = false;     // ⏳ 타임뱅크는 핸드마다 1회
                if (this._learnFixedStack) this.players[nick].chips = this.startingChips;   // 📏 숏스택 연습: 매 핸드 같은 깊이로
                this.players[nick].hasActed = false;
                this.players[nick].role = '';
                this.players[nick]._trapStreet = -1; // 🪤 체크레이즈 트랩 플래그 초기화 (스트리트 번호 재사용 오발동 방지)
                this.players[nick]._plan = null;      // 🧠 [스트리트 플랜] 핸드 단위 의도(밸류/블러프/세미블러프) 초기화

                if (this.players[nick].chips <= 0 && (this.tournamentStarted || this.mode === 'cash')) {
                    // 🎓 [학습모드] 칩 0이면 자동 리필 (사람·봇 모두) — 연습이 끊기지 않게
                    if (this._learnMode) {
                        this.players[nick].chips = this.startingChips;
                        this.players[nick].isSpectator = false;
                        if (!this.players[nick].isBot && this.players[nick].socketId) {
                            io.to(this.players[nick].socketId).emit('gameMessage', '🎓 칩이 자동 충전됐습니다! 계속 연습하세요.');
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
        // 🪑 [버그픽스] 예전엔 정원 제한이 없어, 풀방 관전자가 재바이인하면 7번째로 앉았다(실측).
        //    클라이언트 좌석은 6개(pos-0~pos-5)뿐이라 7번째는 화면에 그려지지도 않는다.
        Object.keys(this.players).forEach(nick => {
            if (this.playerOrder.length >= TABLE_SEATS) return;
            if (this.players[nick]._wantSpectate) return;   // 👀 본인이 관전을 고름 — 앉히지 않는다
            if (this.players[nick].chips > 0 && !this.playerOrder.includes(nick)) this.playerOrder.push(nick);
        });

        // 🪑 [버그픽스] 풀방 대기 관전자 좌석 배정 — 자리가 났으면 바이인 후 이번 핸드부터 합류.
        //    예전엔 _fullRoomSpectator 플래그를 세팅만 하고 한 번도 읽지 않아,
        //    "자리가 나면 다음 핸드부터 참여" 안내가 실제로는 지켜지지 않았다.
        //    진행 중 토너먼트는 중간에 풀스택으로 합류하면 공정성이 깨지므로 제외(캐시/미시작 방만).
        if (!this._mtt && !(this.mode === 'tournament' && this.tournamentStarted)) {
            let openSeats = TABLE_SEATS - this.playerOrder.length;
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
                    if (p.socketId) io.to(p.socketId).emit('gameMessage', '🪑 자리가 나서 합류했습니다! 이번 핸드부터 플레이합니다.');
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
                io.to(this.roomId).emit('gameMessage', '플레이어를 기다리는 중입니다...');
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
                    io.to(this.roomId).emit('gameMessage', '⏳ 리바이 대기 8초! 재구매하면 토너먼트가 계속됩니다!');
                    rebuyables.forEach(n => this.offerRebuy(n));
                    if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
                    this.pendingStageTimeout = setTimeout(() => { this._rebuyGraceActive = false; this.startNextHand(); }, 8000);
                    this.sendState();
                    return;
                }
                const winner = this.playerOrder[0];
                // 🤖 [컴까기] 일반 토너먼트의 우승 처리(우승 횟수·토큰·상금풀)를 타지 않는다.
                //    봇만 상대한 우승이 등급·토큰으로 이어지면 안 되고, 보상은 단계표대로 따로 준다.
                if (this._challenge) { this.finishChallenge(!this.players[winner].isBot); return; }
                this.gameStage = 0;
                this.tournamentStarted = false;
                if (this.tournamentTimer) clearInterval(this.tournamentTimer);

                const _tokenOk = (this._humanEntrants || 0) >= TOKEN_MIN_HUMANS;
                MockDB.addWin(winner, _tokenOk).then(() => {
                    const wp = this.players[winner];
                    const wu = MockDB.users.get(winner);
                    if (!wp || wp.isBot || !wp.socketId || !wu) return;
                    if (_tokenOk) io.to(wp.socketId).emit('tokenEarned', { tokens: wu.tokens || 0 });
                    else io.to(wp.socketId).emit('gameMessage', `🏆 우승! 다만 토큰은 사람이 ${TOKEN_MIN_HUMANS}명 이상 참가한 토너먼트에서만 나옵니다.`);
                });
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

                this.resetForNewTournament();
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
                io.to(this.roomId).emit('gameMessage', '플레이어가 돌아오길 기다리는 중입니다...');
                this.sendState();
                this.tryAutoResume();
                return;
            }
        }

        if (!this.tournamentStarted) {
            this.tournamentStarted = true;
            // 🏆 시작 시점의 "사람" 수를 적어둔다 — 끝날 땐 탈락자가 나가고 없어서 셀 수 없다
            this._humanEntrants = this.playerOrder.filter(n => this.players[n] && !this.players[n].isBot).length;
            // 🏆 [MTT 버그픽스] 블라인드 레벨·시계는 MTT 매니저가 단독으로 소유한다.
            //    테이블마다 제 시계를 돌리면, 밸런싱으로 테이블이 새로 만들어질 때마다
            //    블라인드가 레벨 1로 되돌아가 토너먼트가 끝나지 않았다(실측: 8명 4분 31핸드에 2명만 탈락).
            //    테이블별로 레벨이 제각각이 되는 불공정도 함께 사라진다.
            if (this._mtt) {
                this.blindLevel = this._mtt.blindLevel || 0;
                this.timeRemaining = (this._mtt.timeRemaining != null) ? this._mtt.timeRemaining : this.blindUpInterval;
            } else {
                this.blindLevel = 0;
                if (this.mode !== 'cash') { // 💵 캐시는 블라인드업 없음
                    this.timeRemaining = this.blindUpInterval;
                    this.startTournamentTimer();
                    // 🎓 학습모드 등 "자유 칩" 방은 뱅크롤 차감·상금풀 없이 진행
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
        this.settleBlunders();          // 💥 지난 핸드에 기록한 실수에 그 판의 결과(칩 증감)를 덧붙인다
        this._pfSeen = { opp: new Set(), pfr: new Set() };
        this.communityCards = [];
        this.gameStage = 1;
        this.pot = 0;
        this.ritBoards = null;      // 🎲 [런잇트와이스] 핸드마다 초기화 — 남아있으면 다음 핸드가 오판한다
        this.ritSharedCount = 0;

        // 🎬 [리플레이] 이번 핸드의 액션 로그 + 시작 시점 스택 스냅샷
        this.actionLog = [];
        this.handStartStacks = {};
        this.handStartBlinds = null;

        const bl = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)];
        this.currentHighestBet = bl.bb;
        this.lastFullRaiseAmount = bl.bb;
        // 🐛 레이즈 횟수는 "새 스트리트"에서만 0으로 돌아갔고 "새 핸드"에서는 안 돌아갔다.
        //    프리플랍에서 끝난 핸드의 레이즈가 다음 핸드로 계속 쌓여(실측: 오픈도 없는데 9, 11),
        //    봇이 평범한 오픈을 3벳·4벳 팟으로 착각해 너무 좁게 방어하고 밸류 3벳도 못 했다.
        //    3벳 통계와 학습모드 조언도 같은 값을 써서 함께 틀어져 있었다.
        this.raiseCountThisStreet = 0;

        this.playerOrder.forEach(nick => {
            this.players[nick].hand = [this.deck.pop(), this.deck.pop()];
            this.jamStat(nick).h += 1;
            this.players[nick]._ante = 0;
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
        // 🪙 [빅블라인드 앤티] BB 한 사람만 낸다. 앤티를 먼저 내고(칩이 모자라면 앤티부터), 남은 칩으로 빅블라인드를 낸다.
        //    앤티는 "죽은 돈"이다 — 팟에는 들어가지만 그 사람의 벳(currentBet·totalInvested)으로 치지 않는다.
        //    (벳으로 치면 남들이 1bb 만 콜했을 때 남는 부분이 "받아 주지 않은 벳"으로 BB 에게 되돌아가 앤티가 없던 일이 된다.)
        //    쇼다운 분배는 실제 팟(this.pot)과 벳 합계의 차액을 메인팟에 얹으므로 앤티는 그 판의 승자가 가져간다.
        if (bl.ante > 0 && !bbPlayer.isAllIn && bbPlayer.chips > 0) {
            const antePaid = Math.min(bl.ante, bbPlayer.chips);
            bbPlayer.chips -= antePaid;
            bbPlayer._ante = antePaid;
            this.pot += antePaid;
            if (bbPlayer.chips === 0) bbPlayer.isAllIn = true;
        }
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
            this.handStartStacks[nick] = pl.chips + pl.currentBet + (pl.totalInvested - pl.currentBet) + (pl._ante || 0);
        });
        // 블라인드 포스팅 자체도 로그에 남김
        this.logAction(this.playerOrder[sbIndex], 'sb', bl.sb, 1);
        this.logAction(this.playerOrder[bbIndex], 'bb', bl.bb, 1);

        if (this._challenge && this._challenge.run) this.runOnDeal(sbIndex, bbIndex);   // 🍀 증강 런: 기한·딜 보너스·엿보기

        this.sendState();

        // 💡 [수정 #1 - 치명] 블라인드/앤티로 전원 올인 시 게임이 멈추던 버그 수정
        if (this.turnIndex !== -1) {
            this.startTurnTimer();
        } else {
            if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
            this.emitEquity();
            // 🃏 올인 성립 → 홀카드와 승률을 먼저 보여주고, 3초 뒤에 플랍을 깐다
            //    (예전엔 카드가 곧바로 깔려서 홀카드를 확인할 틈이 없었다)
            this.pendingStageTimeout = setTimeout(() => this.nextStage(), SHOWDOWN_REVEAL_MS);
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
        this._legacyRaiseCount = 0;

        // 🎲 [런잇트와이스] 카드를 깔기 전에 판정 — 올인으로 액션이 끝났고 아직 깔 카드가 남았으면
        //    보드를 두 번 깐다. (이미 발동했으면 재진입 금지 — ritBoards가 증거)
        if (!this.ritBoards) {
            const contestants = this.playerOrder.filter(n => !this.players[n].isFolded).length;
            const actionable = this.playerOrder.filter(n => !this.players[n].isFolded && !this.players[n].isAllIn).length;
            if (RIT.shouldRunItTwice({ enabled: this.runItTwice, mode: this.mode, gameStage: this.gameStage, contestants, actionable })) {
                this.startRunItTwice();
                return;
            }
        }

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
            // 🃏 올인 쇼다운 런아웃 — 방금 깔린 카드를 보고 나서 다음 장까지 3초
            this.pendingStageTimeout = setTimeout(() => this.nextStage(), SHOWDOWN_REVEAL_MS);
            return;
        }

        this.turnIndex = this.findNextActiveIndex((this.dealerIndex + 1) % this.playerOrder.length);
        this.sendState();
        if (this.turnIndex !== -1) this.startTurnTimer();
    }

    // 🎲 [런잇트와이스] 올인 상황에서 보드를 두 번 깐다.
    //    런2는 런1이 쓴 카드 다음부터 뽑으므로 두 보드에 같은 카드가 나올 수 없다.
    //    깔린 카드는 연출을 위해 한 장씩(런1·런2 동시) 공개한 뒤 쇼다운으로 넘긴다.
    startRunItTwice() {
        this.turnIndex = -1;
        const shared = this.communityCards.slice();          // 두 런이 공유하는 이미 깔린 카드
        const boards = RIT.buildRunBoards(shared, () => this.deck.pop(), this.gameStage, 2);
        this.ritBoards = boards;
        this.ritSharedCount = shared.length;
        this.gameStage = 4; // 보드 완성 — 더 이상 스트리트 진행 없음

        io.to(this.roomId).emit('gameMessage', '🎲 런잇트와이스! 보드를 두 번 깝니다.');

        // 남은 카드를 한 장씩 순차 공개 (양쪽 런 동시) — 긴장감 연출
        const total = boards[0].length;
        let shown = shared.length;
        const revealNext = () => {
            shown++;
            this.communityCards = boards[0].slice(0, shown); // 기존 클라 호환: 런1을 메인 보드로
            this.sendState();
            if (shown < total) {
                this.pendingStageTimeout = setTimeout(revealNext, 1400);
            } else {
                this.pendingStageTimeout = setTimeout(() => { this.gameStage = 5; this.evaluateWinner(); }, 1600);
            }
        };
        this.sendState();
        this.pendingStageTimeout = setTimeout(revealNext, 1200);
    }

    // 💡 [신규] 사람·봇 공유 액션 적용 — 검증 통과 시 베팅 반영 후 nextTurn
    applyAction(nick, type, amount) {
        // 베팅은 스트리트(1~4) 진행 중에만. 쇼다운 뒤(5)·대기(0)에 들어온 액션을 받으면
        // 이미 지급이 끝난 팟에 칩이 들어가 다음 핸드 초기화 때 통째로 사라진다.
        if (this.gameStage < 1 || this.gameStage > 4) return false;
        if (this.playerOrder[this.turnIndex] !== nick) return false;
        if (!['fold', 'check', 'call', 'raise', 'allin'].includes(type)) return false;

        const p = this.players[nick];
        if (!p || p.isFolded || p.isAllIn) return false;

        // 📊 액션 전 상태 캡처 (지표 계산용)
        const beforeBet = p.currentBet;
        const beforeHighest = this.currentHighestBet;
        const raisesBeforeAction = this.raiseCountThisStreet || 0;

        // 🎓 [학습모드] 사람 액션 전 GTO 조언 캡처 (액션 후 채점에 사용)
        //    학습모드가 아니어도 사람 액션은 전부 "액션 전 상태"의 조언으로 채점한다(프로필 GTO 근접도).
        //    예전 근접도는 액션이 반영된 뒤의 상태를 조언과 다른 옛 기준으로 봐서, 정석 스틸·숏스택 푸시를 낮게 쳤다.
        let _learnAdvice = null;
        this._pendingGto = null;
        if (p && !p.isBot) {
            const _c = this._advCache;
            if (_c && _c.nick === nick && _c.key === this.advKey(nick)) _learnAdvice = _c.advice;      // ⚡ 차례가 왔을 때 미리 계산해 둔 것
            else { try { _learnAdvice = this.getGtoAdvice(nick); } catch (e) {} }
            const _sc = GtoAdvice.scoreAction(_learnAdvice, type);
            if (_sc != null) this._pendingGto = { nick, score: _sc };
        }
        // 💥 리포트용: 액션 전 상황 (실수로 판정되면 이 상황째로 저장한다)
        this._statAdv = null;
        const _blPre = (_learnAdvice && p && !p.isBot) ? {
            pot: this.pot + Object.values(this.players).reduce((s, x) => s + (x.currentBet || 0), 0),
            chips: p.chips, hand: p.hand.slice(), board: this.communityCards.slice(),
            opp: this.playerOrder.filter(n => n !== nick && !this.players[n].isFolded).length
        } : null;
        if (_blPre) this._statAdv = { nick, advice: _learnAdvice, pre: _blPre, potBB: _blPre.pot / this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb };

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

            // 🚫 [언더레이즈 규칙/TDA] 최소레이즈 미만 올인(언더레이즈)은 이미 행동한 플레이어에게
            //    액션을 재오픈하지 않는다. hasActed=true 로 차례가 돌아오는 유일한 경우는
            //    "내 액션 후 언더레이즈 올인만 있었던 것"(풀 레이즈면 hasActed 리셋됨)
            //    → 이때는 콜/폴드만 가능, 레이즈(올인 리레이즈 포함) 금지.
            if (p.hasActed && targetBet > this.currentHighestBet) return false;

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
            // 프리플랍에 12bb 넘는 스택을 한 번에 밀어 넣은 것만 센다 (숏스택 푸시는 정상 플레이)
            if (finalAction === 'allin' && this.gameStage === 1 && cost >= 12 * (this.handStartBlinds ? this.handStartBlinds.bb : 100)) this.jamStat(nick).j += 1;

            if (p.currentBet > this.currentHighestBet) {
                const raiseDiff = p.currentBet - this.currentHighestBet;
                this.currentHighestBet = p.currentBet;
                this.raiseCountThisStreet = (this.raiseCountThisStreet || 0) + 1; // 📊 3벳 감지
                this._legacyRaiseCount = (this._legacyRaiseCount || 0) + 1;       // 🔬 A/B 전용: 고치기 전 동작 재현
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
            try { if (_blPre) this.noteBlunder(nick, type, p, _learnAdvice, _blPre, beforeBet, beforeHighest); } catch (e) {}
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

        // amount: 이 스트리트에 그 사람이 내놓은 총액 — 말풍선에 "콜 200 / 레이즈 600"으로 보여준다
        io.to(this.roomId).emit('actionSound', { nick, type: finalAction, amount: (finalAction === 'fold' || finalAction === 'check') ? 0 : (p.currentBet || 0) });
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
        // 🧠 세션 표본이 모자라도, 사람이면 계정 누적 전적으로 첫 판부터 성향을 안다
        const session = this._sessionRead(nick);
        const pl = this.players[nick];
        if (!pl || pl.isBot) return session;
        return OppModel.blendRead(session, OppModel.lifetimeRead(MockDB.users.get(nick)));
    }
    _sessionRead(nick) {
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
        // 🛡️ [안전망] 이번 핸드의 카드를 받지 않은 좌석은 액션 대상에서 제외한다.
        //    어떤 경로로든 핸드 도중 좌석이 끼어들면 턴이 그쪽으로 넘어가 게임이 멈추거나,
        //    카드 없이 베팅하고 쇼다운에서 보드만으로 팟을 가져갈 수 있다.
        if (this.gameStage >= 1 && this.gameStage <= 4) {
            this.playerOrder.forEach(n => {
                const pl = this.players[n];
                if (pl && !pl.isFolded && (pl.hand || []).length !== 2) { pl.isFolded = true; pl.hasActed = true; }
            });
        }
        const active = this.playerOrder.filter(n => !this.players[n].isFolded);
        const actioners = active.filter(n => !this.players[n].isAllIn);

        if (active.length === 1) { this.handleWin(active[0]); return; }

        const allMatched = active.every(n => this.players[n].currentBet === this.currentHighestBet || this.players[n].isAllIn);
        const allActed = actioners.every(n => this.players[n].hasActed);

        if (allMatched && allActed) {
            // 🃏 [쇼다운 연출] 더 이상 벳할 사람이 없으면(= 올인 승부 확정) 곧바로 카드를 깔지 않는다.
            //    홀카드와 승률을 먼저 띄우고 3초 뒤에 다음 카드를 깐다.
            //    (예전엔 마지막 콜과 동시에 플랍이 떠서 상대 패를 확인할 틈이 없었다 — 실측)
            if (actioners.length <= 1 && active.length >= 2 && this.gameStage >= 1 && this.gameStage <= 3) {
                this.turnIndex = -1;
                this.sendState();
                try { this.captureAllinEq(); } catch (e) {}
                this.emitEquity();
                if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
                this.pendingStageTimeout = setTimeout(() => this.nextStage(), SHOWDOWN_REVEAL_MS);
                return;
            }
            this.nextStage();
            return;
        }

        if (actioners.length > 0) {
            const nextIdx = this.findNextActiveIndex(this.turnIndex + 1);
            if (nextIdx === -1) { this.nextStage(); return; }
            this.turnIndex = nextIdx;
        } else {
            // 더 이상 벳할 사람이 없다 = 올인 쇼다운. 홀카드가 공개되는 순간이므로
            // 다음 카드를 깔기 전에 3초를 준다 (승률 배지를 보고 상황을 파악할 시간).
            this.turnIndex = -1;
            this.sendState();
            try { this.captureAllinEq(); } catch (e) {}
            this.emitEquity();
            if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
            this.pendingStageTimeout = setTimeout(() => this.nextStage(), SHOWDOWN_REVEAL_MS);
            return;
        }

        this.sendState();
        if (this.turnIndex !== -1) this.startTurnTimer();
    }

    evaluateWinner() {
        this.stopTurnTimer();
        this.turnIndex = -1; // 핸드 종료 — 결과창 동안 "내 턴" 표시·봇 행동이 이어지지 않게
        this._handEndedAt = Date.now(); // 🏆 [MTT] 결과창을 볼 시간을 확보하려고 기록 (테이블 재배치 판단용)
        const active = this.playerOrder.filter(n => !this.players[n].isFolded);
        if (active.length === 1) { this.handleWin(active[0]); return; }

        // 💰 [돈 로직] 사이드팟 보정 → 롤다운 → (RIT) 런별 분배 계산은 lib/showdown.js 순수 모듈로.
        //    시나리오 테스트(3중 사이드팟·무승부 홀수칩·RIT 조합·무작위 300개 칩 보존)가 회귀를 방어한다.
        //    여기서는 결과를 받아 칩 반영 + 한국어 라벨/메시지 등 표현만 담당.
        const boards = this.ritBoards || [this.communityCards];
        const sd = Showdown.computeShowdown({
            contributions: this.playerOrder
                .filter(nick => this.players[nick] && this.players[nick].totalInvested > 0)
                .map(nick => ({ nick, invested: this.players[nick].totalInvested })),
            totalPot: this.pot,
            boards,
            holeCards: Object.fromEntries(this.playerOrder.map(n => [n, this.players[n].hand])),
            isFolded: n => this.players[n].isFolded
        });

        // 칩 반영
        for (const [nick, won] of Object.entries(sd.awards)) this.players[nick].chips += won;
        const allWinnerIds = new Set(sd.winnersAll);

        // ── 표현 계층: 한국어 라벨/메시지/클라 렌더 구조 ──
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

        const messages = [];
        const potResults = []; // 💡 클라이언트 결과창 렌더링용 구조화 데이터
        for (const res of sd.results) {
            const baseLabel = sd.sidePotCount > 1 ? (res.potIdx === 0 ? '[메인팟]' : `[사이드팟 ${res.potIdx}]`) : '[최종 팟]';
            const label = boards.length > 1 ? `[런 ${res.runIdx + 1}] ${baseLabel}` : baseLabel;

            const winnerStrs = res.winners.map(w => {
                const pCards = this.players[w.nick].hand.map(formatCard).join(', ');
                return `🥇 ${w.nick} ➔ 🃏[${pCards}] (${rankKorMap[w.rankName] || w.rankName})`;
            });

            potResults.push({
                label, amount: res.amount,
                board: res.board, // 🎲 이 런의 보드 (클라 결과창에서 런별로 표시)
                winners: res.winners.map(w => ({
                    nick: w.nick,
                    cards: this.players[w.nick].hand.slice(),
                    rank: rankKorMap[w.rankName] || w.rankName,
                    won: w.won,
                    best5: w.best5 // 🌟 승리 조합 5장
                }))
            });

            const boardStr = boards.length > 1 ? `\n🃏 보드: ${res.board.map(formatCard).join(' ')}` : '';
            messages.push(`💰 ${label} ${res.amount.toLocaleString()} 칩${boardStr}\n${winnerStrs.join('\n')}`);
        }

        // 🃏 [공개 규칙] 먼저 까는 사람(앞순서)과 팟을 먹은 사람은 무조건 공개한다.
        //    그 뒤 순서에서 진 사람만 "공개할지 머크할지" 고를 수 있다 (정식 규칙).
        //    봇과 연결이 끊긴 사람은 기본값인 머크로 둔다.
        //    🚨 단, 올인으로 승부가 결정된 판은 예외 — 규칙상 올인 상황에선 남은 전원이
        //    카드를 깐 채로 런아웃을 본다. 그렇게 이미 공개된 패를 결과창에서 다시 덮으면
        //    "왜 자꾸 자동으로 머크되냐"가 된다 (실측: 올인 5핸드 중 4건에서 도로 덮였다).
        //    한 번 보여준 패는 끝까지 보여준다.
        const _contenders = this.playerOrder.filter(n => this.players[n] && !this.players[n].isFolded);
        const _allInShowdown = _contenders.filter(n => !this.players[n].isAllIn).length <= 1 && _contenders.length >= 2;

        const _order = this.showdownOrder();
        const _firstShower = _order[0] || null;
        this._muckDeadline = Date.now() + MUCK_CHOICE_MS;
        this.playerOrder.forEach(nick => {
            const pl = this.players[nick];
            if (!pl || pl.isFolded) return;
            pl._muckChoice = false;
            if (_allInShowdown || allWinnerIds.has(nick) || nick === _firstShower) {
                pl.isMucked = false; // 올인 쇼다운·승자·앞순서는 무조건 공개
                return;
            }
            pl.isMucked = true;      // 기본은 머크
            if (!pl.isBot && !pl.isDisconnected && pl.socketId) {
                pl._muckChoice = true;
                io.to(pl.socketId).emit('muckChoice', { deadline: this._muckDeadline });
            }
        });

        // ⚔️ [상대전적] 쇼다운까지 간 사람끼리만 승패를 적는다.
        //    폴드로 끝난 팟은 패를 겨룬 게 아니므로 전적에 넣지 않는다. 봇도 제외.
        const _humansShown = _contenders.filter(n => this.players[n] && !this.players[n].isBot);
        if (_humansShown.length >= 2) {
            const _won = _humansShown.filter(n => allWinnerIds.has(n));
            const _lost = _humansShown.filter(n => !allWinnerIds.has(n));
            _won.forEach(w => _lost.forEach(l => MockDB.recordH2H(w, l)));
        }

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
        try { this.settleHandResults(); } catch (e) {}
        this.playerOrder.forEach(nick => {
            MockDB.recordHand(nick, allWinnerIds.has(nick), wonByNick[nick] || 0, this.vpipThisHand && this.vpipThisHand.has(nick), this.statKind());
            // 📊 쇼다운 도달 통계 (폴드하지 않고 카드를 깐 플레이어)
            const pl = this.players[nick];
            if (pl && !pl.isFolded && !pl.isBot) {
                MockDB.recordShowdownStat(nick, allWinnerIds.has(nick), this.statKind());
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
            message: (this.ritBoards ? '🎲 [런잇트와이스 결과]\n\n' : '🏆 [쇼다운 결과]\n\n') + messages.join('\n\n'),
            winners: [...allWinnerIds],
            pots: potResults,
            community: this.communityCards.slice(),
            // 🎲 런잇트와이스: 두 보드 + 공유 카드 수 (클라가 두 줄로 렌더)
            runBoards: this.ritBoards ? this.ritBoards.map(b => b.slice()) : null,
            sharedCount: this.ritBoards ? this.ritSharedCount : null
        });

        this.sendState();

        this.scheduleNextHand(8000);
    }

    // ═══ 🗳️ 합의 종료 투표 ═══════════════════════════════════════════
    //  모두 동의하면 토너먼트를 도중에 끝내고 상금풀을 칩 비율대로 나눈다(lib/chop.js).
    //  대상: 단일 테이블 토너먼트 진행 중 — MTT(매니저가 우승 처리)·캐시(원래 자유 퇴장)·학습모드 제외.
    endVoteEligible() {
        // 🏆 MTT(파이널나인 연습 포함)는 매니저가 전 테이블의 사람들 표를 모은다
        if (this._mtt) return this._mtt.started && !this._mtt.finished && !this._mtt._endAgreed;
        return this.mode === 'tournament' && this.tournamentStarted && !this._mtt && !this._mttFreeChips && !this._learnMode;
    }

    // 투표자: 칩이 남아 있고 접속 중인 사람. 봇은 투표하지 않는다.
    //  playerOrder엔 방금 끝난 핸드에서 탈락한 사람(칩 0)이 다음 핸드 전까지 남아 있으므로 칩으로 거른다.
    //  단, 핸드 진행 중(1~4) 올인한 사람은 칩이 0이어도 팟에 몫이 걸려 있어 투표권이 있다.
    endVoteVoters() {
        const live = this.gameStage >= 1 && this.gameStage <= 4;
        return this.playerOrder.filter(n => {
            const p = this.players[n];
            if (!p || p.isBot || p.isDisconnected) return false;
            return p.chips > 0 || (live && p.isAllIn && !p.isFolded);
        });
    }

    endVoteSnapshot() {
        if (this._mtt) return this._mtt.endVoteSnapshot();
        const v = this._endVote;
        if (!v) return { active: false };
        return { active: true, proposer: v.proposer, voters: [...v.voters], yes: [...v.yes], deadline: v.deadline };
    }

    clearEndVote() {
        if (this._endVote && this._endVote.timer) clearTimeout(this._endVote.timer);
        this._endVote = null;
    }

    proposeEndVote(nick) {
        const me = this.players[nick];
        const tell = msg => { if (me && me.socketId) io.to(me.socketId).emit('gameMessage', msg); };
        if (this._mtt) return this._mtt.proposeEndVote(nick, tell);
        if (!this.endVoteEligible()) return tell('🗳️ 진행 중인 토너먼트에서만 종료 투표를 할 수 있습니다.');
        if (this._endAgreed) return tell('🗳️ 이미 종료가 합의됐습니다. 곧 정산합니다.');
        if (this._endVote) return tell('🗳️ 이미 종료 투표가 진행 중입니다.');
        const voters = this.endVoteVoters();
        if (!voters.includes(nick)) return tell('🗳️ 칩이 남아 있는 참가자만 제안할 수 있습니다.');
        if (Date.now() < (this._endVoteCooldownUntil || 0)) return tell('🗳️ 방금 부결됐습니다. 잠시 후 다시 제안해 주세요.');

        this._endVote = { proposer: nick, voters: new Set(voters), yes: new Set([nick]), deadline: Date.now() + END_VOTE_MS, timer: null };
        this._endVote.timer = setTimeout(() => this.finishEndVote(false, '시간 초과'), END_VOTE_MS);
        io.to(this.roomId).emit('gameMessage', `🗳️ ${nick} 님이 토너먼트를 지금 끝내자고 제안했습니다 (칩 비율대로 상금 분배).`);
        this.checkEndVote();
    }

    castEndVote(nick, agree) {
        if (this._mtt) return this._mtt.castEndVote(nick, agree);
        const v = this._endVote;
        if (!v || !v.voters.has(nick) || v.yes.has(nick)) return;
        if (!agree) return this.finishEndVote(false, `${nick} 님 반대`);
        v.yes.add(nick);
        this.checkEndVote();
    }

    checkEndVote() {
        const v = this._endVote;
        if (!v) return;
        if (v.yes.size >= v.voters.size) return this.finishEndVote(true);
        io.to(this.roomId).emit('endVote', this.endVoteSnapshot());
    }

    finishEndVote(passed, reason) {
        if (!this._endVote) return;
        this.clearEndVote();
        io.to(this.roomId).emit('endVote', { active: false });
        if (!passed) {
            this._endVoteCooldownUntil = Date.now() + 15000;
            io.to(this.roomId).emit('gameMessage', `🗳️ 종료 투표 부결 (${reason}) — 토너먼트를 계속합니다.`);
            return;
        }
        this._endAgreed = true;
        if (this.gameStage >= 1 && this.gameStage <= 4) {
            io.to(this.roomId).emit('gameMessage', '🤝 전원 동의! 이번 핸드가 끝나면 칩 비율대로 정산하고 토너먼트를 마칩니다.');
        } else {
            io.to(this.roomId).emit('gameMessage', '🤝 전원 동의! 칩 비율대로 정산합니다.');
            // 결과창(5)이면 대기 중인 다음 핸드 타이머가 startNextHand에서 정산한다. 대기(0)면 지금.
            if (this.gameStage === 0) this.settleAgreedEnd();
        }
    }

    settleAgreedEnd() {
        this._endAgreed = false;
        this.clearEndVote();
        this.stopTurnTimer();
        if (this.pendingStageTimeout) clearTimeout(this.pendingStageTimeout);
        this.gameStage = 0;
        this.tournamentStarted = false;
        if (this.tournamentTimer) clearInterval(this.tournamentTimer);

        const stacks = Object.keys(this.players).map(n => ({ nick: n, chips: this.players[n].chips || 0, isBot: !!this.players[n].isBot }));
        const tableChips = stacks.reduce((s, x) => s + Math.max(0, x.chips), 0);
        const pool = this.prizePool || tableChips;
        const rows = chipChop(pool, stacks);
        rows.forEach(r => {
            if (r.isBot || r.share <= 0) return; // 봇 몫은 소멸 — 봇 우승 시 상금 소멸과 같은 규칙
            MockDB.adjustBankroll(r.nick, r.share).then(nb => {
                const sock = this.players[r.nick] && this.players[r.nick].socketId;
                if (sock) io.to(sock).emit('bankrollUpdate', { bankroll: nb || 0 });
            });
        });
        this.prizePool = 0;

        io.to(this.roomId).emit('tournamentEnd', { chop: true, pool, payouts: rows });
        const paid = rows.filter(r => !r.isBot).map(r => `${r.nick} +${r.share.toLocaleString()}`).join(', ');
        io.to(this.roomId).emit('gameMessage', `🤝 합의 종료 — 상금풀 ${pool.toLocaleString()} 칩 분배: ${paid || '사람 참가자 없음'}`);
        this.resetForNewTournament();
    }

    // 토너먼트가 끝난 뒤 테이블 초기화 — 다음 토너먼트 준비 (정상 우승·합의 종료 공통)
    resetForNewTournament() {
        this.turnIndex = -1;
        if (this._endVote) io.to(this.roomId).emit('endVote', { active: false });
        this.clearEndVote();
        this._endAgreed = false;
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
                io.to(p.socketId).emit('gameMessage', `🔄 리바이 횟수를 모두 소진했습니다 (최대 ${this.maxRebuys}회).`);
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
        // 🛡️ 올인 중인 좌석은 chips===0 이라 파산으로 오인돼 핸드 도중 리바이가 됐다.
        //    보드를 다 보고 재구매를 결정할 수 있는 셈이라 반칙 — 핸드가 끝난 뒤에만 허용.
        if (this.gameStage >= 1 && this.gameStage <= 4 && this.playerOrder.includes(nick)) return false;
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
        if (p._wantSpectate) return;          // 👀 스스로 관전을 고른 사람에겐 권하지 않는다
        // 자리가 없으면 권하지 않는다 (권해봐야 doCashBuyin 이 거절한다)
        const withChips = Object.keys(this.players).filter(n => (this.players[n].chips || 0) > 0).length;
        if (withChips >= TABLE_SEATS) return;
        io.to(p.socketId).emit('cashBuyinOffer', { stack: this.startingChips });
    }

    doCashBuyin(nick) {
        if (this.mode !== 'cash') return false;
        const p = this.players[nick];
        if (!p || p.chips > 0) return false;
        // 🛡️ 올인 중인 좌석(chips===0)이 핸드 도중 재바이인하는 것 차단 — 보드를 보고 결정하는 반칙.
        if (this.gameStage >= 1 && this.gameStage <= 4 && this.playerOrder.includes(nick)) return false;
        // 🪑 자리가 없으면 받지 않는다 — 뱅크롤만 빠지고 앉지 못하는 상황을 막는다
        const _withChips = Object.keys(this.players).filter(n => (this.players[n].chips || 0) > 0).length;
        if (_withChips >= TABLE_SEATS) {
            if (p.socketId) io.to(p.socketId).emit('gameMessage', '🪑 자리가 가득 찼습니다 — 자리가 나면 바이인할 수 있어요.');
            return false;
        }
        p.chips = this.startingChips;
        p.isSpectator = false;
        p.totalBuyins = (p.totalBuyins || 1) + 1; // 첫 입장이 1회
        MockDB.recordCashNet(nick, -this.startingChips); // 💵 바이인 = 순익 -
        // 💰 뱅크롤에서 차감 + 본인 화면 반영
        MockDB.adjustBankroll(nick, -this.startingChips).then(nb => {
            if (p.socketId) io.to(p.socketId).emit('bankrollUpdate', { bankroll: nb || 0 });
        });
        io.to(this.roomId).emit('gameMessage', `💵 ${nick} 님이 ${this.startingChips.toLocaleString()} 칩 바이인! (재입장)`);
        // 좌석 배정은 대기 상태에서만. 핸드 진행 중이면 startNextHand가 다음 핸드에 앉힌다
        // (진행 중에 밀어넣으면 카드 없는 좌석이 턴을 받는다 — B1과 같은 결함).
        if (this.gameStage === 0 && !this.playerOrder.includes(nick)) this.playerOrder.push(nick);
        else if (this.gameStage !== 0 && p.socketId) io.to(p.socketId).emit('gameMessage', '🪑 다음 핸드부터 합류합니다.');
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
            if (!p.isBot && p.chips > 0 && !this._learnMode) {   // 🎓 학습 칩은 연습용 — 뱅크롤로 환수하지 않는다
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
            io.to(this.roomId).emit('gameMessage', `🚪 ${nick} 님이 ${chipsOut.toLocaleString()} 칩을 정산하고 나갔습니다.`);
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

    // 💥 [리포트] 방금 한 액션이 큰 실수면 상황째로 저장한다 (기준은 학습 조언과 같다)
    // 실력 점수·실수 기록·실제 성적을 쌓는 판인가: 일반 토너먼트 · 캐시 · MTT (+ 학습 모드는 학습 통계로 따로)
    countsForSkill() { return !this._challenge; }
    // 이 방의 기록이 들어갈 통계 상자: 'fn' 파이널나인 연습 · true 학습 모드 · false 본 기록
    statKind() { return this._fnMode ? 'fn' : !!this._learnMode; }
    noteBlunder(nick, type, p, advice, pre, beforeBet, beforeHighest) {
        if (!this.countsForSkill()) return;
        const bb = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;
        const toCall = Math.max(0, Math.min(beforeHighest - beforeBet, pre.chips));
        const putIn = Math.max(0, (p.currentBet || 0) - beforeBet);
        // 손실은 실력 점수와 같은 계산(EV 손실)을 쓴다 — 점수와 리포트의 숫자가 서로 어긋나지 않게
        const el = this._evLast && this._evLast.nick === nick ? this._evLast.res : null;
        if (!el || !el.kind || !(el.lossBB > 0)) return;
        const a = { kind: el.kind, costBB: el.lossBB };
        // 유형별 합계는 전부 세고, 상황째로 보관하는 것은 1bb 이상 잃은 결정만
        if (el.lossBB < 1) { MockDB.recordBlunder(nick, null, a.kind, a.costBB, this.statKind()); return; }
        const key = GtoAdvice.actionKey(advice, type);
        const r1 = x => Math.round(x / bb * 10) / 10;
        const ch = this._challenge;
        const rec = {
            t: Date.now(), learn: this.statKind(), kind: a.kind, costBB: a.costBB,
            modeLabel: this._fnMode ? '파이널나인 연습' : this._learnMode ? '학습' : (ch ? (ch.run ? '증강 컴까기' : '컴까기') : '토너먼트'),
            street: advice.street, hand: pre.hand, board: pre.board,
            pos: p.position || '', seats: this.playerOrder.length, opp: pre.opp,
            potBB: r1(pre.pot), toCallBB: r1(toCall), stackBB: r1(pre.chips + beforeBet),
            act: p.isAllIn && type !== 'fold' && type !== 'check' && type !== 'call' ? 'allin' : type, amtBB: r1(p.currentBet || 0),
            best: advice.bestAction, allinBest: advice.sizeHint === '올인',
            bestPct: advice.mix[advice.bestAction] || 0, didPct: advice.mix[key] || 0,
            eq: advice.equity, odds: advice.potOdds, eqLabel: advice.equityLabel || '내 승률',
            reason: String(advice.reason || '').slice(0, 260)
        };
        const saved = MockDB.recordBlunder(nick, rec, a.kind, a.costBB, this.statKind());
        if (saved) (this._handBl || (this._handBl = [])).push({ nick, rec: saved, bb });
    }
    // 🏁 핸드가 끝나 칩 정산이 끝난 직후: 사람마다 그 판의 칩 증감(bb)을 적고, 그 판에 기록된 실수에도 결과를 붙인다.
    //    🐛 예전엔 "다음 핸드 시작 직전"에만 했는데, 학습 모드는 그 전에 스택을 다시 채워서 결과가 늘 0으로 적혔다.
    settleHandResults() {
        if (!this.handStartStacks || this._netHand === this.handId) return;
        this._netHand = this.handId;
        const bb = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;
        this.playerOrder.forEach(nick => {
            const pl = this.players[nick], start = this.handStartStacks[nick];
            if (!pl || pl.isBot || typeof start !== 'number' || !this.countsForSkill()) return;
            const net = (pl.chips - start) / bb;
            MockDB.recordNet(nick, Math.round(net * 10) / 10, this.statKind());
            if (this._fnMode && this._mtt && this._fnRev && this._fnRev.hand === this.handId && this._fnRev.by[nick]) {
                const fr = this._fnRev.by[nick], ds = fr.d;
                const trivial = ds.length === 1 && ds[0].st === 'preflop' && ds[0].act === 'fold' && (ds[0].g === 'best' || ds[0].g === 'good');
                MockDB.recordFnHand(nick, this._mtt.mttId, { lv: this.blindLevel + 1, bb, stk: fr.stk, pos: pl.position || '', seats: this.playerOrder.length, alive: this._mtt.countAlive(),
                    h: fr.h, b: this.communityCards.slice(), net: Math.round(net * 10) / 10, loss: Math.round(ds.reduce((a, x) => a + (x.loss || 0), 0) * 100) / 100, d: ds }, trivial);
            }
            // 📉 이 판에서 잃은 기대값(결정별 손실의 합) + 🎲 운을 뺀 결과(올인 뒤 남은 카드는 승률만큼 받은 것으로 계산)
            const loss = (this._evHandId === this.handId && this._evHand && this._evHand[nick]) || 0;
            const aq = this._allinEq && this._allinEq.handId === this.handId ? this._allinEq.adj : null;
            const hasAdj = !!(aq && typeof aq[nick] === 'number');
            // 🪑 인원 보정(6인 기준 환산) · 인원 구간별 · 자리별 손실도 같이 쌓는다
            const seats = Object.keys(this.handStartStacks).length || this.playerOrder.length, sf = EvLoss.seatFactor(seats), lossN = loss * sf;
            const fmt = seats <= 2 ? 'hu' : seats <= 4 ? 'mid' : 'full', pk = Ranges.posKey(pl.position || '') || 'etc';
            MockDB.recordEv(nick, { evLoss: loss, evLossSq: loss * loss, evHands: 1, evNetAdj: Math.round((hasAdj ? aq[nick] / bb : net) * 100) / 100, evAllin: hasAdj ? 1 : 0,
                evLossN: lossN, evLossNSq: lossN * lossN, evSeats: seats, ['evFh_' + fmt]: 1, ['evFl_' + fmt]: loss, ['evPh_' + pk]: 1, ['evPl_' + pk]: loss }, this.statKind());
        });
        this.settleBlunders();
        if (this._mtt) { try { this._mtt.onHandEnd(this); } catch (e) { console.error('[MTT onHandEnd 오류]', e && e.message); } }
    }
    // 🎲 [운 보정] 둘이 올인으로 맞붙고 카드가 남았을 때, 그 순간의 승률로 "평균적으로 받았을 칩"을 계산해 둔다.
    //    실제로는 이기면 전부·지면 0 이지만, 실력은 승률만큼 받은 것으로 봐야 한다. (셋 이상이 얽힌 올인은 사이드팟이 복잡해 실제 결과를 그대로 쓴다)
    captureAllinEq() {
        if (!this.handStartStacks || (this._allinEq && this._allinEq.handId === this.handId) || this.communityCards.length >= 5) return;
        const live = this.playerOrder.filter(n => this.players[n] && !this.players[n].isFolded);
        if (live.length !== 2) return;
        const eq = this.computeEquities();
        if (!eq || typeof eq[live[0]] !== 'number' || typeof eq[live[1]] !== 'number') return;
        const inv = n => Math.max(0, (this.handStartStacks[n] || 0) - this.players[n].chips);
        let total = 0;
        this.playerOrder.forEach(n => { if (this.players[n] && typeof this.handStartStacks[n] === 'number') total += inv(n); });
        const m = Math.min(inv(live[0]), inv(live[1]));           // 서로 맞붙은 금액
        const dead = Math.max(0, total - inv(live[0]) - inv(live[1]));   // 접은 사람들이 두고 간 칩
        const adj = {};
        live.forEach(n => { const e = eq[n] / 100; adj[n] = e * (dead + m) - (1 - e) * m; });
        this._allinEq = { handId: this.handId, adj };
    }
    // 다음 핸드를 시작하기 직전(또는 방이 끝날 때): 그 판에서 실제로 칩이 얼마나 오갔는지 적는다
    settleBlunders() {
        const list = this._handBl;
        this._handBl = [];
        if (!list || !list.length || !this.handStartStacks) return;
        list.forEach(({ nick, rec, bb }) => {
            const pl = this.players[nick], start = this.handStartStacks[nick];
            if (!pl || typeof start !== 'number') return;
            rec.netBB = Math.round((pl.chips - start) / bb * 10) / 10;
        });
        MockDB.save();
    }

    // 📊 [신규] 액션 단위 포커 지표 + GTO 근접도 수집
    collectActionStats(nick, type, p, beforeBet, beforeHighest, raisesBefore) {
        const ev = {};
        const st0x = s => s || 'preflop';
        const toCall = beforeHighest - beforeBet;
        const facingBet = toCall > 0;
        const isRaise = (type === 'raise' || type === 'allin') && p.currentBet > beforeHighest;

        if (this.gameStage === 1) { // 프리플랍
            // 🐛 예전엔 프리플랍 액션마다 "기회 +1"을 세서, 한 핸드에 두 번 행동하면(오픈 → 3벳에 콜) 분모가 2가 됐다.
            //    VPIP 는 핸드당 한 번만 세니 VPIP·PFR 이 실제보다 낮게 나왔다. 기회와 레이즈 모두 핸드당 한 번만 센다.
            const seen = this._pfSeen || (this._pfSeen = { opp: new Set(), pfr: new Set() });
            if (!seen.opp.has(nick)) { seen.opp.add(nick); ev.preflopOpp = true; ev.seats = this.playerOrder.length; }
            if (isRaise && !seen.pfr.has(nick)) { seen.pfr.add(nick); ev.pfr = true; }
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

        // 🎯 실력 점수는 토너먼트 · 캐시 · MTT 에서만 쌓는다(운영자 요청). 컴까기·증강 컴까기는 목표 칩·기한·증강 때문에
        //    정석과 다르게 쳐야 하는 판이라 점수에 섞지 않는다. (GTO 학습은 원래 학습 통계에 따로 쌓인다)
        // 📉 EV 손실 — 이 결정으로 잃은 기대값(bb). 실력 점수는 이것의 100판당 합으로 낸다.
        this._evLast = null;
        let _el = null;
        if (this.countsForSkill()) {
            const sa0 = this._statAdv;
            if (sa0 && sa0.nick === nick && sa0.advice && sa0.pre) {
                const bb0 = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;
                _el = EvLoss.of(sa0.advice, type, { bb: bb0, pot: sa0.pre.pot, toCall: Math.max(0, Math.min(toCall, sa0.pre.chips)),
                    putIn: Math.max(0, (p.currentBet || 0) - beforeBet), street: sa0.advice.street, equity: (sa0.advice.equity || 0) / 100, opponents: sa0.pre.opp });
                if (_el) {
                    this._evLast = { nick, res: _el };
                    if (process.env.DEV_EVLOG) console.log('EVLOG ' + JSON.stringify({ n: nick, seats: this.playerOrder.length, pos: p.position || '', st: sa0.advice.street, type, best: sa0.advice.bestAction, call: toCall / bb0, pot: sa0.pre.pot / bb0, ev: sa0.advice.ev, h: p.hand.join(''), b: this.communityCards.join(''), eq: sa0.advice.equity, mix: sa0.advice.mix, sv: (sa0.advice.notes || []).some(n => n.indexOf('솔버') >= 0), l: _el.lossBB, k: _el.kind }));
                    if (this._evHandId !== this.handId) { this._evHandId = this.handId; this._evHand = {}; }
                    this._evHand[nick] = (this._evHand[nick] || 0) + _el.lossBB;
                    const st0 = sa0.advice.street || 'preflop';
                    MockDB.recordEv(nick, { ['evG_' + _el.grade]: 1, ['evC_' + st0]: 1, ['evS_' + st0]: _el.lossBB }, this.statKind());
                    // 🎞️ [대회 복기] 연습 대회의 결정은 판별로 모아 두었다가 판이 끝나면 저장한다
                    if (this._fnMode) {
                        if (!this._fnRev || this._fnRev.hand !== this.handId) this._fnRev = { hand: this.handId, by: {} };
                        const A = sa0.advice, rb = x => Math.round(x / bb0 * 10) / 10, key0 = GtoAdvice.actionKey(A, type);
                        (this._fnRev.by[nick] = this._fnRev.by[nick] || { h: sa0.pre.hand, stk: rb(sa0.pre.chips + beforeBet), d: [] }).d.push({
                            st: st0, b: sa0.pre.board.length, pot: rb(sa0.pre.pot), call: rb(Math.max(0, Math.min(toCall, sa0.pre.chips))),
                            act: (p.isAllIn && type !== 'fold' && type !== 'check' && type !== 'call') ? 'allin' : type, amt: rb(p.currentBet || 0),
                            best: A.bestAction, mix: A.mix, pct: A.mix[key0] || 0, g: _el.grade, loss: _el.lossBB, k: _el.kind || null,
                            size: A.sizeHint ? String(A.sizeHint).slice(0, 60) : '', sv: (A.notes || []).some(n => n.indexOf('솔버') >= 0),
                            why: _el.grade === 'best' ? '' : String(A.reason || '').slice(0, A.icm ? 360 : 220),
                            ic: A.icm ? (A.icm.push ? [A.icm.chip, A.icm.req, 'p'] : [A.icm.chip, A.icm.req]) : undefined
                        });
                    }
                    // 📏 스택 깊이별(내 스택 bb) · 🏁 대회 단계별 손실 — 대회에서는 "몇 bb 일 때, 어느 단계에서 새나"가 가장 쓸모 있는 피드백이다
                    {
                        const myBB = (sa0.pre.chips + beforeBet) / bb0, dk = myBB <= 12 ? 'd12' : myBB <= 25 ? 'd25' : myBB <= 40 ? 'd40' : 'deep';
                        const f2 = { ['evDn_' + dk]: 1, ['evDl_' + dk]: _el.lossBB };
                        if (this._mtt) {
                            const alive = this._mtt.countAlive(), paid = this._mtt.paid || 0, tot = this._mtt.totalEntrants || alive;
                            const ph = alive <= 2 ? 'hu' : (paid && alive <= paid) ? 'itm' : (paid && alive <= paid + 2) ? 'bubble' : alive <= this._mtt.tableSize ? 'ft' : alive <= tot / 2 ? 'mid' : 'early';
                            f2['evTn_' + ph] = 1; f2['evTl_' + ph] = _el.lossBB;
                        }
                        MockDB.recordEv(nick, f2, this.statKind());
                    }
                    // 🧮 솔버 일치율: 솔버 조언이 나온 결정 가운데 솔버 범위 안(권장 액션이거나 25% 이상 섞는 액션)으로 친 횟수
                    // 🏆 상금 압박(ICM)이 걸린 결정: 횟수 · 기준대로 친 횟수 · 손실
                    if (sa0.advice.icm) MockDB.recordEv(nick, { evIn: 1, evIk: (_el.grade === 'best' || _el.grade === 'good') ? 1 : 0, evIl: _el.lossBB }, this.statKind());
                    if (sa0.advice.solverTable) MockDB.recordEv(nick, { ['evVn_' + st0]: 1, ['evVk_' + st0]: (_el.grade === 'best' || _el.grade === 'good') ? 1 : 0 }, this.statKind());
                }
                // 📊 상황별 빈도: 이 자리에서 "했나"와 "조언이 권한 빈도"를 같이 쌓는다
                try {
                    const pre0 = st0x(sa0.advice.street) === 'preflop';
                    // 📏 승률 추정의 정확도: (조언이 쓴 승률 − 상대의 실제 패 상대 승률)을 스트리트·상대 종류별 합계로
                    const q = this._eqCal;
                    if (q && q.nick === nick && q.hand === this.handId && q.st === st0x(sa0.advice.street)) {
                        const k = q.st + '_' + (q.bot ? 'b' : 'h'), e = q.est - q.tr;
                        MockDB.recordEv(nick, { ['evQn_' + k]: 1, ['evQe_' + k]: e, ['evQs_' + k]: e * e }, this.statKind());
                    }
                    this._eqCal = null;
                    const spot = Freqs.spotOf({
                        street: st0x(sa0.advice.street), mix: sa0.advice.mix, type, isRaise, toCall: Math.max(0, toCall),
                        pos: p.position || '', isBB: !!(p.role && p.role.includes('BB')), raisesBefore: raisesBefore || 0,
                        iRaised: (this.actionLog || []).some(a => a.nick === nick && a.street === 1 && (a.type === 'raise' || a.type === 'allin')),
                        limpers: pre0 ? this.playerOrder.filter(n => n !== nick && this.players[n] && !this.players[n].isFolded && (this.players[n].currentBet || 0) === bb0 && !(this.players[n].role && this.players[n].role.includes('BB'))).length : 0,
                        pfAggressor: !pre0 && this.lastAggressorBefore(this.gameStage) === nick, allinIsCall: !!sa0.advice.allinIsCall
                    });
                    if (spot) MockDB.recordEv(nick, Freqs.fields(spot), this.statKind());
                } catch (e) {}
            }
        }
        const gto = this.countsForSkill() ? this.gtoProximity(nick, type, p, toCall) : null;
        if (gto !== null) {
            // 🎯 [점수 보정 — 실측으로 찾은 두 가지 왜곡]
            //   ① 프리플랍에 쓰레기 패를 접는 건 누구나 맞히는 결정이다. 이걸 전부 세면 "전부 폴드만 하는 사람"이 84점,
            //      제대로 치는 사람이 88점으로 거의 같게 나왔다 → 뻔한 폴드(폴드 권장 85% 이상을 폴드)는 점수에서 뺀다.
            //   ② 1bb 짜리 결정과 50bb 짜리 결정을 똑같이 세면 큰 판의 실수가 묻힌다 → 팟 크기(bb)의 제곱근으로 가중(1~6배).
            const sa = this._statAdv;
            const adv = sa && sa.nick === nick ? sa.advice : null;
            //   (공짜로 넘기는 뻔한 체크도 같다 — 체크 권장 85% 이상을 체크한 것은 누구나 맞히는 결정)
            const easyFold = !!(adv && ((adv.street === 'preflop' && type === 'fold' && adv.bestAction === 'fold' && (adv.mix.fold || 0) >= 85)
                || (type === 'check' && adv.bestAction === 'check' && (adv.mix.check || 0) >= 85)));
            if (easyFold) ev.gtoEasy = true;
            else {
                ev.gtoScore = gto;
                const potBB = sa && sa.nick === nick ? sa.potBB : 1;
                ev.gtoWeight = Math.round(Math.max(1, Math.min(6, Math.sqrt(Math.max(1, potBB)))) * 100) / 100;
                ev.gtoStreet = adv ? adv.street : 'preflop';
                // 🔎 이 결정 한 건을 기록해 둔다(본인만 볼 수 있다)
                if (adv && sa.pre) {
                    const bb = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;
                    const r1 = x => Math.round(x / bb * 10) / 10;
                    const key = GtoAdvice.actionKey(adv, type);
                    MockDB.recordDecision(nick, {
                        t: Date.now(), st: adv.street, h: sa.pre.hand, b: sa.pre.board, pos: p.position || '',
                        pot: r1(sa.pre.pot), call: r1(Math.max(0, toCall)), act: type, amt: r1(p.currentBet || 0),
                        best: adv.bestAction, bestPct: adv.mix[adv.bestAction] || 0, pct: adv.mix[key] || 0,
                        sc: gto, w: ev.gtoWeight, loss: _el ? _el.lossBB : null, g: _el ? _el.grade : null, why: String(adv.reason || '').slice(0, 160)
                    }, this.statKind());
                }
            }
        }

        MockDB.recordActionStats(nick, ev, this.statKind());
    }

    // 🎯 단순화된 GTO 근접도: 팟 오즈 대비 승률(에퀴티)로 행동 적정성 평가 (0~100)
    // 🎓 [학습모드] 현재 플레이어 상황에서 GTO 권장 액션 분석
    //   각 액션(폴드/체크/콜/레이즈)의 EV와 권장 빈도, 핸드 평가를 계산
    getGtoAdvice(nick) {
        const cont = f => (f.raise || 0) + (f.call || 0);
        const p = this.players[nick];
        if (!p || !p.hand || p.hand.length !== 2 || p.isFolded) return null;

        let equity;
        try { equity = this.estimateBotEquity(nick); } catch (e) { return null; }
        if (typeof equity !== 'number' || isNaN(equity)) return null;

        // 🐛 [숏스택 팟오즈] 예전엔 "상대 벳 전체"를 콜 금액으로 보고 팟오즈를 냈다. 내 칩이 그보다 적으면 실제로는 내 칩만큼만 걸고,
        //    상대 벳 중 내가 못 받는 부분은 상대에게 돌아간다. 예: 팟 1000에 상대 3000 벳, 내 칩 500 → 필요 승률은 43%가 아니라 25%.
        //    그래서 칩이 적을 때 조언이 지나치게 폴드로 기울었다.
        const _fullCall = Math.max(0, this.currentHighestBet - p.currentBet);
        const toCall = Math.min(_fullCall, p.chips);
        const _myMax = p.currentBet + p.chips;
        const potBefore = this.pot + Object.keys(this.players).reduce((s, n) => n === nick ? s : s + Math.min(this.players[n].currentBet || 0, _myMax), 0);
        // 🐛 [팟오즈] 이번 스트리트에 내가 이미 낸 칩(블라인드·앞선 벳)도 팟의 일부다. 예전엔 그걸 빼고 계산해서 필요 승률이 높게 나왔다
        //    (BB가 2.5bb 오픈을 받을 때: 실제 27%인데 33%로 계산).
        let potOdds = toCall > 0 ? toCall / (potBefore + p.currentBet + toCall) : 0;
        // 🏆 [ICM] 입상이 걸린 대회의 올인 승부는 칩이 아니라 상금 기대값으로 본다. 차이가 2%p 이상일 때만 적용한다(대회 초반은 차이가 거의 없다).
        //    필요 승률(potOdds)을 상금 기준 값으로 바꿔 두면 아래의 콜/폴드 판단과 설명이 전부 그 값으로 나온다.
        let _icm = null, _icmPush = null;
        if (toCall > 0) { try { const ic = this.icmCall(nick, toCall, potBefore + p.currentBet + toCall); if (ic && ic.tax >= 0.02) { _icm = ic; potOdds = ic.req; } if (ic && process.env.DEV_ICMLOG) console.log('ICMLOG advice ' + JSON.stringify(Object.assign({ n: nick, call: toCall, chips: p.chips }, ic))); } catch (e) {} }
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
        // 🎯 [상황별 조언] 예전엔 승률 하나로만 갈라서 헤즈업·4명·숏스택에서 전부 같은 말을 했다.
        //    상대 수 · 유효 스택(bb) · 포지션 · SPR 을 같이 본다. notes 는 화면에 "지금 상황" 꼬리표로 나간다.
        let notes = [];
        let sizeHint = '', rawEquity = null, equityLabel = '내 승률';
        const _ev = {};          // 📉 액션별 기대값(칩) — EV 손실 계산용 (lib/evloss.js)
        let _vRangeW = null;     // 🔍 벳한 상대의 프리플랍 범위 폭(%)
        let _svTable = null;     // 📋 솔버 표(패 종류별 빈도)
        const _bbNow = this.blindStructure[Math.min(this.blindLevel, this.blindStructure.length - 1)].bb;
        const _liveOpp = this.playerOrder.filter(n => n !== nick && this.players[n] && !this.players[n].isFolded);
        const _stk = n => this.players[n].chips + (this.players[n].currentBet || 0);
        const effBB = (_liveOpp.length ? Math.min(_stk(nick), Math.max(..._liveOpp.map(_stk))) : _stk(nick)) / _bbNow;
        const _effBehind = _liveOpp.length ? Math.min(p.chips, Math.max(..._liveOpp.map(n => this.players[n].chips))) : p.chips;
        const _spr = potBefore > 0 ? _effBehind / potBefore : 99;

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
            // 🎯 디펜스 폭: 살아있는 인원(나 포함) + 리레이즈 여부 — 봇 botDecide와 동일 컨텍스트
            // 누가 열었나(마지막으로 레이즈한 사람의 자리) · 내가 BB 인가 · 헤즈업 테이블인가 — 학습용 방어 기준에 쓴다
            const _opn = this.playerOrder.find(n => n !== nick && this.players[n] && !this.players[n].isFolded
                && (this.players[n].currentBet || 0) === this.currentHighestBet && this.currentHighestBet > bb) || null;
            const _opnPos = _opn ? (this.players[_opn].position || '') : '';
            const _huTable = this.playerOrder.length === 2;
            // 📊 범위표(lib/ranges.js)에 넘길 것: 레이즈가 몇 번 나왔나 · 내가 이미 올렸나(= 내 오픈에 3벳이 온 것) · 올린 사람보다 내가 뒤인가
            const _iRaised = (this.actionLog || []).some(a => a.nick === nick && (a.board || []).length === 0 && (a.type === 'raise' || a.type === 'allin'));
            // 📊 솔버 프리플랍 자료의 열쇠: 지금까지의 행동(자리:R 레이즈 · C 콜 · F 들어왔다가 접음)>내 자리
            let _seqKey = null;
            if (!_huTable && facingRaise) {
                const _dp = n => Ranges.dataPos((this.players[n] || {}).position || '');
                let _hi = bb; const _tok = [], _in = new Set();
                (this.actionLog || []).filter(a => a.street === 1).forEach(a => {
                    if (a.type === 'sb' || a.type === 'bb' || a.type === 'ante' || a.type === 'check') return;
                    const ps = _dp(a.nick);
                    if ((a.type === 'raise' || a.type === 'allin') && a.amount > _hi) { _tok.push(ps + ':R'); _hi = a.amount; _in.add(a.nick); }
                    else if (a.type === 'call' || a.type === 'allin') { _tok.push(ps + ':C'); _in.add(a.nick); }
                    else if (a.type === 'fold' && _in.has(a.nick)) _tok.push(ps + ':F');
                });
                _seqKey = _tok.join(',') + '>' + _dp(nick);
            }
            const _ctx = { seq: _seqKey, numActive: opponents + 1, threeBetPlus: (this.raiseCountThisStreet || 0) >= 2,
                headsUp: _huTable, openerPos: _opnPos, closing: !!isBB, potOdds: facingRaise ? potOdds : 0,   // potOdds: 오픈 크기·앤티에 따라 방어 폭이 달라진다
                chart: true, raises: this.raiseCountThisStreet || 1, iRaised: _iRaised, inPosition: this.isInPosition(nick) };
            const rt = preflopRangeTier(code, p.position || '', facingRaise, _ctx);
            // 문구: 처음 연 것이면 '오픈', 누가 림프한 뒤 올린 것(내가 림프했거나 블라인드가 올림)이면 '레이즈', 두 번째 레이즈부터는 '리레이즈'
            const _iLimped = !isBB && (p.currentBet || 0) >= bb;
            const _opnBlind = !!(_opn && this.players[_opn].role && /SB|BB/.test(this.players[_opn].role) && this.playerOrder.length > 2);
            const _vsWord = (this.raiseCountThisStreet || 0) >= 2 ? '리레이즈' : ((_iLimped || (_opnBlind && this.players[_opn].role.includes('BB'))) ? '레이즈' : '오픈');
            const _vs = facingRaise ? (_huTable ? ' (헤즈업 — 넓게 방어)' : (_opnPos ? ` (${_opnPos} ${_vsWord} 상대${isBB ? ' · BB라 넓게' : ''})` : '')) : '';
            posInfo = { position: p.position || '-', code, rangeScore: rt.score, rangeLabel: rt.label, threshold: openThreshold(p.position || '') };
            // 등급은 핸드 점수로, 승률은 "아무 패 한 명 상대"(몬테카를로 표)로 — 예전 값은 어림식을 상대 수의 제곱근으로 나눈 것이라 승률이 아니었다
            { const _pt = GtoAdvice.preflopTier(rt.score); tier = _pt.tier; tierLabel = _pt.tierLabel; tierColor = _pt.tierColor; }
            equity = ShortStack.equityVs(code, 1);
            equityLabel = '1명 상대 승률';

            const canCheck = (toCall === 0); // BB 무료 체크 또는 림프 팟
            notes.push(this.playerOrder.length === 2 ? '헤즈업 테이블' : (opponents === 1 ? '상대 1명 남음' : `${opponents + 1}명 남음`));
            notes.push(`유효 스택 ${Math.round(effBB)}bb`);
            // ── 스택이 짧거나 올인을 마주한 상황은 일반 오픈/3벳 표가 아니라 푸시/폴드 기준으로 본다 (봇과 같은 표) ──
            let _special = false;
            const _pctl = ShortStack.handPercentile(code);
            const _pc = x => Math.round(x * 100);
            const _raises = this.raiseCountThisStreet || 0;
            const _aggr = _liveOpp.find(n => (this.players[n].currentBet || 0) === this.currentHighestBet && this.currentHighestBet > bb) || null;
            const _aggrP = _aggr ? this.players[_aggr] : null;
            const _aggrAllIn = !!(_aggrP && (_aggrP.isAllIn || _aggrP.chips === 0));
            if (facingRaise && toCall > 0 && (toCall >= p.chips * 0.4 || (_aggrAllIn && toCall >= bb * 3))) {
                // (가) 올인(또는 내 스택의 큰 몫)을 받는 상황 — "올인하는 사람의 범위 상대 승률"로 판단
                let x;
                if (_aggrAllIn) x = ShortStack.shoverPct(_aggr ? _stk(_aggr) / bb : effBB, Math.max(1, _liveOpp.length), _raises);
                else x = _raises >= 3 ? 0.03 : _raises === 2 ? 0.07 : ShortStack.openPct(_aggrP ? _aggrP.position : '');
                if (_aggr && _aggrAllIn) { const js = this.jamStat(_aggr); if (js.j >= 2 && js.h >= 3) x = Math.max(x, Math.min(1, js.j / js.h)); }
                x = Math.min(1, x);
                const res = ShortStack.shouldCallShove(code, x, potOdds, 0.02);
                equity = res.equity; equityLabel = '올인 범위 상대 승률';   // 판단에 쓴 숫자를 그대로 보여 준다
                notes.push('올인 받기');
                _special = true;
                if (res.call) {
                    const jam = res.equity > 0.60 && p.chips > toCall;
                    mix = jam ? { fold: 0, call: 40, raise: 60 } : { fold: 8, call: 92 };
                    bestAction = jam ? 'raise' : 'call';
                    reason = `상대가 스택을 건 범위는 상위 약 ${_pc(x)}%로 봅니다. 그 범위 상대로 ${code}의 승률은 약 ${_pc(res.equity)}% — 필요 승률(${_pc(potOdds)}%)을 넘으니 ${jam ? '올인' : '콜'}.`;
                } else {
                    mix = { fold: 90, call: 10 };
                    bestAction = 'fold';
                    reason = `상대가 스택을 건 범위는 상위 약 ${_pc(x)}%. 그 범위 상대로 ${code}의 승률은 약 ${_pc(res.equity)}%라 필요 승률(${_pc(potOdds)}%)에 못 미칩니다 — 폴드. ("아무 패 상대 승률"로 보면 넓게 받게 됩니다.)`;
                }
            } else if (effBB <= 12 && p.chips > 0) {
                // (나) 12bb 이하: 올인 아니면 폴드
                if (!facingRaise) {
                    const _bhd = _liveOpp.filter(n => !this.players[n].hasActed && !this.players[n].isAllIn);
                    const behind = Math.max(1, _bhd.length);
                    let range = ShortStack.pushPct(effBB, behind), _rk = _pctl, _jev = null;
                    // 🧨 어림표 대신 지금 스택·앤티·뒤 사람들의 칩으로 직접 푼 균형(lib/jam.js)을 쓴다. 순위도 "올인 기대값이 높은 순"이다.
                    try { const ji = this.jamInfo(nick, code); if (ji) { range = ji.range; _rk = ji.rank; _jev = ji.ev; notes.push('올인 균형 계산'); } } catch (e) {}
                    // 🏆 [ICM] 입상이 걸린 대회에서는 푸시 범위도 상금 기준으로 — 받는 쪽이 조심해야 하는 자리면 넓게, 내가 지면 먼저 떨어지는 자리면 좁게
                    try {
                        const ip = this.icmPush(nick, range, _bhd);
                        if (ip && Math.abs(ip.ratio - 1) >= 0.12) {
                            const r0 = range; range = Math.max(0.03, Math.min(1, range * ip.ratio));
                            _icmPush = { chip: Math.round(r0 * 100), req: Math.round(range * 100), alive: ip.alive, paid: ip.paid, push: true };
                        }
                    } catch (e) {}
                    notes.push('숏스택 — 푸시/폴드');
                    _special = true;
                    const _jt = _jev != null ? ` (올인의 기대값 약 ${_jev >= 0 ? '+' : ''}${Math.round(_jev * 10) / 10}bb)` : '';
                    if (_rk <= range) {
                        mix = canCheck ? { check: 8, raise: 92 } : { fold: 8, raise: 92 };
                        bestAction = 'raise';
                        reason = `${Math.round(effBB)}bb 숏스택 — 작게 열고 접을 칩이 없습니다. 올인 아니면 폴드: 뒤에 ${behind}명이면 푸시 범위는 상위 약 ${_pc(range)}%, ${code}는 상위 ${_pc(_rk)}% → 올인.${_jt}`;
                    } else if (canCheck) {
                        mix = { check: 100 }; bestAction = 'check';
                        reason = `${Math.round(effBB)}bb 숏스택 — ${code}는 푸시 범위(상위 약 ${_pc(range)}%) 밖입니다. 공짜로 플랍을 보세요.`;
                    } else {
                        mix = { fold: 94, raise: 6 }; bestAction = 'fold';
                        reason = `${Math.round(effBB)}bb 숏스택 — 올인 아니면 폴드입니다. 뒤에 ${behind}명이면 푸시 범위는 상위 약 ${_pc(range)}%인데 ${code}는 상위 ${_pc(_rk)}% → 폴드.${_jt} (작게 열거나 림프하면 칩만 흘립니다.)`;
                    }
                } else if (!(isBB && toCall <= bb * 1.5 && effBB >= 6)) {
                    const openX = _raises >= 2 ? 0.07 : ShortStack.openPct(_aggrP ? _aggrP.position : '');
                    let r = ShortStack.reshovePct(openX, effBB), _in = _pctl <= r, _rk = _pctl, _jt = '';
                    // 🧨 연 사람의 오픈 범위를 상대로 직접 푼 균형: 올인의 기대값이 0 을 넘는 패가 리쉬브 범위다
                    try { const jr = this.jamInfo(nick, code); if (jr) { r = Jam.fracAbove(jr.res, 0); _in = jr.ev > 0; _rk = jr.rank; _jt = ` (올인의 기대값 약 ${jr.ev >= 0 ? '+' : ''}${Math.round(jr.ev * 10) / 10}bb)`; notes.push('올인 균형 계산'); } } catch (e) {}
                    notes.push('숏스택 — 리쉬브/폴드');
                    _special = true;
                    if (_in) {
                        mix = { fold: 6, call: 4, raise: 90 }; bestAction = 'raise';
                        reason = `${Math.round(effBB)}bb로 오픈을 받았습니다 — 콜하면 플랍 뒤에 할 수 있는 게 없어 올인(리쉬브) 아니면 폴드. 리쉬브 범위 상위 약 ${_pc(r)}%, ${code}는 상위 ${_pc(_rk)}% → 올인.${_jt}`;
                    } else {
                        mix = { fold: 92, call: 6, raise: 2 }; bestAction = 'fold';
                        reason = `${Math.round(effBB)}bb로 오픈을 받았습니다 — 올인 아니면 폴드. 리쉬브 범위는 상위 약 ${_pc(r)}%인데 ${code}는 상위 ${_pc(_rk)}% → 폴드.${_jt}`;
                    }
                }
            } else if (effBB <= 25 && facingRaise && _raises <= 1 && _aggrP && !_aggrAllIn) {
                // (다) 13~25bb: 넓은 오픈에는 리쉬브가 3벳보다 낫다. 연 사람의 오픈 범위 상대로 직접 푼 올인의 기대값으로 고른다
                //      (13~20bb 는 +0.3bb, 20~25bb 는 +1bb 넘게 남을 때만 — 그 아래는 콜·작은 3벳이 나을 수 있어 범위표에 맡긴다).
                let r = effBB <= 20 ? ShortStack.reshovePct(ShortStack.openPct(_aggrP.position), effBB) : 0, _in = effBB <= 20 && _pctl <= r, _rk = _pctl, _jt = '';
                try { const jr = this.jamInfo(nick, code), thr = effBB <= 20 ? 0.3 : 1; if (jr) { r = Jam.fracAbove(jr.res, thr); _in = jr.ev > thr; _rk = jr.rank; _jt = ` 올인의 기대값 약 +${Math.round(jr.ev * 10) / 10}bb.`; if (_in) notes.push('올인 균형 계산'); } } catch (e) {}
                if (_in) {
                    notes.push('리쉬브 스택');
                    _special = true;
                    mix = { fold: 8, call: 17, raise: 75 }; bestAction = 'raise';
                    reason = `${Math.round(effBB)}bb — 작게 3벳하면 스택의 3분의 1이 들어가 어차피 못 접습니다. ${_aggrP.position || '상대'} 오픈 상대로 리쉬브 범위는 상위 약 ${_pc(r)}%, ${code}는 상위 ${_pc(_rk)}% → 올인이 기준.${_jt}`;
                }
            }
            // 📊 레인지 표가 지금 상황에 맞는 표를 그리도록 알려준다 (헤즈업 / 숏스택 푸시 / 6인)
            posInfo.chart = { players: this.playerOrder.length, headsUp: _huTable, effBB: Math.round(effBB), push: null };
            if (effBB <= 12 && !facingRaise) {
                const _bh = Math.max(1, _liveOpp.filter(n => !this.players[n].hasActed && !this.players[n].isAllIn).length);
                posInfo.chart.push = { range: _icmPush ? _icmPush.req / 100 : ShortStack.pushPct(effBB, _bh), behind: _bh };
            }
            // 📊 레이즈를 받은 자리면 그 상황의 범위표 한 장을 같이 보낸다(패마다 [레이즈 %, 콜 %])
            if (rt.freq && !_special && (facingRaise || rt.open)) {
                const cells = {}; let wr = 0, wc = 0;
                Ranges.ALL.forEach(c => {
                    const f = (preflopRangeTier(c, p.position || '', facingRaise, _ctx).freq) || null;
                    if (!f) return;
                    if (f.raise || f.call) cells[c] = [f.raise, f.call];
                    wr += f.raise / 100 * Ranges.combos(c); wc += f.call / 100 * Ranges.combos(c);
                });
                posInfo.chart.vs = { name: rt.chartName, raiseName: rt.raiseName || '3벳', cells, raise: Math.round(wr / 13.26), call: Math.round(wc / 13.26), priced: !!rt.priced };
            }
            if (_special) {
                // 위에서 결정됨
                if (bestAction === 'raise') sizeHint = '올인';
            } else if (!facingRaise) {
                // 미오픈/오픈 기회 (아직 레이즈 없음) — 정석은 raise-or-fold, 림프 지양 (BB는 공짜 체크 가능)
                const late = (p.position === 'BTN' || p.position === 'CO' || p.position === 'SB');
                // 모두 접고 SB 가 BB 한 명만 상대하는 자리(6인 테이블의 블라인드 대결). 헤즈업 테이블은 아래에서 따로 넓게 연다.
                const _sbVsBb = !_huTable && opponents === 1 && !!(p.role && p.role.includes('SB'));
                if (rt.freq && rt.open && !canCheck && opponents >= 2) {
                    // 📊 먼저 여는 자리: 솔버 자료의 오픈 빈도
                    const f = rt.freq;
                    mix = { fold: f.fold, raise: f.raise };
                    bestAction = f.raise >= 50 ? 'raise' : 'fold';
                    reason = f.raise >= 85 ? `${p.position || ''} 오픈 범위에 드는 핸드(${code}) — 오픈 레이즈가 정석입니다. (솔버: 오픈 ${f.raise}%)`
                        : f.raise <= 15 ? `${p.position || ''} 오픈 범위 밖(${code}) — 폴드가 정석입니다.${f.raise > 0 ? ` (솔버도 ${f.raise}%만 엽니다)` : ''}`
                        : `${code}는 ${p.position || ''}에서 섞어 여는 패입니다 — 솔버는 ${f.raise}%만 엽니다. 어느 쪽도 실수가 아닙니다.`;
                } else if (opponents === 1 && !canCheck && rt.tier !== 'raise' && rt.score > Quiz.HU_OPEN_SCORE) {
                    // 헤즈업 버튼(SB)은 6인 버튼 차트보다 훨씬 넓게 연다
                    mix = { fold: 15, raise: 85 };
                    bestAction = 'raise'; reason = `헤즈업 버튼 — 상대가 한 명뿐이고 플랍 뒤에도 포지션이 내 것이라 전체 패의 4분의 3쯤을 엽니다. ${code}는 6인 테이블에선 접을 패지만 여기선 오픈.`;
                } else if (rt.tier === 'raise') {
                    mix = canCheck ? { check: 8, raise: 92 } : { fold: 6, raise: 94 };
                    bestAction = 'raise'; reason = `${p.position || ''} 오픈 레인지에 드는 핸드(${code}) — 오픈 레이즈가 정석입니다.`;
                    if (_sbVsBb && !canCheck) mix = { fold: 4, call: 26, raise: 70 };
                } else if (_sbVsBb && !canCheck) {
                    // 🐛 블라인드끼리(모두 접고 SB 차례) 또는 헤즈업 버튼의 "콜만 하기(림프)"는 솔버도 자주 쓰는 선택이다(절반 값에 BB 한 명만 상대).
                    //    예전엔 믹스에 콜이 아예 없어서 SB 림프가 매번 0%짜리 실수로 채점됐다.
                    if (rt.tier === 'call' || rt.score >= 30) { mix = { fold: 30, call: 40, raise: 30 }; bestAction = 'call'; reason = `SB에서 BB 한 명만 남았습니다 — ${code}는 접기엔 아깝고 올리기엔 약한 패라 콜(림프)로 싸게 보는 것이 무난합니다. 스틸 레이즈도 섞입니다.`; }
                    else { mix = { fold: 72, call: 20, raise: 8 }; bestAction = 'fold'; reason = `약한 핸드(${code}) — 폴드가 기본입니다. 절반 값이라 가끔 콜도 나옵니다.`; }
                } else if (rt.tier === 'call') {
                    if (canCheck) {
                        mix = { check: 100 };
                        bestAction = 'check'; reason = `마지널 핸드(${code}) — 체크로 공짜 플랍을 보세요.`;
                    } else if (late) {
                        mix = { fold: 55, raise: 45 };
                        bestAction = 'fold'; reason = `늦은 포지션 마지널(${code}) — 림프 말고 스틸 오픈 아니면 폴드입니다.`;
                    } else {
                        mix = { fold: 80, raise: 20 };
                        bestAction = 'fold'; reason = `마지널 핸드(${code}) — 앞 포지션에선 폴드가 정석(가끔만 오픈).`;
                    }
                } else {
                    mix = canCheck ? { check: 100 } : { fold: 92, raise: 8 };
                    bestAction = canCheck ? 'check' : 'fold';
                    reason = canCheck ? `약한 핸드(${code}) — 공짜로 플랍을 보세요.` : `오픈 레인지 밖(${code}) — 폴드가 정석입니다(가끔 스틸).`;
                }
            } else {
                // 레이즈에 직면 — 3벳/콜/폴드
                if (rt.freq) {
                    // 📊 범위표가 있는 자리: 패마다 정해진 빈도를 그대로 쓴다
                    const f = rt.freq, rn = rt.raiseName || '3벳';
                    mix = { fold: f.fold, call: f.call, raise: f.raise };
                    bestAction = rt.tier;
                    const parts = [f.raise ? `${rn} ${f.raise}%` : '', f.call ? `콜 ${f.call}%` : '', f.fold ? `폴드 ${f.fold}%` : ''].filter(Boolean).join(' · ');
                    const pure = Math.max(f.raise, f.call, f.fold) >= 85;
                    let why;
                    if (rt.tier === 'raise') {
                        const bluffy = rt.score < 70 && !/^(AA|KK|QQ|JJ|TT|AK)/.test(code);
                        why = bluffy ? `${code}는 ${rn} 범위의 "블러프 쪽"입니다 — 상대의 강한 패(에이스·킹)를 막거나 뒤집을 길이 있어서, 콜보다 ${rn}으로 섞습니다.` : `${code}는 ${rn}으로 값을 키우는 패입니다.`;
                    } else if (rt.tier === 'call') why = `${code}는 콜로 플랍을 보는 패입니다.${f.raise >= 15 ? ` ${rn}도 섞입니다.` : ''}`;
                    else why = cont(f) > 0 ? `${code}는 접는 쪽이 기본이지만 가끔 섞어 치는 패입니다.` : `${code}는 이 자리의 방어 범위 밖입니다 — 폴드.`;
                    reason = `${why} 범위표(${rt.chartName}): ${parts}${pure ? '' : ' — 섞어 치는 패라 어느 쪽도 실수가 아닙니다'}.${rt.priced ? ' (오픈 크기·앤티에 맞춰 콜 폭을 조정했습니다.)' : ''}${_vs}`;
                } else if (rt.tier === 'raise') {
                    mix = { fold: 5, call: 35, raise: 60 };
                    bestAction = 'raise'; reason = `강한 핸드(${code}) — 3벳으로 밸류를 키우세요.${_vs}`;
                } else if (rt.tier === 'call') {
                    // 방어 범위 한가운데면 콜이 분명하고, 경계 바로 위면 폴드도 섞인다
                    const edge = typeof rt.gap === 'number' && rt.gap < 6;
                    mix = edge ? { fold: 40, call: 56, raise: 4 } : { fold: 15, call: 77, raise: 8 };
                    bestAction = 'call'; reason = `콜 가능한 핸드(${code}, 점수 ${rt.score}) — 콜로 플랍을 보세요.${edge ? ' (방어 범위의 아래쪽 경계라 접어도 큰 차이는 없습니다.)' : ''}${_vs}`;
                } else {
                    // 🐛 예전엔 경계에서 한 끗 모자란 패도, 한참 모자란 패도 똑같이 "폴드 88 · 콜 12"였다 — 경계선 패를 콜하면 "접어야 할 패로 콜"로 채점됐다.
                    const edge = typeof rt.gap === 'number' && rt.gap >= -6;
                    mix = edge ? { fold: 60, call: 38, raise: 2 } : { fold: 90, call: 9, raise: 1 };
                    bestAction = 'fold';
                    reason = edge ? `경계선 핸드(${code}) — 접는 쪽이 조금 낫지만 콜도 나오는 패입니다.${_vs}` : `레이즈에 약한 핸드(${code}) — 폴드가 정석입니다.${_vs}`;
                }
            }
            if (!_special && (bestAction === 'raise' || (mix.raise || 0) >= 30)) {
                if (!facingRaise) {
                    // 림퍼: 블라인드가 아닌데 bb 만큼만 넣고 남아 있는 사람
                    const limpers = _liveOpp.filter(n => { const o = this.players[n]; return (o.currentBet || 0) === bb && !(o.role && o.role.includes('BB')); }).length;
                    sizeHint = GtoAdvice.openSize(effBB, _huTable, limpers);
                }
                else {
                    const callers = _liveOpp.filter(n => n !== _opn && (this.players[n].currentBet || 0) === this.currentHighestBet).length;
                    const inPos = !(p.role && (p.role.includes('SB') || p.role.includes('BB'))) || _huTable && p.role.includes('D');
                    sizeHint = GtoAdvice.threeBetSize(this.currentHighestBet, callers, inPos, bb, _stk(nick)).text;
                    // 4벳은 3벳의 2.2~2.5배, 그 위(5벳)는 올인이 기준
                    if (_raises >= 3) sizeHint = '올인';
                    else if (_raises === 2) {
                        const to = Math.round(this.currentHighestBet * (inPos ? 2.2 : 2.5) / bb) * bb;
                        sizeHint = to >= _stk(nick) * 0.4 ? '올인 (4벳 크기가 스택의 40%를 넘어 어차피 못 접습니다)' : `약 ${to.toLocaleString()} (상대 3벳의 ${inPos ? '2.2' : '2.5'}배)`;
                    }
                }
            }
            // 📉 기대값(칩). 레이즈를 받았으면 "콜의 기대값" = 상대 범위 상대 승률 × 실현율 × 콜 뒤 팟 − 콜 금액,
            //    아직 아무도 안 열었으면 "오픈의 기대값" = 오픈 기준에서 얼마나 떨어진 패인가로 어림(기준 위 d점이면 0.0035·d² bb·최대 8bb, 아래는 1점당 −0.03bb·최대 −1.5bb).
            //    맞춘 기준: 전부 접는 사람은 이론상 블라인드만큼(6인 약 25bb/100판, 헤즈업 약 75bb/100판) 잃는다 — 자리별 평균이 그 근처가 되게 했다.
            {
                const potAll = potBefore + p.currentBet;
                if (facingRaise) {
                    let eqR, R = 1;
                    if (equityLabel === '올인 범위 상대 승률') eqR = equity;      // 올인 받기: 위에서 이미 그 범위 상대 승률을 냈고, 다 깔리니 실현율은 1
                    else {
                        const x = (_huTable && _raises <= 1) ? 0.76 : _raises >= 3 ? 0.03 : _raises === 2 ? 0.07 : ShortStack.openPct(_aggrP ? _aggrP.position : _opnPos);
                        eqR = ShortStack.shouldCallShove(code, Math.min(1, x), 0, 0).equity;
                        const g = typeof rt.gap === 'number' ? rt.gap : 0;
                        // 실현율: 자리가 나쁠수록, 패가 방어 기준에서 멀수록 승률만큼 못 가져간다 (BB 0.80 · SB 0.72 · 그 밖 0.93, 패에 따라 −0.2~+0.1)
                        R = (isBB ? 0.80 : (!_huTable && p.role && p.role.includes('SB')) ? 0.72 : 0.93) + Math.max(-0.2, Math.min(0.1, g / 100));
                    }
                    let c = eqR * R * (potAll + toCall) - toCall;
                    // 강한 패는 지금 팟보다 훨씬 큰 팟을 가져간다(AA 는 콜 뒤 팟의 승률분보다 몇 배 번다) — 승률이 50%를 넘는 만큼 제곱으로 더한다
                    if (equityLabel !== '올인 범위 상대 승률') c += 9 * Math.pow(Math.max(0, eqR - 0.5), 2) * (potAll + toCall);
                    // 어림값의 부호가 방어 기준표와 어긋나면 기준표를 따른다(기준표는 외부 솔버 자료에 맞춰 둔 것)
                    if (!_special && typeof rt.gap === 'number') {
                        const cap = Math.min(0.3, Math.abs(rt.gap) * 0.05) * bb;
                        if (rt.tier !== 'fold' && c < 0) c = cap; else if (rt.tier === 'fold' && c > 0) c = -cap;
                    }
                    _ev.call = Math.round(c);
                } else if (_special) {
                    _ev.open = Math.round((bestAction === 'raise' ? 1 : -0.6) * bb);      // 푸시/폴드 구간
                } else {
                    const hu1 = opponents === 1 && !canCheck;      // 한 명만 남은 자리(헤즈업 버튼·블라인드 대결)는 훨씬 넓게 열어 패 하나의 값은 작다
                    const d = rt.score - (hu1 ? Quiz.HU_OPEN_SCORE : openThreshold(p.position || ''));
                    _ev.open = Math.round((d >= 0 ? Math.min(8, 0.0035 * d * d) * (hu1 ? 0.6 : 1) : Math.max(-1.5, 0.03 * d)) * bb);
                }
            }
        } else {
            // 🎯 [벳 범위 반영] 벳을 받았으면 "아무 패 상대 승률"이 아니라 "벳하는 범위 상대 승률"로 본다.
            //    몬테카를로 승률은 상대가 아무 패나 들고 있다고 가정해서, 큰 벳을 받은 상황에서 과하게 낙관적이었다
            //    (실측: 승률 66%라며 콜을 권했지만 벳한 범위 상대로는 한참 낮은 경우). 봇이 쓰는 것과 같은 계산이다.
            if (toCall > 0) {
                try {
                    const _bf = toCall / Math.max(_bbNow, potBefore - toCall);
                    const _vn = this.lastAggressorBefore(this.gameStage + 1) || '';
                    const _ag = HandRead.summarizeVillain(this.actionLog, _vn).aggroStreets || 1;
                    // 🔍 벳한 사람의 프리플랍 행동으로 범위를 먼저 좁히고, 그 안에서 "이 보드에 강한 쪽"을 벳 범위로 본다
                    const _wf = _vn ? this.villainRangeWeights(_vn) : null;
                    if (_wf) _vRangeW = VRange.widthOf(_wf);
                    const vsRange = this.equityVsRangeMC(nick, _bf, _ag, _wf);
                    // 🔬 [검증용 · DEV_EQLOG] 추정 승률(범위 반영 전/후)을 "벳한 사람의 실제 패 상대 승률"과 견준다
                    //    📏 [실전 보정 자료] 운영 중에도 같은 비교를 합계로만 쌓는다(collectActionStats → evQ*). 패는 저장하지 않고,
                    //    이 값은 상대 패에서 나온 것이라 조언 객체(화면으로 나감)에는 절대 넣지 않는다 — 방 안에만 잠깐 둔다.
                    this._eqCal = null;
                    if (vsRange != null && _vn && this.players[_vn] && (this.players[_vn].hand || []).length === 2 && opponents === 1 && (process.env.DEV_EQLOG || this.countsForSkill())) {
                        try {
                            const vh = this.players[_vn].hand, known = new Set([...this.communityCards, ...p.hand, ...vh]);
                            const deck0 = FULL_DECK.filter(c => !known.has(c)), need = 5 - this.communityCards.length;
                            let w = 0, n = 0;
                            // 리버는 한 번, 턴은 남은 카드 전부(정확), 플랍은 60번 표본(운영 서버 부담을 줄이려고 — 합계로 쌓이면 표본 오차는 평균된다)
                            const iters = need === 0 ? 1 : need === 1 ? deck0.length : (process.env.DEV_EQLOG ? 300 : 60);
                            for (let it = 0; it < iters; it++) {
                                const d = deck0.slice(), bd = this.communityCards.slice();
                                if (need === 1) bd.push(d[it]);
                                else for (let k = 0; k < need; k++) bd.push(d.splice(Math.floor(Math.random() * d.length), 1)[0]);
                                const m = Hand.solve(p.hand.concat(bd)), h = Hand.solve(vh.concat(bd)), ws = Hand.winners([m, h]);
                                w += ws.length === 2 ? 0.5 : (ws[0] === m ? 1 : 0); n++;
                            }
                            this._eqCal = { nick, hand: this.handId, st: street, est: vsRange, tr: w / n, bot: !!this.players[_vn].isBot };
                            if (process.env.DEV_EQLOG)
                            console.log('EQLOG ' + JSON.stringify({ st: street, old: this.equityVsRangeMC(nick, _bf, _ag), nw: vsRange, tr: w / n, raw: equity, bf: Math.round(_bf * 100) / 100, wd: _vRangeW, bot: !!this.players[_vn].isBot }));
                        } catch (e) {}
                    }
                    if (vsRange != null) {
                        rawEquity = equity;
                        // 벳한 사람 말고도 남은 상대가 있으면 그 사람들도 이겨야 한다. 아무 패 상대 승률(전원 상대)을 한 명분으로 환산해 나머지 인원만큼 곱한다.
                        const others = Math.max(0, opponents - 1);
                        equity = others > 0 ? vsRange * Math.pow(Math.max(0.01, rawEquity), others / opponents) : vsRange;
                    }
                } catch (e) {}
            }
            const _draw = GtoAdvice.detectDraws(p.hand, this.communityCards);
            // 포스트플랍 — 상대 수·포지션·SPR 을 반영한 조언 (lib/gtoadvice.js)
            const pa = GtoAdvice.postflopAdvice({
                equity, potOdds, toCall, opponents, inPosition: this.isInPosition(nick),
                spr: _spr, stackShare: p.chips > 0 ? toCall / p.chips : 1,
                draw: _draw, pot: potBefore, behind: Math.max(0, _effBehind - toCall),
                // 🎯 주도권: 앞 스트리트에 마지막으로 올린 사람이 나이고 아직 벳이 없으면 c벳 자리 — 약한 패의 벳도 정석 비중이 있다
                cbetFreq: (toCall === 0 && this.lastAggressorBefore(this.gameStage) === nick)
                    ? Postflop.cbetFrequency({ street: this.gameStage, adv: Postflop.rangeAdvantage(this.communityCards), nOpp: opponents, inPosition: this.isInPosition(nick), skill: 1 }) : 0
            });
            mix = pa.mix; bestAction = pa.bestAction; reason = pa.reason; notes = pa.notes;
            // 📉 콜의 기대값(칩) = 승률 × 실현율 × 콜 뒤 팟 − 콜 금액. 카드가 남은 스트리트는 뒤에 또 벳을 맞아 승률만큼 못 가져가므로 실현율을 곱한다(플랍 0.8 · 턴 0.9 · 리버 1).
            if (toCall > 0) _ev.call = Math.round(equity * (street === 'flop' ? 0.8 : street === 'turn' ? 0.9 : 1) * (potBefore + p.currentBet + toCall) - toCall);
            tier = pa.tier; tierLabel = pa.tierLabel; tierColor = pa.tierColor;   // 등급도 "한 명 상대 환산"으로
            if (rawEquity != null) notes.push(_vRangeW != null && _vRangeW < 90 ? `상대 범위 반영 (프리플랍 약 ${_vRangeW}% → 그중 벳하는 쪽)` : '상대 벳 범위 반영');
            // 🧮 [솔버 조회] 미리 풀어 둔 상황이면 솔버의 빈도를 쓴다(비슷한 대표 보드 · 같은 종류의 패 기준)
            let _sv = null;
            try {
                const r = _icm ? null : this.solverLookup(nick, toCall, potBefore, effBB);   // 솔버 자료는 칩 기준이라 상금 압박이 걸린 자리에는 쓰지 않는다
                if (r) {
                    const f = r.freqs, ko = FlopSolve.bucketKo(r.bucket);
                    const cards = FlopSolve.parseBoardKey(r.board).map(c => c[0] + ({ s: '♠', h: '♥', d: '♦', c: '♣' })[c[1]]).join('');
                    const src = r.turnClass ? `솔버 계산(${r.spotName} · 비슷한 플랍 ${cards} · ${FlopSolve.TURN_KO[r.turnClass]} · 플랍은 ${r.line === 'xx' ? '둘 다 체크' : '체크-벳-콜'})`
                        : `솔버 계산(${r.spotName} · 비슷한 보드 ${cards} 기준)`;
                    if (toCall === 0) {
                        const bet = f.length === 3 ? f[1] + f[2] : f[1];
                        mix = { check: f[0], bet };
                        bestAction = bet > f[0] ? 'bet' : 'check';
                        _sv = { big: f.length === 3 && f[2] > f[1], turn: !!r.turnClass, mixed: f.length === 3 && bet > 0 && Math.max(f[1], f[2]) < 0.7 * bet };   // mixed: 두 크기를 비슷하게 섞는 패
                        reason = `${src}: 이 자리에서 "${ko}" 종류의 패는 체크 ${f[0]}% · 벳 ${bet}%${f.length === 3 && bet > 0 ? ` (작게 ${f[1]}% · 크게 ${f[2]}%)` : ''}로 칩니다.${Math.min(f[0], bet) >= 25 ? ' 섞어 치는 자리라 어느 쪽도 실수가 아닙니다.' : ''}`;
                    } else {
                        mix = { fold: f[0], call: f[1], raise: f[2] };
                        bestAction = f[2] >= f[1] && f[2] >= f[0] ? 'raise' : (f[1] >= f[0] ? 'call' : 'fold');
                        _sv = {};
                        reason = `${src}: 이 벳을 받은 "${ko}" 종류의 패는 폴드 ${f[0]}% · 콜 ${f[1]}% · 레이즈 ${f[2]}%로 칩니다.`;
                    }
                    notes.push('🧮 솔버 계산');
                    // 📋 학습 화면용: 이 자리에서 패 종류마다 솔버가 어떻게 치는지 한 장의 표로
                    _svTable = { title: src, acts: toCall === 0 ? (f.length === 3 ? ['체크', '작게 벳', '크게 벳'] : ['체크', '벳']) : ['폴드', '콜', '레이즈'], rows: r.table || [] };
                }
            } catch (e) {}
            // 🌊 [리버 계산] 둘만 남은 리버는 양쪽 범위를 만들어 그 자리에서 푼 값을 쓴다
            try {
                const rr = street === 'river' ? this.riverAdvice(nick, toCall) : null;
                if (rr) {
                    const pc = x => Math.round(x * 100), bbv = x => Math.round(x / _bbNow * 10) / 10;
                    if (!rr.facing) {
                        const bet = pc(rr.freq);
                        mix = { check: 100 - bet, bet };
                        bestAction = rr.ev.bet > rr.ev.check ? 'bet' : 'check';
                        if (Math.abs(rr.ev.bet - rr.ev.check) < 0.02 * rr.pot) bestAction = bet >= 50 ? 'bet' : 'check';     // 값이 거의 같으면 빈도가 높은 쪽을 권한다
                        _ev.acts = { check: Math.round(rr.ev.check), bet: Math.round(rr.ev.bet) };
                        _sv = { river: true, bet: rr.bet };
                        reason = `리버 계산(범위 대 범위): 이 패는 체크 ${100 - bet}% · 벳 ${bet}%가 균형입니다. 기대값은 체크 ${bbv(rr.ev.check)}bb · 벳 ${bbv(rr.ev.bet)}bb. 내 범위 전체로는 ${pc(rr.rangeFreq)}% 벳하는 자리입니다.${Math.abs(rr.ev.bet - rr.ev.check) < 0.02 * rr.pot ? ' 두 값이 거의 같아 어느 쪽도 실수가 아닙니다.' : ''}`;
                    } else {
                        const strongRaise = (pa.mix.raise || 0) >= 30 ? Math.min(60, pa.mix.raise) : 0;      // 아주 강한 패의 레이즈는 예전 기준을 그대로 살린다(계산 나무에 레이즈가 없다)
                        const call = pc(rr.freq), k = (100 - strongRaise) / 100;
                        mix = strongRaise ? { fold: Math.round((100 - call) * k), call: Math.round(call * k), raise: strongRaise } : { fold: 100 - call, call };
                        bestAction = strongRaise >= 50 ? 'raise' : (rr.ev.call > 0 ? 'call' : 'fold');
                        if (!strongRaise && Math.abs(rr.ev.call) < 0.02 * (rr.pot + toCall)) bestAction = call >= 50 ? 'call' : 'fold';
                        // 🔬 [검증용 · DEV_RLOG] 콜의 기대값 예측 두 가지(예전 근사 · 리버 계산)를 상대의 실제 패로 본 결과와 견준다
                        if (process.env.DEV_RLOG) {
                            try {
                                const vn = this.playerOrder.find(n => n !== nick && this.players[n] && !this.players[n].isFolded), vh = vn && this.players[vn].hand;
                                if (vh && vh.length === 2) {
                                    const m = Hand.solve(p.hand.concat(this.communityCards)), h = Hand.solve(vh.concat(this.communityCards)), ws = Hand.winners([m, h]);
                                    const potAll = potBefore + p.currentBet, truth = ws.length === 2 ? potAll / 2 : (ws[0] === m ? potAll : -toCall);
                                    console.log('RVLOG ' + JSON.stringify({ old: _ev.call, sol: Math.round(rr.ev.call), truth: Math.round(truth), pot: potAll, call: toCall, bb: _bbNow, bot: !!this.players[vn].isBot, eq: Math.round(equity * 100), sCall: Math.round(rr.freq * 100) }));
                                }
                            } catch (e) {}
                        }
                        _ev.acts = { fold: 0, call: Math.round(rr.ev.call) };
                        _ev.call = Math.round(rr.ev.call);
                        _sv = { river: true };
                        reason = `리버 계산(범위 대 범위): 이 벳에 이 패는 콜 ${call}% · 폴드 ${100 - call}%가 균형입니다. 콜의 기대값은 ${rr.ev.call >= 0 ? '+' : ''}${bbv(rr.ev.call)}bb(폴드는 0). 내 범위 전체로는 ${pc(rr.rangeFreq)}%를 콜해야 상대가 아무 패로나 벳해서 이득 보지 못합니다.${strongRaise ? ' 아주 강한 패라 레이즈도 좋습니다.' : ''}`;
                    }
                    notes.push('🌊 리버 계산');
                }
            } catch (e) {}
            const _tx = this.analyzeBoardTexture() || {};
            if (_sv && bestAction === 'bet' && _sv.river) {
                sizeHint = `팟의 2/3 ≈ ${Math.round(_sv.bet).toLocaleString()} (계산에 쓴 크기)`;
            } else if (_sv && bestAction === 'bet' && _sv.turn) {
                sizeHint = `팟의 2/3 ≈ ${Math.round(potBefore * 0.66).toLocaleString()} (솔버 계산에 쓴 크기)`;
            } else if (_sv && bestAction === 'bet') {
                // 🔎 [검증 2026-10-11] 같은 상황을 4배 정밀하게(오차 1% → 0.25%) 다시 풀어 보니 체크·벳, 폴드·콜·레이즈의 빈도는 평균 1~5%p 차이로 안정적이었지만
                //    "작게/크게"의 비율은 크게 달라졌다(예: 작게 15% → 0%). 두 크기의 기대값이 비슷해서다. 그래서 한쪽이 뚜렷할 때만 크기를 권한다.
                sizeHint = _sv.mixed ? `팟의 1/3 ≈ ${Math.round(potBefore * 0.33).toLocaleString()} 또는 3/4 ≈ ${Math.round(potBefore * 0.75).toLocaleString()} (솔버가 두 크기를 섞어 씁니다 — 어느 쪽이든 괜찮습니다)`
                    : _sv.big ? `팟의 3/4 ≈ ${Math.round(potBefore * 0.75).toLocaleString()} (솔버가 이 종류의 패에 주로 쓰는 크기)` : `팟의 1/3 ≈ ${Math.round(potBefore * 0.33).toLocaleString()} (솔버가 이 종류의 패에 주로 쓰는 크기)`;
            } else if ((mix.bet || 0) > 0 && bestAction === 'bet') {
                sizeHint = GtoAdvice.betSize({ opponents, wet: !!_tx.wet, dry: !!_tx.dry, spr: _spr, pot: potBefore, thin: !!pa.thin, range: !!pa.rangeBet }).text;
            } else if (bestAction === 'raise') {
                const to = Math.min(p.currentBet + p.chips, this.currentHighestBet * 3);
                sizeHint = (to >= p.currentBet + p.chips || _spr <= 1.5) ? '올인' : `약 ${to.toLocaleString()} (상대 벳의 3배)`;
            }
        }

        let _icmOut = null;
        if (_icm) {
            const tot = potBefore + p.currentBet + toCall, c = Math.round(_icm.chip * 100), q = Math.round(_icm.req * 100);
            // 채점도 같은 기준으로: 콜의 기대값에서 상금 압박만큼(필요 승률 차이 × 콜 뒤 팟)을 뺀다
            if (typeof _ev.call === 'number') _ev.call = Math.round(_ev.call - _icm.tax * tot);
            delete _ev.acts;
            notes.push(`상금 기준(ICM) — 필요 승률 ${c}% → ${q}%`);
            reason = String(reason || '') + ` 🏆 상금 기준(ICM): ${_icm.alive}명 남음 · 입상 ${_icm.paid}명 — 칩만 보면 ${c}%면 되지만, 지면 ${toCall >= p.chips ? '탈락이라' : '칩이 크게 줄어'} 상금 기대값이 깎이므로 ${q}%가 필요합니다.`;
            _icmOut = { chip: c, req: q, alive: _icm.alive, paid: _icm.paid };
        }
        if (_icmPush) {
            notes.push(`상금 기준(ICM) — 푸시 범위 ${_icmPush.chip}% → ${_icmPush.req}%`);
            reason = String(reason || '') + ` 🏆 상금 기준(ICM): ${_icmPush.alive}명 남음 · 입상 ${_icmPush.paid}명 — 칩만 보면 푸시 범위는 상위 약 ${_icmPush.chip}%지만, ${_icmPush.req > _icmPush.chip ? '뒤의 사람들이 탈락이 무서워 좁게 받아야 하는 자리라 더 넓게 밀 수 있습니다' : '받히고 지면 내가 먼저 떨어지는 자리라 더 좁게 밉니다'}(약 ${_icmPush.req}%).`;
            _icmOut = _icmPush;
        }
        return {
            icm: _icmOut,
            equity: Math.round(equity * 100),
            potOdds: Math.round(potOdds * 100),
            tier, tierLabel, tierColor,
            street, opponents, toCall,
            potSize: potBefore,
            mix, bestAction, reason,
            notes, sizeHint, equityLabel,
            allinIsCall: _fullCall > 0 && _fullCall >= p.chips,   // 콜이 곧 올인인 자리 — '올인' 버튼을 눌러도 콜로 채점한다
            rawEquity: rawEquity == null ? null : Math.round(rawEquity * 100),
            posInfo, ev: _ev, solverTable: _svTable,
            handStr: p.hand.join(' ')
        };
    }

    // 🎓 [학습모드] 사람이 한 액션을 GTO 권장과 비교해 채점
    //   advice: 액션 전 캡처한 getGtoAdvice 결과, actualType: 실제 한 액션
    gradeAction(advice, actualType, gtoScore) {
        if (!advice) return null;
        // 실제 액션을 믹스 키로 정규화 (allin→raise, check→check, call→call, fold→fold)
        // 🐛 체크할 수 있는 자리에서 친 벳은 서버에서 'raise' 액션이다. 예전엔 그대로 믹스의 'raise'를 찾아서(없음 → 0%)
        //    조언이 "벳"이어도, 그대로 벳을 해도 "아쉬움"으로 채점됐다.
        const actKey = GtoAdvice.actionKey(advice, actualType);
        const recommendedPct = advice.mix[actKey] || 0;
        const isBest = (actKey === advice.bestAction);

        let grade, gradeColor, gradeIcon, msg;
        if (GtoAdvice.wrongSize(advice, actualType)) {
            // 방향(공격)은 맞지만 크기가 틀림 — 이 스택에서는 올인이 기준
            grade = '무난'; gradeColor = '#ffd97a'; gradeIcon = '🟡';
            msg = '방향은 맞지만 크기가 다릅니다 — 이 스택에서는 올인이 기준입니다. 작게 치면 접지도 못할 크기로 칩만 묶입니다.';
        } else if (isBest || recommendedPct >= 40) {
            grade = '훌륭'; gradeColor = '#7bedaa'; gradeIcon = '✅';
            msg = isBest ? 'GTO 최적 선택입니다!' : 'GTO상 충분히 좋은 선택입니다.';
        } else if (recommendedPct >= 15) {
            grade = '무난'; gradeColor = '#ffd97a'; gradeIcon = '🟡';
            const actKo = { fold: '폴드', check: '체크', call: '콜', bet: '벳', raise: '레이즈' };
            msg = `나쁘진 않지만 GTO 권장은 "${actKo[advice.bestAction] || advice.bestAction}"였습니다.`;
        } else {
            grade = '아쉬움'; gradeColor = '#ff6b6b'; gradeIcon = '⚠️';
            const actKo = { fold: '폴드', check: '체크', call: '콜', bet: '벳', raise: '레이즈' };
            msg = `GTO 권장은 "${actKo[advice.bestAction] || advice.bestAction}"였습니다. ${advice.reason}`;
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
        // 사람 액션은 applyAction 이 액션 전에 조언 기준으로 매겨 둔 점수를 쓴다 (아래 옛 계산은 봇 리플레이용)
        if (this._pendingGto && this._pendingGto.nick === nick) return this._pendingGto.score;
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
        this.turnIndex = -1; // 핸드 종료 — 결과창 동안 "내 턴" 표시·봇 행동이 이어지지 않게
        this._handEndedAt = Date.now(); // 🏆 [MTT] 결과창을 볼 시간을 확보하려고 기록 (테이블 재배치 판단용)
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
        // 🐛 [올인한 짧은 스택의 기권승] 이긴 사람은 상대 한 명 한 명에게서 "자기가 건 만큼"까지만 가져갈 수 있다.
        //    예: BB 가 앤티(또는 빅블라인드 일부)만 내고 올인, SB 는 100 을 블라인드로 냈다가 폴드 → 예전엔 BB 가 SB 의 100 을 통째로 가져갔다
        //    (실측: 20칩으로 앤티만 낸 BB 가 120 을 받음). BB 가 건 돈을 넘는 부분은 낸 사람에게 돌려준다.
        if (winner && winner.isAllIn) {
            const cap = winner.totalInvested || 0;
            this.playerOrder.forEach(n => {
                const pl = this.players[n];
                if (n === winnerId || !pl) return;
                const excess = (pl.totalInvested || 0) - cap;
                if (excess > 0) { pl.chips += excess; pl.totalInvested -= excess; this.pot -= excess; if (pl.chips > 0) pl.isAllIn = false; }
            });
        }
        if (winner) winner.chips += this.pot;
        if (winner) winner.isMucked = true;

        this.gameStage = 5;

        // 💬 봇 기권승 멘트
        if (this.players[winnerId] && this.players[winnerId].isBot) {
            this.botSay(winnerId, 'win');
        }

        // 📊 전적 집계 + 📜 핸드 히스토리
        try { this.settleHandResults(); } catch (e) {}
        this.playerOrder.forEach(n => MockDB.recordHand(n, n === winnerId, n === winnerId ? this.pot : 0, this.vpipThisHand && this.vpipThisHand.has(n), this.statKind()));

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

        this.scheduleNextHand(6000);
    }
}

const rooms = new Map();

// 🚦 [정원] 동시 접속 정원. 넘으면 줄을 세우고 자리가 나면 먼저 온 순서대로 들여보낸다.
//    환경변수 MAX_PLAYERS 로 정한다(0 = 제한 없음). 관리자 페이지에서 켜진 동안 바꿀 수도 있다(재시작하면 환경변수 값으로 돌아간다).
//    기본 20 — 무료 서버(CPU 0.1개)에서 실측·환산한 "버튼이 밀리지 않는" 인원 근처.
const capacity = new Capacity(process.env.MAX_PLAYERS !== undefined ? process.env.MAX_PLAYERS : 20);
function onlineNicks() {
    const set = new Set();
    try { io.sockets.sockets.forEach(sk => { if (sk.nickname) set.add(sk.nickname); }); } catch (e) {}
    return set;
}
function nickInGame(nick) {
    for (const room of rooms.values()) { if (room.players && room.players[nick]) return true; }
    return false;
}
// 자리가 났으면 대기열 앞에서부터 들여보내고, 남은 사람들에게 바뀐 순서를 알린다
function drainCapacity() {
    const now = Date.now();
    capacity.drain(onlineNicks(), now).forEach(q => {
        const sk = io.sockets.sockets.get(q.socketId);
        if (sk) sk.emit('queueAdmit'); else capacity.held.delete(q.nick);
    });
    capacity.queue.forEach((q, i) => {
        const sk = io.sockets.sockets.get(q.socketId);
        if (sk) sk.emit('loginQueued', { position: i + 1, waiting: capacity.queue.length, max: capacity.max });
    });
}
setInterval(() => { if (capacity.queue.length) drainCapacity(); }, 5000);   // 맡아 둔 자리가 시간 초과로 풀린 경우 등

// 📋 [세션 리포트] 닉네임 → 이번 세션 시작 시점의 지표 스냅샷 (재접속해도 유지)
const sessionSnapshots = new Map();
// 🎯 실력 점수 = 가중 평균. (가중치가 없는 옛 기록은 단순 평균)
// 🏅 실력 점수(하나의 순위용) = GTO 일치 점수 − 실수 감점.
//    일치 점수만으로는 "전부 콜"(57점, 100판당 −1879bb)과 "전부 폴드"(55점, −22bb)가 구분되지 않았다(실측).
//    큰 실수의 손실 어림값(결정 100번당 bb)을 로그로 눌러 최대 30점까지 깎는다:
//      손실 0 → 0점 · 25bb → 6점 · 75bb → 12점 · 175bb → 18점 · 375bb → 24점 · 775bb 이상 → 30점
//    실측 결과(6인): 조언대로 95 · 평범한 타이트 60 · 전부 폴드 49 · 전부 콜 34 · 무작위 30 · 전부 올인 0 · 반대로 0 — 수익 순서와 같다.
function skillIndex(obj) {
    const cnt = obj.gtoScoreCount || 0;
    const raw = gtoAvg(obj.gtoScoreSum || 0, obj.gtoW || 0, cnt);
    if (raw === null) return null;
    let lossBB = 0;
    Blunder.KIND_KEYS.forEach(k => { lossBB += obj['lkB_' + k] || 0; });
    const loss100 = cnt > 0 ? lossBB / cnt * 100 : 0;
    const penalty = Math.min(30, Math.round(6 * Math.log2(1 + loss100 / 25)));
    return { raw, loss100: Math.round(loss100 * 10) / 10, penalty, score: Math.max(0, raw - penalty) };
}
function gtoAvg(sum, w, cnt) { return w > 0 ? Math.round(sum / w) : (cnt > 0 ? Math.round(sum / cnt) : null); }
// 📉 EV 손실 기준 실력 점수 한 묶음 — 순위표·근거 화면·리포트가 같은 계산을 쓴다.
//   score ± pm (95% 구간 lo~hi) · loss100(100판당 잃은 기대값 bb) · grades(결정 등급별 건수) · streets(스트리트별 손실)
//   net100 = 실제 결과, adj100 = 올인 뒤의 운을 뺀 결과 (둘 다 100판당 bb, 30판 이상일 때만)
function evView(a) {
    const ix = a ? EvLoss.index(a) : null;
    if (!ix) return null;
    const grades = {}; let dec = 0;
    EvLoss.GRADE_KEYS.forEach(g => { grades[g] = a['evG_' + g] || 0; dec += grades[g]; });
    const streets = ['preflop', 'flop', 'turn', 'river'].map(st => ({ st, n: a['evC_' + st] || 0, loss: Math.round((a['evS_' + st] || 0) * 10) / 10,
        per100: Math.round((a['evS_' + st] || 0) / ix.hands * 1000) / 10 }));
    const n = ix.hands;
    const FMT = { hu: '헤즈업', mid: '3~4인', full: '5~6인' };
    const formats = Object.keys(FMT).map(k => ({ id: k, name: FMT[k], hands: a['evFh_' + k] || 0, per100: a['evFh_' + k] > 0 ? Math.round((a['evFl_' + k] || 0) / a['evFh_' + k] * 1000) / 10 : null,
        base: k === 'hu' ? 75 : k === 'mid' ? 43 : 27 })).filter(x => x.hands > 0);      // base: 그 인원에서 전부 접는 사람이 잃는 양(150 ÷ 인원) 어림
    const positions = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map(p => ({ pos: p, hands: a['evPh_' + p] || 0, per100: a['evPh_' + p] > 0 ? Math.round((a['evPl_' + p] || 0) / a['evPh_' + p] * 1000) / 10 : null })).filter(x => x.hands > 0);
    const solver = ['flop', 'turn'].map(st => ({ st, n: a['evVn_' + st] || 0, ok: a['evVk_' + st] || 0 })).filter(x => x.n > 0);
    return Object.assign({}, ix, { decisions: dec, grades, streets, formats, positions, solver,
        net100: (a.netHands || 0) >= 30 ? Math.round((a.netBB || 0) / a.netHands * 100) : null,
        adj100: n >= 30 && typeof a.evNetAdj === 'number' ? Math.round(a.evNetAdj / n * 100) : null,
        allins: a.evAllin || 0 });
}

// 🎓 [코칭] 세션 지표를 포커 이론 기준으로 진단 → 약점 + 구체적 조언 생성
//   각 지표의 건강 범위는 6맥스 캐시/토너 기준 통념값
function buildCoaching(s, handsPlayed, extra) {
    const issues = [];   // { area, severity, msg, tip }
    const strengths = [];
    const ex = extra || {};
    // 🐛 예전엔 헤즈업·3인 판에서도 6인 기준(VPIP 18~28%)으로 "너무 많이 참여한다"고 진단했다. 평균 테이블 인원에 맞춘 기준을 쓴다.
    const seats = ex.avgSeats || 6;
    const V = seats <= 2.5 ? { hi: 92, lo: 50, pfrLo: 30, name: '헤즈업' } : seats <= 4.2 ? { hi: 55, lo: 22, pfrLo: 14, name: '3~4인' } : { hi: 40, lo: 14, pfrLo: 8, name: '5~6인' };
    if (handsPlayed < 10) {
        return { headline: '아직 표본이 적어 정밀 진단은 어렵습니다. 좀 더 쳐보세요!', issues: [], strengths: [], sample: 'low' };
    }
    const { vpip, pfr, af, foldToBet, wtsd, wsd, gto } = s;

    // 1) VPIP (팟 참여율) — 건강범위 대략 18~28% (6맥스)
    if (vpip !== null) {
        if (vpip > V.hi) issues.push({ area: 'VPIP', severity: 'high', msg: `너무 많은 핸드로 팟에 참여합니다 (${vpip}% · ${V.name} 테이블 기준 ${V.hi}% 이하가 적정).`, tip: '프리플랍 핸드 선택을 좁히세요. 약한 오프수트(예: J5o, Q7o)는 폴드하고, 포지션이 나쁘면 더 타이트하게 가는 게 장기적으로 이득입니다.' });
        else if (vpip < V.lo) issues.push({ area: 'VPIP', severity: 'mid', msg: `너무 타이트합니다 (${vpip}% · ${V.name} 테이블 기준 ${V.lo}% 이상이 적정).`, tip: '좋은 핸드만 기다리면 블라인드에 칩이 샙니다. 버튼·컷오프 같은 좋은 포지션에선 수딧 커넥터나 작은 페어도 적극적으로 들어가 보세요.' });
        else strengths.push(`팟 참여율(VPIP ${vpip}%)이 건강한 범위입니다.`);
    }
    // 2) PFR vs VPIP 갭 — 갭이 크면 너무 수동적(콜만 많음)
    if (vpip !== null && pfr !== null) {
        const gap = vpip - pfr;
        if (pfr < V.pfrLo && vpip >= V.lo + 4) issues.push({ area: 'PFR', severity: 'high', msg: `프리플랍에서 레이즈 없이 콜만 많습니다 (PFR ${pfr}%).`, tip: '들어갈 가치가 있는 핸드면 림프(콜) 대신 레이즈로 들어가세요. 주도권을 쥐면 상대를 폴드시키거나 팟을 키울 수 있습니다.' });
        else if (gap > 18) issues.push({ area: '수동성', severity: 'mid', msg: `참여는 많은데 레이즈가 적습니다 (VPIP-PFR 갭 ${gap}).`, tip: '콜링 위주 플레이는 주도권을 내줍니다. 핸드가 좋으면 레이즈로 압박하고, 애매하면 차라리 폴드하는 양극화 전략이 좋습니다.' });
        else if (pfr >= 12 && gap <= 12) strengths.push(`프리플랍 공격성(PFR ${pfr}%)이 좋습니다.`);
    }
    // 3) AF (공격성) — 건강범위 약 1.5~3.5
    if (af !== null && af !== undefined) {
        if (af < 1.0) issues.push({ area: 'AF', severity: 'mid', msg: `포스트플랍이 수동적입니다 (AF ${af}).`, tip: '콜만 하지 말고 베팅·레이즈로 주도하세요. 좋은 핸드는 밸류 베팅으로 칩을 더 받아내고, 드로우는 세미블러프로 압박하는 게 정석입니다.' });
        else if (af > 5) issues.push({ area: 'AF', severity: 'mid', msg: `너무 공격적입니다 (AF ${af}).`, tip: '블러프 빈도가 과합니다. 상대가 잡아내기 시작하면 칩이 샙니다. 밸류와 블러프의 균형을 맞추세요.' });
        else strengths.push(`포스트플랍 공격성(AF ${af})이 균형 잡혀 있습니다.`);
    }
    // 4) Fold to Bet — 너무 높으면 호구처럼 쉽게 폴드(블러프 당함), 너무 낮으면 콜링스테이션
    if (foldToBet !== null) {
        if (foldToBet > 70) issues.push({ area: '폴드율', severity: 'mid', msg: `상대 베팅에 너무 자주 폴드합니다 (${foldToBet}%).`, tip: '쉽게 접으면 상대 블러프에 당합니다. 적당한 핸드로는 콜다운(블러프 캐치)도 하세요. 모든 베팅이 진짜 핸드는 아닙니다.' });
        else if (foldToBet < 25 && wtsd !== null && wtsd > 35) issues.push({ area: '콜링스테이션', severity: 'high', msg: `잘 폴드하지 않습니다 (폴드율 ${foldToBet}%, 쇼다운 도달 ${wtsd}%).`, tip: '약한 핸드로 끝까지 보는 콜링스테이션 성향입니다. 진 게임은 일찍 접어 손실을 줄이세요. "궁금해서" 콜하는 칩이 제일 아깝습니다.' });
    }
    // 5) WTSD / WSD — 쇼다운까지 갔을 때 이기는 비율
    if (wsd !== null && wtsd !== null && wtsd > 20) {
        if (wsd < 40) issues.push({ area: '쇼다운', severity: 'mid', msg: `쇼다운까지 가지만 자주 집니다 (승률 ${wsd}%).`, tip: '약한 핸드로 쇼다운을 너무 자주 봅니다. 강하지 않으면 리버에서 큰 베팅을 마주쳤을 때 접는 훈련을 하세요.' });
        else if (wsd > 55) strengths.push(`쇼다운 승률(${wsd}%)이 높습니다 — 핸드 선택이 좋습니다.`);
    }
    // 6) GTO 종합
    if (gto !== null) {
        if (gto >= 75) strengths.push(`GTO 근접도 ${gto}점 — 의사결정이 이론에 매우 가깝습니다! 👏`);
        else if (gto < 55) issues.push({ area: 'GTO', severity: 'mid', msg: `전반적 의사결정 점수가 낮습니다 (GTO ${gto}점).`, tip: '매 액션 전에 "내 승률 vs 팟 오즈"를 떠올리세요. 콜 비용보다 이길 확률이 높으면 콜, 낮으면 폴드가 기본입니다.' });
    }

    // 7) 실제로 저지른 실수 유형 — 통계 추정보다 정확하다(그 순간의 인원·스택·포지션을 반영한 조언과 비교한 것). 손실이 큰 유형을 맨 앞에.
    const lk = (ex.leaks || []).filter(l => l.n >= 2 && l.bb >= 3).slice(0, 2);
    lk.reverse().forEach(l => {
        const rate = ex.decisions > 0 ? ` · 결정 ${ex.decisions}번 중` : '';
        issues.unshift({ area: l.name, severity: l.bb >= 10 ? 'high' : 'mid', msg: `${l.n}번 나왔고, 합쳐서 약 ${l.bb}bb를 잃은 셈입니다${rate}.`, tip: l.tip, leak: true });
    });

    // 우선순위: high > mid, 최대 3개만
    issues.sort((a, b) => (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1));
    const topIssues = issues.slice(0, 3);

    let headline;
    if (topIssues.length === 0) headline = '약점이 거의 안 보입니다. 지금 페이스를 유지하세요! 🎯';
    else if (topIssues[0].severity === 'high') headline = `가장 시급한 개선점은 "${topIssues[0].area}"입니다.`;
    else headline = '몇 가지 다듬으면 더 좋아질 부분이 있습니다.';

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
        // 🏁 파이널나인 딥스택 연습: 정원 20 · 전용 블라인드 구조 · 상위 3명 입상 · 기록은 전용 상자(fnStats)에만
        this.fn = !!settings.fn;
        this.maxEntrants = settings.maxEntrants || this.tableSize * 6;
        this.structure = settings.structure || null;
        this.paid = settings.paid || 0;
        this.rebuyMax = settings.rebuys || 0;                 // 한 사람이 다시 들어올 수 있는 횟수
        this.rebuyUntilLevel = settings.rebuyUntilLevel || 0; // 이 레벨까지만 리바인 가능
        this.rebuys = {};                                     // nick → 쓴 횟수
        this.botLevel = {};                                   // 봇 이름 → 난이도
        this.entrants = [];        // { nick, socketId, isBot }
        this.tables = [];          // roomId 배열
        this.eliminated = [];      // 탈락 순서(나중일수록 높은 순위) — { nick, place }
        this.started = false;
        this.finished = false;
        this.totalEntrants = 0;
        this.tableCounter = 0;
        this._tickBusy = false;
        this._noHumanTicks = 0;
        // 🏆 블라인드 레벨·남은 시간은 여기서만 관리하고 모든 테이블에 밀어넣는다
        this.blindLevel = 0;
        this.timeRemaining = this.blindUpInterval;
        this._blindTimer = null;
    }

    // 토너먼트 전체가 공유하는 블라인드 시계 (테이블이 새로 만들어져도 이어진다)
    startBlindClock() {
        if (this._blindTimer) clearInterval(this._blindTimer);
        this._blindTimer = setInterval(() => {
            if (this.finished) return;
            const live = this.tables.map(rid => rooms.get(rid)).filter(Boolean);
            if (this.timeRemaining > 0) {
                this.timeRemaining--;
            } else {
                const maxLv = live.length ? live[0].blindStructure.length - 1 : 0;
                if (this.blindLevel < maxLv) this.blindLevel++;
                this.timeRemaining = this.blindUpInterval;
                live.forEach(r => {
                    r.blindLevel = this.blindLevel;
                    r.timeRemaining = this.timeRemaining;
                    const bl = r.blindStructure[Math.min(this.blindLevel, r.blindStructure.length - 1)];
                    io.to(r.roomId).emit('gameMessage', `🚨 블라인드 레벨 업! (${bl.sb}/${bl.bb})`);
                    r.sendState(); // 블라인드 표시를 기다리지 않고 바로 갱신
                });
            }
            // 모든 테이블이 같은 레벨·같은 시계를 보게 동기화
            live.forEach(r => {
                r.blindLevel = this.blindLevel;
                r.timeRemaining = this.timeRemaining;
                io.to(r.roomId).emit('updateTimer', this.timeRemaining);
            });
        }, 1000);
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
            tableSize: this.tableSize, startingChips: this.startingChips, fn: this.fn, maxEntrants: this.maxEntrants,
            levelSec: this.blindUpInterval, paid: this.paid, rebuys: this.rebuyMax, rebuyUntilLevel: this.rebuyUntilLevel, startBB: this.structure ? Math.round(this.startingChips / this.structure[0].bb) : null,
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
        this.humanEntrants = this.entrants.filter(e => !e.isBot).length; // 🏆 토큰 지급 판정용

        const shuffled = this.entrants.slice();
        for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }

        // 테이블 수: 정원 기준, 단 모든 테이블에 최소 2명 보장
        const groups = this.splitIntoGroups(shuffled.map(e => ({ nick: e.nick, socketId: e.socketId, isBot: e.isBot, chips: this.startingChips })));
        groups.forEach(g => this.seatTable(g, false));

        this.entrants.forEach(e => { if (e.socketId) io.to(e.socketId).emit('mttStarted', { mttId: this.mttId, name: this.name }); });
        this.broadcastStatus();
        this.startBlindClock();
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
        if (this.fn) room._fnMode = true;
        if (this.structure) room.blindStructure = this.structure.map(x => Object.assign({}, x));
        // 재배치로 만들어진 테이블도 토너먼트의 현재 블라인드 레벨을 그대로 이어받는다
        room.blindLevel = this.blindLevel;
        room.timeRemaining = this.timeRemaining;
        if (isFinal) room._isFinalTable = true;
        rooms.set(roomId, room);
        this.tables.push(roomId);

        group.forEach(s => {
            const pl = makeFreshPlayer(s.nick, s.socketId, s.isBot, s.chips);
            pl.chips = s.chips;
            room.players[s.nick] = pl;
            if (s.isBot) room.players[s.nick]._persona = room.assignPersona(s.nick, this.fn ? ((this.botLevel || {})[s.nick] || 'hard') : 'hard');
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
        if (isFinal) io.to(roomId).emit('gameMessage', '🏆 파이널 테이블! 마지막 승부입니다!');
        // 첫 핸드 시작
        if (group.length >= 2) room.scheduleNextHand(isFinal ? 2500 : 2000);
        return room;
    }

    // ─────────── 탈락 통보 (즉시 피드백용; 순위 확정은 tick에서) ───────────
    onPlayerEliminated(roomId, nick) {
        if (this.finished) return;
        if (this.eliminated.find(e => e.nick === nick)) return;
        const place = this.totalEntrants - this.eliminated.length;
        this.eliminated.push({ nick, place });
        if (this.fn) MockDB.recordFnResult(nick, { t: Date.now(), place, total: this.totalEntrants, id: this.mttId, paid: this.paid, level: this.blindLevel + 1 });
        if (process.env.DEV_MTTLOG) console.log(`[MTTLOG] out ${place} ${nick} t=${Date.now()} alive=${this.countAlive()} room=${roomId.split('#')[1]}`);
        const room = rooms.get(roomId);
        if (room && room.players[nick] && room.players[nick].socketId) {
            io.to(room.players[nick].socketId).emit('mttEliminated', { place, total: this.totalEntrants });
        }
        io.to(roomId).emit('gameMessage', `💀 ${nick} 님 탈락 — ${place}위 / ${this.totalEntrants}명`);
        // 즉시 한 번 점검(빠른 반응) — 단 tick과 충돌 않도록 가드
        setTimeout(() => this.tick(), 600);
    }

    // ─────────── 핸드가 끝난 직후(칩 정산 완료)에 테이블이 알려 준다 ───────────
    //  🐛 [순위 버그] 예전엔 탈락을 "그 테이블의 다음 판이 시작될 때" 기록했다. 그 전에 테이블이 합쳐지거나(재배치) 토너먼트가 끝나면
    //     기록이 빠졌고, 빠진 사람은 끝날 때 "참가 신청 순서대로" 빈 순위를 받았다 — 그래서 1대1에서 진 방장(신청 1번)이 3위,
    //     훨씬 전에 탈락했지만 기록이 빠져 있던 사람이 2위가 됐다. 이제 탈락하는 그 판이 끝나는 즉시 기록한다.
    //  ⏱ [파이널 테이블] 예전엔 테이블들이 계속 새 판을 돌려서 "전 테이블이 동시에 쉬는 순간"이 잘 안 왔고, 그 사이에 더 탈락해서
    //     6명이 되어도 한참 뒤에(더 적은 인원으로) 모였다. 이제 합쳐야 하는 순간부터 새 판을 멈추고, 돌던 판이 끝나는 대로 모은다.
    onHandEnd(room) {
        if (this.finished) return;
        const starts = room.handStartStacks || {};
        const recorded = new Set(this.eliminated.map(e => e.nick));
        // 🔄 [리바인] 칩을 다 잃었는데 리바인이 남아 있고 마감 레벨 전이면, 탈락시키지 않고 시작 칩으로 다시 앉힌다(자동).
        //    실제 매장은 본인이 정하지만, 연습에서는 거의 모두가 다시 들어오므로 흐름을 끊지 않게 자동으로 한다.
        if (this.rebuyMax > 0 && this.blindLevel < this.rebuyUntilLevel) {
            room.playerOrder.forEach(n => {
                const p = room.players[n];
                if (!p || p.chips > 0 || recorded.has(n) || (this.rebuys[n] || 0) >= this.rebuyMax) return;
                this.rebuys[n] = (this.rebuys[n] || 0) + 1;
                p.chips = this.startingChips; p.isSpectator = false; p.rebuysUsed = this.rebuys[n];
                io.to(room.roomId).emit('gameMessage', `🔄 ${n} 님 리바인 — ${this.startingChips.toLocaleString()}칩으로 다시 시작합니다 (리바인 ${this.rebuys[n]}/${this.rebuyMax})`);
                if (p.socketId) io.to(p.socketId).emit('gameMessage', `🔄 리바인했습니다. 남은 리바인 ${this.rebuyMax - this.rebuys[n]}회 · 리바인은 레벨 ${this.rebuyUntilLevel}까지입니다.`);
            });
        }
        room.playerOrder
            .filter(n => room.players[n] && room.players[n].chips <= 0 && !recorded.has(n))
            .sort((a, b) => (starts[a] || 0) - (starts[b] || 0))      // 같은 판에서 여럿이 탈락하면 그 판을 더 적은 칩으로 시작한 사람이 더 낮은 순위
            .forEach(n => this.onPlayerEliminated(room.roomId, n));
        if (this._endVote) this.checkEndVote();                       // 투표 중 탈락한 사람을 투표자에서 뺀다
        if (this._endAgreed) { setTimeout(() => this.tryAgreedFinish(), DEV_FAST ? 100 : 2500); return; }
        this.updateHold();
        // 결과를 볼 시간(3초)이 지나자마자 한 번 점검해서 바로 합친다 (4초 하트비트를 기다리지 않는다)
        if (this.hold) setTimeout(() => this.tick(), DEV_FAST ? 150 : 3100);
    }
    // ═══ 🗳️ [MTT 합의 종료] 봇이 아닌 사람들끼리 전원 동의하면 지금 끝낸다 ═══
    //   투표자: 모든 테이블에서 칩이 남아 있고 접속 중인 사람(봇은 투표하지 않는다). 사람이 한 명뿐이면 그 사람의 제안만으로 끝난다.
    //   끝낼 때: 남은 사람은 칩이 많은 순서대로 순위를 받고, 이미 탈락한 사람의 순위는 그대로다. 돌고 있는 판은 끝까지 친 뒤에 끝낸다.
    endVoteVoters() {
        const out = [];
        this.tables.forEach(rid => { const r = rooms.get(rid); if (r) r.playerOrder.forEach(n => { const p = r.players[n]; if (p && !p.isBot && !p.isDisconnected && (p.chips > 0 || (r.gameStage >= 1 && r.gameStage <= 4 && p.isAllIn && !p.isFolded)) && !out.includes(n)) out.push(n); }); });
        return out;
    }
    endVoteSnapshot() {
        const v = this._endVote;
        if (!v) return { active: false };
        return { active: true, mtt: true, proposer: v.proposer, voters: [...v.voters], yes: [...v.yes], deadline: v.deadline };
    }
    _say(msg) { this.tables.forEach(rid => io.to(rid).emit('gameMessage', msg)); }
    proposeEndVote(nick, tell) {
        if (!this.started || this.finished) return tell('🗳️ 진행 중인 토너먼트에서만 종료 투표를 할 수 있습니다.');
        if (this._endAgreed) return tell('🗳️ 이미 종료가 합의됐습니다. 곧 마칩니다.');
        if (this._endVote) return tell('🗳️ 이미 종료 투표가 진행 중입니다.');
        const voters = this.endVoteVoters();
        if (!voters.includes(nick)) return tell('🗳️ 칩이 남아 있는 참가자만 제안할 수 있습니다.');
        if (Date.now() < (this._endVoteCooldownUntil || 0)) return tell('🗳️ 방금 부결됐습니다. 잠시 후 다시 제안해 주세요.');
        this._endVote = { proposer: nick, voters: new Set(voters), yes: new Set([nick]), deadline: Date.now() + END_VOTE_MS, timer: null };
        this._endVote.timer = setTimeout(() => this.finishEndVote(false, '시간 초과'), END_VOTE_MS);
        this._say(`🗳️ ${nick} 님이 토너먼트를 지금 끝내자고 제안했습니다 (남은 칩 순서대로 순위 확정 · 사람 ${voters.length}명 전원 동의 필요).`);
        this.checkEndVote();
    }
    castEndVote(nick, agree) {
        const v = this._endVote;
        if (!v || !v.voters.has(nick) || v.yes.has(nick)) return;
        if (!agree) return this.finishEndVote(false, `${nick} 님 반대`);
        v.yes.add(nick);
        this.checkEndVote();
    }
    checkEndVote() {
        const v = this._endVote;
        if (!v) return;
        // 투표 중에 탈락하거나 나간 사람은 뺀다
        const still = new Set(this.endVoteVoters());
        [...v.voters].forEach(n => { if (!still.has(n)) { v.voters.delete(n); v.yes.delete(n); } });
        if (v.voters.size === 0) return this.finishEndVote(false, '투표자 없음');
        if (v.yes.size >= v.voters.size) return this.finishEndVote(true);
        const snap = this.endVoteSnapshot();
        this.tables.forEach(rid => io.to(rid).emit('endVote', snap));
    }
    finishEndVote(passed, reason) {
        if (!this._endVote) return;
        if (this._endVote.timer) clearTimeout(this._endVote.timer);
        this._endVote = null;
        this.tables.forEach(rid => io.to(rid).emit('endVote', { active: false }));
        if (!passed) {
            this._endVoteCooldownUntil = Date.now() + 15000;
            this._say(`🗳️ 종료 투표 부결 (${reason}) — 토너먼트를 계속합니다.`);
            return;
        }
        this._endAgreed = true;
        this._say('🤝 사람 전원 동의! 진행 중인 판이 끝나면 남은 칩 순서대로 순위를 정하고 토너먼트를 마칩니다.');
        this.tryAgreedFinish();
    }
    tryAgreedFinish() {
        if (!this._endAgreed || this.finished) return;
        const busy = this.tables.some(rid => { const r = rooms.get(rid); return r && r.gameStage >= 1 && r.gameStage <= 4; });
        if (busy) return;
        this.finished = true;
        if (this._heartbeat) clearInterval(this._heartbeat);
        if (this._blindTimer) { clearInterval(this._blindTimer); this._blindTimer = null; }
        const alive = this.livePlayers().sort((a, b) => b.chips - a.chips);
        const recorded = new Set(this.eliminated.map(e => e.nick));
        alive.forEach(a => recorded.add(a.nick));
        // 기록이 빠진 사람(같은 판에 여럿이 탈락한 직후 등)은 남은 사람 바로 아래 순위로 채운다
        const missing = this.entrants.filter(e => !recorded.has(e.nick));
        const ranking = alive.map((a, i) => ({ place: i + 1, nick: a.nick, chips: a.chips }))
            .concat(missing.map((e, i) => ({ place: alive.length + i + 1, nick: e.nick })))
            .concat(this.eliminated.slice().sort((a, b) => a.place - b.place).map(e => ({ place: e.place, nick: e.nick })));
        if (this.fn) {
            alive.forEach((a, i) => { if (!a.isBot) MockDB.recordFnResult(a.nick, { t: Date.now(), place: i + 1, total: this.totalEntrants, id: this.mttId, paid: this.paid, level: this.blindLevel + 1, agreed: true }); });
            missing.forEach((e, i) => { if (!e.isBot) MockDB.recordFnResult(e.nick, { t: Date.now(), place: alive.length + i + 1, total: this.totalEntrants, id: this.mttId, paid: this.paid, level: this.blindLevel + 1, agreed: true }); });
        }
        const champion = alive.length ? alive[0].nick : (ranking[0] && ranking[0].nick);
        if (process.env.DEV_MTTLOG) console.log(`[MTTLOG] agreed-finish ${JSON.stringify(ranking.slice(0, 8).map(r => r.place + ':' + r.nick))}`);
        this.tables.forEach(rid => {
            io.to(rid).emit('mttFinished', { champion, totalEntrants: this.totalEntrants, ranking, agreed: true });
            io.to(rid).emit('gameMessage', `🤝 합의 종료 — 남은 ${alive.length}명은 칩 순서대로 순위가 정해졌습니다 (1위 ${champion}).`);
        });
        setTimeout(() => {
            this.tables.forEach(rid => { if (rooms.has(rid)) destroyRoom(rid); });
            mtts.delete(this.mttId);
        }, 8000);
    }

    // 지금 테이블을 합쳐야 하는 상태인가 (파이널 테이블 구성 · 테이블 수 과다 · 한 명만 남은 테이블)
    updateHold() {
        const info = this.tables.map(rid => rooms.get(rid)).filter(Boolean)
            // 판이 도는 중에 올인한 사람은 칩이 0 이어도 아직 살아 있다 — 이들을 빼면 판정이 판마다 깜빡인다
            .map(r => r.playerOrder.filter(n => r.players[n] && (r.players[n].chips > 0 || (r.gameStage >= 1 && r.gameStage <= 4 && r.players[n].isAllIn && !r.players[n].isFolded))).length).filter(n => n > 0);
        const total = info.reduce((a, b) => a + b, 0);
        const was = !!this.hold;
        this.hold = info.length > 1 && (info.length > this.idealTableCount(total) || info.some(n => n === 1));
        if (this.hold && !was) {
            this._holdSince = Date.now();
            if (process.env.DEV_MTTLOG) console.log(`[MTTLOG] hold total=${total} tables=${info.join('/')} t=${Date.now()}`);
            const final = total <= this.tableSize;
            this.tables.forEach(rid => io.to(rid).emit('gameMessage', final ? `🏆 ${total}명 남았습니다 — 진행 중인 판이 끝나면 파이널 테이블로 모입니다.` : '🔄 진행 중인 판이 끝나면 테이블을 다시 나눕니다.'));
        }
        return this.hold;
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
        if (this._endAgreed) { this.tryAgreedFinish(); return; }
        // 1) 빈 테이블 제거
        this.tables.forEach(rid => {
            const r = rooms.get(rid);
            if (!r) return;
            // 🛡️ [버그픽스] 핸드가 진행 중인 테이블은 절대 건드리지 않는다.
            //    올인 쇼다운 런아웃 동안에는 남은 전원의 chips가 0이라 "빈 테이블"로 오판됐다.
            //    하트비트가 4초마다 도는데 런아웃은 그보다 길어서, 팟이 지급되기 전에 테이블이
            //    통째로 삭제되며 그 칩과 참가자가 토너먼트에서 통째로 사라졌다.
            if (r.gameStage >= 1 && r.gameStage < 5) return;
            if (r.playerOrder.filter(n => r.players[n] && r.players[n].chips > 0).length === 0) destroyRoom(rid);
        });
        this.tables = this.tables.filter(rid => rooms.has(rid));

        const live = this.livePlayers();
        this.updateHold();

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
        // 🛡️ [버그픽스] 이미 다음 핸드가 예약돼 있으면 손대지 않는다.
        //    예전엔 결과창 8초 타이머를 무시하고 1.5초 뒤 재가동을 따로 걸어서,
        //    (1) 쇼다운 결과를 1.5초밖에 못 보고 (2) 뒤늦게 온 8초 타이머가 새 판을 덮어썼다.
        if (r._nextHandTimer) return;
        if (r.gameStage === 5) r.scheduleNextHand(Math.max(800, 6000 - (Date.now() - (r._handEndedAt || 0))));   // 결과창을 이미 충분히 봤으면 곧바로
        else if (r.gameStage === 0) r.scheduleNextHand(1200);
    }

    // 전체 생존자를 적정 테이블 수로 재배치 (칩 유지). isFinal이면 단일 파이널.
    consolidate(live, isFinal) {
        // 진행 중인 핸드가 있는 테이블이면 끝날 때까지 대기 (다음 tick에서 처리)
        //    쇼다운 직후(결과창 3초)도 "진행 중"으로 본다 — 누가 이겼는지 보기도 전에
        //    테이블이 통째로 재배치되면 판이 섞인 것처럼 보인다.
        const RESULT_GRACE_MS = 3000;
        const busy = this.tables.some(rid => {
            const r = rooms.get(rid);
            if (!r) return false;
            if (r.gameStage >= 1 && r.gameStage < 5) return true;
            return r.gameStage === 5 && (Date.now() - (r._handEndedAt || 0)) < RESULT_GRACE_MS;
        });
        if (busy) { this.broadcastStatus(); return; }

        // 칩 스냅샷 (현재 시점 재조회) + 이전 테이블 기록
        const fresh = this.livePlayers();
        const survivors = fresh.map(p => ({ nick: p.nick, socketId: p.socketId, isBot: p.isBot, chips: p.chips, _prevRoom: p.roomId }));

        // 기존 테이블 전부 정리 (핸드 진행중 아님이 보장됨)
        this.tables.forEach(rid => { if (rooms.has(rid)) destroyRoom(rid); });
        this.tables = [];

        if (process.env.DEV_MTTLOG) console.log(`[MTTLOG] merge final=${isFinal || survivors.length <= this.tableSize} n=${survivors.length} wait=${this._holdSince ? Date.now() - this._holdSince : -1}ms t=${Date.now()}`);
        this.hold = false;      // 합쳤으니 새 판을 다시 돌린다
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
        if (this._blindTimer) { clearInterval(this._blindTimer); this._blindTimer = null; }
        const champion = winner.nick;
        // 연습 모드의 우승은 연습 기록에만 남긴다(명예의 전당·토큰과 무관)
        if (this.fn) { if (!winner.isBot) MockDB.recordFnResult(champion, { t: Date.now(), place: 1, total: this.totalEntrants, id: this.mttId, paid: this.paid, level: this.blindLevel + 1 }); }
        else if (!winner.isBot) MockDB.addMttWin(champion, this.totalEntrants, (this.humanEntrants || 0) >= TOKEN_MIN_HUMANS);

        // 누락된 탈락자 보완: entrants 중 우승자도, 탈락기록도 없는 사람을 채움
        //   (같은 핸드 동시 탈락 등으로 콜백이 일부 누락된 경우 대비)
        const recorded = new Set(this.eliminated.map(e => e.nick));
        recorded.add(champion);
        const missing = this.entrants.filter(e => !recorded.has(e.nick));
        if (missing.length) console.error(`[MTT] 탈락 기록 누락 ${missing.length}명 — 끝에서 보완: ${missing.map(e => e.nick).join(', ')}`);
        // 누락자는 마지막에 탈락한 것으로 간주(가장 낮은 빈 순위부터 부여)
        missing.forEach(e => {
            const place = this.totalEntrants - this.eliminated.length;
            this.eliminated.push({ nick: e.nick, place });
            if (this.fn && !e.isBot) MockDB.recordFnResult(e.nick, { t: Date.now(), place, total: this.totalEntrants, id: this.mttId, paid: this.paid, level: this.blindLevel + 1 });
        });

        const ranking = [{ place: 1, nick: champion }].concat(
            this.eliminated.slice().sort((a, b) => a.place - b.place).map(e => ({ place: e.place, nick: e.nick }))
        );
        if (process.env.DEV_MTTLOG) console.log(`[MTTLOG] finish ${JSON.stringify(ranking.map(r => r.place + ':' + r.nick))} missing=${missing.length}`);
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
        if (this._blindTimer) { clearInterval(this._blindTimer); this._blindTimer = null; }
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

// 🏁 [파이널나인 딥스택 연습] 구조 — 운영자가 알려 준 값(2026-10-10): 1레벨 10,000/20,000 · 시작 3,000,000칩(150bb) · 레벨 10분(앱에서는 3분으로 진행) ·
//    3레벨(30,000/60,000)부터 BB 앤티 · 리바인 1회. (얼리버드 추가 칩 340만~400만은 넣지 않았다.)
//    ⚠️ 알려 주지 않은 부분은 가정이다: 4레벨 이후의 블라인드, 리바인 마감(6레벨까지로 둠), 입상 인원(20명 중 3명). 테이블은 이 게임의 최대인 6인(실제 매장은 9인).
const FN_MTT = {
    // 레벨은 3분: 실제 매장은 10분이지만 앱은 판이 서너 배 빨리 돌아서, 한 레벨에 치는 판 수를 실제와 비슷하게 맞춘 값이다(운영자 결정 — 10분 진행은 없앰)
    // 칩 단위는 실제 매장(1레벨 10,000/20,000 · 300만 칩)의 100분의 1 로 줄였다 — 숫자가 너무 커서 적응이 안 된다는 운영자 요청. bb 로 보면 똑같다(150bb 시작).
    entrants: 20, tableSize: 6, startingChips: 30000, blindUpInterval: 180, paid: 3, rebuys: 1, rebuyUntilLevel: 6, normalBots: 3,
    structure: [[100, 200], [200, 400], [300, 600], [400, 800], [500, 1000], [600, 1200], [800, 1600], [1000, 2000], [1500, 3000], [2000, 4000],
        [3000, 6000], [4000, 8000], [6000, 12000], [8000, 16000], [10000, 20000], [15000, 30000], [20000, 40000], [30000, 60000], [50000, 100000]]
        .map((x, i) => ({ level: i + 1, sb: x[0], bb: x[1], ante: i < 2 ? 0 : x[1] }))
};
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
        // 🤖 컴까기: 혼자 치는 방은 숨기고, 친구를 기다리는 협동 방만 목록에 올린다
        if (room._challenge && !(room._challenge.coop && room._challenge.waiting)) return;
        const humans = Object.values(room.players).filter(p => p && !p.isBot).length;
        const bots = Object.values(room.players).filter(p => p && p.isBot).length;
        const playing = (room.gameStage >= 1 && room.gameStage < 5) || room.tournamentStarted || room._cashStarted;
        list.push({
            id: roomId,
            mode: room._challenge ? 'coop' : (room.mode || 'tournament'),   // 'tournament' | 'cash' | 'coop'(컴까기 협동)
            humans, bots,
            total: humans + bots,
            playing: !!playing
        });
    });
    return list;
}

// 💡 [수정 #6] 빈 방 정리 (메모리 누수 + 유령 방 목록 방지)
// ═══ 🍀 증강 컴까기(로그라이크 런) ═══
// 진행 중인 런 (닉네임 → 런). 메모리에만 둔다 — 서버가 재시작되면 진행 중이던 런은 사라진다(보상은 정산 시점에만 생긴다).
const runs = new Map();

// 💾 런은 계정에도 적어 둔다 — 서버가 재시작돼도(무료 호스팅은 자주 잠든다) 이어서 할 수 있게.
function saveRun(nick, run) {
    const u = MockDB.users.get(nick);
    if (!u) return;
    u.run = Rogue.serialize(run);
    MockDB.save();
}
// 메모리에 없으면 계정에 저장된 런을 검증해서 되살린다
function loadRun(nick) {
    let run = runs.get(nick);
    if (run) return run;
    const u = MockDB.users.get(nick);
    if (!u || !u.run) return null;
    run = Rogue.restore(u.run, Math.random);
    if (!run) { delete u.run; return null; }
    runs.set(nick, run);
    return run;
}

function runOfferPayload(run, extra) {
    return Object.assign({
        floor: run.floor, total: Rogue.FLOORS.length, next: Rogue.floorSetup(run),
        offers: run.offers.map(Rogue.describe), rerolls: run.rerolls,
        augments: run.augments.map(Rogue.describe),
        coins: run.coins || 0, shop: Rogue.shopView(run), extraPicks: run.extraPicks || 0
    }, extra || {});
}

// 런 종료 정산 — 깬 층만큼 뱅크롤·코어
function endRun(nick, run, sock) {
    if (runs.get(nick) === run) runs.delete(nick);
    const u = MockDB.users.get(nick);
    if (!u) return;
    delete u.run;
    const r = Rogue.settle(u, run);
    MockDB.save();
    if (sock) sock.emit('runEnd', Object.assign({ floor: run.floor, total: Rogue.FLOORS.length, augments: run.augments.map(Rogue.describe), coresNow: u.cores || 0 }, r));
    if (r.reward > 0) {
        MockDB.adjustBankroll(nick, r.reward).then(nb => { if (sock) sock.emit('bankrollUpdate', { bankroll: nb || 0 }); });
    }
}

// 이번 층의 방을 만들어 바로 시작한다 (컴까기 방과 같은 이름을 써서 방 목록 제외·남의 입장 금지 규칙을 그대로 탄다)
function launchRunFloor(socket, run) {
    const nick = socket.nickname;
    const roomId = `🤖컴까기_${nick}`;
    if (rooms.has(roomId)) { try { destroyRoom(roomId); } catch (e) {} }
    const fs = Rogue.floorSetup(run);
    // 블라인드는 층 내내 그대로(50/100) — 기한이 핸드 수라 블라인드가 오르면 계산이 흐려진다
    const settings = { startingChips: fs.startChips, blindUpInterval: 3600, turnTimeLimit: 30, mode: 'tournament', maxRebuys: 0 };
    const room = new GameRoom(roomId, settings);
    room._mttFreeChips = true;                 // 참가비·상금풀 없음 (뱅크롤과 무관한 칩)
    room._challenge = {
        nick, stage: 0, done: false, run, boss: fs.boss, floorName: fs.name,
        quota: fs.quota, hands: fs.hands, handsPlayed: 0, mullLeft: fs.mull, settledHandId: 0, dealBonus: 0, peek: null
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.currentRoom = roomId;
    leaveLobby(socket);
    room.hostNickname = nick;
    room.players[nick] = {
        id: nick, socketId: socket.id, chips: fs.startChips,
        currentBet: 0, totalInvested: 0, isFolded: false, hasActed: false, role: '',
        isAllIn: false, isDisconnected: false, isMucked: false, isSpectator: false,
        hand: [], lastEmoteTime: 0, isBot: false, rebuysUsed: 0
    };
    room.playerOrder.push(nick);
    fs.bots.forEach(d => room.addBot(d));
    room.playerOrder.forEach(n => { const bp = room.players[n]; if (bp && bp.isBot) bp.chips = fs.botChips; });
    run.phase = 'play'; run.inFloor = true;
    saveRun(nick, run);

    socket.emit('joinRoomSuccess', roomId);
    socket.emit('runFloorStart', Object.assign({}, fs, { augments: run.augments.map(Rogue.describe), botNames: room.playerOrder.filter(n => room.players[n].isBot) }));
    room.sendState();
    setTimeout(() => { if (rooms.get(roomId) === room && !room._challenge.done) room.startNextHand(); }, fs.boss ? 4600 : 3000);
}

function destroyRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    try { room.settleBlunders(); } catch (e) {}
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
    // 🍀 [증강 런] 층이 끝나기 전에 방이 치워지면(접속 끊김·다른 방 시작) 그 층은 실패 — 깬 층까지만 정산한다.
    //    서버 재시작은 이 길을 타지 않으므로(방이 그냥 사라진다) 그때는 그 층을 처음부터 다시 하게 된다.
    if (room._challenge && room._challenge.run && !room._challenge.done) {
        try { room.finishRunFloor(false, true); } catch (e) { console.error('run settle on destroy:', e); }
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
                try { socket.emit('gameMessage', '⚠️ 처리 중 오류가 발생했습니다. 다시 시도해 주세요.'); } catch (_) {}
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

            // 🛡️ [관리자] admin 으로 로그인하면 게임에 들이지 않고 관리자 페이지로 보낸다.
            //    ⚠️ 재접속(PIN 생략) 경로는 관리자에겐 절대 허용하지 않는다 — 비밀번호 없이 들어오는 문이 된다.
            if (safeNick === ADMIN_NICK) {
                const ip = socketIp(socket);
                const lim = adminRouter && adminRouter.limiter;
                if (lim && lim.blocked(ip)) {
                    socket.emit('loginError', '시도가 너무 많습니다. 15분 뒤에 다시 해보세요.');
                    return;
                }
                if (!isValidPin(pin) || isReconnect) {
                    socket.emit('loginError', '비밀번호는 숫자 4자리로 입력해주세요.');
                    return;
                }
                const au = await MockDB.getUser(ADMIN_NICK);
                let first = false;
                if (!process.env.ADMIN_PASS && !au.pinHash) { await MockDB.setPin(ADMIN_NICK, pin); first = true; }
                if (!verifyAdmin(pin)) {
                    const n = lim ? lim.fail(ip) : 0;
                    accessLog.push({ type: 'adminfail', nick: ADMIN_NICK, ip, detail: `게임 로그인 실패 ${n}` });
                    socket.emit('loginError', '비밀번호가 일치하지 않습니다. 다시 확인해주세요.');
                    return;
                }
                if (lim) lim.reset(ip);
                accessLog.push({
                    type: 'admin', nick: ADMIN_NICK, ip,
                    ua: shortUA(socket.handshake && socket.handshake.headers && socket.handshake.headers['user-agent']),
                    detail: first ? '관리자 비밀번호 최초 등록' : '게임 로그인으로 입장'
                });
                socket.emit('adminRedirect', { url: adminRouter ? adminRouter.mintTicket() : '/admin/' });
                return;
            }

            const existed = MockDB.users.has(safeNick);
            const user = await MockDB.getUser(safeNick);

            // 🔒 재접속이라고 PIN 확인을 건너뛰지 않는다.
            //    예전엔 { reconnect: true } 한 줄로 남의 계정에 비밀번호 없이 들어올 수 있었다.
            //    (isReconnect 는 이제 "세션 스냅샷을 새로 뜰지" 판단에만 쓴다)
            {
                if (!isValidPin(pin)) {
                    socket.emit('loginError', '비밀번호는 숫자 4자리로 입력해주세요.');
                    return;
                }
                if (!user.pinHash) {
                    // 최초 로그인 → PIN 등록
                    await MockDB.setPin(safeNick, pin);
                } else if (user.pinHash !== hashPin(pin)) {
                    accessLog.push({
                        type: 'fail', nick: safeNick, ip: socketIp(socket),
                        ua: shortUA(socket.handshake && socket.handshake.headers && socket.handshake.headers['user-agent']),
                        detail: '비밀번호 불일치'
                    });
                    socket.emit('loginError', '비밀번호가 일치하지 않습니다. 다시 확인해주세요.');
                    return;
                }
            }

            // 🚦 [정원] 비밀번호까지 맞았으면 자리가 있는지 본다. 없으면 줄을 세우고 여기서 멈춘다(자리가 나면 클라이언트가 다시 로그인한다).
            if (!capacity.canEnter(user.nickname, onlineNicks(), Date.now(), nickInGame(user.nickname))) {
                const position = capacity.enqueue(user.nickname, socket.id, Date.now());
                socket.emit('loginQueued', { position, waiting: capacity.queue.length, max: capacity.max });
                return;
            }
            capacity.entered(user.nickname);

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

            // 📋 [접속 기록] 관리자 페이지용. 봇은 소켓으로 로그인하지 않으므로 사람만 남는다.
            socket._ip = socketIp(socket);
            socket._loginAt = Date.now();
            user.lastSeen = socket._loginAt;
            accessLog.push({
                type: 'login', nick: user.nickname, ip: socket._ip,
                ua: shortUA(socket.handshake && socket.handshake.headers && socket.handshake.headers['user-agent']),
                detail: isReconnect ? '재접속' : (existed ? '' : '신규 가입')
            });

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
        // 📋 [접속 기록] 어느 방에 들어갔는지 (방 이름은 사용자가 지은 것이라 길이를 자른다)
        accessLog.push({
            type: 'join', nick: socket.nickname, ip: socket._ip || socketIp(socket),
            detail: String((data && data.roomId) || '').slice(0, 40)
        });

        // 💡 [수정 #8] 방 이름 길이 제한
        const roomId = (typeof data === 'string' ? data : String(data.roomId || '')).trim().slice(0, 20);
        if (!roomId) return socket.emit('joinError', '방 이름을 정확히 입력해주세요.');

        // 🚪 [버그픽스] 한 사람이 두 방에 동시에 들어갈 수 있었다. 재접속으로 원래 방에 복귀한 상태에서
        //    다른 방(초대 링크 등)에 또 들어가면 두 테이블의 화면 갱신이 번갈아 와서 테이블이 깜빡이고,
        //    한쪽 방에는 자리만 차지한 유령이 남았다. 다른 방에 자리가 있으면 먼저 나가게 한다.
        for (const [rid, r] of rooms) {
            if (rid !== roomId && r.players[socket.nickname] && !r.players[socket.nickname].isBot) {
                return socket.emit('joinError', `이미 [${rid}] 방에 있습니다. 먼저 그 방에서 나가세요.`);
            }
        }

        if (!rooms.has(roomId)) {
            const settings = (data && data.settings) || {};
            // 💵 캐시 게임은 없앴다(운영자 결정) — 방은 토너먼트로만 만든다. 내부의 'cash' 진행 방식은 GTO 학습 모드(블라인드 고정·칩 자동 충전)만 쓴다.
            settings.mode = 'tournament'; delete settings.cashBlind; delete settings.runItTwice;
            rooms.set(roomId, new GameRoom(roomId, settings));
            io.emit('roomList', roomListArray());
        }

        const room = rooms.get(roomId);
        const nick = socket.nickname;

        // 🤖 컴까기 방은 주인 혼자 치는 방이다 (재접속한 주인만 다시 들어올 수 있다)
        if (room._challenge && !room.players[nick]) {   // 이미 멤버(재접속)면 통과
            const ch = room._challenge;
            if (!ch.coop) return socket.emit('joinError', '컴까기 방에는 들어갈 수 없습니다.');
            if (!ch.waiting) return socket.emit('joinError', '이미 도전이 시작됐습니다. 끝나면 들어오세요.');
            const humans = Object.values(room.players).filter(x => x && !x.isBot).length;
            if (humans >= Challenge.COOP_MAX) return socket.emit('joinError', `협동은 ${Challenge.COOP_MAX}명까지입니다.`);
        }

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
            // 👀 본인이 "관전으로 입장"을 고른 경우 — 자리가 있어도 앉지 않는다
            const wantSpectate = !!(data && data.asSpectator);
            // 💵 캐시: 진행 중에도 칩 들고 바로 착석 / 🏆 토너먼트: 진행 중이면 관전 / 풀방: 관전
            const asSpectator = wantSpectate || joinAsSpectatorFull || ((room.mode === 'tournament') && room.tournamentStarted);
            room.players[nick] = {
                id: nick, socketId: socket.id,
                chips: asSpectator ? 0 : room.startingChips,
                currentBet: 0, totalInvested: 0,
                isFolded: false, hasActed: false, role: '', isAllIn: false,
                isDisconnected: false, isMucked: false, hand: [], lastEmoteTime: 0,
                isSpectator: asSpectator,
                _fullRoomSpectator: joinAsSpectatorFull, // 풀방 관전 — 자리 나면 합류 가능
                _wantSpectate: wantSpectate,             // 👀 본인이 고른 관전 — 자동으로 앉히지 않는다
                rebuysUsed: 0, totalBuyins: 1
            };
            if (wantSpectate) {
                io.to(roomId).emit('gameMessage', `👀 ${nick} 님이 관전하러 왔습니다.`);
                socket.emit('gameMessage', '👀 관전 중입니다 — 아래 [참여하기]를 누르면 자리에 앉습니다.');
            } else if (asSpectator) {
                const reason = joinAsSpectatorFull ? '(자리가 차서 관전석으로)' : '';
                io.to(roomId).emit('gameMessage', `👀 ${nick} 님이 관전자로 입장하셨습니다. ${reason}`);
                if (joinAsSpectatorFull) socket.emit('gameMessage', '👀 자리가 가득 차 관전자로 입장했습니다. 자리가 나면 다음 핸드부터 참여할 수 있어요.');
            } else {
                io.to(roomId).emit('gameMessage', `👋 ${nick} 님이 방에 입장하셨습니다.`);
                if (room.mode === 'cash') {
                    // 💵 최초 바이인 — 차감 후 본인 화면에도 반영 (예전엔 UI가 옛 금액 그대로였다)
                    MockDB.recordCashNet(nick, -room.startingChips);
                    MockDB.adjustBankroll(nick, -room.startingChips).then(nb => socket.emit('bankrollUpdate', { bankroll: nb || 0 }));
                }
                // 💡 [버그픽스] 캐시 진행 중 입장은 "다음 핸드부터" 합류 — 여기서 playerOrder에 바로 넣으면
                //    카드를 받지 않은 좌석이 진행 중인 핸드의 턴을 받아 베팅까지 하고, 쇼다운에선 보드만으로
                //    족보가 평가돼 팟을 가져갈 수도 있었다. 좌석 배정은 startNextHand가 핸드 경계에서 처리한다.
                if (room.mode === 'cash' && room.gameStage !== 0) {
                    socket.emit('gameMessage', '🪑 지금 핸드가 진행 중입니다 — 다음 핸드부터 합류합니다.');
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

        // 🍀 [증강 런] 층 도중에 나가면 그 런은 거기서 끝 — 깬 층까지만 정산한다 (나갔다 들어와 같은 층을 다시 치는 것 방지)
        if (room._challenge && room._challenge.run && !room._challenge.done) room.finishRunFloor(false, true);

        // 🛡️ [버그픽스] 진행 중인 핸드에 칩이 걸려 있으면(특히 올인) 즉시 이탈 금지.
        //    올인한 사람은 chips===0 이라 아래 "생존자 이탈 차단"을 통과해 좌석이 통째로 삭제됐고,
        //    아직 팟에 쓸어담기지 않은 currentBet이 사라져 테이블 총칩이 줄었다(실측 30,000→20,000).
        //    쇼다운 참가 자격도 함께 사라져 올인한 칩을 그냥 몰수당했다.
        //    캐시는 아래 "나가기 예약" 경로가 핸드 종료 후 정산해 주므로 예외.
        if (room.mode !== 'cash' && room.gameStage >= 1 && room.gameStage <= 4 && !p.isSpectator && !p.isFolded && (p.isAllIn || (p.totalInvested || 0) > 0)) {
            socket.emit('gameMessage', '🚨 이번 핸드에 칩이 걸려 있습니다! 핸드가 끝난 뒤에 나갈 수 있어요.');
            return;
        }

        // 토너먼트 생존자(칩 보유)는 게임 붕괴 방지를 위해 이탈 차단 (캐시는 상시 이탈 허용)
        if (room.mode === 'tournament' && room.tournamentStarted && p.chips > 0 && !p.isSpectator) {
            socket.emit('gameMessage', '🚨 토너먼트 진행 중에는 나갈 수 없습니다! (파산/관전 시에만 가능)');
            return;
        }

        // 💵 [#3] 캐시 진행 중 나가기 → 이번 핸드까지 보고 나가기 예약 (폴드 후 핸드 종료 시 캐시아웃)
        if (room.mode === 'cash' && room.gameStage > 0 && room.gameStage < 5 && !p.isFolded && !p.isSpectator) {
            const wasMyTurn = (room.playerOrder[room.turnIndex] === nick);
            // 💡 [버그픽스] 올인한 사람을 폴드 처리하면 이미 팟에 넣은 칩의 권리를 통째로 잃는다
            //    (실측: 10,000 올인 → 0 칩 정산). 올인은 더 이상 액션이 없으니 그대로 쇼다운까지 가고,
            //    핸드가 끝난 뒤 딴 칩까지 합쳐 정산한다.
            if (!p.isAllIn) { p.isFolded = true; p.hasActed = true; }
            p._pendingLeave = true; // 핸드 종료 시 자동 캐시아웃 이탈
            socket.emit('gameMessage', '🚪 이번 핸드가 끝나면 보유 칩을 정산하고 나갑니다...');
            if (wasMyTurn) { io.to(roomId).emit('actionSound', { nick, type: 'fold' }); room.nextTurn(); }
            else room.sendState();
            return; // 즉시 이탈하지 않고 예약만
        }

        if (p._disconnectTimer) clearTimeout(p._disconnectTimer);
        // 🐛 학습 모드(공짜 연습 칩)에서 나가면 테이블 칩이 통째로 뱅크롤에 들어왔다(실측 100,000 → 107,027). 학습은 뱅크롤과 무관해야 한다.
        if (room.mode === 'cash' && p.chips > 0 && !room._learnMode) {
            // 💵 캐시아웃 → 뱅크롤 환수. 환수액을 본인 화면에도 즉시 반영한다.
            MockDB.recordCashNet(nick, p.chips);
            MockDB.adjustBankroll(nick, p.chips).then(nb => socket.emit('bankrollUpdate', { bankroll: nb || 0 }));
        }
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

    // 🤖 [컴까기] 단계표 + 내 진행 상황 + 순위
    socket.on('getChallenge', async () => {
        if (!socket.nickname) return;
        const u = await MockDB.getUser(socket.nickname);
        const top = Array.from(MockDB.users.values())
            .map(x => ({ nickname: x.nickname, p: Challenge.progressOf(x) }))
            .filter(x => x.nickname && !x.nickname.startsWith('🤖') && x.p.count > 0)
            .sort((a, b) => b.p.count - a.p.count || b.p.best - a.p.best || a.p.tries - b.p.tries)
            .slice(0, 10)
            .map(x => ({ nickname: x.nickname, best: x.p.best, count: x.p.count, tries: x.p.tries }));
        socket.emit('challengeData', { ladder: Challenge.ladder(u), progress: Challenge.progressOf(u), top, total: Challenge.STAGES.length });
    });

    // 🤖 [컴까기] 도전 시작 — 혼자 + 봇들로 토너먼트 방을 만들어 바로 시작한다.
    //    자유 칩(_mttFreeChips)이라 참가비가 없고, 이겨도 일반 토너먼트 우승으로 치지 않는다.
    socket.on('startChallenge', async (data) => {
        if (!socket.nickname) return;
        const nick = socket.nickname;
        const stage = Number(data && data.stage);
        const u = await MockDB.getUser(nick);
        if (!Challenge.canPlay(u, stage)) { socket.emit('challengeError', '없는 단계입니다.'); return; }
        const roomId = `🤖컴까기_${nick}`;
        const cur = socket.currentRoom;
        if (cur && cur !== roomId && rooms.has(cur) && rooms.get(cur).players[nick]) {
            socket.emit('challengeError', '먼저 지금 있는 방에서 나가세요.');
            return;
        }
        if (rooms.has(roomId)) { try { destroyRoom(roomId); } catch (e) {} }
        const st = Challenge.STAGES[stage - 1];
        const settings = { startingChips: Challenge.START_CHIPS, blindUpInterval: Challenge.BLIND_UP_MIN, turnTimeLimit: 30, mode: 'tournament', maxRebuys: 0 };
        const room = new GameRoom(roomId, settings);
        room._mttFreeChips = true;                 // 참가비·상금풀 없음
        room._challenge = { nick, stage, done: false };
        rooms.set(roomId, room);

        socket.join(roomId);
        socket.currentRoom = roomId;
        leaveLobby(socket);
        room.hostNickname = nick;
        room.players[nick] = {
            id: nick, socketId: socket.id, chips: settings.startingChips,
            currentBet: 0, totalInvested: 0, isFolded: false, hasActed: false, role: '',
            isAllIn: false, isDisconnected: false, isMucked: false, isSpectator: false,
            hand: [], lastEmoteTime: 0, isBot: false, rebuysUsed: 0
        };
        room.playerOrder.push(nick);
        st.bots.forEach(d => room.addBot(d));
        if (st.botChipsMult) {
            room.playerOrder.forEach(n => { const bp = room.players[n]; if (bp && bp.isBot) bp.chips = Math.round(settings.startingChips * st.botChipsMult); });
        }
        const pr = Challenge.progressOf(u);
        u.challenge = { cleared: pr.cleared, best: pr.best, clears: pr.clears, tries: pr.tries + 1 };
        MockDB.save();

        socket.emit('joinRoomSuccess', roomId);
        const boss = stage === Challenge.STAGES.length;
        socket.emit('challengeStarted', { stage, name: st.name, desc: st.desc, total: Challenge.STAGES.length, boss,
            bots: room.playerOrder.filter(n => room.players[n].isBot) });
        room.sendState();
        // 인트로 연출(보스전은 더 길다)이 끝난 뒤에 첫 카드를 돌린다
        setTimeout(() => { if (rooms.get(roomId) === room && !room._challenge.done) room.startNextHand(); }, boss ? 4600 : 3200);
    });

    // 🧠 [GTO 문제 학습] 분야 목록 + 내 기록
    socket.on('quizInfo', async () => {
        if (!socket.nickname) return;
        const u = await MockDB.getUser(socket.nickname);
        socket.emit('quizInfo', { cats: Quiz.catList(), stats: Quiz.statsOf(u), mine: mineInfo(u) });
    });
    // 🩹 내 실수 복습: 실전·학습에서 기록된 큰 실수 모음
    function minePool(u) { return ((u && u.blunders) || []).concat((u && u.learnStats && u.learnStats.blunders) || []); }
    function mineInfo(u) {
        const m = (u && u.quizMine) || {};
        return { pool: minePool(u).filter(r => Quiz.fromBlunder(r)).length, n: m.n || 0, ok: m.ok || 0 };
    }
    // 문제 하나 — 정답·해설은 서버가 쥐고 있다가 답을 받은 뒤에 보낸다
    socket.on('quizNext', (data) => {
        if (!socket.nickname) return;
        if (data && data.cat === 'mine') {
            const u = MockDB.users.get(socket.nickname);
            const rec = Quiz.pickBlunder(minePool(u), Math.random);
            const mq = rec ? Quiz.fromBlunder(rec) : null;
            socket._quiz = mq;
            socket.emit('quizQuestion', mq ? Quiz.publicView(mq)
                : { empty: true, msg: '아직 기록된 큰 실수가 없습니다. 게임이나 GTO 학습을 몇 판 치고 나면, 그때 틀렸던 상황이 여기에 문제로 나옵니다.' });
            return;
        }
        const q = Quiz.generate(data && typeof data.cat === 'string' ? data.cat : 'all', Math.random);
        socket._quiz = q;
        socket.emit('quizQuestion', Quiz.publicView(q));
    });
    socket.on('quizAnswer', async (data) => {
        if (!socket.nickname) return;
        const q = socket._quiz;
        if (!q) return;
        socket._quiz = null;                          // 한 문제에 한 번만 채점
        const choice = data && typeof data.choice === 'string' ? data.choice : '';
        const correct = choice === q.answer;
        const u = await MockDB.getUser(socket.nickname);
        if (u && q.cat === 'mine') {
            // 그 실수 기록에 "다시 풀어 본 횟수 · 맞힌 횟수"를 적는다(맞힌 문제는 덜 나온다)
            const rec = minePool(u).find(r => r.t === q._t);
            if (rec) { rec.qn = (rec.qn || 0) + 1; if (correct) rec.qok = (rec.qok || 0) + 1; }
            const m = u.quizMine || (u.quizMine = { n: 0, ok: 0 });
            m.n++; if (correct) m.ok++;
            MockDB.save();
            socket.emit('quizResult', { correct, answer: q.answer, choice, explain: q.explain, ref: q.ref, stats: Quiz.statsOf(u), mine: mineInfo(u) });
            return;
        }
        const stats = u ? Quiz.record(u, q.cat, correct) : Quiz.statsOf(null);
        if (u) MockDB.save();
        socket.emit('quizResult', { correct, answer: q.answer, choice, explain: q.explain, ref: q.ref, stats });
    });

    // 📈 [실력 비교] 최근 30일 — 칩이 아니라 "결정의 질"로 나란히 본다 (GTO 근접도 · 실수 손실 · 가장 큰 약점 · 최근 7일 추세)
    socket.on('getSkillBoard', (req) => {
        if (!socket.nickname) return;
        const rows = [];
        const calSum = {};      // 📏 승률 추정 정확도 — 모든 계정의 최근 30일 합계
        // 최근 14일의 날짜 열쇠 (추세선용)
        const dayKeys = [];
        { const now = new Date(); for (let i = 13; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i); dayKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); } }
        MockDB.users.forEach(u => {
            if (!u || !u.nickname || u.nickname.startsWith('🤖') || u.nickname === ADMIN_NICK) return;
            const a30 = MockDB.aggregateRange(u, 30);
            Object.keys(a30).forEach(k => { if (k.startsWith('evQ')) calSum[k] = (calSum[k] || 0) + a30[k]; });
            const ev = evView(a30);
            if (!ev || ev.hands < 10) return;
            const a7 = MockDB.aggregateRange(u, 7);
            const prev = {}; Object.keys(a30).forEach(k => { prev[k] = (a30[k] || 0) - (a7[k] || 0); });
            const si = skillIndex(a30) || { raw: null }, ix7 = EvLoss.index(a7), ixPrev = EvLoss.index(prev);
            let lossBB = 0, top = null;
            Blunder.KIND_KEYS.forEach(k => { const bb = a30['lkB_' + k] || 0; lossBB += bb; if (bb > 0 && (!top || bb > top.bb)) top = { name: Blunder.KINDS[k].name, bb: Math.round(bb * 10) / 10, n: a30['lkN_' + k] || 0 }; });
            rows.push({
                nick: u.nickname, me: u.nickname === socket.nickname,
                hands: ev.hands, decisions: ev.decisions,   // 점수에 들어가는 판 수(토너먼트·캐시·MTT)
                gto: ev.score, pm: ev.pm, lo: ev.lo, hi: ev.hi, raw: si.raw,      // gto = 실력 점수(100판당 EV 손실에서 환산) ± 오차 · raw = 권장과 일치한 정도(참고)
                trend: (ix7 && ixPrev && ix7.hands >= 30 && ixPrev.hands >= 30) ? (ix7.score - ixPrev.score) : null,
                loss100: ev.loss100, raw100: ev.raw100, seats: ev.seats, se100: ev.se100, grades: ev.grades,
                top,
                vpip: a30.preflopOpps > 0 ? Math.round(a30.vpipHands / a30.preflopOpps * 100) : null,
                pfr: a30.preflopOpps > 0 ? Math.round(a30.pfrHands / a30.preflopOpps * 100) : null,
                low: ev.hands < 50,
                // 실제 성적: 100판당 칩 증감(bb). 운이 크게 섞이므로 30판 이상일 때만 보여 준다. adj100 은 올인 뒤의 운을 뺀 값
                net100: ev.net100, adj100: ev.adj100, allins: ev.allins, netHands: a30.netHands || 0,
                // 유형별 손실(bb) — 비교표용
                leaks: Object.fromEntries(Blunder.KIND_KEYS.map(k => [k, Math.round((a30['lkB_' + k] || 0) * 10) / 10]).filter(x => x[1] > 0)),
                // 날짜별 점수(결정 5번 이상인 날만) — 추세선용
                spark: dayKeys.map(k => { const d = (u.dailyLog || {})[k]; const x = d && d.evHands >= 10 ? EvLoss.index(d) : null; return x ? x.score : null; })
            });
        });
        rows.sort((x, y) => (x.low ? 1 : 0) - (y.low ? 1 : 0) || y.gto - x.gto || x.loss100 - y.loss100);
        const cal = [];
        ['h', 'b'].forEach(w => ['flop', 'turn', 'river'].forEach(st => {
            const n = calSum['evQn_' + st + '_' + w] || 0;
            if (n >= 30) cal.push({ who: w, st, n, bias: Math.round((calSum['evQe_' + st + '_' + w] || 0) / n * 1000) / 10, rmse: Math.round(Math.sqrt(Math.max(0, (calSum['evQs_' + st + '_' + w] || 0) / n)) * 1000) / 10 });
        }));
        socket.emit('skillBoard', { rows: rows.slice(0, 40), days: 30, mini: !!(req && req.mini), cal,
            kinds: Blunder.KIND_KEYS.map(k => ({ id: k, name: Blunder.KINDS[k].name })) });
    });

    // 🔎 [실력 점수의 근거] 점수가 어떻게 나왔는지 — 누구의 것이든 집계는 볼 수 있고, 패가 드러나는 결정 기록은 본인 것만 준다
    socket.on('getSkillDetail', (req) => {
        if (!socket.nickname) return;
        const nick = req && typeof req.nick === 'string' ? req.nick : socket.nickname;
        const u = MockDB.users.get(nick);
        if (!u || nick.startsWith('🤖')) return;
        const a = MockDB.aggregateRange(u, 30);
        const si = skillIndex(a) || { raw: null };
        const ev = evView(a);
        if (!ev) { socket.emit('skillDetail', { nick, empty: true }); return; }
        const me = nick === socket.nickname;
        const streets = ['preflop', 'flop', 'turn', 'river'].map(st => ({ st, n: a['gqC_' + st] || 0, score: (a['gqW_' + st] > 0) ? Math.round(a['gqS_' + st] / a['gqW_' + st]) : null }));
        const leaks = Blunder.KIND_KEYS.map(k => ({ name: Blunder.KINDS[k].name, tip: Blunder.KINDS[k].tip, n: a['lkN_' + k] || 0, bb: Math.round((a['lkB_' + k] || 0) * 10) / 10 })).filter(l => l.n > 0).sort((x, y) => y.bb - x.bb);
        socket.emit('skillDetail', {
            nick, me, hands: ev.hands, decisions: ev.decisions, easy: a.gqEasy || 0,
            score: ev.score, pm: ev.pm, lo: ev.lo, hi: ev.hi, raw: si.raw, loss100: ev.loss100, raw100: ev.raw100, seats: ev.seats, se100: ev.se100, L0: EvLoss.L0,
            formats: ev.formats, positions: ev.positions, solver: ev.solver,
            grades: ev.grades, evStreets: ev.streets, net100: ev.net100, adj100: ev.adj100, allins: ev.allins,
            freqs: Freqs.summarize(a), freqMin: Freqs.MIN,
            buckets: { best: a.gqN_best || 0, ok: a.gqN_ok || 0, weak: a.gqN_weak || 0, bad: a.gqN_bad || 0 },
            streets, leaks,
            recent: me ? (u.recentDec || []).slice(-30).reverse().map(r => Object.assign({}, r, { why: Blunder.std(r.why) })) : null
        });
    });

    // 🍀 [증강 런] 내 기록·순위·진행 중인 런
    socket.on('getRun', async () => {
        if (!socket.nickname) return;
        const u = await MockDB.getUser(socket.nickname);
        const top = Array.from(MockDB.users.values())
            .map(x => ({ nickname: x.nickname, p: Rogue.progressOf(x) }))
            .filter(x => x.nickname && !x.nickname.startsWith('🤖') && x.p.best > 0)
            .sort((a, b) => b.p.best - a.p.best || b.p.wins - a.p.wins || a.p.runs - b.p.runs)
            .slice(0, 5)
            .map(x => ({ nickname: x.nickname, best: x.p.best, wins: x.p.wins }));
        const run = loadRun(socket.nickname);
        socket.emit('runData', {
            progress: Rogue.progressOf(u), top, total: Rogue.FLOORS.length,
            active: run ? { floor: run.floor, augments: run.augments.length } : null
        });
    });

    // 🍀 [증강 런] 시작 — 하던 런이 있으면 이어서, 없으면 새 런(첫 증강 3택부터)
    socket.on('runStart', async (data) => {
        if (!socket.nickname) return;
        const nick = socket.nickname;
        const u = await MockDB.getUser(nick);
        if (!u) return;
        const roomId = `🤖컴까기_${nick}`;
        const cur = socket.currentRoom;
        if (cur && cur !== roomId && rooms.has(cur) && rooms.get(cur).players[nick]) {
            socket.emit('challengeError', '먼저 지금 있는 방에서 나가세요.');
            return;
        }
        // 🔬 밸런스 측정 전용(DEV_RUN) — 원하는 층·증강으로 바로 시작한다. 운영 서버에는 이 환경변수가 없다.
        if (process.env.DEV_RUN && data && data.dev) {
            const old = rooms.get(roomId);
            if (old && old._challenge && old._challenge.run && !old._challenge.done) old._challenge.done = true;
            const dr = Rogue.newRun(Math.random);
            dr.floor = Math.max(1, Math.min(Rogue.FLOORS.length, Number(data.dev.floor) || 1));
            dr.cleared = dr.floor - 1;
            dr.augments = (Array.isArray(data.dev.augments) ? data.dev.augments : []).filter(id => Object.prototype.hasOwnProperty.call(Rogue.AUGMENTS, id));
            dr.revive = dr.augments.filter(a => a === 'revive').length;
            // 실제 런에서는 올인 이력이 층을 넘어 이어진다 — 측정도 "이미 올인을 남발해 온 사람"으로 시작할 수 있게
            if (data.dev.jam && Number.isInteger(data.dev.jam.h) && Number.isInteger(data.dev.jam.j)) dr.jam = { h: Math.max(0, data.dev.jam.h), j: Math.max(0, Math.min(data.dev.jam.h, data.dev.jam.j)) };
            dr.offers = []; runs.set(nick, dr);
            launchRunFloor(socket, dr);
            return;
        }
        let run = loadRun(nick);
        if (run && run.phase !== 'pick') {
            const old = rooms.get(roomId);
            if (old && old._challenge && old._challenge.run === run && !old._challenge.done) {
                // 층을 치던 방이 아직 살아 있는데 새로 시작을 눌렀다 — 그 런은 여기서 끝(깬 층까지 정산)
                old.finishRunFloor(false, true);
                run = null;
            } else {
                // 방이 없다 = 서버가 재시작됐다. 플레이어 잘못이 아니니 그 층을 처음부터 다시 한다.
                launchRunFloor(socket, run);
                return;
            }
        }
        if (!run) { run = Rogue.newRun(Math.random); runs.set(nick, run); saveRun(nick, run); }
        socket.emit('runOffer', runOfferPayload(run, { start: run.augments.length === 0 && run.cleared === 0 }));
    });

    // 🍀 [증강 런] 증강 고르기 → 바로 다음 층 시작 (상점에서 "하나 더"를 샀으면 한 번 더 고른다)
    socket.on('runPick', (data) => {
        if (!socket.nickname) return;
        const nick = socket.nickname;
        const run = loadRun(nick);
        if (!run || run.phase !== 'pick') return;
        const cur = socket.currentRoom;
        if (cur && cur !== `🤖컴까기_${nick}` && rooms.has(cur) && rooms.get(cur).players[nick]) {
            socket.emit('challengeError', '먼저 지금 있는 방에서 나가세요.');
            return;
        }
        if (!Rogue.pick(run, data ? data.idx : undefined, Math.random)) return;   // 정수만 받는다 (Number(null) 이 0 이 되는 것 방지)
        if (run.phase === 'pick') { saveRun(nick, run); socket.emit('runOffer', runOfferPayload(run, { more: true })); return; }
        launchRunFloor(socket, run);
    });

    // 🍀 [증강 런] 증강 다시 뽑기 (런 하나에 정해진 횟수만 — 상점에서 늘릴 수 있다)
    socket.on('runReroll', () => {
        if (!socket.nickname) return;
        const run = loadRun(socket.nickname);
        if (!run || !Rogue.reroll(run, Math.random, !!run.afterBoss)) return;
        saveRun(socket.nickname, run);
        socket.emit('runOffer', runOfferPayload(run, { rerolled: true }));
    });

    // 🪙 [증강 런] 층 사이 상점 — 코인으로 산다
    socket.on('runBuy', (data) => {
        if (!socket.nickname) return;
        const run = loadRun(socket.nickname);
        const id = data && typeof data.id === 'string' ? data.id : '';
        if (!run || !Rogue.buy(run, id)) return;
        saveRun(socket.nickname, run);
        socket.emit('runOffer', runOfferPayload(run, { rerolled: true, boughtId: id }));
    });

    // 🍀 [증강 런] 증강 고르는 화면에서 그만두기 — 깬 층까지 정산
    socket.on('runAbandon', () => {
        if (!socket.nickname) return;
        const run = loadRun(socket.nickname);
        if (!run || run.phase !== 'pick') return;
        endRun(socket.nickname, run, socket);
    });

    // 🍀 [증강 런] 멀리건 — 프리플랍에서 아직 아무 행동도 안 했을 때 내 패를 새로 받는다
    socket.on('runMulligan', () => {
        if (!socket.nickname) return;
        const room = rooms.get(socket.currentRoom);
        const ch = room && room._challenge;
        if (!ch || !ch.run || ch.done || ch.nick !== socket.nickname) return;
        const p = room.players[socket.nickname];
        if (!p || ch.mullLeft <= 0 || room.gameStage !== 1 || p.isFolded || p.isAllIn || p.hasActed || p.hand.length !== 2 || room.deck.length < 12) return;
        p.hand = [room.deck.pop(), room.deck.pop()];
        ch.mullLeft -= 1;
        socket.emit('runBonus', { bonus: 0, notes: [{ id: 'mull', amount: 0 }] });
        room.sendState();
    });

    // 🤖 [컴까기 협동] 친구를 기다리는 방 만들기 — 방 목록·초대 링크로 들어온다(최대 4명)
    socket.on('createCoopChallenge', async () => {
        if (!socket.nickname) return;
        const nick = socket.nickname;
        const cur = socket.currentRoom;
        if (cur && rooms.has(cur) && rooms.get(cur).players[nick]) { socket.emit('challengeError', '먼저 지금 있는 방에서 나가세요.'); return; }
        const roomId = `🤖협동_${nick}`;
        if (rooms.has(roomId)) { try { destroyRoom(roomId); } catch (e) {} }
        const settings = { startingChips: Challenge.START_CHIPS, blindUpInterval: Challenge.BLIND_UP_MIN, turnTimeLimit: 30, mode: 'tournament', maxRebuys: 0 };
        const room = new GameRoom(roomId, settings);
        room._mttFreeChips = true;
        room._challenge = { coop: true, waiting: true, nick, stage: 0, done: false, members: [] };
        rooms.set(roomId, room);
        socket.join(roomId); socket.currentRoom = roomId; leaveLobby(socket);
        room.hostNickname = nick;
        await MockDB.getUser(nick);
        room.players[nick] = {
            id: nick, socketId: socket.id, chips: settings.startingChips,
            currentBet: 0, totalInvested: 0, isFolded: false, hasActed: false, role: '',
            isAllIn: false, isDisconnected: false, isMucked: false, isSpectator: false,
            hand: [], lastEmoteTime: 0, isBot: false, rebuysUsed: 0
        };
        room.playerOrder.push(nick);
        socket.emit('joinRoomSuccess', roomId);
        room.sendState();
        io.emit('roomList', roomListArray());
    });

    // 🤖 [컴까기 협동] 방장이 단계를 골라 시작
    socket.on('startCoopChallenge', (data) => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !room._challenge || !room._challenge.coop || !room._challenge.waiting) return;
        if (room.hostNickname !== socket.nickname) return;
        const ch = room._challenge;
        const stage = Number(data && data.stage);
        const humans = Object.keys(room.players).filter(n => !room.players[n].isBot && !room.players[n].isDisconnected);
        if (humans.length < 1 || humans.length > Challenge.COOP_MAX) return;
        const users = humans.map(n => MockDB.users.get(n)).filter(Boolean);
        if (users.length !== humans.length || !users.every(u => Challenge.canPlay(u, stage))) {
            socket.emit('challengeError', '없는 단계입니다.');
            return;
        }
        const setup = Challenge.coopSetup(stage, humans.length);
        const st = Challenge.STAGES[stage - 1];
        ch.stage = stage; ch.waiting = false; ch.done = false; ch.members = humans.slice();
        room.playerOrder = humans.slice();
        humans.forEach(n => { room.players[n].chips = room.startingChips; room.players[n].isSpectator = false; });
        setup.bots.forEach(d => room.addBot(d));
        room.playerOrder.forEach(n => { const bp = room.players[n]; if (bp && bp.isBot) bp.chips = Math.round(room.startingChips * setup.mult); });
        users.forEach(u => { const pr = Challenge.progressOf(u); u.challenge = { cleared: pr.cleared, best: pr.best, clears: pr.clears, tries: pr.tries + 1 }; });
        MockDB.save();
        const boss = stage === Challenge.STAGES.length;
        io.to(room.roomId).emit('challengeStarted', { stage, name: st.name, desc: st.desc, total: Challenge.STAGES.length, boss, coop: true,
            bots: room.playerOrder.filter(n => room.players[n].isBot) });
        room.sendState();
        io.emit('roomList', roomListArray());
        setTimeout(() => { if (rooms.get(room.roomId) === room && !ch.done && !ch.waiting) room.startNextHand(); }, boss ? 4600 : 3200);
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
        // 📏 스택 깊이 선택 (100 / 40 / 20 / 10bb). 100bb 가 아니면 매 핸드 그 깊이로 다시 채운다 —
        //    숏스택 판단(푸시/폴드·리쉬브)은 "그 깊이의 핸드"를 반복해야 익는다.
        const stackBB = [10, 20, 40, 100].includes(data && data.stackBB) ? data.stackBB : 100;
        const settings = { startingChips: stackBB * 100, blindUpInterval: 999999, turnTimeLimit: 60, mode: 'cash', cashBlind: 100 };
        const room = new GameRoom(roomId, settings);
        room._learnMode = true; // 🎓 학습 모드 플래그
        room._learnFixedStack = true;   // 🎓 학습은 칩을 따거나 잃지 않는다 — 매 핸드 전원이 고른 깊이로 다시 시작
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

    // 🗳️ 토너먼트 합의 종료 투표 — 제안 / 찬반 (투표자 자격은 방에서 검증)
    socket.on('proposeEndVote', () => {
        const room = rooms.get(socket.currentRoom);
        if (room && socket.nickname && room.players[socket.nickname]) room.proposeEndVote(socket.nickname);
    });
    socket.on('castEndVote', (data) => {
        const room = rooms.get(socket.currentRoom);
        if (room && socket.nickname) room.castEndVote(socket.nickname, !!(data && data.agree));
    });

    socket.on('startFirstHand', async () => {
        const room = rooms.get(socket.currentRoom);
        if (room && room._challenge) return; // 🤖 컴까기 방은 전용 시작 경로만 쓴다
        if (room && room.gameStage === 0 && !room.tournamentStarted) {
            if (room.hostNickname !== socket.nickname) return; // 💡 호스트 권한 검증
            const activeCount = room.playerOrder.filter(n => room.players[n] && !room.players[n].isDisconnected).length;
            if (activeCount < 2) {
                socket.emit('gameMessage', '🚨 혼자서는 토너먼트를 시작할 수 없습니다! (최소 2명 필요)');
                return;
            }
            // 💰 캐시가 아닌 토너먼트는 사람 참가자 전원의 뱅크롤이 바이인 이상이어야 시작
            if (room.mode !== 'cash') {
                for (const n of room.playerOrder) {
                    const p = room.players[n];
                    if (!p || p.isBot) continue;
                    const u = await MockDB.getUser(n);
                    if ((u.bankroll || 0) < room.startingChips) {
                        io.to(room.roomId).emit('gameMessage', `🚨 ${n} 님의 보유 칩이 바이인(${room.startingChips.toLocaleString()})보다 적어 시작할 수 없습니다!`);
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
        if (room._challenge) return; // 🤖 컴까기 방의 봇은 단계표가 정한다
        if (room.gameStage !== 0 || room.tournamentStarted) {
            socket.emit('gameMessage', '🤖 봇은 게임 시작 전 대기실에서만 추가할 수 있습니다!');
            return;
        }
        if (room.playerOrder.length >= 6) {
            socket.emit('gameMessage', '🚨 자리가 가득 찼습니다! (최대 6명)');
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

    // ⏳ [타임뱅크] 진짜 고민될 때 한 핸드에 딱 한 번, 15초를 더 쓴다.
    //    상용 포커앱의 표준 기능. 내 턴일 때만, 핸드당 1회.
    socket.on('useTimeBank', () => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname) return;
        if (room.gameStage < 1 || room.gameStage > 4) return;
        if (room.turnIndex === -1 || room.playerOrder[room.turnIndex] !== socket.nickname) return;
        const p = room.players[socket.nickname];
        if (!p || p.isFolded || p.isAllIn || p._tbUsed) return;
        p._tbUsed = true;
        room.extendTurn(TIME_BANK_MS);
        room.sendState();
    });

    // 🍅 [던지기] 상대 자리로 물건이 날아간다 — 한게임 포커류의 그 재미.
    //    실제 게임에는 아무 영향이 없는 순수 연출이라 검증은 "누구에게" 만 확인하면 된다.
    socket.on('throwItem', (data) => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname) return;
        const me = room.players[socket.nickname];
        if (!me) return;
        const now = Date.now();
        if (now - (me.lastThrowTime || 0) < 3000) return;
        const target = data && data.to;
        if (typeof target !== 'string' || target === socket.nickname || !room.players[target]) return;
        const item = THROW_ITEMS.includes(data && data.item) ? data.item : THROW_ITEMS[0];
        me.lastThrowTime = now;
        io.to(room.roomId).emit('itemThrown', { from: socket.nickname, to: target, item });
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

    // 🏁 [파이널나인 딥스택 연습] 20인 MTT 를 연다 — 친구들은 MTT 목록에서 들어오고, 시작하면 빈자리는 봇이 채운다
    socket.on('createFnMtt', (data) => {
        if (!socket.nickname || socket.currentRoom || socket._mttId) return;

        const mttId = 'mtt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const name = `🏁 파이널나인 딥스택 연습 (${socket.nickname})`;
        const mtt = new MTTManager(mttId, socket.nickname, { name, fn: true, tableSize: FN_MTT.tableSize, startingChips: FN_MTT.startingChips,
            blindUpInterval: Number(process.env.DEV_FN_LEVEL) || FN_MTT.blindUpInterval, maxEntrants: FN_MTT.entrants, structure: FN_MTT.structure, paid: FN_MTT.paid,
            rebuys: FN_MTT.rebuys, rebuyUntilLevel: FN_MTT.rebuyUntilLevel });
        mtts.set(mttId, mtt);
        mtt.addEntrant(socket.nickname, socket.id, false);
        socket._mttId = mttId;
        leaveLobby(socket);
        socket.emit('mttCreated', { mttId, name });
        mtt.broadcastLobby();
        io.emit('mttList', mttListArray());
    });
    // 🎞️ [대회 복기] 최근 연습 대회 목록 + 고른 대회의 판들(결정마다 권장 플레이·손실)
    socket.on('getFnReview', (data) => {
        if (!socket.nickname || !MockDB.users.has(socket.nickname)) return;
        const u = MockDB.users.get(socket.nickname), all = (u.fnReviews || []).slice().reverse();
        const meta = r => ({ id: r.id, t: r.t, place: r.place || null, played: r.played || 0, entrants: FN_MTT.entrants, shown: r.hands.length, skipped: r.skipped || 0, agreed: !!r.agreed,
            loss: Math.round(r.hands.reduce((a, h) => a + (h.loss || 0), 0) * 10) / 10, mistakes: r.hands.reduce((a, h) => a + h.d.filter(x => x.loss > 0).length, 0) });
        const cur = all.find(r => r.id === (data && data.id)) || all[0] || null;
        const kinds = {}; Blunder.KIND_KEYS.forEach(k => { kinds[k] = { name: Blunder.KINDS[k].name, tip: Blunder.KINDS[k].tip }; });
        socket.emit('fnReview', { list: all.map(meta), cur: cur ? Object.assign(meta(cur), { hands: cur.hands.map(h => Object.assign({}, h, { d: h.d.map(x => Object.assign({}, x, { why: Blunder.std(x.why) })) })) }) : null, kinds });
    });
    // 🏁 [파이널나인 연습 기록] 이 모드에서 친 것만 모은 점수·피드백·대회 결과 + 친구들 비교
    socket.on('getFnReport', () => {
        if (!socket.nickname || !MockDB.users.has(socket.nickname)) return;
        const u = MockDB.users.get(socket.nickname), F = u.fnStats || {};
        const dk = { d12: '12bb 이하', d25: '13~25bb', d40: '26~40bb', deep: '41bb 이상' }, pk = { early: '초반', mid: '중반', ft: '파이널 테이블', bubble: '버블(입상 직전)', itm: '입상권', hu: '마지막 1대1' };
        const per = (o, keys, n, l) => Object.keys(keys).map(k => ({ id: k, name: keys[k], n: o[n + k] || 0, per: o[n + k] > 0 ? Math.round((o[l + k] || 0) / o[n + k] * 100) / 100 : null })).filter(x => x.n > 0);
        const leaks = Blunder.KIND_KEYS.map(k => ({ name: Blunder.KINDS[k].name, tip: Blunder.KINDS[k].tip, n: F['lkN_' + k] || 0, bb: Math.round((F['lkB_' + k] || 0) * 10) / 10 })).filter(l => l.n > 0).sort((a, b) => b.bb - a.bb);
        const sum = x => ({ games: x.fnGames || 0, itm: x.fnItm || 0, wins: x.fnWins || 0, avgPlace: x.fnGames > 0 ? Math.round(x.fnPlaceSum / x.fnGames * 10) / 10 : null });
        const board = [];
        MockDB.users.forEach(x => {
            if (!x || !x.nickname || x.nickname.startsWith('🤖') || x.nickname === ADMIN_NICK || !x.fnStats) return;
            const ev = evView(x.fnStats), sm = sum(x.fnStats);
            if (!ev && !sm.games) return;
            board.push(Object.assign({ nick: x.nickname, me: x.nickname === socket.nickname, score: ev ? ev.score : null, pm: ev ? ev.pm : null, hands: ev ? ev.hands : 0, loss100: ev ? ev.raw100 : null }, sm));
        });
        board.sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score));
        socket.emit('fnReport', {
            cfg: { entrants: FN_MTT.entrants, startChips: FN_MTT.startingChips, startBB: FN_MTT.startingChips / FN_MTT.structure[0].bb, levelSec: FN_MTT.blindUpInterval,
                lv1: FN_MTT.structure[0].sb + '/' + FN_MTT.structure[0].bb, paid: FN_MTT.paid, tableSize: FN_MTT.tableSize, rebuys: FN_MTT.rebuys, rebuyUntilLevel: FN_MTT.rebuyUntilLevel, normalBots: FN_MTT.normalBots, anteLevel: 3 },
            ev: evView(F), summary: sum(F), results: (u.fnResults || []).slice(-20).reverse(),
            depth: per(F, dk, 'evDn_', 'evDl_'), phases: per(F, pk, 'evTn_', 'evTl_'),
            icm: { n: F.evIn || 0, ok: F.evIk || 0, loss: Math.round((F.evIl || 0) * 10) / 10, payouts: Icm.payoutsFor(FN_MTT.paid) },
            freqs: Freqs.summarize(F), leaks, blunders: Blunder.top(F.blunders, 0, 5).map(Blunder.describe),
            stats: { vpip: F.preflopOpps > 0 ? Math.round((F.vpipHands || 0) / F.preflopOpps * 100) : null, pfr: F.preflopOpps > 0 ? Math.round((F.pfrHands || 0) / F.preflopOpps * 100) : null, hands: F.handsPlayed || 0 },
            board
        });
    });

    // 🎨 [상점] 카탈로그 + 내 보유/장착 상태
    function shopPayload(u) {
        const c = normalizeCosmetics(u);
        const myRank = rankIndexOf(u);
        return {
            items: Object.entries(COSMETICS).map(([id, it]) => ({
                id, kind: it.kind, name: it.name, price: it.price, cur: it.cur || 'token',
                desc: it.desc || '', text: it.text || '',
                noBuy: !!it.noBuy,
                // 🏅 테두리는 등급으로 열린다 — 잠겨 있으면 무엇이 필요한지 같이 보낸다
                locked: it.kind === 'frame' ? (it.rank > myRank) : (it.photo ? !hasPhoto(u) : (it.challenge ? !c.owned.includes(id) : false)),
                need: it.kind === 'frame' ? rankNeedText(it.rank) : (it.photo ? '사진을 올리면 열립니다' : (it.challenge ? '컴까기 보스전(10단계)을 깨면 열립니다' : ''))
            })),
            owned: c.owned.slice(),
            equipped: { back: c.back, avatar: c.avatar, title: c.title, frame: c.frame },
            bankroll: u.bankroll || 0,
            tokens: u.tokens || 0, // 🏆 우승 토큰
            cores: u.cores || 0,   // 🔷 컴까기 코어
            // 🏅 내 등급 현황 (다음 등급까지 얼마나 남았는지 보여주려고)
            rank: {
                idx: myRank, name: RANKS[myRank].name,
                wins: u.wins || 0, peak: u.peakBankroll || 0,
                next: myRank + 1 < RANKS.length
                    ? { name: RANKS[myRank + 1].name, wins: RANKS[myRank + 1].wins, peak: RANKS[myRank + 1].peak }
                    : null
            },
            hasPhoto: hasPhoto(u),
            photoVer: hasPhoto(u) ? u.photo.ver : 0
        };
    }
    socket.on('getShop', async () => {
        if (!socket.nickname || !MockDB.users.has(socket.nickname)) return;
        socket.emit('shopData', shopPayload(MockDB.users.get(socket.nickname)));
    });

    // 🎨 구매 — 뱅크롤에서 차감한다. 이미 가진 것/모르는 id/잔액 부족은 전부 거절.
    socket.on('buyCosmetic', async (data) => {
        if (!socket.nickname || !MockDB.users.has(socket.nickname)) return;
        const u = MockDB.users.get(socket.nickname);
        const c = normalizeCosmetics(u);
        const id = data && data.id;
        const item = cosItem(id);
        if (!item) { socket.emit('shopResult', { ok: false, msg: '없는 아이템입니다.' }); return; }
        // 🏅 테두리는 등급으로만, 📷 사진은 업로드로만 — 돈으로 사는 물건이 아니다
        if (item.noBuy) { socket.emit('shopResult', { ok: false, msg: '이건 돈으로 살 수 있는 게 아닙니다.' }); return; }
        if (c.owned.includes(id)) { socket.emit('shopResult', { ok: false, msg: '이미 가지고 있습니다.' }); return; }
        if (item.cur === 'core') {
            // 🔷 컴까기 전용 아이템은 코어로만 — 토큰이나 뱅크롤로는 못 산다
            if ((u.cores || 0) < item.price) {
                socket.emit('shopResult', { ok: false, msg: `코어가 ${item.price - (u.cores || 0)}개 모자랍니다. 컴까기 단계를 깨면 받습니다.` });
                return;
            }
            u.cores = (u.cores || 0) - item.price;
        } else {
            if ((u.tokens || 0) < item.price) {
                socket.emit('shopResult', { ok: false, msg: `토큰이 ${item.price - (u.tokens || 0)}개 모자랍니다. 사람 ${TOKEN_MIN_HUMANS}명 이상 토너먼트에서 우승하면 1개씩 받습니다.` });
                return;
            }
            u.tokens = (u.tokens || 0) - item.price; // 🏆 토큰으로만 산다 — 뱅크롤은 건드리지 않는다
        }
        c.owned.push(id);
        c[item.kind] = id; // 산 건 바로 장착
        MockDB.save();
        socket.emit('shopResult', { ok: true, msg: `${item.name} 구매 완료! 바로 장착했습니다.` });
        socket.emit('shopData', shopPayload(u));
        const room = rooms.get(socket.currentRoom);
        if (room) room.sendState();
    });

    // 📷 [프로필 사진] 클라이언트가 캔버스로 128px 까지 줄여서 data URL 로 보낸다.
    //    ⚠️ 확장자나 MIME 문자열은 믿지 않는다 — 실제 바이트 앞머리(매직바이트)로 이미지인지 확인한다.
    //       그래야 HTML/SVG 같은 걸 이미지인 척 올려 /avatar 로 되받는 길이 막힌다.
    socket.on('uploadAvatar', (data) => {
        if (!socket.nickname || !MockDB.users.has(socket.nickname)) return;
        const fail = msg => socket.emit('shopResult', { ok: false, msg });
        const now = Date.now();
        if (now - (photoRate.get(socket.nickname) || 0) < 5000) { fail('조금 있다 다시 올리세요.'); return; }

        const raw = data && data.data;
        if (typeof raw !== 'string' || raw.length > PHOTO_MAX_B64) { fail('사진이 너무 큽니다.'); return; }
        const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
        if (!m) { fail('사진 형식을 못 읽겠습니다.'); return; }
        let buf;
        try { buf = Buffer.from(m[1], 'base64'); } catch (e) { fail('사진을 못 읽겠습니다.'); return; }
        if (!buf.length || buf.length > PHOTO_MAX_BYTES) { fail('사진이 너무 큽니다.'); return; }

        const isJpg = buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
        const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
        const isWebp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
        const mime = isJpg ? 'image/jpeg' : isPng ? 'image/png' : isWebp ? 'image/webp' : null;
        if (!mime) { fail('이미지 파일이 아닙니다.'); return; }

        const u = MockDB.users.get(socket.nickname);
        photoRate.set(socket.nickname, now);
        u.photo = { b64: buf.toString('base64'), mime, ver: ((u.photo && u.photo.ver) || 0) + 1 };
        const c = normalizeCosmetics(u);
        if (!c.owned.includes('av_photo')) c.owned.push('av_photo');
        c.avatar = 'av_photo'; // 올렸으면 바로 쓴다
        MockDB.save();
        socket.emit('shopResult', { ok: true, msg: '프로필 사진을 바꿨습니다!' });
        socket.emit('shopData', shopPayload(u));
        const room = rooms.get(socket.currentRoom);
        if (room) room.sendState();
    });

    socket.on('removeAvatarPhoto', () => {
        if (!socket.nickname || !MockDB.users.has(socket.nickname)) return;
        const u = MockDB.users.get(socket.nickname);
        u.photo = null;
        const c = normalizeCosmetics(u);
        c.owned = c.owned.filter(id => id !== 'av_photo');
        if (c.avatar === 'av_photo') c.avatar = 'av_none';
        MockDB.save();
        socket.emit('shopResult', { ok: true, msg: '사진을 내렸습니다.' });
        socket.emit('shopData', shopPayload(u));
        const room = rooms.get(socket.currentRoom);
        if (room) room.sendState();
    });

    // 🎨 장착 변경 — 보유한 것만 가능
    socket.on('equipCosmetic', (data) => {
        if (!socket.nickname || !MockDB.users.has(socket.nickname)) return;
        const u = MockDB.users.get(socket.nickname);
        const c = normalizeCosmetics(u);
        const id = data && data.id;
        const item = cosItem(id);
        if (!item) { socket.emit('shopResult', { ok: false, msg: '없는 아이템입니다.' }); return; }
        if (item.kind === 'frame') {
            // 🏅 테두리는 owned 가 아니라 등급으로 판정한다
            if (item.rank > rankIndexOf(u)) {
                socket.emit('shopResult', { ok: false, msg: `아직 못 답니다 — ${rankNeedText(item.rank)}` });
                return;
            }
            c.frame = id;
            c.frameAuto = false; // 직접 골랐으니 이제 자동으로 안 바꾼다
        } else if (item.photo) {
            if (!hasPhoto(u)) { socket.emit('shopResult', { ok: false, msg: '먼저 사진을 올리세요.' }); return; }
            c.avatar = id;
        } else {
            if (!c.owned.includes(id)) { socket.emit('shopResult', { ok: false, msg: '아직 가지고 있지 않습니다.' }); return; }
            c[item.kind] = id;
        }
        MockDB.save();
        socket.emit('shopData', shopPayload(u));
        const room = rooms.get(socket.currentRoom);
        if (room) room.sendState();
    });

    // 🃏 폴드한 사람이 자기 패를 보여주기로 선택 (한 장만도 가능 — 블러프 자랑용)
    //    실제 공개는 핸드가 끝난 뒤(gameStage 5)에 일어난다. sendState 가 그때만 깐다.
    socket.on('showFoldedCards', (data) => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname) return;
        const p = room.players[socket.nickname];
        if (!p || !p.isFolded) return;                       // 죽은 사람만
        if (!p.hand || p.hand.length !== 2) return;
        if (room.gameStage < 1 || room.gameStage > 5) return; // 이번 핸드 안에서만

        const which = data && data.which;
        let rc;
        if (which === 0) rc = [true, false];
        else if (which === 1) rc = [false, true];
        else if (which === 'both') rc = [true, true];
        else if (which === 'none') rc = null;
        else return;

        p._revealCards = rc;
        if (rc && room.gameStage === 5) {
            const shown = [rc[0] ? p.hand[0] : null, rc[1] ? p.hand[1] : null].filter(Boolean);
            io.to(room.roomId).emit('gameMessage', `🃏 ${socket.nickname} 님이 죽은 패를 공개했습니다 (${shown.length}장).`);
        }
        room.sendState();
    });

    // 👀 관전자가 자리에 앉겠다고 할 때
    socket.on('takeSeat', () => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname) return;
        const nick = socket.nickname;
        const p = room.players[nick];
        if (!p) return;
        if (!p.isSpectator && (p.chips || 0) > 0) return;           // 이미 앉아 있음

        // 자리 확인 (클라이언트 좌석 레이아웃과 동일한 정원)
        const withChips = Object.keys(room.players).filter(n => (room.players[n].chips || 0) > 0).length;
        if (withChips >= TABLE_SEATS) {
            socket.emit('gameMessage', '🪑 자리가 가득 찼습니다 — 자리가 나면 앉을 수 있어요.');
            return;
        }
        // 진행 중인 토너먼트에는 중간 합류 불가 (공정성)
        if (room.mode !== 'cash' && room.tournamentStarted) {
            socket.emit('gameMessage', '🏆 토너먼트 진행 중에는 합류할 수 없습니다 — 끝나면 자동으로 참여됩니다.');
            return;
        }

        p._wantSpectate = false;
        p._fullRoomSpectator = false;
        p.isSpectator = false;
        p.chips = room.startingChips;
        if (room.mode === 'cash') {
            // 💵 캐시는 바이인 — 뱅크롤에서 차감하고 본인 화면에 반영
            MockDB.recordCashNet(nick, -room.startingChips);
            MockDB.adjustBankroll(nick, -room.startingChips).then(nb => socket.emit('bankrollUpdate', { bankroll: nb || 0 }));
        }
        io.to(room.roomId).emit('gameMessage', `🪑 ${nick} 님이 관전석에서 자리에 앉았습니다.`);
        if (room.gameStage === 0 && !room.playerOrder.includes(nick)) room.playerOrder.push(nick);
        else if (room.gameStage !== 0) socket.emit('gameMessage', '🪑 다음 핸드부터 플레이합니다.');
        room.sendState();
        if (room.mode === 'cash') room.tryAutoResume();
        io.to('lobby').emit('roomList', roomListArray());
    });

    // 👀 자리에 앉아 있다가 관전으로 돌아가기 (칩은 정산)
    socket.on('goSpectate', () => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname) return;
        const p = room.players[socket.nickname];
        if (!p || p.isSpectator) return;
        if (room.mode !== 'cash') { socket.emit('gameMessage', '🏆 토너먼트에선 중간에 관전으로 바꿀 수 없습니다.'); return; }
        if (room.gameStage >= 1 && room.gameStage <= 4 && !p.isFolded && ((p.totalInvested || 0) > 0 || p.isAllIn)) {
            socket.emit('gameMessage', '🚨 이번 핸드가 끝난 뒤에 관전으로 바꿀 수 있습니다.');
            return;
        }
        const back = room._learnMode ? 0 : (p.chips || 0);
        if (back > 0) {
            MockDB.recordCashNet(socket.nickname, back);
            MockDB.adjustBankroll(socket.nickname, back).then(nb => socket.emit('bankrollUpdate', { bankroll: nb || 0 }));
        }
        p.chips = 0;
        p.isSpectator = true;
        p._wantSpectate = true;
        room.playerOrder = room.playerOrder.filter(n => n !== socket.nickname);
        io.to(room.roomId).emit('gameMessage', `👀 ${socket.nickname} 님이 ${back.toLocaleString()} 칩을 정산하고 관전으로 돌아갔습니다.`);
        room.sendState();
    });

    // 🃏 진 사람이 자기 패를 공개하기로 선택 (앞순서·승자는 애초에 선택지가 없다)
    socket.on('revealHand', () => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname) return;
        const p = room.players[socket.nickname];
        if (!p || !p._muckChoice) return;                       // 선택 권한 없음
        if (room.gameStage !== 5) return;                       // 쇼다운 중에만
        if (Date.now() > (room._muckDeadline || 0) + 1500) return; // 시간 초과
        p._muckChoice = false;
        p.isMucked = false;
        io.to(room.roomId).emit('gameMessage', `🃏 ${socket.nickname} 님이 패를 공개했습니다.`);
        room.sendState();
    });

    // 🃏 그냥 접겠다 (기본값과 같지만 선택창을 즉시 닫기 위해)
    socket.on('muckHand', () => {
        const room = rooms.get(socket.currentRoom);
        if (!room || !socket.nickname) return;
        const p = room.players[socket.nickname];
        if (!p || !p._muckChoice) return;
        p._muckChoice = false;
        p.isMucked = true;
        room.sendState();
    });

    // 🏆 [MTT] 참가
    socket.on('joinMtt', (data) => {
        if (!socket.nickname || socket.currentRoom) return;
        const mtt = mtts.get(data && data.mttId);
        if (!mtt || mtt.started) { socket.emit('gameMessage', '🚫 이미 시작했거나 없는 토너먼트입니다.'); return; }
        if (mtt.entrants.length >= mtt.maxEntrants) { socket.emit('gameMessage', '🚫 정원이 가득 찼습니다.'); return; }
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
        if (mtt.entrants.length >= mtt.maxEntrants) { socket.emit('gameMessage', '🚫 정원이 가득 찼습니다.'); return; }
        mtt.addBot();
        io.emit('mttList', mttListArray());
    });

    // 🏆 [MTT] 시작 (호스트)
    socket.on('startMtt', () => {
        const mtt = mtts.get(socket._mttId);
        if (!mtt || mtt.hostNick !== socket.nickname || mtt.started) return;
        // 🏁 파이널나인 연습은 빈자리를 봇으로 채워 항상 20명으로 시작한다
        if (mtt.fn) {
            let guard = 0; while (mtt.entrants.length < mtt.maxEntrants && guard++ < 40) mtt.addBot();
            // 상대 구성: 봇 가운데 중수 3명, 나머지는 전부 고수 (운영자 지정)
            const bots = mtt.entrants.filter(e => e.isBot).map(e => e.nick);
            for (let i = bots.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bots[i], bots[j]] = [bots[j], bots[i]]; }
            bots.forEach((n, i) => { mtt.botLevel[n] = i < FN_MTT.normalBots ? 'normal' : 'hard'; });
        }
        if (mtt.entrants.length < 2) { socket.emit('gameMessage', '🚫 최소 2명 필요합니다.'); return; }
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


    // 💰 뱅크롤 조회 (로비 표시 갱신)
    socket.on('getBankroll', async () => {
        if (!socket.nickname) return;
        // 💸 [#1] 방에 없을 때(로비) 뱅크롤 0이면 무료 충전
        if (!socket.currentRoom) {
            const refill = await MockDB.refillIfBroke(socket.nickname, 0, 10000);
            if (refill.refilled) {
                socket.emit('gameMessage', '💸 뱅크롤이 바닥나 무료 보너스 10,000 칩을 받았습니다!');
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
        const _pc = normalizeCosmetics(u);
        const _ri = rankIndexOf(u);
        // ⚔️ "나와의" 전적 — 보는 사람 기준으로 뒤집어 보여준다
        const _rec = (u.h2h && u.h2h[socket.nickname]) || null;
        socket.emit('profileData', {
            rank: { idx: _ri, name: RANKS[_ri].name, peak: u.peakBankroll || 0 }, // 🏅 등급
            photoVer: hasPhoto(u) ? u.photo.ver : 0,                               // 📷 프로필 사진
            // u.h2h[나] 는 "이 사람이 나를 상대로" 낸 성적 → 내 기준으로는 승패를 바꿔 읽는다
            h2h: (u.nickname !== socket.nickname && _rec) ? { myWins: _rec.l || 0, myLosses: _rec.w || 0 } : null,
            cosmetics: { back: _pc.back, avatar: _pc.avatar, title: cosTitleText(_pc.title) }, // 🎨 꾸미기
            nickname: u.nickname,
            wins: u.wins || 0,
            handsPlayed: hp,
            handsWon: u.handsWon || 0,
            vpipHands: u.vpipHands || 0,
            biggestPot: u.biggestPot || 0,
            seasonPoints: (u.seasonId === CURRENT_SEASON) ? (u.seasonPoints || 0) : 0,
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
                gto: gtoAvg(u.gtoScoreSum || 0, u.gtoW || 0, u.gtoScoreCount || 0), // GTO 근접도
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
        if (res && res.claimed) socket.emit('bankrollUpdate', { bankroll: res.bankroll || 0 });
    });
    socket.on('claimMission', async (data) => {
        if (!socket.nickname || !data || !data.id) return;
        const res = await MockDB.claimMission(socket.nickname, data.id);
        socket.emit('missionResult', { id: data.id, ...res });
        if (res.ok) {
            socket.emit('bankrollUpdate', { bankroll: res.bankroll || 0 });
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

        let handsPlayed, handsWon, pfOpps, vpipH, pfrH, tbCount, tbOpps, aggrBets, aggrCalls, foldToBet, faceBet, wtsd, wsd, gtoSum, gtoCnt, gtoWt = 0;
        let metaTop = {};
        let since = 0, src = u, blSrc = u.blunders, seatSum = 0, seatCnt = 0;
        let evSrc = null;      // 📉 EV 손실 집계의 출처(범위별)
        const leaks = {};
        const leakFrom = get => Blunder.KIND_KEYS.forEach(k => { const n = get('lkN_' + k) || 0; if (n > 0) leaks[k] = { n, bb: Math.round((get('lkB_' + k) || 0) * 10) / 10 }; });

        if (range === 'learn') {
            // 🎓 학습 모드 누적 통계 (실전과 분리)
            const L = u.learnStats || {};
            handsPlayed = L.handsPlayed || 0; handsWon = L.handsWon || 0; pfOpps = L.preflopOpps || 0;
            vpipH = L.vpipHands || 0; pfrH = L.pfrHands || 0; tbCount = L.threeBetCount || 0; tbOpps = L.threeBetOpps || 0;
            aggrBets = L.aggrBets || 0; aggrCalls = L.aggrCalls || 0; foldToBet = L.foldToBet || 0; faceBet = L.faceBet || 0;
            wtsd = L.wentToShowdown || 0; wsd = L.wonAtShowdown || 0; gtoSum = L.gtoScoreSum || 0; gtoCnt = L.gtoScoreCount || 0; gtoWt = L.gtoW || 0;
            metaTop = { durationMin: null, bankrollStart: null, bankrollDelta: null, tourneyWins: null, seasonPointsGained: null, newAchievements: [] };
            blSrc = L.blunders; seatSum = L.seatSum || 0; seatCnt = L.seatCnt || 0;
            leakFrom(k => L[k]);
            evSrc = L;
        } else if (range === 'session') {
            const snap = sessionSnapshots.get(socket.nickname);
            if (!snap) { socket.emit('sessionReport', null); return; }
            const d = (k) => Math.max(0, (u[k] || 0) - (snap[k] || 0));
            handsPlayed = d('handsPlayed'); handsWon = d('handsWon'); pfOpps = d('preflopOpps');
            vpipH = d('vpipHands'); pfrH = d('pfrHands'); tbCount = d('threeBetCount'); tbOpps = d('threeBetOpps');
            aggrBets = d('aggrBets'); aggrCalls = d('aggrCalls'); foldToBet = d('foldToBet'); faceBet = d('faceBet');
            wtsd = d('wentToShowdown'); wsd = d('wonAtShowdown'); gtoSum = d('gtoScoreSum'); gtoCnt = d('gtoScoreCount'); gtoWt = d('gtoW');
            since = snap.ts; seatSum = d('seatSum'); seatCnt = d('seatCnt');
            leakFrom(k => (u[k] || 0) - (snap[k] || 0));
            evSrc = {}; Object.keys(u).filter(k => k.startsWith('ev') || k.startsWith('fq')).forEach(k => { evSrc[k] = (u[k] || 0) - (snap[k] || 0); });
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
            wtsd = agg.wentToShowdown; wsd = agg.wonAtShowdown; gtoSum = agg.gtoScoreSum; gtoCnt = agg.gtoScoreCount; gtoWt = agg.gtoW || 0;
            { const now = new Date(); since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime(); }
            seatSum = agg.seatSum || 0; seatCnt = agg.seatCnt || 0;
            leakFrom(k => agg[k]);
            evSrc = agg;
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
                gto: gtoAvg(gtoSum, gtoWt, gtoCnt),
                sampleActions: gtoCnt
            }
        };
        // 💥 가장 치명적이었던 플레이 (손실 어림값이 큰 순) + 실수 유형별 합계
        report.blunders = Blunder.top(blSrc, since, 3).map(Blunder.describe);
        report.leaks = Object.keys(leaks).map(k => ({ kind: k, name: Blunder.KINDS[k].name, tip: Blunder.KINDS[k].tip, n: leaks[k].n, bb: leaks[k].bb }))
            .sort((a, b) => b.bb - a.bb);
        report.avgSeats = seatCnt >= 5 ? Math.round(seatSum / seatCnt * 10) / 10 : null;
        report.ev = evView(evSrc);     // 📉 실력 점수(EV 손실 기준) · 오차 · 등급 분포 · 운을 뺀 결과
        report.freqs = Freqs.summarize(evSrc);      // 📊 상황별 빈도 비교
        report.coaching = buildCoaching(report.stats, handsPlayed, { avgSeats: report.avgSeats, leaks: report.leaks, decisions: gtoCnt });
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

    socket.on('leaveQueue', () => { if (capacity.leave(socket.id)) drainCapacity(); });
    socket.on('disconnect', () => {
        // 🚦 줄 서 있던 사람이면 줄에서 빼고, 접속해 있던 사람이면 그 자리를 다음 사람에게 준다
        capacity.leave(socket.id);
        setTimeout(drainCapacity, 100);
        try {
            // 📋 [접속 기록] 머문 시간까지 남긴다
            if (socket.nickname) {
                const mins = socket._loginAt ? Math.round((Date.now() - socket._loginAt) / 60000) : null;
                accessLog.push({
                    type: 'logout', nick: socket.nickname, ip: socket._ip || socketIp(socket),
                    detail: mins === null ? '' : `${mins}분 머무름`
                });
                const _u = MockDB.users.get(socket.nickname);
                if (_u) _u.lastSeen = Date.now();
            }
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

// 🛡️ 관리자 페이지 — MockDB·rooms·io 가 다 만들어진 뒤에 붙인다(위에서 붙이면 참조가 비어 있다)
try {
    adminRouter = require('./admin')({ accessLog, MockDB, rooms, io, adminNick: ADMIN_NICK, verify: verifyAdmin, capacity, onlineNicks, drainCapacity });
    app.use('/admin', adminRouter);
} catch (e) {
    console.error('🛡️ [관리자] 마운트 실패(게임에는 영향 없음):', e && e.message);
}

// 🎉 파티 나이트 — 포커(기본 네임스페이스)와 분리된 /party 모듈 마운트
try {
    require('./lib/party/engine')(io, app);
} catch (e) {
    console.error('🎉 [파티 나이트] 마운트 실패(포커에는 영향 없음):', e && e.message);
}

const PORT = process.env.PORT || 3000;
// 🌐 원격 DB(Turso)가 설정된 경우 부팅 시 원격 데이터를 먼저 로드한 뒤 리슨
//    (재배포 직후 빈 로컬 상태로 로그인 받다가 원격 데이터로 뒤늦게 덮어쓰는 레이스 방지)
//    원격 미설정이면 initRemote()는 즉시 반환 — 기존 동작 그대로.
MockDB.initRemote().catch(e => console.error('🌐 원격 초기화 오류:', e && e.message)).finally(() => {
    try { MockDB.purgeCheckAccounts(); MockDB.applyStatsEpoch(); MockDB.migrateEvNorm(); } catch (e) { console.error('통계 기점 적용 오류:', e && e.message); }
    server.listen(PORT, () => {
        console.log(`✅ [Master Server] 치명 버그 수정 + 보안 패치 + 방 정리 시스템 적용 완료! (포트 ${PORT})`);
    });
});

// 🛡️ [안정성] 주기적 자동저장 (디바운스가 놓친 변경분까지 60초마다 안전 저장)
setInterval(() => { try { MockDB.flush(); } catch (e) {} }, 60000);
process.on('exit', () => { try { flushAccessLog(); } catch (e) {} });

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
    // 🌐 원격(Turso) 저장까지 완료 대기(최대 3초) 후 종료 — Render 재배포 시 마지막 변경 보존
    try { flushAccessLog(); } catch (e) {}
    Promise.all([MockDB.flushRemoteNow(3000).catch(() => {}), flushAccessRemoteNow(2500).catch(() => {})]).finally(() => {
        try { server.close(() => { console.log('✅ 안전하게 종료되었습니다.'); process.exit(0); }); } catch (e) { process.exit(0); }
    });
    // 소켓이 안 닫혀 hang되는 경우 대비 강제 종료 타임아웃
    setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));