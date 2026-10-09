// 🌊 리버 계산기 — 리버 한 스트리트를 "범위 대 범위"로 직접 푼다(CFR+).
//   리버는 카드가 더 안 나오므로 나무가 작다. 양쪽 범위(패와 무게)와 팟·남은 스택만 있으면 수십 ms 에 균형 전략이 나온다.
//   푸는 나무(벳 크기 하나):
//     N0 먼저 행동하는 쪽(OOP): 체크 / 벳
//     N1 OOP 체크 뒤 IP: 체크(쇼다운) / 벳          N3 그 벳을 받은 OOP: 폴드 / 콜
//     N2 OOP 벳을 받은 IP: 폴드 / 콜
//   레이즈는 넣지 않았다(리버 레이즈는 드물고, 넣으면 나무가 몇 배가 된다) — 한계로 적어 둔다.
//   값의 기준: 리버 시작 시점. 접으면 0, 쇼다운에서 이기면 +팟 + 상대가 이번 스트리트에 넣은 칩, 지면 −내가 넣은 칩, 비기면 +팟/2.
const { Hand } = require('pokersolver');

// 7장 패의 세기를 비교 가능한 값으로 — pokersolver 로 한 번씩만 풀고 서로 비교해 순위를 매긴다
function rankHands(board, hands) {
    const solved = hands.map(h => Hand.solve(h.concat(board)));
    const order = solved.map((s, i) => i).sort((x, y) => { const w = Hand.winners([solved[x], solved[y]]); return w.length === 2 ? 0 : (w[0] === solved[x] ? 1 : -1); });
    const rank = new Array(hands.length); let r = 0;
    order.forEach((idx, k) => { if (k > 0) { const w = Hand.winners([solved[order[k - 1]], solved[idx]]); if (w.length !== 2) r++; } rank[idx] = r; });
    return rank;
}

// 입력: { board(5장), pot, stack(남은 유효 스택), bet(벳 금액 — 없으면 팟의 2/3), oop: [{ hand:[c1,c2], w }], ip: [...], iters }
// 반환: { oop: [{ hand, w, sBet, sCall, evCheck, evBet, evCall }], ip: [{ hand, w, sBet, sCall, evCheck, evBet, evCall }], bet }
//   sBet = (자기 차례에) 벳할 빈도, sCall = 벳을 받았을 때 콜할 빈도. ev* = 그 패로 그 액션을 골랐을 때의 기대값(칩, 상대는 균형 전략).
function solve(g) {
    const P = g.pot, b = Math.max(0, Math.min(g.bet != null ? g.bet : Math.round(P * 0.66), g.stack));
    const A = g.oop, B = g.ip, n1 = A.length, n2 = B.length;
    if (!n1 || !n2 || !(P > 0)) return null;
    const all = A.map(x => x.hand).concat(B.map(x => x.hand)), rk = rankHands(g.board, all);
    // 짝마다: 0 같이 못 듦(카드 겹침) · 1 OOP 승 · 2 비김 · 3 OOP 패
    const M = new Uint8Array(n1 * n2);
    for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
        const h = A[i].hand, k = B[j].hand;
        if (h[0] === k[0] || h[0] === k[1] || h[1] === k[0] || h[1] === k[1]) continue;
        const d = rk[i] - rk[n1 + j];
        M[i * n2 + j] = d > 0 ? 1 : d === 0 ? 2 : 3;
    }
    const a = Float64Array.from(A.map(x => x.w)), bw = Float64Array.from(B.map(x => x.w));
    const mk = n => ({ r0: new Float64Array(n), r1: new Float64Array(n), s: new Float64Array(n).fill(0.5), acc: new Float64Array(n), den: new Float64Array(n) });
    const N0 = mk(n1), N3 = mk(n1), N1 = mk(n2), N2 = mk(n2);      // r0 = 수동(체크·폴드) 후회, r1 = 적극(벳·콜) 후회, s = 적극 쪽 빈도
    const upd = (nd, i, vPass, vAct, wAvg, t) => {
        const cur = nd.s[i] * vAct + (1 - nd.s[i]) * vPass;
        nd.r0[i] = Math.max(0, nd.r0[i] + vPass - cur); nd.r1[i] = Math.max(0, nd.r1[i] + vAct - cur);
        nd.acc[i] += t * wAvg * nd.s[i]; nd.den[i] += t * wAvg;
        const z = nd.r0[i] + nd.r1[i]; nd.s[i] = z > 0 ? nd.r1[i] / z : 0.5;
    };
    const sdO = (m, c) => (m === 1 ? P + c : m === 2 ? P / 2 : -c), sdI = (m, c) => (m === 3 ? P + c : m === 2 ? P / 2 : -c);
    const iters = g.iters || 300;
    const vBet = new Float64Array(n1), vChk = new Float64Array(n1), vCall3 = new Float64Array(n1);
    const vCall2 = new Float64Array(n2), vChk1 = new Float64Array(n2), vBet1 = new Float64Array(n2);
    const evalAll = (S0, S3, S1, S2) => {
        vBet.fill(0); vChk.fill(0); vCall3.fill(0); vCall2.fill(0); vChk1.fill(0); vBet1.fill(0);
        for (let i = 0; i < n1; i++) {
            const ai = a[i], s0 = S0[i], s3 = S3[i], row = i * n2;
            for (let j = 0; j < n2; j++) {
                const m = M[row + j]; if (!m) continue;
                const bj = bw[j], o0 = sdO(m, 0), ob = sdO(m, b), i0 = sdI(m, 0), ib = sdI(m, b);
                // OOP 의 값(상대 도달 확률 bj 로 가중)
                vBet[i] += bj * (S2[j] * ob + (1 - S2[j]) * P);
                vChk[i] += bj * (1 - S1[j]) * o0;
                vCall3[i] += bj * S1[j] * ob;
                // IP 의 값(상대 도달 확률 ai 로 가중)
                vCall2[j] += ai * s0 * ib;
                vChk1[j] += ai * (1 - s0) * i0;
                vBet1[j] += ai * (1 - s0) * (s3 * ib + (1 - s3) * P);
            }
        }
    };
    for (let t = 1; t <= iters; t++) {
        evalAll(N0.s, N3.s, N1.s, N2.s);
        for (let i = 0; i < n1; i++) {
            const chkTotal = vChk[i] + N3.s[i] * vCall3[i];        // 체크했을 때: 상대가 체크하면 쇼다운, 벳하면 내 N3 전략대로
            const reachChk = 1 - N0.s[i];
            upd(N3, i, 0, vCall3[i], reachChk, t);
            upd(N0, i, chkTotal, vBet[i], 1, t);
        }
        for (let j = 0; j < n2; j++) { upd(N2, j, 0, vCall2[j], 1, t); upd(N1, j, vChk1[j], vBet1[j], 1, t); }
    }
    const avg = nd => nd.acc.map((x, i) => (nd.den[i] > 0 ? x / nd.den[i] : 0.5));
    const S0 = avg(N0), S3 = avg(N3), S1 = avg(N1), S2 = avg(N2);
    evalAll(S0, S3, S1, S2);
    // 기대값은 "그 패와 같이 들 수 있는 상대 패의 무게"로 나눠 한 판의 값으로 만든다
    const massO = new Float64Array(n1), massI = new Float64Array(n2), massO3 = new Float64Array(n1), massI2 = new Float64Array(n2);
    for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) { if (!M[i * n2 + j]) continue; massO[i] += bw[j]; massI[j] += a[i] * (1 - S0[i]); massO3[i] += bw[j] * S1[j]; massI2[j] += a[i] * S0[i]; }
    const dv = (x, m) => (m > 1e-12 ? x / m : 0);
    return {
        bet: b,
        oop: A.map((x, i) => ({ hand: x.hand, w: x.w, sBet: S0[i], sCall: S3[i], evBet: dv(vBet[i], massO[i]), evCheck: dv(vChk[i] + S3[i] * vCall3[i], massO[i]), evCall: dv(vCall3[i], massO3[i]) })),
        ip: B.map((x, j) => ({ hand: x.hand, w: x.w, sBet: S1[j], sCall: S2[j], evBet: dv(vBet1[j], massI[j]), evCheck: dv(vChk1[j], massI[j]), evCall: dv(vCall2[j], massI2[j]) }))
    };
}

module.exports = { solve, rankHands };
