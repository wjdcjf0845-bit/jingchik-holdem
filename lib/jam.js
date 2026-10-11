// 🧨 프리플랍 올인 승부를 직접 푼다 — 올인(푸시·리쉬브)과 그 올인을 받는 범위의 균형.
//   올인 승부는 뒤에 벳이 없어서 "패 대 패 승률"만 있으면 정확히 계산된다(플랍 이후 플레이를 어림할 필요가 없다).
//   재료: lib/pfeq.bin.gz — 패 종류 169 × 169 의 쇼다운 승률과, 두 종류가 동시에 나올 수 있는 조합 수(tools/pfeq_build.js 로 만든다).
//
//   푸는 방법: 가상 플레이(fictitious play). 미는 쪽은 "상대의 지금까지 평균 전략"에 가장 좋은 대응을, 받는 쪽도 마찬가지로 하고 평균을 갱신한다.
//   둘이 붙는 게임에서는 평균 전략이 균형으로 모인다.
//   어림한 것(솔직하게): 받는 사람이 여럿이면 "먼저 받는 한 명"만 본다(둘이 같이 받는 경우는 무시) — 그래서 뒤에 사람이 많을수록 미는 범위가 조금 넓게 나온다.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const Ranges = require('./ranges');

const N = Ranges.ALL.length;
let M = null;
function load() {
    if (M !== null) return M;
    try {
        const buf = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'pfeq.bin.gz')));
        const eq = new Float64Array(N * N), w = new Float64Array(N * N);
        for (let i = 0; i < N * N; i++) { eq[i] = buf.readUInt16LE(i * 2) / 65535; w[i] = buf[N * N * 2 + i]; }
        const idx = {}; Ranges.ALL.forEach((c, i) => { idx[c] = i; });
        const combos = Ranges.ALL.map(c => Ranges.combos(c));
        M = { eq, w, idx, combos };
    } catch (e) { M = false; }
    return M;
}

// 패 a 가 패 b 를 상대로 이길 확률(쇼다운까지)
function equity(a, b) { const m = load(); return m ? m.eq[m.idx[a] * N + m.idx[b]] : null; }

// 패 하나의 "범위 상대 승률". range: 길이 169 의 가중치(그 패를 들고 있을 확률 × 그 행동을 할 확률). 카드 겹침을 반영한다.
function equityVs(code, range) {
    const m = load(); if (!m) return null;
    const i = m.idx[code]; let a = 0, b = 0;
    for (let j = 0; j < N; j++) { const x = m.w[i * N + j] * range[j]; a += x * m.eq[i * N + j]; b += x; }
    return b > 0 ? a / b : null;
}

// o: { pot 지금 팟에 깔린 칩 전부(bb, 모두의 블라인드·앤티·오픈 포함),
//      hero: { stack 전체 칩, posted 이미 낸 칩 },
//      callers: [{ stack, posted, prior? }] 행동 순서대로. prior = 길이 169, 그 사람이 지금까지의 행동으로 그 패를 들고 있을 확률(없으면 아무 패),
//      iters? }
// 반환: { jam[169] 미는 빈도, ev[169] 밀었을 때의 기대값(bb, 접는 것 대비), jamPct, call: [받는 빈도 169], callPct: [..] }
function solve(o) {
    const m = load(); if (!m) return null;
    const W = m.w, E = m.eq, T = o.iters || 80, K = o.callers.length;
    const hero = o.hero, pot = o.pot;
    const cs = o.callers.map(c => {
        const eff = Math.min(hero.stack, c.stack);
        const riskH = eff - hero.posted, riskC = eff - c.posted;
        return { riskH, riskC, total: pot + riskH + riskC, prior: c.prior || null };
    });
    const s = new Float64Array(N).fill(0.5), t = cs.map(() => new Float64Array(N).fill(0.3));
    const ev = new Float64Array(N), q = new Float64Array(K), eqk = new Float64Array(K);
    const heroEv = () => {
        for (let i = 0; i < N; i++) {
            for (let k = 0; k < K; k++) {
                const c = cs[k], pr = c.prior, tk = t[k]; let all = 0, called = 0, won = 0;
                for (let j = 0; j < N; j++) {
                    const x = W[i * N + j] * (pr ? pr[j] : 1); if (!x) continue;
                    all += x; const y = x * tk[j]; called += y; won += y * E[i * N + j];
                }
                q[k] = all > 0 ? called / all : 0; eqk[k] = called > 0 ? won / called : 0.5;
            }
            let pNo = 1, v = 0;
            for (let k = 0; k < K; k++) { v += pNo * q[k] * (eqk[k] * cs[k].total - cs[k].riskH); pNo *= 1 - q[k]; }
            ev[i] = v + pNo * pot;
        }
    };
    for (let it = 0; it < T; it++) {
        heroEv();
        const a = 1 / (it + 2);
        for (let i = 0; i < N; i++) s[i] += a * ((ev[i] > 0 ? 1 : 0) - s[i]);
        for (let k = 0; k < K; k++) {
            const c = cs[k], tk = t[k];
            for (let j = 0; j < N; j++) {
                let den = 0, num = 0;
                for (let i = 0; i < N; i++) { const x = W[i * N + j] * s[i]; if (!x) continue; den += x; num += x * (1 - E[i * N + j]); }
                const callEv = den > 0 ? (num / den) * c.total - c.riskC : -1;
                tk[j] += a * ((callEv > 0 ? 1 : 0) - tk[j]);
            }
        }
    }
    heroEv();
    const tot = m.combos.reduce((x, y) => x + y, 0);
    const pctOf = (arr, pr) => { let a = 0, b = 0; for (let i = 0; i < N; i++) { const x = m.combos[i] * (pr ? pr[i] : 1); a += x * arr[i]; b += x; } return b > 0 ? a / b : 0; };
    return { jam: s, ev, jamPct: pctOf(s), call: t, callPct: t.map((x, k) => pctOf(x, cs[k].prior)), total: tot };
}

// 결과를 조금씩 다른 숫자마다 다시 풀지 않게 기억해 둔다(스택은 1bb, 팟은 0.5bb 단위로 묶는다)
const CACHE = new Map();
function solveCached(o, tag) {
    const r1 = x => Math.round(x), r5 = x => Math.round(x * 2) / 2;
    const key = [tag || '', r5(o.pot), r1(o.hero.stack), r5(o.hero.posted)].concat(o.callers.map(c => r1(c.stack) + ':' + r5(c.posted) + ':' + (c.tag || ''))).join('|');
    let v = CACHE.get(key);
    if (v) { CACHE.delete(key); CACHE.set(key, v); return v; }
    v = solve({ pot: r5(o.pot), hero: { stack: r1(o.hero.stack), posted: r5(o.hero.posted) }, callers: o.callers.map(c => ({ stack: r1(c.stack), posted: r5(c.posted), prior: c.prior })), iters: o.iters });
    if (v) { CACHE.set(key, v); if (CACHE.size > 400) CACHE.delete(CACHE.keys().next().value); }
    return v;
}

// 미는 순위: 기대값이 높은 패부터 세어 그 패가 위에서 몇 %째인가(0~1). ICM 으로 범위를 넓히거나 좁힐 때 쓴다.
function rankOf(res, code) {
    const m = load(); if (!m || !res) return 1;
    const i = m.idx[code]; let above = 0, tot = 0;
    for (let j = 0; j < N; j++) { tot += m.combos[j]; if (res.ev[j] > res.ev[i]) above += m.combos[j]; }
    return (above + m.combos[i] / 2) / tot;
}

// 올인의 기대값이 thr(bb) 를 넘는 패의 비율(0~1)
function fracAbove(res, thr) {
    const m = load(); if (!m || !res) return 0;
    let a = 0, tot = 0; for (let j = 0; j < N; j++) { tot += m.combos[j]; if (res.ev[j] > thr) a += m.combos[j]; }
    return a / tot;
}

module.exports = { load, equity, equityVs, solve, solveCached, rankOf, fracAbove, N };
