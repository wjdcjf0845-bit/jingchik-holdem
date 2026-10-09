// 솔버 출력(Desktop/PokeSolver/work/out/*.json) → lib/solverdata.json
//   노드마다 "패 종류별 평균 빈도(%)"만 남긴다. 무게는 그 패가 처음 범위에 든 비중.
const fs = require('fs'), path = require('path');
const PF = require('../../lib/preflop'), R = require('../../lib/ranges'), FS = require('../../lib/flopsolve');
const DIR = process.argv[2];
const comboCode = k => PF.handToCode([k.slice(0, 2), k.slice(2, 4)]);
const wIp = () => 1;
const wOop = spot => code => { const f = spot === 'hu' ? R.lookup({ headsUp: true, heroPos: 'BB' }, code) : R.lookup({ heroPos: 'BB', openerPos: spot === 'utg' ? 'UTG' : 'BTN' }, code); return f ? f.call / 100 : 0; };
function agg(node, board, weightOf, mapActs) {
    if (!node || !node.strategy) return null;
    const acts = node.strategy.actions, S = node.strategy.strategy, out = {};
    const add = (key, vec, w) => { const o = out[key] || (out[key] = { v: vec.map(() => 0), w: 0 }); vec.forEach((x, i) => { o.v[i] += x * w; }); o.w += w; };
    Object.keys(S).forEach(k => {
        const hand = [k.slice(0, 2), k.slice(2, 4)], w = weightOf(comboCode(k));
        if (!(w > 0)) return;
        const bk = FS.bucket(hand, board); if (!bk) return;
        const vec = mapActs(acts, S[k]);
        add(bk.key, vec, w); add(bk.made + '|*', vec, w); add('*', vec, w);
    });
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

const data = {}; const summary = [];
fs.readdirSync(DIR).filter(f => f.endsWith('.json')).forEach(f => {
    const [spot, bkey] = f.replace('.json', '').split('_');
    const board = FS.parseBoardKey(bkey), root = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const wo = wOop(spot), o = {};
    o.oop_root = agg(root, board, wo, betMap2);
    const ipNode = root.childrens.CHECK;
    o.ip_cbet = agg(ipNode, board, wIp, betMap3);
    const kb = betKids(ipNode);
    if (kb[0]) { o.oop_vs_s = agg(ipNode.childrens[kb[0]], board, wo, vsMap); const rk = raiseKid(ipNode.childrens[kb[0]]); if (rk) o.ip_xr = agg(ipNode.childrens[kb[0]].childrens[rk], board, wIp, vsMap); }
    if (kb[1]) o.oop_vs_b = agg(ipNode.childrens[kb[1]], board, wo, vsMap);
    const db = betKids(root);
    if (db[0]) o.ip_vs_s = agg(root.childrens[db[0]], board, wIp, vsMap);
    if (db[1]) o.ip_vs_b = agg(root.childrens[db[1]], board, wIp, vsMap);
    Object.keys(o).forEach(k => { if (!o[k]) delete o[k]; });
    (data[spot] = data[spot] || {})[bkey] = o;
    summary.push(`${spot} ${bkey}  OOP 돈크 ${o.oop_root['*'][1]}% | IP c벳 ${o.ip_cbet['*'][1] + o.ip_cbet['*'][2]}% (작게 ${o.ip_cbet['*'][1]} · 크게 ${o.ip_cbet['*'][2]}) | OOP vs 작은 벳: 폴드 ${o.oop_vs_s['*'][0]} 콜 ${o.oop_vs_s['*'][1]} 레이즈 ${o.oop_vs_s['*'][2]}`);
});
fs.writeFileSync(path.join(__dirname, '../../lib/solverdata.json'), JSON.stringify(data));
console.log(summary.join('\n')); console.log('boards', summary.length, 'bytes', fs.statSync(path.join(__dirname, '../../lib/solverdata.json')).size);
