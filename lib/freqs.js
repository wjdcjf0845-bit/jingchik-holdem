// 📊 상황별 빈도 — "그 자리에서 몇 번 중 몇 번 했나"를 기준과 나란히.
//   한 번의 블러프나 한 번의 폴드가 맞았는지는 따질 수 없다. 하지만 "c벳을 100번 중 78번 했다"는 따질 수 있다.
//   기준은 고정된 숫자가 아니라 "그때 들고 있던 패로 조언이 권한 빈도의 평균"이다 — 좋은 패가 많이 들어와서 많이 올린 것은 치우침이 아니다.
//   통계 칸: fqN_<상황>(기회) · fqA_<상황>(실제로 한 횟수) · fqE_<상황>(조언대로였다면 했을 횟수의 기댓값)
const SPOTS = {
    open_UTG:  { name: '오픈 — UTG',          act: '오픈',  hi: '앞자리에서 너무 넓게 엽니다. 뒤에 다섯 명이 남아 있어 좁고 강한 패만 여는 자리입니다.', lo: '앞자리 오픈이 너무 좁습니다. 범위표 안의 패는 접지 말고 여세요.' },
    open_HJ:   { name: '오픈 — HJ',           act: '오픈',  hi: 'HJ에서 너무 넓게 엽니다.', lo: 'HJ 오픈이 너무 좁습니다.' },
    open_CO:   { name: '오픈 — CO',           act: '오픈',  hi: 'CO에서 너무 넓게 엽니다. 버튼이 뒤에 남아 있습니다.', lo: 'CO 오픈이 좁습니다. 전체 패의 4분의 1쯤은 여는 자리입니다.' },
    open_BTN:  { name: '오픈 — 버튼',         act: '오픈',  hi: '버튼에서도 여는 패에는 한계가 있습니다. 범위표 밖의 패는 접으세요.', lo: '버튼 오픈이 너무 좁습니다. 가장 넓게(절반 가까이) 여는 자리인데 블라인드를 훔칠 기회를 놓치고 있습니다.' },
    open_SB:   { name: '오픈 — SB',           act: '오픈',  hi: 'SB에서 너무 자주 올립니다.', lo: 'SB에서 너무 자주 접습니다. BB 한 명만 남은 자리라 넓게 싸울 수 있습니다.' },
    bbdef:     { name: 'BB 방어',             act: '계속',  hi: 'BB에서 너무 넓게 받습니다. 앞자리 오픈·큰 오픈에는 좁혀야 합니다.', lo: 'BB에서 너무 자주 접습니다. 이미 1bb를 냈고 마지막에 행동하므로 가장 넓게 지키는 자리입니다 — 블라인드를 계속 뺏기고 있습니다.' },
    threebet:  { name: '3벳',                 act: '3벳',   hi: '3벳이 너무 잦습니다. 4벳을 맞으면 접어야 하는 패가 많아집니다.', lo: '3벳이 너무 드뭅니다. 강한 패뿐 아니라 A5s 같은 블러프 3벳도 섞어야 상대가 편하게 열지 못합니다.' },
    vs3bet:    { name: '3벳 받고 계속',       act: '계속',  hi: '3벳에 너무 넓게 따라갑니다. 포지션 없이 큰 팟을 약한 패로 치게 됩니다.', lo: '3벳에 너무 자주 접습니다. 상대가 아무 패로나 3벳해도 이득을 봅니다.' },
    cbet:      { name: '플랍 c벳',            act: '벳',    hi: 'c벳이 너무 잦습니다. 보드가 내 범위에 불리하거나 상대가 여럿이면 체크가 맞는 자리가 많습니다.', lo: 'c벳이 너무 드뭅니다. 프리플랍에 올린 사람은 플랍에서 작게라도 자주 벳하는 것이 이득입니다.' },
    vsflopbet: { name: '플랍 벳에 폴드',      act: '폴드',  hi: '플랍 벳에 너무 자주 접습니다. 상대가 아무 패로나 벳해도 이득을 봅니다.', lo: '플랍 벳에 너무 안 접습니다. 맞은 것도 드로우도 없는 패는 놓아야 합니다.' },
    barrel:    { name: '턴 두 번째 벳',       act: '벳',    hi: '턴에 너무 자주 또 벳합니다. 플랍을 따라온 범위는 강해져 있습니다.', lo: '턴에 너무 자주 멈춥니다. 플랍에 벳하고 턴에 체크하면 약한 패라고 알려 주는 셈입니다.' },
    riverbet:  { name: '리버 벳',             act: '벳',    hi: '리버 벳이 너무 잦습니다. 더 좋은 패만 따라오는 벳이 섞여 있습니다.', lo: '리버에 벳이 너무 드뭅니다. 이기고 있는 패로 값을 못 받고 있습니다.' },
    rivercall: { name: '리버 벳에 콜',        act: '콜',    hi: '리버에서 너무 넓게 콜합니다. 리버의 큰 벳은 대체로 강합니다.', lo: '리버에서 너무 자주 접습니다. 팟오즈가 좋은 자리의 블러프 캐치를 놓치고 있습니다.' }
};
const SPOT_KEYS = Object.keys(SPOTS);

// 지금 결정이 어느 상황인가 → { id, did(했나), exp(조언이 권한 빈도 0~1) } 또는 null
//   c: { street, mix, type, isRaise, toCall, pos, isBB, raisesBefore, iRaised, limpers, pfAggressor(앞 스트리트 마지막 레이즈가 나), allinIsCall }
function spotOf(c) {
    if (!c || !c.mix) return null;
    const m = c.mix, pR = ((m.raise || 0) + (m.bet || 0)) / 100, pF = (m.fold || 0) / 100;
    const raised = !!c.isRaise && !(c.type === 'allin' && c.allinIsCall);
    const folded = c.type === 'fold';
    if (c.street === 'preflop') {
        const rb = c.raisesBefore || 0;
        if (rb === 0) {
            if (c.isBB || (c.limpers || 0) > 0) return null;        // 림프 팟은 따로 세지 않는다
            const p = c.pos || '';
            const k = p.indexOf('UTG') === 0 ? 'UTG' : (p === 'LJ' || p === 'MP' || p === 'HJ') ? 'HJ' : (p === 'CO' || p === 'BTN' || p === 'SB') ? p : null;
            return k ? { id: 'open_' + k, did: raised, exp: pR } : null;
        }
        if (rb === 1 && !c.iRaised) {
            // BB 는 '방어'와 '3벳' 두 가지를 다 본다
            const out = [{ id: 'threebet', did: raised, exp: pR }];
            if (c.isBB) out.push({ id: 'bbdef', did: !folded, exp: 1 - pF });
            return out;
        }
        if (rb === 2 && c.iRaised) return { id: 'vs3bet', did: !folded, exp: 1 - pF };
        return null;
    }
    const facing = (c.toCall || 0) > 0;
    if (c.street === 'flop') {
        if (!facing) return c.pfAggressor ? { id: 'cbet', did: raised, exp: pR } : null;
        return { id: 'vsflopbet', did: folded, exp: pF };
    }
    if (c.street === 'turn') return (!facing && c.pfAggressor) ? { id: 'barrel', did: raised, exp: pR } : null;
    if (c.street === 'river') return facing ? { id: 'rivercall', did: !folded, exp: 1 - pF } : { id: 'riverbet', did: raised, exp: pR };
    return null;
}
// 통계 칸에 더할 값
function fields(spot) {
    const out = {};
    (Array.isArray(spot) ? spot : (spot ? [spot] : [])).forEach(s => {
        out['fqN_' + s.id] = 1;
        if (s.did) out['fqA_' + s.id] = 1;
        if (s.exp > 0) out['fqE_' + s.id] = Math.round(s.exp * 1e4) / 1e4;
    });
    return out;
}
// 누적 → 표. 기회가 MIN 번 이상인 상황만. 차이가 8%p 이상이고 표본 오차(2σ)도 넘을 때만 "치우침"으로 본다.
const MIN = 12;
function summarize(a) {
    if (!a) return [];
    return SPOT_KEYS.map(id => {
        const n = a['fqN_' + id] || 0;
        if (n < MIN) return null;
        const act = (a['fqA_' + id] || 0) / n, ref = Math.min(1, (a['fqE_' + id] || 0) / n);
        const diff = act - ref, se = Math.sqrt(Math.max(0.0025, ref * (1 - ref)) / n);
        const off = Math.abs(diff) >= 0.08 && Math.abs(diff) >= 2 * se;
        const S = SPOTS[id];
        return { id, name: S.name, act: S.act, n, actual: Math.round(act * 100), ref: Math.round(ref * 100), diff: Math.round(diff * 100),
            verdict: off ? (diff > 0 ? 'high' : 'low') : 'ok', tip: off ? (diff > 0 ? S.hi : S.lo) : '' };
    }).filter(Boolean);
}

module.exports = { SPOTS, SPOT_KEYS, spotOf, fields, summarize, MIN };
