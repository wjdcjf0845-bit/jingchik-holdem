// 대표 플랍 고르기: 서로 다른 플랍 1,755종(무늬 바꿔치기는 같은 것으로 봄) 가운데, 이미 고른 것들과 가장 먼 것을 하나씩 더한다.
//   거리는 게임이 "비슷한 보드"를 찾을 때 쓰는 것과 같은 함수(lib/flopsolve.js) — 그래서 고를수록 조회 오차가 고르게 줄어든다.
//   사용: node tools/solver/boards.js <개수>  → 한 줄에 하나씩 "Ks,7d,2c"
const FS = require('../../lib/flopsolve');
const RK = 'AKQJT98765432';
const BASE = ['As7d2c', 'AsKd6h', 'Ah9h8d', 'AdJsTc', 'Ks7d2c', 'KhQh5d', 'Kd9s8s', 'Qs6d3c', 'QdJh9h', 'Js8d4c', 'JhTh6d', 'Td9s5c', '9h8h6d', '8s5d2c', '7d6s5s', '6s4d3c', 'Ks8d8c', '9s9d4c', 'As5d5c', 'QsQd7c', 'Kh9h4h', '8h6h3h'];
function all() {
    const out = [];
    for (let a = 0; a < 13; a++) for (let b = a; b < 13; b++) for (let c = b; c < 13; c++) {
        const r = [RK[a], RK[b], RK[c]];
        const pats = (a === b && b === c) ? ['shd'] : (a === b) ? ['shd', 'shs'] : (b === c) ? ['shd', 'shs'.split('').reverse().join('')] : ['shd', 'sss', 'ssh', 'shs', 'hss'];
        pats.forEach(p => {
            const cards = r.map((x, i) => x + p[i]);
            if (new Set(cards).size === 3) out.push(cards.join(''));
        });
    }
    return out;
}
function pick(n) {
    const pool = all(), chosen = BASE.slice();
    const tex = k => FS.texture(FS.parseBoardKey(k));
    const T = {}; pool.concat(chosen).forEach(k => { T[k] = tex(k); });
    const dmin = {}; pool.forEach(k => { dmin[k] = Math.min(...chosen.map(c => FS.distance(T[k], T[c]))); });
    while (chosen.length < n) {
        let best = null, bd = -1;
        pool.forEach(k => { if (dmin[k] > bd) { bd = dmin[k]; best = k; } });
        if (!best || bd <= 0) break;
        chosen.push(best);
        pool.forEach(k => { dmin[k] = Math.min(dmin[k], FS.distance(T[k], T[best])); });
    }
    return chosen;
}
if (require.main === module) {
    const n = Number(process.argv[2] || 100);
    pick(n).forEach(k => console.log(FS.parseBoardKey(k).join(',')));
}
module.exports = { all, pick, BASE };
