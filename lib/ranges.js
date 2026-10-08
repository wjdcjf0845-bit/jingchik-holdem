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

// 상황 → 그 패의 { raise, call, fold } (%). 맞는 표가 없으면 null (예전 점수 기준을 쓴다).
//   ctx: { heroPos, openerPos, raises(이번 프리플랍의 레이즈 수: 1 오픈, 2 3벳, 3 이상 4벳+), iRaised(내가 이미 레이즈했나), headsUp, inPosition(3벳한 사람보다 내가 뒤인가) }
function lookup(ctx, code) {
    if (!ctx || !code) return null;
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

module.exports = { ALL, combos, parse, expand, build, lookup, width, grid, posKey };
