// 📊 프리플랍 범위표 — "레이즈를 받았을 때" 패마다 3벳 몇 % · 콜 몇 % · 폴드 몇 %.
//   예전엔 169개 패를 핸드 점수 한 줄로 세워 놓고 문턱만 옮겼다. 그러면 3벳이 "강한 순"으로만 나와서
//   솔버가 쓰는 블러프 3벳(A5s 처럼 에이스를 막고 뒤집을 길이 있는 패)이 빠지고, 수딧 커넥터와 오프수트 브로드웨이가 같은 취급을 받았다.
//   여기서는 상황마다 범위를 직접 적는다(6인 100bb, 2.5bb 오픈 기준 · 공개된 솔버 범위의 근사 — 폭은 test/ranges.test.js 에서 검사).
//
//   표기: 'QQ+' 'JJ-77' 'A2s+' 'K9s+' 'A5s-A2s' 'T9s' 'AJo+' 'KQo' — 뒤에 ':50' 을 붙이면 그 빈도(%)로 섞는다.
//         r = 레이즈(3벳·4벳) 범위, c = 콜 범위. 한 패가 양쪽에 있으면 레이즈 몫을 먼저 채우고 남은 만큼을 콜 몫으로 쓴다.
const RK = '23456789TJQKA';
const ri = c => RK.indexOf(c);

const ALL = [];
for (let a = 12; a >= 0; a--) for (let b = a; b >= 0; b--) {
    if (a === b) ALL.push(RK[a] + RK[b]);
    else { ALL.push(RK[a] + RK[b] + 's'); ALL.push(RK[a] + RK[b] + 'o'); }
}
const combos = code => code.length === 2 ? 6 : (code[2] === 's' ? 4 : 12);

// 표기 한 토막 → 패 코드 목록
function expand(tok) {
    const out = [];
    const m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so]?)(\+|-([2-9TJQKA])([2-9TJQKA])[so]?)?$/);
    if (!m) throw new Error('범위 표기를 읽을 수 없습니다: ' + tok);
    const hi = ri(m[1]), lo = ri(m[2]), suf = m[3], plus = m[4] === '+', dash = m[4] && m[4][0] === '-';
    if (hi === lo) {                       // 페어
        const top = plus ? 12 : hi, bot = dash ? ri(m[5]) : hi;
        for (let r = Math.max(top, bot); r >= Math.min(top, bot); r--) out.push(RK[r] + RK[r]);
        return out;
    }
    if (!suf) throw new Error('수딧(s)/오프수트(o)를 적어야 합니다: ' + tok);
    let from = lo, to = lo;
    if (plus) to = hi - 1;                 // A2s+ = A2s..AKs
    else if (dash) to = ri(m[6]);          // A5s-A2s
    for (let r = Math.max(from, to); r >= Math.min(from, to); r--) out.push(m[1] + RK[r] + suf);
    return out;
}
function parse(str) {
    const map = {};
    String(str || '').split(',').map(s => s.trim()).filter(Boolean).forEach(tok => {
        const [body, w] = tok.split(':');
        const pct = w == null ? 100 : Number(w);
        expand(body).forEach(code => { map[code] = pct; });
    });
    return map;
}
// { r, c } 표기 → 패마다 { raise, call, fold } (%)
function build(def) {
    const R = parse(def.r), C = parse(def.c), out = {};
    ALL.forEach(code => {
        const raise = Math.min(100, R[code] || 0);
        const call = Math.min(100 - raise, C[code] || 0);
        if (raise > 0 || call > 0) out[code] = { raise, call, fold: 100 - raise - call };
    });
    return out;
}
const FOLD = Object.freeze({ raise: 0, call: 0, fold: 100 });

// ───────── 오픈을 받을 때 ─────────
// BB: 이미 1bb 를 냈고 뒤에 아무도 없어 가장 넓게 지킨다. 3벳은 밸류(QQ+·AK) + 블러프(A5s-A2s·수딧 커넥터 일부)로 양쪽 끝에서 고른다.
const BB_VS = {
    UTG: { r: 'QQ+,AKs,AKo:70,JJ:50,TT:20,AQs:55,AJs:25,A5s:85,A4s:65,A3s:35,KQs:40,KJs:20,87s:20,76s:35,65s:40,54s:35',
           c: 'JJ-22,A2s+,K5s+,Q7s+,J8s+,T7s+,96s+,85s+,74s+,64s+,53s+,43s,ATo+,KTo+,QJo,QTo:40,JTo:60,A9o:30' },
    HJ:  { r: 'QQ+,AKs,AKo:85,JJ:65,TT:35,AQs:70,AJs:40,ATs:20,A5s:90,A4s:70,A3s:50,A2s:30,KQs:55,KJs:35,KTs:20,QJs:25,AQo:25,K5s:25,87s:35,76s:45,65s:45,54s:45',
           c: 'JJ-22,A2s+,K3s+,Q6s+,J6s+,T7s+,96s+,85s+,74s+,63s+,53s+,43s,A8o+,A5o:40,K9o+,Q9o+,J9o+,T9o,98o:40,K8o:30' },
    CO:  { r: 'JJ+,AKs,AKo,TT:65,99:25,AQs:85,AJs:60,ATs:40,A9s:20,A5s,A4s:85,A3s:65,A2s:50,KQs:70,KJs:50,KTs:35,K9s:20,QJs:45,QTs:20,JTs:35,AQo:55,AJo:20,KQo:25,K5s:40,K4s:25,T9s:25,98s:30,87s:45,76s:50,65s:50,54s:50',
           c: 'TT-22,A2s+,K2s+,Q4s+,J5s+,T6s+,95s+,85s+,74s+,63s+,53s+,43s,A4o+,A3o:50,K8o+,Q9o+,J9o+,T8o+,98o,87o:60,K7o:40,Q8o:60,J8o:50,76o:30' },
    BTN: { r: 'TT+,AKs,AKo,99:60,88:30,AQs,AJs:80,ATs:60,A9s:40,A8s:25,A5s,A4s,A3s:80,A2s:70,KQs:85,KJs:70,KTs:50,K9s:40,QJs:60,QTs:40,JTs:50,AQo:85,AJo:50,ATo:20,KQo:55,KJo:20,K6s:40,K5s:50,K4s:35,Q9s:35,Q8s:20,J9s:35,T9s:40,T8s:20,98s:40,87s:50,76s:55,65s:55,54s:55,A8o:20,A5o:25,K9o:20,QJo:15',
           c: '99-22,A2s+,K2s+,Q2s+,J4s+,T5s+,95s+,84s+,74s+,63s+,52s+,42s+,32s,A2o+,K7o+,Q8o+,J8o+,T8o+,97o+,87o,76o:70,65o:40,K6o:60,K5o:30,Q7o:30' },
    SB:  { r: 'TT+,AKs,AKo,99:70,88:45,77:25,AQs,AJs,ATs:80,A9s:55,A8s:35,A5s,A4s,A3s:90,A2s:80,KQs,KJs:85,KTs:70,K9s:50,QJs:75,QTs:55,JTs:65,AQo,AJo:75,ATo:40,KQo:75,KJo:40,K6s:40,K5s:55,K4s:45,Q9s:45,Q8s:25,J9s:45,T9s:50,T8s:30,98s:50,87s:55,76s:60,65s:60,54s:60,A9o:20,A8o:30,A5o:35,A4o:20,K9o:30,QJo:30,JTo:20',
           c: '99-22,A2s+,K2s+,Q2s+,J3s+,T4s+,94s+,84s+,73s+,63s+,52s+,42s+,32s,A2o+,K5o+,Q7o+,J7o+,T7o+,97o+,86o+,76o,65o:70,54o:40,K4o:50,Q6o:40' }
};
// SB: 콜하면 포지션 없이 BB 의 스퀴즈까지 받는다 → 계속할 패는 전부 3벳(콜 없음)
const SB_VS = {
    UTG: { r: 'QQ+,AKs,AKo,JJ,TT:55,99:20,AQs,AJs:60,ATs:25,KQs:70,KJs:30,A5s:85,A4s:55,76s:20,65s:20', c: '' },
    HJ:  { r: 'JJ+,AKs,AKo,TT:80,99:45,88:20,AQs,AJs:85,ATs:50,KQs:90,KJs:55,KTs:25,QJs:35,AQo:45,A5s,A4s:70,A3s:30,76s:30,65s:30', c: '' },
    CO:  { r: 'TT+,AKs,AKo,99:80,88:50,77:25,AQs,AJs,ATs:85,A9s:45,A8s:25,KQs,KJs:90,KTs:60,K9s:25,QJs:70,QTs:35,JTs:55,T9s:25,AQo,AJo:50,KQo:45,A5s,A4s,A3s:60,A2s:35,87s:25,76s:40,65s:40,54s:25', c: '' },
    BTN: { r: '88+,77:70,66:45,55:25,AKs,AQs,AJs,ATs,A9s:85,A8s:65,A7s:50,A6s:30,A5s,A4s,A3s:85,A2s:65,KQs,KJs,KTs,K9s:65,K8s:30,QJs,QTs:80,Q9s:40,JTs:90,J9s:45,T9s:70,T8s:25,98s:55,87s:45,76s:50,65s:50,54s:35,AKo,AQo,AJo:90,ATo:55,A9o:20,KQo:85,KJo:45,KTo:15,QJo:25', c: '' }
};
// 그 밖의 자리(HJ·CO·BTN 이 앞자리 오픈을 받을 때): 뒤에 사람이 남아 있어 좁게. 버튼만 콜이 꽤 있고, 나머지는 3벳 위주.
const IP_VS = {
    UTG: { r: 'QQ+,AKs,AKo:85,JJ:65,TT:30,AQs:65,AJs:30,A5s:80,A4s:50,KQs:45,KJs:20,76s:20,65s:20',
           c: 'JJ-77,66:50,AQs,AJs,ATs:50,KQs,KJs:50,QJs:50,JTs:60,T9s:40,AKo,AQo:35' },
    HJ:  { r: 'QQ+,AKs,AKo,JJ:80,TT:45,99:15,AQs:80,AJs:45,ATs:20,A5s:90,A4s:65,A3s:30,KQs:60,KJs:30,QJs:15,AQo:30,87s:20,76s:30,65s:25',
           c: 'JJ-66,55:50,AQs,AJs,ATs:60,KQs,KJs:60,KTs:30,QJs:60,JTs:65,T9s:50,98s:30,AKo,AQo:50' },
    CO:  { r: 'JJ+,AKs,AKo,TT:75,99:40,88:15,AQs,AJs:70,ATs:40,A9s:20,A5s,A4s:85,A3s:55,A2s:35,KQs:80,KJs:55,KTs:30,QJs:40,JTs:30,AQo:70,AJo:25,KQo:30,98s:20,87s:35,76s:40,65s:40,54s:30',
           c: 'TT-55,44:50,AQs,AJs,ATs,A9s:40,KQs,KJs,KTs:60,QJs,QTs:50,JTs,T9s:70,98s:50,87s:40,AQo,AJo:35,KQo:45' }
};
// HJ·CO 는 콜하면 뒤에서 스퀴즈를 맞기 쉬워 버튼보다 콜이 훨씬 적다 — 콜 몫을 이 비율로 줄인다
const IP_CALL_SCALE = { HJ: 0.25, CO: 0.45, BTN: 1 };

// ───────── 내 오픈에 3벳이 왔을 때 ─────────
//   앞자리 오픈은 좁고 강해서 계속하는 패도 강하다. 뒷자리 오픈은 넓어서 많이 접지만, 포지션이 있으면 콜이 늘어난다.
const VS_3BET = {
    early:   { r: 'KK+,AKs,AKo:45,QQ:35,A5s:40,A4s:20',
               c: 'QQ-88,77:50,AQs,AJs,ATs:60,KQs,KJs:70,KTs:30,QJs:60,JTs:65,T9s:40,98s:25,AKo,AQo:45' },
    lateIP:  { r: 'QQ+,AKs,AKo:80,JJ:30,A5s:65,A4s:45,A3s:20,KQo:15,AQo:20,K5s:15',
               c: 'JJ-55,44:50,AQs-A8s,A7s:50,KQs-KTs,K9s:50,QJs,QTs,Q9s:40,JTs,J9s:50,T9s,T8s:40,98s,87s,76s,65s:60,54s:40,AQo,AKo,AJo:55,KQo:55' },
    btnIP:   { r: 'QQ+,AKs,AKo,JJ:45,TT:15,A5s:75,A4s:60,A3s:35,A2s:20,AQo:30,KQo:20,K5s:25,K4s:15,AJo:10',
               c: 'JJ-22,A2s+,K7s+,K6s:50,Q8s+,J8s+,T8s+,T7s:50,97s+,86s+,75s+,65s,54s,64s:40,AJo+,ATo:60,KJo+,KTo:40,QJo:60,JTo:30' },
    sbOOP:   { r: 'QQ+,AKs,AKo,JJ:50,TT:20,A5s:70,A4s:50,A3s:25,AQo:25,KQo:15,K5s:15',
               c: 'JJ-55,44:50,33:30,AQs-A7s,A6s:50,KQs-K9s,K8s:40,QJs,QTs,Q9s:50,JTs,J9s:60,T9s,T8s:50,98s,87s,76s:70,65s:60,54s:40,AQo,AJo:70,ATo:25,KQo:70,KJo:25' },
    lateOOP: { r: 'QQ+,AKs,AKo:85,JJ:35,A5s:60,A4s:35,AQo:15',
               c: 'JJ-77,66:50,AQs-ATs,A9s:40,KQs,KJs,KTs:50,QJs,QTs:35,JTs,T9s:60,98s:40,87s:30,AQo:75,AKo,KQo:25' }
};
// ───────── 3벳·4벳을 끼고 처음 들어갈 때(콜드) / 내 3벳에 4벳이 왔을 때 ─────────
const COLD_VS_3BET = { r: 'KK+,AKs,QQ:50,AKo:35', c: 'QQ,JJ:35,AKo:25' };
const VS_4BET = { r: 'KK+,AKs,QQ:45,AKo:45,A5s:15', c: 'QQ,JJ:70,TT:35,AKo,AQs:55,KQs:20' };

// ───────── 헤즈업(둘만) — 버튼이 전체의 4분의 3 이상을 연다 ─────────
const HU_BB_VS_OPEN = {
    r: '88+,77:50,66:30,AKs,AQs,AJs,ATs:80,A9s:60,A8s:40,A5s:70,A4s:60,A3s:50,A2s:45,KQs,KJs:80,KTs:60,K9s:40,QJs:65,QTs:45,JTs:55,T9s:40,98s:35,87s:40,76s:40,65s:40,54s:35,K5s:35,K4s:30,Q6s:25,J7s:25,T7s:25,AKo,AQo,AJo:80,ATo:55,A9o:25,KQo:70,KJo:40,QJo:20,A5o:25,A4o:20,K8o:15,Q8o:15,J8o:15',
    c: '77-22,A2s+,K2s+,Q2s+,J2s+,T3s+,94s+,84s+,74s+,63s+,53s+,43s,A2o+,K4o+,Q6o+,J7o+,T7o+,97o+,86o+,76o,65o:60,K3o:50,K2o:30,Q5o:50,J6o:40,T6o:40,96o:40,85o:40,75o:50,54o:40'
};
const HU_VS_3BET = {
    r: 'JJ+,AKs,AKo,TT:40,AQs:30,A5s:55,A4s:45,A3s:30,K5s:20,AQo:20,KQo:15,A2s:20',
    c: 'TT-22,A2s+,K5s+,K4s:50,Q7s+,J7s+,T7s+,96s+,86s+,75s+,65s,54s,A8o+,A7o:50,A5o:40,KTo+,K9o:50,QTo+,JTo,T9o:40'
};

const T = {
    BB: Object.fromEntries(Object.keys(BB_VS).map(k => [k, build(BB_VS[k])])),
    SB: Object.fromEntries(Object.keys(SB_VS).map(k => [k, build(SB_VS[k])])),
    IP: Object.fromEntries(Object.keys(IP_VS).map(k => [k, build(IP_VS[k])])),
    V3: Object.fromEntries(Object.keys(VS_3BET).map(k => [k, build(VS_3BET[k])])),
    COLD3: build(COLD_VS_3BET), V4: build(VS_4BET), HUBB: build(HU_BB_VS_OPEN), HU3: build(HU_VS_3BET)
};

// 자리 이름을 표의 열쇠로 (9인 테이블의 자리 이름도 받는다)
function posKey(p) {
    if (!p) return '';
    if (p === 'UTG' || p.indexOf('UTG') === 0) return 'UTG';
    if (p === 'LJ' || p === 'MP' || p === 'HJ') return 'HJ';
    return p;
}
const get = (table, code) => (table && table[code]) || FOLD;

// ───────── 솔버 프리플랍 자료 (lib/preflopdata.json.gz) ─────────
//   공개 솔버(TexasSolver)에 딸려 온 6인 100bb 프리플랍 해(2.5bb 오픈 · SB 3bb · 레이크 있는 캐시 게임 기준, 510개 상황)를 그대로 옮긴 것.
//   위의 손으로 적은 표보다 우선해서 쓴다 — 손으로 적은 표는 자료에 없는 상황(헤즈업 · 림프가 낀 판 등)에만 남는다.
//   열쇠는 "지금까지의 행동>내 자리" (자리:R 레이즈 · C 콜 · F 들어왔다가 접음). 예) "BTN:R>BB", "CO:R,BTN:C>SB", "BTN:R,BB:R>BTN"
let PRE = null;
function preData() {
    if (PRE !== null) return PRE;
    try { PRE = JSON.parse(require('zlib').gunzipSync(require('fs').readFileSync(require('path').join(__dirname, 'preflopdata.json.gz'))).toString('utf8')); } catch (e) { PRE = false; }
    return PRE;
}
const dataPos = p => { const k = posKey(p); return k === 'HJ' ? 'MP' : k; };
function dataKey(ctx) {
    if (ctx.seq) return ctx.seq;                          // 서버가 실제 행동 기록으로 만든 열쇠
    if (ctx.headsUp) return null;
    const hero = dataPos(ctx.heroPos), op = dataPos(ctx.openerPos), raises = ctx.raises || 1;
    if (!hero) return null;
    if (raises === 1 && op) return `${op}:R>${hero}`;
    if (raises === 2 && ctx.iRaised && ctx.threeBettorPos) return `${hero}:R,${dataPos(ctx.threeBettorPos)}:R>${hero}`;
    return null;
}
// 💲 [레이크 보정] 자료는 레이크가 있는 캐시 게임의 해라서 BB 의 콜 방어가 좁다(레이크는 콜해서 보는 작은 팟에서 가장 아프다).
//    이 게임에는 레이크가 없으므로, 오픈을 받는 BB 의 콜 범위를 "계속하는 폭의 18%"만큼 넓힌다 — 접던 패 가운데 좋은 것부터 콜에 넣는다.
//    (레이크 없는 해의 BB vs 버튼 방어는 대략 50~55%로 알려져 있다. 자료 44% → 보정 뒤 약 52%.) 3벳 범위는 그대로 둔다.
const NO_RAKE_BB = 0.18;
const _widen = {};
function widened(key, table) {
    if (_widen[key]) return _widen[key];
    const PF = require('./preflop');
    let cont = 0; ALL.forEach(c => { const r = table[c]; if (r) cont += (r[0] + r[1]) / 100 * combos(c); });
    let left = cont * NO_RAKE_BB;
    const out = {};
    ALL.map(c => ({ c, r: table[c] || [0, 0], s: PF.handRangeScore(c) + (c[2] === 's' ? 6 : 0) })).filter(x => x.r[0] + x.r[1] < 100).sort((a, b) => b.s - a.s).forEach(x => {
        if (left <= 0) return;
        const room = (100 - x.r[0] - x.r[1]) / 100 * combos(x.c), add = Math.min(room, left);
        out[x.c] = [x.r[0], Math.round(x.r[1] + add / combos(x.c) * 100)]; left -= add;
    });
    return (_widen[key] = out);
}
const KO_N = ['오픈', '3벳', '4벳', '5벳', '6벳'];
function keyName(key) {
    const [hist, hero] = key.split('>'); let n = 0;
    const acts = hist ? hist.split(',').map(t => { const [p, k] = t.split(':'); return (p === 'MP' ? 'HJ' : p) + ' ' + (k === 'R' ? KO_N[Math.min(n++, 4)] : k === 'A' ? (n++, '올인') : k === 'C' ? '콜' : '폴드'); }) : [];
    const h = hero === 'MP' ? 'HJ' : hero;
    return acts.length === 1 && n === 1 ? `${h} vs ${acts[0]}` : acts.length ? `${acts.join(' · ')} → ${h}` : `${h} 오픈`;
}
// 🏁 [대회용 얕은 스택 자료] HRC 로 직접 푼 6인 · BB 앤티 프리플랍 해(깊이별) — lib/preflop_mtt.json.gz (tools/hrc_import.js 로 만든다).
//    100bb 자료는 캐시 게임 기준이라 20~30bb 대회에는 맞지 않는다. 유효 스택이 이 자료의 범위 안이면 가장 가까운 깊이의 표를 쓴다.
//    값: { 패: [레이즈 %(올인 포함), 콜 %, 그중 올인 %] }. 열쇠의 A 는 올인 레이즈.
let MTT = null;
function mttData() {
    if (MTT !== null) return MTT;
    try { MTT = JSON.parse(require('zlib').gunzipSync(require('fs').readFileSync(process.env.MTT_DATA || require('path').join(__dirname, 'preflop_mtt.json.gz'))).toString('utf8')); } catch (e) { MTT = false; }
    return MTT;
}
// 유효 스택(bb)에 쓸 깊이. 자료의 가장 얕은 깊이 − 6bb 부터 가장 깊은 깊이 × 1.2 까지만 쓴다(그 밖은 null → 100bb 자료·푸시폴드 계산).
function mttDepth(effBB) {
    const D = mttData(); if (!D || !(effBB > 0)) return null;
    const ds = Object.keys(D).map(Number).sort((a, b) => a - b); if (!ds.length) return null;
    if (effBB < ds[0] - 6 || effBB > ds[ds.length - 1] * 1.2) return null;
    return ds.reduce((best, d) => (Math.abs(d - effBB) < Math.abs(best - effBB) ? d : best), ds[0]);
}
function mttRow(depth, key, code) {
    const D = mttData(); if (!D || !D[depth]) return undefined;
    const T = D[depth].tables[key]; if (!T) return undefined;
    return T[code] || [0, 0, 0];
}
// 먼저 여는 자리의 한 줄: [레이즈 %, 콜(림프) %, 올인 %] — 자료가 없으면 null
function mttOpen(pos, code, effBB) {
    const d = mttDepth(effBB); if (d == null) return null;
    const r = mttRow(d, '>' + dataPos(pos), code);
    return r ? { raise: r[0], call: r[1], jam: r[2] || 0, depth: d } : null;
}
function fromData(ctx, code) {
    // 대회용 얕은 스택 자료가 먼저다(유효 스택이 그 범위 안일 때)
    const md = ctx.depth ? mttDepth(ctx.depth) : null;
    if (md != null) {
        const k = ctx.seqA || dataKey(ctx);
        const r = k ? mttRow(md, k, code) : undefined;
        if (r) return { raise: r[0], call: r[1], fold: 100 - r[0] - r[1], jam: r[2] || 0, name: keyName(k) + ` (${md}bb · 직접 푼 대회용)`, data: true, mtt: true };
    }
    const D = preData(); if (!D) return null;
    const key = dataKey(ctx); if (!key) return null;
    const T0 = D.tables[key]; if (!T0) return null;
    const bbVsOpen = /^[A-Z]+:R>BB$/.test(key);
    const row = (bbVsOpen ? widened(key, T0)[code] : null) || T0[code] || [0, 0];
    return { raise: row[0], call: row[1], fold: 100 - row[0] - row[1], name: keyName(key) + ' (솔버)', data: true };
}
// 먼저 여는(RFI) 빈도(%) — 자료에 없는 자리(BB, 헤즈업)는 null
function openFreq(pos, code) {
    const D = preData(); if (!D) return null;
    const T0 = D.tables['>' + dataPos(pos)]; if (!T0) return null;
    return (T0[code] || [0, 0])[0];
}

// 상황 → 그 패의 { raise, call, fold } (%). 맞는 표가 없으면 null (예전 점수 기준을 쓴다).
//   ctx: { heroPos, openerPos, raises(이번 프리플랍의 레이즈 수: 1 오픈, 2 3벳, 3 이상 4벳+), iRaised(내가 이미 레이즈했나), headsUp, inPosition(3벳한 사람보다 내가 뒤인가) }
function lookup(ctx, code) {
    if (!ctx || !code) return null;
    const d = ctx.noData ? null : fromData(ctx, code);
    if (d) return d;
    if (ctx.seq) ctx = Object.assign({}, ctx, { seq: null });
    const raises = ctx.raises || 1, hero = posKey(ctx.heroPos), op = posKey(ctx.openerPos);
    let table = null, name = '';
    if (raises >= 3) { table = T.V4; name = '4벳 받기'; }
    else if (raises === 2) {
        if (ctx.headsUp) { if (ctx.iRaised) { table = T.HU3; name = '헤즈업 3벳 받기'; } else return null; }
        else if (!ctx.iRaised) { table = T.COLD3; name = '오픈과 3벳이 나온 뒤'; }
        else {
            const early = hero === 'UTG' || hero === 'HJ';
            const k = early ? 'early' : hero === 'SB' ? 'sbOOP' : (ctx.inPosition ? (hero === 'BTN' ? 'btnIP' : 'lateIP') : 'lateOOP');
            table = T.V3[k]; name = early ? '앞자리 오픈 → 3벳 받기' : (ctx.inPosition ? '뒷자리 오픈 → 3벳 받기(포지션 있음)' : '오픈 → 3벳 받기(포지션 없음)');
        }
    } else {
        if (ctx.headsUp) { table = T.HUBB; name = '헤즈업 BB 방어'; }
        else if (hero === 'BB') { table = T.BB[op]; name = `BB vs ${op} 오픈`; }
        else if (hero === 'SB') { table = T.SB[op]; name = `SB vs ${op} 오픈`; }
        else if (hero === 'HJ' || hero === 'CO' || hero === 'BTN') {
            const base = T.IP[op];
            if (!base) return null;
            const f = get(base, code), k = IP_CALL_SCALE[hero];
            const call = Math.round(f.call * k);
            return { raise: f.raise, call, fold: 100 - f.raise - call, name: `${hero} vs ${op} 오픈` };
        }
        if (!table) return null;
    }
    const f = get(table, code);
    return { raise: f.raise, call: f.call, fold: f.fold, name };
}
// 표 전체의 폭(%) — 검사·표시용
function width(ctx) {
    let r = 0, c = 0;
    ALL.forEach(code => { const f = lookup(ctx, code); if (!f) return; r += f.raise / 100 * combos(code); c += f.call / 100 * combos(code); });
    return { raise: Math.round(r / 1326 * 1000) / 10, call: Math.round(c / 1326 * 1000) / 10, total: Math.round((r + c) / 1326 * 1000) / 10 };
}
// 화면에 그릴 표 한 장 — { code: [레이즈%, 콜%] } (폴드뿐인 패는 뺀다)
function grid(ctx) {
    const out = {}; let name = '';
    ALL.forEach(code => { const f = lookup(ctx, code); if (!f) return; name = f.name; if (f.raise || f.call) out[code] = [f.raise, f.call]; });
    return name ? { name, cells: out, width: width(ctx) } : null;
}

module.exports = { ALL, combos, parse, expand, build, lookup, width, grid, posKey, dataPos, openFreq, keyName, preData, mttData, mttDepth, mttOpen };
