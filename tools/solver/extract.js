// 솔버 출력(Desktop/PokeSolver/work/out/*.json) → lib/solverdata.json
//   노드마다 "패 종류별 평균 빈도(%)"만 남긴다. 무게는 그 패가 처음 범위에 든 비중.
const fs = require('fs'), path = require('path');
const PF = require('../../lib/preflop'), FS = require('../../lib/flopsolve');
const DIR = process.argv[2];
const comboCode = k => PF.handToCode([k.slice(0, 2), k.slice(2, 4)]);
const { SPOTS } = require('./spots');
const BASE = new Set(require('./boards').BASE);
function agg(node, board, weightOf, mapActs, raw) {
    if (!node || !node.strategy) return null;
    const acts = node.strategy.actions, S = node.strategy.strategy, out = {};
    const add = (key, vec, w) => { const o = out[key] || (out[key] = { v: vec.map(() => 0), w: 0 }); vec.forEach((x, i) => { o.v[i] += x * w; }); o.w += w; };
    Object.keys(S).forEach(k => {
        const hand = [k.slice(0, 2), k.slice(2, 4)];
        let w = weightOf(comboCode(k));
        if (typeof w === 'function') w = w(k);
        if (!(w > 0)) return;
        const bk = FS.bucket(hand, board); if (!bk) return;
        const vec = mapActs(acts, S[k]);
        add(bk.key, vec, w); add(bk.made + '|*', vec, w); add('*', vec, w);
    });
    if (raw) return out;
    const res = {};
    Object.keys(out).forEach(k => { const o = out[k]; res[k] = o.v.map(x => Math.round(x / o.w * 100)).concat([Math.round(o.w * 10) / 10]); });
    return res;
}
const amt = a => Number(a.split(' ')[1]);
const betMap3 = (acts, p) => { const bets = acts.map((a, i) => [a, i]).filter(x => x[0].startsWith('BET')).sort((x, y) => amt(x[0]) - amt(y[0])); const chk = acts.indexOf('CHECK');
    return [chk >= 0 ? p[chk] : 0, bets[0] ? p[bets[0][1]] : 0, bets.slice(1).reduce((s, b) => s + p[b[1]], 0)]; };
const betMap2 = (acts, p) => { const x = betMap3(acts, p); return [x[0], x[1] + x[2]]; };
const vsMap = (acts, p) => [acts.indexOf('FOLD') >= 0 ? p[acts.indexOf('FOLD')] : 0, acts.indexOf('CALL') >= 0 ? p[acts.indexOf('CALL')] : 0, acts.reduce((s, a, i) => s + (a.startsWith('RAISE') ? p[i] : 0), 0)];
const betKids = n => Object.keys(n.childrens || {}).filter(k => k.startsWith('BET')).sort((a, b) => amt(a) - amt(b));
const raiseKid = n => Object.keys(n.childrens || {}).find(k => k.startsWith('RAISE'));

function extractOne(file) {
    const [spot, bkey] = path.basename(file).replace('.json', '').replace(/^o_/, '').split('_');
    if (!SPOTS[spot]) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw.childrens) return { spot, bkey, o: raw };            // 이미 요약된 파일
    const board = FS.parseBoardKey(bkey), root = raw;
    const wo = SPOTS[spot].oop, wIp = SPOTS[spot].ip, o = {};
    o.oop_root = agg(root, board, wo, betMap3);
    const ipNode = root.childrens.CHECK;
    o.ip_cbet = agg(ipNode, board, wIp, betMap3);
    const kb = betKids(ipNode);
    if (kb[0]) { o.oop_vs_s = agg(ipNode.childrens[kb[0]], board, wo, vsMap); const rk = raiseKid(ipNode.childrens[kb[0]]); if (rk) o.ip_xr = agg(ipNode.childrens[kb[0]].childrens[rk], board, wIp, vsMap); }
    if (kb[1]) o.oop_vs_b = agg(ipNode.childrens[kb[1]], board, wo, vsMap);
    const db = betKids(root);
    if (db[0]) o.ip_vs_s = agg(root.childrens[db[0]], board, wIp, vsMap);
    if (db[1]) o.ip_vs_b = agg(root.childrens[db[1]], board, wIp, vsMap);
    Object.keys(o).forEach(k => { if (!o[k]) delete o[k]; });
    // ── 턴 (솔버를 set_dump_rounds 2 로 돌린 출력에만 있다) ──
    //   플랍이 어떻게 지나갔나(줄) × 턴 카드의 종류 × 노드 × 패 종류 → 평균 빈도. 무게 = 처음 범위 × 그 줄로 올 확률.
    const xx = ipNode.childrens.CHECK;
    if (xx && xx.dealcards) {
        const P = (node, key, act) => { const st = node.strategy; const row = st.strategy[key] || st.strategy[key.slice(2) + key.slice(0, 2)]; const i = st.actions.indexOf(act); return row && i >= 0 ? row[i] : 0; };
        const lines = { xx: { chance: xx, oopReach: k => P(root, k, 'CHECK'), ipReach: k => P(ipNode, k, 'CHECK') } };
        kb.forEach((bk, i) => {
            const vs = ipNode.childrens[bk], ch = vs.childrens.CALL;
            if (ch && ch.dealcards) lines[i === 0 ? 'xbc_s' : 'xbc_b'] = { chance: ch, oopReach: k => P(root, k, 'CHECK') * P(vs, k, 'CALL'), ipReach: k => P(ipNode, k, bk) };
        });
        const T = {};
        Object.keys(lines).forEach(ln => {
            const L = lines[ln], acc = {};
            Object.keys(L.chance.dealcards).forEach(card => {
                const tn = L.chance.dealcards[card];
                if (!tn || !tn.strategy) return;
                const cls = FS.turnClass(board, card), b4 = board.concat([card]);
                const put = (name, node, w, map) => {
                    if (!node || !node.strategy) return;
                    const r = agg(node, b4, w, map, true); if (!r) return;
                    const A = (acc[cls] = acc[cls] || {}), N = (A[name] = A[name] || {});
                    Object.keys(r).forEach(k => { const o2 = N[k] || (N[k] = { v: r[k].v.map(() => 0), w: 0 }); r[k].v.forEach((x, i) => { o2.v[i] += x; }); o2.w += r[k].w; });
                };
                const wO = c => k => wo(c) * L.oopReach(k), wI = c => k => wIp(c) * L.ipReach(k);
                put('t_oop', tn, wO, betMap2);
                const afterChk = tn.childrens.CHECK;
                put('t_ip', afterChk, wI, betMap2);
                const tb = betKids(afterChk || {})[0]; if (tb) put('t_oop_vs', afterChk.childrens[tb], wO, vsMap);
                const ob = betKids(tn)[0]; if (ob) put('t_ip_vs', tn.childrens[ob], wI, vsMap);
            });
            const out = {};
            Object.keys(acc).forEach(cls => { out[cls] = {}; Object.keys(acc[cls]).forEach(name => { const N = acc[cls][name], res = {};
                Object.keys(N).forEach(k => { if (N[k].w < 2 || k === '*') return; res[k] = N[k].v.map(x => Math.round(x / N[k].w * 100)).concat([Math.round(N[k].w)]); });
                out[cls][name] = res; }); });
            T[ln] = out;
        });
        o.turn = T;
    }
    return { spot, bkey, o };
}
// node extract.js --one <솔버 출력.json> <요약.json>   : 한 파일을 요약해 저장(원본은 지워도 된다)
// node extract.js <폴더> [<폴더> …]                    : 폴더들의 원본·요약을 모아 lib/solverdata.json 을 만든다
if (process.argv[2] === '--one') {
    const r = extractOne(process.argv[3]);
    if (!r) { console.error('모르는 상황'); process.exit(1); }
    fs.writeFileSync(process.argv[4], JSON.stringify(r.o));
} else {
    const data = {}, count = {};
    process.argv.slice(2).forEach(DIR => fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f.indexOf('_') > 0).forEach(f => {
        let r = null; try { r = extractOne(path.join(DIR, f)); } catch (e) { console.error('건너뜀', f, e.message); }
        if (!r || !r.o || !r.o.ip_cbet) return;
        // 턴 자료는 크다(보드당 약 20KB). 표본이 적은 줄(무게 8 미만)은 뺀다.
        if (r.o.turn) {
            if (!BASE.has(r.bkey) && process.env.TURN_BASE_ONLY) delete r.o.turn;   // 기본은 모든 보드의 턴 자료를 싣는다(실측: 972개 상황일 때 서버 메모리 130MB → 202MB). TURN_BASE_ONLY=1 이면 기본 22보드만
            else Object.values(r.o.turn).forEach(L => Object.values(L).forEach(C => Object.values(C).forEach(N => Object.keys(N).forEach(k => { if (N[k][N[k].length - 1] < 8) delete N[k]; }))));
        }
        (data[r.spot] = data[r.spot] || {})[r.bkey] = r.o; count[r.spot] = (count[r.spot] || 0) + 1;
    }));
    const outFile = process.env.OUT || path.join(__dirname, '../../lib/solverdata.json.gz');
    fs.writeFileSync(outFile, require('zlib').gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 }));
    Object.keys(count).forEach(sp => { const all = Object.values(data[sp]).map(o => o.ip_cbet['*']); const m = i => Math.round(all.reduce((s2, x) => s2 + x[i], 0) / all.length);
        console.log(`${sp.padEnd(6)} 보드 ${String(count[sp]).padStart(3)}  나중에 행동하는 쪽 벳 평균 ${m(1) + m(2)}% (작게 ${m(1)} · 크게 ${m(2)})`); });
    console.log('합계', Object.values(count).reduce((a, b) => a + b, 0), '상황 ·', Math.round(fs.statSync(outFile).size / 1024), 'KB');
}
