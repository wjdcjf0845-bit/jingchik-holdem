// 모형의 실현율 숫자를 100bb 솔버 자료에 맞춘다.
//   사용: node tools/pfmodel_fit.js            → 지금 숫자로 견주기만
//         node tools/pfmodel_fit.js fit [회]   → 좌표 하강으로 맞추고 scratch/pfmodel_params.json 에 저장
//   오차: 패마다 |콜 빈도 차| + |레이즈 빈도 차| 를 조합 수로 평균한 값(%p). 수비(오픈 받기)와 3벳 받기를 같이 본다.
const fs = require('fs'), path = require('path');
const PM = require('./pfmodel'), Ranges = require('../lib/ranges'), Jam = require('../lib/jam');
const D = Ranges.preData(), N = PM.N, ALL = PM.ALL, m = Jam.load();
const tab = key => { const T = D.tables[key]; if (!T) return null; return { r: Float64Array.from(ALL.map(c => (T[c] || [0, 0])[0] / 100)), c: Float64Array.from(ALL.map(c => (T[c] || [0, 0])[1] / 100)) }; };
const OPEN = {}; PM.POS.slice(0, 5).forEach(p => { OPEN[p] = tab('>' + p).r; });
const PAIRS = []; PM.POS.slice(0, 5).forEach((O, oi) => PM.POS.slice(oi + 1).forEach(Dp => PAIRS.push([O, Dp])));

function compare(P, opt) {
    opt = opt || {};
    const res = PM.solveAll(P, PM.ENV100, { open: OPEN, fixedOpen: true, iters: opt.iters || 120 });
    let loss = 0, n = 0; const rows = [];
    PAIRS.forEach(([O, Dp]) => {
        const q = res.vs[O + '>' + Dp], t = tab(O + ':R>' + Dp); if (!t) return;
        const mr = q.d0.R ? q.d0.R.map((v, i) => v + (q.d0.J ? q.d0.J[i] : 0)) : q.d0.J, mc = q.d0.C;
        let e = 0, w = 0; for (let i = 0; i < N; i++) { e += m.combos[i] * (Math.abs(mr[i] - t.r[i]) + Math.abs(mc[i] - t.c[i])); w += m.combos[i]; }
        const row = { spot: O + '→' + Dp, err: e / w * 100, mR: PM.pctOf(mr) * 100, sR: PM.pctOf(t.r) * 100, mC: PM.pctOf(mc) * 100, sC: PM.pctOf(t.c) * 100 };
        loss += row.err; n++;
        // 3벳 받기(연 사람)
        const t3 = tab(O + ':R,' + Dp + ':R>' + O);
        if (t3 && q.o1) {
            const pr = OPEN[O]; let e3 = 0, w3 = 0;
            for (let i = 0; i < N; i++) { const ww = m.combos[i] * pr[i]; e3 += ww * (Math.abs(q.o1.A[i] - t3.r[i]) + Math.abs(q.o1.C[i] - t3.c[i])); w3 += ww; }
            row.err3 = e3 / w3 * 100; row.m4 = PM.pctOf(q.o1.A, pr) * 100; row.s4 = PM.pctOf(t3.r, pr) * 100; row.mC3 = PM.pctOf(q.o1.C, pr) * 100; row.sC3 = PM.pctOf(t3.c, pr) * 100;
            loss += row.err3 * 0.6; n += 0.6;
        }
        rows.push(row);
    });
    return { loss: loss / n, rows, res };
}
function show(c) {
    const f = x => (x == null ? '  -' : x.toFixed(1).padStart(5));
    console.log('자리        오차   3벳(모형/솔버)  콜(모형/솔버) | 3벳 받기: 오차  4벳(모형/솔버)  콜(모형/솔버)');
    c.rows.forEach(r => console.log(r.spot.padEnd(9), f(r.err), ' ', f(r.mR), f(r.sR), ' ', f(r.mC), f(r.sC), ' |', f(r.err3), ' ', f(r.m4), f(r.s4), ' ', f(r.mC3), f(r.sC3)));
    console.log('평균 오차', c.loss.toFixed(2), '%p');
}

const file = path.join(__dirname, '../scratch/pfmodel_params.json');
let P = Object.assign({}, PM.DEF);
try { Object.assign(P, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {}
if (process.argv[2] === 'fit') {
    const rounds = Number(process.argv[3] || 4), keys = ['oop', 'ip', 'init', 'sq', 's', 'c', 'p', 'o', 'g'];
    let best = compare(P, { iters: 80 }).loss; console.log('시작', best.toFixed(3), JSON.stringify(P));
    let step = 0.06;
    for (let r = 0; r < rounds; r++) {
        keys.forEach(k => {
            [1, -1].forEach(dir => {
                for (let tries = 0; tries < 4; tries++) {
                    const Q = Object.assign({}, P, { [k]: Math.round((P[k] + dir * step) * 1000) / 1000 });
                    const l = compare(Q, { iters: 80 }).loss;
                    if (l < best - 1e-4) { best = l; P = Q; } else break;
                }
            });
            console.log(r, k, best.toFixed(3), JSON.stringify(P));
        });
        step *= 0.5;
        fs.writeFileSync(file, JSON.stringify(P));
    }
}
if (require.main === module) show(compare(P, { iters: 200 }));
module.exports = { compare, OPEN, PAIRS, tab };
