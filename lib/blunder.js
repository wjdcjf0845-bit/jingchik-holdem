// 💥 치명적 플레이 기록 — 리포트에 "어떤 상황에서 어떻게 쳤고 무엇이 문제였나"를 보여주기 위한 순수 로직.
//   기준은 학습 조언(getGtoAdvice)과 같다: 내가 고른 액션의 권장 빈도가 15% 미만이고 권장 액션도 아닐 때만 실수로 본다.
//   손실은 "그 결정 하나로 기대값이 얼마나 깎였나"의 어림값(bb) — 실제 그 판의 결과(운)와는 따로 적는다.
const GtoAdvice = require('./gtoadvice');

const KINDS = {
    overfold:    { name: '이길 만한 패를 접음',          tip: '상대 벳 크기에 비해 내 승률이 충분했습니다. 팟오즈(콜 금액 ÷ 콜 뒤 팟)보다 승률이 높으면 접지 마세요.' },
    freefold:    { name: '공짜로 볼 수 있는데 접음',      tip: '낼 칩이 없을 때는 접을 이유가 없습니다. 체크하면 공짜로 다음 카드를 봅니다.' },
    overcall:    { name: '접어야 할 패로 콜',            tip: '승률이 팟오즈에 못 미치는 콜이 쌓이면 가장 크게 샙니다. "혹시나"로 따라가지 마세요.' },
    spew:        { name: '접어야 할 패로 레이즈·올인',    tip: '약한 패로 판을 키우면 더 좋은 패만 따라옵니다. 블러프는 상대가 접을 수 있는 자리·크기에서만 하세요.' },
    badbluff:    { name: '체크할 자리에서 무리한 벳',     tip: '쇼다운 가치가 있는 어중간한 패는 체크로 싸게 쇼다운을 보는 게 낫습니다.' },
    missedvalue: { name: '강한 패로 벳을 안 함',          tip: '강한 패는 직접 벳해서 팟을 키워야 합니다. 체크만 하면 상대가 공짜 카드를 받고 팟도 작게 끝납니다.' },
    passive:     { name: '레이즈할 패로 콜만 함',         tip: '강한 패로 콜만 하면 약한 패들이 싸게 따라와 뒤집힙니다. 레이즈로 값을 받으세요.' },
    overraise:   { name: '콜이 맞는 자리에서 레이즈',     tip: '콜로 충분한 패를 레이즈하면 더 좋은 패에게만 판을 키워 줍니다.' }
};
const KIND_KEYS = Object.keys(KINDS);
const MAX_KEEP = 40, MAX_AGE = 30 * 86400000;

// ctx: { bb, pot(액션 전 팟: 깔린 칩 전부), toCall, putIn(이번 액션으로 더 넣은 칩), equity(0~1), street('preflop'|'flop'|'turn'|'river') }
// 반환: null(실수 아님) 또는 { kind, costBB }
function assess(advice, type, ctx) {
    if (!advice || !advice.mix || !ctx || !(ctx.bb > 0)) return null;
    if (GtoAdvice.wrongSize(advice, type)) return null;
    const key = GtoAdvice.actionKey(advice, type);
    const best = advice.bestAction;
    const pct = advice.mix[key] || 0;
    if (key === best || pct >= 15) return null;
    const pot = Math.max(0, ctx.pot || 0), toCall = Math.max(0, ctx.toCall || 0), putIn = Math.max(0, ctx.putIn || 0);
    const eq = Math.max(0, Math.min(1, ctx.equity || 0));
    const pre = ctx.street === 'preflop';     // 프리플랍의 승률 숫자는 "아무 패 한 명 상대"라 EV 계산에 쓰지 않는다
    let kind, cost;
    if (type === 'fold') {
        if (toCall <= 0) { kind = 'freefold'; cost = pot * 0.3; }
        else {
            kind = 'overfold';
            cost = pre ? pot * (best === 'raise' ? 0.35 : 0.25) : Math.max(eq * (pot + toCall) - toCall, pot * 0.1);
        }
    } else if (type === 'call') {
        if (best === 'fold') { kind = 'overcall'; cost = pre ? toCall * 0.35 : Math.max(toCall - eq * (pot + toCall), toCall * 0.1); }
        else { kind = 'passive'; cost = pot * 0.15; }
    } else if (type === 'check') {
        kind = 'missedvalue'; cost = pot * 0.25;
    } else {
        if (best === 'fold') { kind = 'spew'; cost = putIn * (pre ? 0.35 : Math.max(0.15, 0.55 - eq)); }
        else if (best === 'check') { kind = 'badbluff'; cost = putIn * 0.2; }
        else { kind = 'overraise'; cost = putIn * 0.15; }
    }
    const costBB = Math.round(cost / ctx.bb * 10) / 10;
    if (!(costBB > 0)) return null;
    return { kind, costBB };
}

// 목록에 넣는다. 30일 지난 것은 버리고, 넘치면 "하루 넘은 것 중 가장 가벼운 것"부터 뺀다(방금 친 판은 리포트에 꼭 남게).
function add(list, rec, now) {
    const t = now || Date.now();
    const arr = Array.isArray(list) ? list.filter(r => r && typeof r.t === 'number' && t - r.t <= MAX_AGE) : [];
    arr.push(rec);
    while (arr.length > MAX_KEEP) {
        const old = arr.filter(r => t - r.t > 86400000);
        const pool = old.length ? old : arr.slice(0, -1);
        let worst = pool[0];
        pool.forEach(r => { if ((r.costBB || 0) < (worst.costBB || 0)) worst = r; });
        arr.splice(arr.indexOf(worst), 1);
    }
    return arr;
}

// since 이후의 기록 중 손실이 큰 순으로 n개
function top(list, since, n) {
    return (Array.isArray(list) ? list : []).filter(r => r && r.t >= (since || 0))
        .sort((a, b) => (b.costBB || 0) - (a.costBB || 0) || b.t - a.t).slice(0, n || 3);
}

// 표준어로 바꾸기 전에 저장된 기록에는 예전 말투가 남아 있다 — 보여줄 때 고친다
function std(t) {
    return String(t || '').replace(/니데이/g, '니다').replace(/니꺼/g, '니까').replace(/으이소/g, '으세요').replace(/([가-힣])이소(?![가-힣])/g, '$1세요');
}
const STREET_KO = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };
const ACT_KO = { fold: '폴드', check: '체크', call: '콜', raise: '레이즈', allin: '올인', bet: '벳' };
const bbTxt = x => (Math.round((x || 0) * 10) / 10) + 'bb';

// 저장된 기록 → 화면에 보여줄 글 (상황 · 내 플레이 · 권장 · 문제 · 결과)
function describe(r) {
    const k = KINDS[r.kind] || { name: '실수', tip: '' };
    const facing = r.toCallBB > 0;
    const situ = [STREET_KO[r.street] || r.street];
    if (r.pos) situ.push(r.pos + ' 자리');
    situ.push(r.seats === 2 ? '헤즈업' : `${r.seats}명 테이블`);
    if (r.street !== 'preflop' || r.opp !== r.seats - 1) situ.push(`상대 ${r.opp}명 남음`);
    situ.push(`팟 ${bbTxt(r.potBB)}`);
    situ.push(facing ? `상대 벳에 콜 ${bbTxt(r.toCallBB)} 필요` : '체크 가능');
    situ.push(`내 스택 ${bbTxt(r.stackBB)}`);
    const bestKo = r.best === 'raise' && r.allinBest ? '올인' : (ACT_KO[r.best] || r.best);
    let did = ACT_KO[r.act] || r.act;
    if (r.amtBB > 0 && r.act !== 'fold' && r.act !== 'check') did += ` ${bbTxt(r.amtBB)}`;
    return {
        t: r.t, kind: r.kind, title: k.name, costBB: r.costBB, learn: !!r.learn, modeLabel: r.modeLabel || '',
        hand: r.hand || [], board: r.board || [],
        situation: situ.join(' · '),
        did, should: bestKo, shouldPct: r.bestPct, didPct: r.didPct,
        why: std(r.reason) + ((r.act === 'raise' || r.act === 'allin') && r.potBB > 0 && r.amtBB >= r.potBB * 1.5
            ? ` (팟 ${bbTxt(r.potBB)}에 ${bbTxt(r.amtBB)}를 걸었습니다 — 팟의 ${(r.amtBB / r.potBB).toFixed(1)}배.)` : ''),
        tip: k.tip,
        equity: r.eq, potOdds: r.odds, equityLabel: r.eqLabel || '내 승률',
        netBB: (typeof r.netBB === 'number') ? r.netBB : null
    };
}

module.exports = { KINDS, KIND_KEYS, assess, add, top, describe, std, MAX_KEEP };
