// 🔍 상대의 프리플랍 범위 — "그 사람이 프리플랍에 한 행동"으로 들고 있을 만한 패에 무게를 준다.
//   예전의 플랍 이후 승률은 상대 패를 "아무 두 장 중 이 보드에 강한 상위 몇 %"로 봤다. 그러면 UTG 에서 열고 들어온 사람도
//   72o 로 투페어를 들고 있을 수 있다고 계산하게 된다. 실제로는 UTG 오픈 범위에 72o 가 없다.
//   여기서는 프리플랍 행동(어느 자리에서 열었나 · 콜했나 · 3벳했나)을 범위표(lib/ranges.js · lib/preflop.js)에 넣어 패마다 0~1 의 무게를 낸다.
//   사람도 봇도 범위표대로만 치지는 않으므로, 범위 밖의 패에도 작은 무게(FLOOR)를 남긴다.
const PF = require('./preflop');
const Ranges = require('./ranges');

const HU_OPEN_SCORE = 35;      // lib/gtoquiz.js 와 같은 값(헤즈업 버튼 오픈 기준)
const FLOOR = 0.06;

// 행동 하나의 무게. a: { kind: 'raise'|'call'|'check', raisesBefore, openerPos, iRaised }
function actWeight(code, pos, a, headsUp, inPosition) {
    const rb = a.raisesBefore || 0, score = PF.handRangeScore(code);
    if (a.kind === 'raise') {
        if (rb === 0) {
            if (headsUp) return score > HU_OPEN_SCORE ? 1 : 0;
            if (pos === 'BB') return PF.isInOpenRange(code, 'CO') ? 1 : 0;        // 림프 팟에서 BB 가 올림
            return PF.isInOpenRange(code, pos) ? 1 : 0;
        }
        const f = Ranges.lookup({ heroPos: pos, openerPos: a.openerPos, raises: rb, iRaised: !!a.iRaised, headsUp, inPosition }, code);
        return f ? f.raise / 100 : (score >= 78 ? 1 : 0);
    }
    if (a.kind === 'call') {
        if (rb === 0) return score >= 80 ? 0.35 : 1;                              // 림프: 아주 강한 패는 대개 올렸을 것
        const f = Ranges.lookup({ heroPos: pos, openerPos: a.openerPos, raises: rb, iRaised: !!a.iRaised, headsUp, inPosition }, code);
        return f ? f.call / 100 : (score >= 55 ? 1 : 0.2);
    }
    return score >= 80 ? 0.35 : 1;                                                // 체크(BB 의 공짜 플랍)
}

// line: { pos, headsUp, inPosition, acts: [...] } → 패 코드 → 무게(0~1)
function weightFn(line) {
    if (!line || !Array.isArray(line.acts) || !line.acts.length) return null;
    const cache = {};
    return code => {
        if (cache[code] != null) return cache[code];
        let w = 1;
        line.acts.forEach(a => { w *= actWeight(code, line.pos || '', a, !!line.headsUp, !!line.inPosition); });
        return (cache[code] = FLOOR + (1 - FLOOR) * Math.max(0, Math.min(1, w)));
    };
}
// 범위의 폭(%) — 화면 설명·검사용
function widthOf(fn) {
    if (!fn) return 100;
    let n = 0;
    Ranges.ALL.forEach(c => { n += fn(c) * Ranges.combos(c); });
    return Math.round(n / 13.26);
}
// 프리플랍 액션 기록(순서대로) → 한 사람의 행동 줄. log: [{ nick, type, amount }] (블라인드 포함), posOf: nick → 자리
function lineFromLog(log, nick, bb, posOf) {
    let hi = bb, raises = 0, opener = '';
    const acts = [], raisedBy = new Set();
    (log || []).forEach(e => {
        if (!e || e.type === 'sb' || e.type === 'bb' || e.type === 'ante') return;
        const isRaise = (e.type === 'raise' || e.type === 'allin') && e.amount > hi;
        const kind = isRaise ? 'raise' : (e.type === 'check' ? 'check' : (e.type === 'call' || e.type === 'allin') ? 'call' : null);
        if (e.nick === nick && kind) acts.push({ kind, raisesBefore: raises, openerPos: opener, iRaised: raisedBy.has(nick) });
        if (isRaise) { hi = e.amount; raises++; opener = posOf(e.nick) || ''; raisedBy.add(e.nick); }
    });
    return acts;
}

module.exports = { weightFn, widthOf, lineFromLog, actWeight, FLOOR };
