// 🧮 프리플랍 어림 모형 — 20~40bb 의 오픈·콜·3벳 범위를 만들기 위한 도구.
//   가진 솔버는 플랍 이후 전용이라 프리플랍을 풀지 못한다. 그래서 프리플랍만 직접 푼다:
//     · 올인으로 끝나는 가지는 패 대 패 승률표로 정확히 계산한다(lib/pfeq.bin.gz).
//     · 플랍을 보는 가지(콜)는 "팟의 몫 = 승률 × 실현율"로 어림한다. 실현율은 자리(포지션 유무)·주도권·패의 생김새(수딧·연결·작은 페어)·SPR 로 정한다.
//   실현율의 숫자들은 100bb 솔버 자료(lib/preflopdata.json.gz)에 맞춰 고른다(tools/pfmodel_fit.js). 같은 모형을 얕은 스택에 적용한 것이 결과물이다.
//   솔직하게: 얕은 스택에서 이 모형이 맞는지 견줄 정답은 없다. 100bb 에서 솔버와 얼마나 맞는지만 확인할 수 있다.
const Jam = require('../lib/jam');
const Ranges = require('../lib/ranges');
const N = Jam.N, ALL = Ranges.ALL, RK = '23456789TJQKA';
const POS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

// 패의 생김새
const FEAT = ALL.map(code => {
    const hi = RK.indexOf(code[0]), lo = RK.indexOf(code[1]), pair = code.length === 2, s = code[2] === 's' ? 1 : 0;
    const gap = hi - lo - 1;
    let conn = pair ? 0 : gap === 0 ? 1 : gap === 1 ? 0.75 : gap === 2 ? 0.45 : gap === 3 ? 0.2 : 0;
    if (!pair && hi === 12 && lo <= 3) conn = Math.max(conn, 0.3);         // 휠 에이스
    if (!pair && lo <= 1) conn *= 0.7;
    return { s, pair: pair ? 1 : 0, conn, small: pair ? (12 - hi) / 12 : 0, high: (hi + lo) / 24 };
});

// 실현율 = 1 + (SPR 이 깊을수록 커지는 정도) × (자리 + 주도권 + 패의 생김새) − 잡패 감점.
//   SPR 이 0 에 가까우면(곧 올인) 누구나 승률만큼 가져간다(실현율 1). 포지션·주도권·수딧·연결·작은 페어의 값은 뒤에 칠 칩이 많을수록 커진다.
//   ip·oop: 포지션이 있을 때/없을 때의 가감 · init: 마지막으로 올린 쪽의 가산 · s·c·p: 수딧·연결·작은 페어 · o: 오프수트 잡패 감점 · g: SPR 곡선의 휘어짐
//   sq: 받는 사람 뒤에 아직 사람이 남았을 때, 한 명당 '스퀴즈를 맞아 콜한 칩을 버리게 될' 확률
const DEF = { ip: 0.05, oop: -0.2, init: 0.1, s: 0.12, c: 0.10, p: 0.15, o: 0.18, sq: 0.1, g: 1 };

// 실현율 표(길이 169): role 'ip'|'oop', init 주도권(마지막으로 올린 쪽) 여부, spr
function realize(P, role, init, spr) {
    const phi = Math.pow(Math.min(1, Math.log(1 + Math.max(0, spr)) / Math.log(18)), P.g || 1);
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const f = FEAT[i];
        const r = 1 + phi * ((role === 'ip' ? P.ip : P.oop) + (init ? P.init : 0) + P.s * f.s + P.c * f.conn * (f.s ? 1 : 0.5) + P.p * f.small)
            - P.o * (0.4 + 0.6 * phi) * (1 - f.s) * (1 - f.conn) * (1 - f.pair) * (1 - f.high);
        out[i] = Math.max(0.3, Math.min(1.8, r));
    }
    return out;
}

// 한 판(연 사람 O 대 받는 사람 D, 나머지는 전부 접음)을 푼다.
// cfg: { S 유효 스택, open O의 오픈 크기, postO·postD 이미 낸 블라인드, dead 그 밖의 죽은 돈(다른 블라인드·앤티),
//        tb 3벳 크기(없으면 3벳 = 올인만), fb 4벳 크기(없으면 4벳 = 올인), jam0 D가 오픈에 바로 올인할 수 있나,
//        dIP D가 플랍 이후 포지션이 있나, rake·rakeCap, prior O의 오픈 범위(길이 169, 0~1), iters }
// 반환: { d0: {F,C,R,J}[169], o1: {F,C,A}, d2, o3, oj, evO[169](O가 열었을 때 이 판의 기대값, 시작 대비), foldD[169](O의 패별로 D가 접을 확률) }
function solve(P, cfg) {
    const m = Jam.load(), W = m.w, E = m.eq;
    const S = cfg.S, x = cfg.open, dead = cfg.dead, T = cfg.iters || 200;
    const rake = pot => pot - Math.min((cfg.rake || 0) * pot, cfg.rakeCap || 0);
    const roleO = cfg.dIP ? 'oop' : 'ip', roleD = cfg.dIP ? 'ip' : 'oop';
    // 몫 행렬: share[i*N+j] = O 의 팟 몫
    const shareM = (inv, initO) => {
        const pot = dead + 2 * inv, spr = (S - inv) / pot;
        const rO = realize(P, roleO, initO, spr), rD = realize(P, roleD, !initO, spr), M = new Float64Array(N * N);
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const e = E[i * N + j], a = e * rO[i], b = (1 - e) * rD[j]; M[i * N + j] = a + b > 0 ? a / (a + b) : 0.5; }
        return { M, pot: rake(pot), inv };
    };
    const tb = cfg.tb && cfg.tb < 0.45 * S ? cfg.tb : null, fb = tb && cfg.fb && cfg.fb < 0.45 * S ? cfg.fb : null;
    const fold = (winner, invO, invD) => ({ t: 'fold', winner, invO, invD });
    const show = () => ({ t: 'show', pot: rake(dead + 2 * S), inv: S });
    const flop = (inv, initO) => Object.assign({ t: 'flop' }, shareM(inv, initO));
    // 트리
    const OJ = { p: 'O', name: 'oj', acts: [['F', fold('D', x, S)], ['K', show()]] };
    let O1 = null;
    if (tb) {
        let A;
        if (fb) {
            const O3 = { p: 'O', name: 'o3', acts: [['F', fold('D', fb, S)], ['K', show()]] };
            const D2 = { p: 'D', name: 'd2', acts: [['F', fold('O', fb, tb)], ['C', flop(fb, true)], ['J', O3]] };
            A = D2;
        } else A = { p: 'D', name: 'd2', acts: [['F', fold('O', S, tb)], ['K', show()]] };
        O1 = { p: 'O', name: 'o1', acts: [['F', fold('D', x, tb)], ['C', flop(tb, false)], ['A', A]] };
    }
    const srp = flop(x, true); srp.sq = 1 - Math.pow(1 - Math.min(0.9, P.sq || 0), cfg.behind || 0);
    const d0acts = [['F', fold('O', x, cfg.postD)], ['C', srp]];
    if (O1) d0acts.push(['R', O1]);
    if (cfg.jam0 || !O1) d0acts.push(['J', OJ]);
    const D0 = { p: 'D', name: 'd0', acts: d0acts };
    const nodes = []; (function walk(n) { if (n.p) { n.reg = n.acts.map(() => new Float64Array(N)); n.sum = n.acts.map(() => new Float64Array(N)); nodes.push(n); n.acts.forEach(a => walk(a[1])); } })(D0);

    const matO = (M, r, k, out) => { for (let i = 0; i < N; i++) { let a = 0; const o = i * N; for (let j = 0; j < N; j++) a += W[o + j] * r[j] * (M ? M[o + j] : 1); out[i] += k * a; } };
    const matD = (M, r, k, out, inv) => { for (let j = 0; j < N; j++) { let a = 0; for (let i = 0; i < N; i++) a += W[i * N + j] * r[i] * (M ? (inv ? 1 - M[i * N + j] : M[i * N + j]) : 1); out[j] += k * a; } };
    // 반환: [vO, vD] (반사실 가치). rO·rD: 각자의 도달 확률
    function cfr(n, rO, rD, w) {
        const vO = new Float64Array(N), vD = new Float64Array(N);
        if (n.t === 'fold') {
            if (n.winner === 'O') { matO(null, rD, dead + n.invD, vO); matD(null, rO, -n.invD, vD); }
            else { matO(null, rD, -n.invO, vO); matD(null, rO, dead + n.invO, vD); }
            return [vO, vD];
        }
        if (n.t === 'show' || n.t === 'flop') {
            const M = n.t === 'show' ? E : n.M;
            matO(M, rD, n.pot, vO); matO(null, rD, -n.inv, vO);
            matD(M, rO, n.pot * (1 - (n.sq || 0)), vD, true); matD(null, rO, -n.inv, vD);
            return [vO, vD];
        }
        const A = n.acts.length, isO = n.p === 'O', sig = n.acts.map(() => new Float64Array(N));
        for (let h = 0; h < N; h++) { let tot = 0; for (let a = 0; a < A; a++) tot += Math.max(0, n.reg[a][h]); for (let a = 0; a < A; a++) sig[a][h] = tot > 0 ? Math.max(0, n.reg[a][h]) / tot : 1 / A; }
        const kids = [];
        for (let a = 0; a < A; a++) {
            const r2 = new Float64Array(N), base = isO ? rO : rD;
            for (let h = 0; h < N; h++) r2[h] = base[h] * sig[a][h];
            kids.push(isO ? cfr(n.acts[a][1], r2, rD, w) : cfr(n.acts[a][1], rO, r2, w));
        }
        const mine = isO ? 0 : 1, other = 1 - mine, vm = isO ? vO : vD, vo = isO ? vD : vO, reach = isO ? rO : rD;
        for (let a = 0; a < A; a++) { const km = kids[a][mine], ko = kids[a][other]; for (let h = 0; h < N; h++) { vm[h] += sig[a][h] * km[h]; vo[h] += ko[h]; } }
        for (let a = 0; a < A; a++) { const km = kids[a][mine], rg = n.reg[a], sm = n.sum[a]; for (let h = 0; h < N; h++) { rg[h] = Math.max(0, rg[h] + km[h] - vm[h]); sm[h] += w * reach[h] * sig[a][h]; } }
        return [vO, vD];
    }
    const one = new Float64Array(N).fill(1), prior = cfg.prior || one;
    for (let it = 1; it <= T; it++) cfr(D0, prior, one, it);
    // 평균 전략
    const avg = n => { const o = {}; n.acts.forEach((a, k) => { o[a[0]] = new Float64Array(N); }); for (let h = 0; h < N; h++) { let tot = 0; n.acts.forEach((a, k) => { tot += n.sum[k][h]; }); n.acts.forEach((a, k) => { o[a[0]][h] = tot > 0 ? n.sum[k][h] / tot : 1 / n.acts.length; }); } return o; };
    const out = {}; nodes.forEach(n => { out[n.name] = avg(n); });
    // 평균 전략으로 O 의 기대값(패별, 열었다는 조건) 과 D 가 접을 확률
    nodes.forEach(n => { n.fixed = out[n.name]; });
    function evalO(n, rD) {
        const v = new Float64Array(N);
        if (n.t === 'fold') { if (n.winner === 'O') matO(null, rD, dead + n.invD, v); else matO(null, rD, -n.invO, v); return v; }
        if (n.t) { matO(n.t === 'show' ? E : n.M, rD, n.pot, v); matO(null, rD, -n.inv, v); return v; }
        if (n.p === 'D') { n.acts.forEach(a => { const r2 = new Float64Array(N); for (let h = 0; h < N; h++) r2[h] = rD[h] * n.fixed[a[0]][h]; const k = evalO(a[1], r2); for (let h = 0; h < N; h++) v[h] += k[h]; }); return v; }
        // O 는 평균 전략을 따른다
        n.acts.forEach(a => { const k = evalO(a[1], rD); for (let h = 0; h < N; h++) v[h] += n.fixed[a[0]][h] * k[h]; });
        return v;
    }
    const raw = evalO(D0, one), norm = new Float64Array(N), fd = new Float64Array(N);
    matO(null, one, 1, norm); matO(null, out.d0.F, 1, fd);
    out.evO = raw.map((v, i) => v / norm[i]); out.foldD = fd.map((v, i) => v / norm[i]);
    out.hasR = !!O1; out.hasFb = !!fb;
    return out;
}

// 자리 설정: O 가 열고 D 가 받는 판의 숫자들. env: { S, ante(죽은 앤티), open, openSB, tbIP·tbOOP(3벳 배수), fbMul(4벳 배수), jam0, rake, rakeCap }
function spot(env, O, D, pos) {
    pos = pos || POS;
    const postO = O === 'SB' ? 0.5 : 0, postD = D === 'SB' ? 0.5 : D === 'BB' ? 1 : 0;
    const open = O === 'SB' ? env.openSB : env.open;
    const dIP = !(D === 'SB' || D === 'BB');            // 블라인드가 받으면 연 사람이 포지션, 그 밖엔 받는 사람이 포지션(SB 오픈 대 BB 는 BB 가 포지션)
    const dPos = O === 'SB' ? true : dIP;
    const tb = open * (dPos ? env.tbIP : env.tbOOP);
    return { S: env.S, open, postO, postD, dead: 1.5 + (env.ante || 0) - postO - postD, tb, fb: env.fbMul ? tb * env.fbMul : null,
        jam0: !!env.jam0, dIP: dPos, rake: env.rake || 0, rakeCap: env.rakeCap || 0, behind: Math.max(0, pos.length - 1 - pos.indexOf(D)) };
}

const ENV100 = { S: 100, ante: 0, open: 2.5, openSB: 3.0, tbIP: 3.4, tbOOP: 4.4, fbMul: 2.2, jam0: false, rake: 0.05, rakeCap: 0.6 };
// 대회용: 깊이별 크기(작게 열고, 3벳도 작게, 4벳은 올인)
function envMtt(S, ante) {
    return { S, ante: ante ? 1 : 0, open: S <= 25 ? 2.0 : 2.2, openSB: S <= 25 ? 2.5 : 3.0, tbIP: S <= 30 ? 2.6 : 3.0, tbOOP: S <= 30 ? 3.2 : 3.8, fbMul: null, jam0: S <= 40, rake: 0, rakeCap: 0 };
}

// 오픈 범위까지 같이 맞춘다: 오픈 범위 → 각 수비자와의 판 → 오픈의 기대값 → 오픈 범위 … 를 되풀이.
// 반환: { open: { POS: Float64Array(169) }, vs: { 'O>D': solve 결과 } }
//   opt.pos: 자리 목록(기본 6인 POS). 9인이면 ['UTG','UTG1','UTG2','LJ','HJ','CO','BTN','SB','BB'] — 마지막 둘이 블라인드여야 한다.
function solveAll(P, env, opt) {
    opt = opt || {};
    const pos = opt.pos || POS, nO = pos.length - 1;
    const open = {}, vs = {};
    pos.slice(0, nO).forEach(O => { open[O] = opt.open && opt.open[O] ? Float64Array.from(opt.open[O]) : new Float64Array(N).fill(0.3); });
    const rounds = opt.fixedOpen ? 1 : (opt.rounds || 4);
    for (let r = 0; r < rounds; r++) {
        pos.slice(0, nO).forEach((O, oi) => {
            const defs = pos.slice(oi + 1), postO = O === 'SB' ? 0.5 : 0, winAll = 1.5 + (env.ante || 0) - postO;
            const res = defs.map(D => (vs[O + '>' + D] = solve(P, Object.assign(spot(env, O, D, pos), { prior: open[O], iters: opt.iters || 150 }))));
            if (opt.fixedOpen) return;
            // 오픈의 기대값: 앞사람부터 접으면 다음 사람과의 판. (둘 이상이 같이 들어오는 경우는 무시)
            const nw = new Float64Array(N);
            for (let h = 0; h < N; h++) {
                let pAll = 1, ev = 0;
                res.forEach(q => { ev += pAll * (q.evO[h] - q.foldD[h] * winAll); pAll *= q.foldD[h]; });
                ev += pAll * winAll;
                nw[h] = ev > -postO ? 1 : 0;
            }
            for (let h = 0; h < N; h++) open[O][h] = 0.5 * open[O][h] + 0.5 * nw[h];
        });
    }
    return { open, vs };
}

const pctOf = (arr, prior) => { const m = Jam.load(); let a = 0, b = 0; for (let i = 0; i < N; i++) { const w = m.combos[i] * (prior ? prior[i] : 1); a += w * arr[i]; b += w; } return b > 0 ? a / b : 0; };

module.exports = { solve, solveAll, spot, realize, ENV100, envMtt, DEF, POS, FEAT, pctOf, N, ALL };
