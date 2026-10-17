// 🏁 딥스택 실력 비교 — 사람마다 표준 지표(VPIP · PFR · 3벳 · AF · 벳에 폴드 · 쇼다운 승률)를 뽑고,
//    기준 범위 · 친구들과의 차이로 "무엇이 다른지"를 짧게 적는다. 순수 함수라 시험한다.
//    기준 범위는 대회(MTT) 딥스택의 흔한 건강 범위 어림값이다. 평균 테이블 인원이 적으면 VPIP · PFR 범위를 넓힌다.
const MIN = { pre: 50, tb: 30, af: 30, ftb: 30, sd: 15 };
const pct = (a, b, min) => (b >= min ? Math.round(a / b * 1000) / 10 : null);
function ranges(seats) {
    const r = seats >= 6 ? { vpip: [17, 28], pfr: [13, 22] } : seats >= 4.2 ? { vpip: [22, 36], pfr: [17, 28] } : { vpip: [30, 55], pfr: [22, 40] };
    return Object.assign(r, { tb: [5, 11], af: [1.8, 4], ftb: [40, 58], wsd: [48, 60], gap: [2, 10] });
}
// fnStats 하나 → 지표
function metrics(F) {
    F = F || {};
    const seats = F.seatCnt > 0 ? Math.round(F.seatSum / F.seatCnt * 10) / 10 : 9;
    return {
        seats,
        vpip: pct(F.vpipHands || 0, F.preflopOpps || 0, MIN.pre),
        pfr: pct(F.pfrHands || 0, F.preflopOpps || 0, MIN.pre),
        tb: pct(F.threeBetCount || 0, F.threeBetOpps || 0, MIN.tb),
        af: (F.aggrBets || 0) + (F.aggrCalls || 0) >= MIN.af && F.aggrCalls > 0 ? Math.round(F.aggrBets / F.aggrCalls * 10) / 10 : null,
        ftb: pct(F.foldToBet || 0, F.faceBet || 0, MIN.ftb),
        wsd: pct(F.wonAtShowdown || 0, F.wentToShowdown || 0, MIN.sd),
        net100: (F.netHands || 0) >= 30 ? Math.round((F.netBB || 0) / F.netHands * 100) : null
    };
}
// 가장 크게 새는 실수 종류(100판당 bb). kinds: { key: { name } }
function topLeak(F, kinds) {
    const h = (F && F.evHands) || 0;
    if (h < 30) return null;
    let best = null;
    Object.keys(kinds || {}).forEach(k => { const bb = (F['lkB_' + k] || 0); if (bb > 0 && (!best || bb > best.bb)) best = { key: k, name: kinds[k].name, bb, n: F['lkN_' + k] || 0 }; });
    return best ? { key: best.key, name: best.name, n: best.n, per100: Math.round(best.bb / h * 1000) / 10 } : null;
}
const LABEL = { vpip: 'VPIP', pfr: 'PFR', tb: '3벳', af: 'AF', ftb: '벳에 폴드', wsd: '쇼다운 승률' };
const NOTE_LABEL = Object.assign({ gap: 'VPIP−PFR' }, LABEL);
const WORD = { vpip: ['좁음', '넓음'], pfr: ['소극적', '공격적'], tb: ['적음', '많음'], af: ['소극적', '공격적'], ftb: ['적게 접음', '많이 접음'], wsd: ['낮음 — 약한 패로 끝까지 가는 편', '높음 — 너무 많이 접는 신호'], gap: ['레이즈 위주', '콜 위주'] };
const unit = k => (k === 'af' ? '' : k === 'gap' ? '%p' : '%');
// 한 칸의 판정: 'lo' · 'hi' · 'ok' · null(표본 부족) 과 벗어난 정도(범위 폭 기준)
function judge(k, v, R) {
    if (v == null) return { v: null, s: null, d: 0 };
    const [lo, hi] = R[k], w = Math.max(1, hi - lo);
    if (v < lo) return { v, s: 'lo', d: (lo - v) / w };
    if (v > hi) return { v, s: 'hi', d: (v - hi) / w };
    return { v, s: 'ok', d: 0 };
}
// rows: [{ nick, me, score, pm, loss100, games, itm, wins, avgPlace, hands, st: metrics(), leak: topLeak() }]
//  → 같은 rows 에 cells(지표별 판정) · notes(짧은 차이 설명 1~3개)를 붙인다
function analyze(rows) {
    const keys = Object.keys(LABEL);
    const scored = rows.filter(r => r.score != null);
    const bestScore = scored.length > 1 ? Math.max(...scored.map(r => r.score)) : null;
    const lowLoss = scored.length > 1 ? Math.min(...scored.map(r => r.loss100)) : null;
    return rows.map(r => {
        const st = r.st || {}, R = ranges(st.seats || 9);
        const cells = {}; keys.forEach(k => { cells[k] = Object.assign(judge(k, st[k], R), { range: R[k] }); });
        // 참여한 판 중 콜로 들어간 정도(VPIP − PFR): 크면 콜 위주 — 표에는 없고 설명에만
        const gapV = st.vpip != null && st.pfr != null ? Math.round((st.vpip - st.pfr) * 10) / 10 : null;
        const cand = Object.assign({}, cells, { gap: Object.assign(judge('gap', gapV, R), { range: R.gap }) });
        const notes = [];
        if (bestScore != null && r.score === bestScore) notes.push({ t: 'good', s: `실력 점수 1위(${r.score})` });
        else if (lowLoss != null && r.loss100 === lowLoss) notes.push({ t: 'good', s: `EV 손실 가장 적음(${r.loss100}bb/100)` });
        const off = Object.keys(cand).filter(k => cand[k].s === 'lo' || cand[k].s === 'hi').sort((a, b) => cand[b].d - cand[a].d).slice(0, 2);
        off.forEach(k => { const c = cand[k]; notes.push({ t: 'warn', s: `${NOTE_LABEL[k]} ${c.v}${unit(k)} ${WORD[k][c.s === 'hi' ? 1 : 0]}(기준 ${c.range[0]}~${c.range[1]}${unit(k)})` }); });
        if (r.leak) notes.push({ t: 'leak', s: `최대 누수: ${r.leak.name} ${r.leak.per100}bb/100` });
        if (!off.length && keys.some(k => cells[k].s === 'ok')) notes.push({ t: 'good', s: '표준 지표가 모두 기준 범위 안' });
        if ((r.hands || 0) < 300) notes.push({ t: 'info', s: `표본 ${r.hands || 0}판 — 아직 참고만` });
        return Object.assign({}, r, { cells, notes });
    });
}
module.exports = { metrics, topLeak, analyze, ranges, LABEL, MIN };
