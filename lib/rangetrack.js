// 🧭 범위 추적 — "리버까지 이렇게 쳐 온 사람은 어떤 패를 얼마나 들고 있나".
//   리버 계산기(lib/riversolve.js)에 넣을 양쪽 범위를 만든다.
//   ① 프리플랍: 그 사람의 프리플랍 행동으로 낸 무게(lib/vrange.js)
//   ② 플랍·턴: 그 사람이 한 행동마다 "그 종류의 패가 그 행동을 할 확률"을 곱한다.
//      확률은 솔버 자료(lib/solverdata.json.gz)를 노드 종류별로 전부 평균한 표에서 가져온다 — 특정 보드의 답이 아니라
//      "탑페어는 c벳 자리에서 대체로 얼마나 벳하나" 수준의 일반 경향이다. 표에 없는 행동은 어림값을 쓴다.
//   사람도 봇도 솔버대로만 치지 않으므로 확률에는 바닥값(FLOOR)을 둔다(어떤 패도 완전히 0 이 되지는 않는다).
const FlopSolve = require('./flopsolve');

const FLOOR = 0.05;
const RANKS = '23456789TJQKA', SUITS = 'shdc';
const DECK = []; for (const r of RANKS) for (const s of SUITS) DECK.push(r + s);

// 솔버 자료를 노드 종류별로 평균 — { 노드: { 패 종류: [빈도…] } }
let GEN = null;
function generic(data) {
    if (GEN && !data) return GEN;
    const D = data || FlopSolve.load();
    const acc = {};
    const add = (node, key, row) => {
        const w = row[row.length - 1]; if (!(w > 0)) return;
        const N = (acc[node] = acc[node] || {}), o = (N[key] = N[key] || { v: row.slice(0, -1).map(() => 0), w: 0 });
        if (o.v.length !== row.length - 1) return;
        row.slice(0, -1).forEach((x, i) => { o.v[i] += x * w; }); o.w += w;
    };
    if (D) Object.values(D).forEach(spot => Object.values(spot).forEach(b => {
        Object.keys(b).forEach(node => { if (node !== 'turn') Object.keys(b[node]).forEach(k => add(node, k, b[node][k])); });
        if (b.turn) Object.values(b.turn).forEach(L => Object.values(L).forEach(C => Object.keys(C).forEach(node => Object.keys(C[node]).forEach(k => add(node, k, C[node][k])))));
    }));
    const out = {};
    Object.keys(acc).forEach(node => { out[node] = {}; Object.keys(acc[node]).forEach(k => { const o = acc[node][k]; out[node][k] = o.v.map(x => x / o.w / 100); }); });
    if (!data) GEN = out;
    return out;
}
// 표에 없을 때 쓰는 어림값: 만든 패별 [벳할 확률, 벳에 콜할 확률, 벳에 레이즈할 확률]
const FALLBACK = { mon: [0.75, 0.6, 0.38], op: [0.75, 0.85, 0.12], tp1: [0.7, 0.9, 0.08], tp2: [0.5, 0.85, 0.04], mp: [0.3, 0.7, 0.03], lp: [0.25, 0.45, 0.03], ah: [0.3, 0.3, 0.03], oc: [0.35, 0.3, 0.04], air: [0.35, 0.12, 0.05] };

// 한 행동의 확률. ctx: { street: 'flop'|'turn', oop(그 사람이 먼저 행동하는 쪽인가), facing: null|'s'|'b'|'r'(받은 벳: 작은·큰·레이즈), act: 'x'|'b'|'c'|'r' }
function actionProb(bk, ctx, gen) {
    if (!bk) return 1;
    const flop = ctx.street === 'flop';
    let node, idx;
    if (!ctx.facing) {
        node = ctx.oop ? (flop ? 'oop_root' : 't_oop') : (flop ? 'ip_cbet' : 't_ip');
        idx = ctx.act === 'x' ? 'chk' : 'bet';
    } else {
        node = ctx.facing === 'r' ? 'ip_xr' : ctx.oop ? (flop ? (ctx.facing === 'b' ? 'oop_vs_b' : 'oop_vs_s') : 't_oop_vs') : (flop ? (ctx.facing === 'b' ? 'ip_vs_b' : 'ip_vs_s') : 't_ip_vs');
        idx = ctx.act === 'c' ? 1 : ctx.act === 'r' ? 2 : 0;
    }
    const N = gen && gen[node], row = N && (N[bk.key] || N[bk.made + '|*']);
    let p;
    if (row) p = idx === 'chk' ? row[0] : idx === 'bet' ? row.slice(1).reduce((a, b) => a + b, 0) : row[idx];
    else { const f = FALLBACK[bk.made] || FALLBACK.air; p = idx === 'chk' ? 1 - f[0] : idx === 'bet' ? f[0] : idx === 1 ? f[1] : idx === 2 ? f[2] : 1 - f[1] - f[2]; }
    return Math.max(FLOOR, Math.min(1, p || 0));
}

// 한 사람의 리버 범위.
//   o: { board(5장), dead(뺄 카드 — 상대의 범위를 만들 때는 내 두 장), pre(패 코드 → 프리플랍 무게, 없으면 전부 1),
//        acts: [{ street, oop, facing, act }] (플랍·턴에 그 사람이 한 행동, 순서대로), keep(반드시 넣을 패 — 내 범위를 만들 때 내 실제 패), max(남길 패 수) }
//   반환: [{ hand:[c1,c2], w }] (무게 큰 순, 합 1)
function build(o, handToCode, gen) {
    const G = gen || generic();
    const dead = new Set((o.board || []).concat(o.dead || []));
    const live = DECK.filter(c => !dead.has(c));
    const flop = o.board.slice(0, 3), turn = o.board.slice(0, 4);
    const out = [];
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const hand = [live[i], live[j]];
        let w = o.pre ? o.pre(handToCode(hand)) : 1;
        if (!(w > 0)) continue;
        let bf = null, bt = null;
        for (const a of (o.acts || [])) {
            const bk = a.street === 'flop' ? (bf || (bf = FlopSolve.bucket(hand, flop))) : (bt || (bt = FlopSolve.bucket(hand, turn)));
            w *= actionProb(bk, a, G);
            if (w < 1e-6) break;
        }
        if (w >= 1e-6) out.push({ hand, w });
    }
    out.sort((x, y) => y.w - x.w);
    let kept = out.slice(0, o.max || 90);
    if (o.keep) {
        const has = h => (h[0] === o.keep[0] && h[1] === o.keep[1]) || (h[0] === o.keep[1] && h[1] === o.keep[0]);
        if (!kept.some(x => has(x.hand))) { const mine = out.find(x => has(x.hand)); kept.push(mine || { hand: o.keep.slice(), w: kept.length ? kept[kept.length - 1].w : 1 }); }
    }
    const tot = kept.reduce((s, x) => s + x.w, 0) || 1;
    kept.forEach(x => { x.w /= tot; });
    return kept;
}

// 한 스트리트의 행동 기록 → 사람별 행동 목록. seq: [{ who:'O'|'I', type:'x'|'b'|'c'|'f', frac(벳이면 팟 대비 크기) }]
function actsOfStreet(street, seq) {
    const out = { O: [], I: [] };
    let bets = 0, lastFrac = 0;
    (seq || []).forEach(a => {
        if (a.type === 'f') return;
        const facing = bets === 0 ? null : bets >= 2 ? 'r' : (lastFrac > 0.5 ? 'b' : 's');
        const act = a.type === 'b' ? (bets === 0 ? 'b' : 'r') : a.type;
        out[a.who].push({ street, oop: a.who === 'O', facing, act });
        if (a.type === 'b') { bets++; lastFrac = a.frac || 0.5; }
    });
    return out;
}

module.exports = { generic, actionProb, build, actsOfStreet, FALLBACK, FLOOR };
