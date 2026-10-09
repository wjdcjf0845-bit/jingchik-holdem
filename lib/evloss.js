// 📉 EV 손실 — "그 결정으로 기대값을 몇 bb 잃었나". 전문 분석 도구와 같은 단위로 실력을 잰다.
//   예전 점수는 "권장과 같은 버튼을 눌렀는가"를 셌다. 그러면 1bb 짜리 결정과 50bb 짜리 결정이 같은 무게가 되고,
//   전부 콜하는 사람과 전부 접는 사람이 비슷한 점수가 된다. EV 손실은 판돈이 큰 실수일수록 크게 잡힌다.
//
//   원칙
//   · 권장 액션을 골랐으면 손실 0.
//   · 균형 전략에서 "섞는" 액션(권장 비중 25% 이상)은 기대값이 같다 → 손실 0.
//   · 그 밖에는 손실을 계산한다. 콜/폴드는 승률과 팟 크기로 정확히 나오고(EV(콜) = 승률 × 콜 뒤 팟 − 콜 금액),
//     벳·레이즈·체크는 상대가 접을 확률을 모르므로 어림값을 쓴다(아래 식에 표시).
//   · 프리플랍은 조언이 넘겨주는 값(ev.call = 상대 범위 상대 승률 × 실현율로 낸 콜의 기대값, ev.open = 오픈의 기대값 어림)을 쓴다.
const GtoAdvice = require('./gtoadvice');

const GRADES = {
    best:    { name: '정확',     hint: '권장 액션' },
    good:    { name: '좋음',     hint: '섞어 치는 범위 안' },
    inacc:   { name: '부정확',   hint: '0.5bb 미만 손실' },
    mistake: { name: '실수',     hint: '0.5~2bb 손실' },
    blunder: { name: '큰 실수',  hint: '2bb 이상 손실' }
};
const GRADE_KEYS = Object.keys(GRADES);
const MAX_LOSS = 10;

// ctx: { bb, pot(액션 전 팟 — 깔린 칩 전부, 내 것 포함), toCall, putIn(이번 액션으로 더 넣은 칩), street, equity(0~1), opponents }
// advice.ev (선택): { call: 콜의 기대값(칩), open: 오픈 레이즈의 기대값(칩) }
// 반환: { lossBB, grade, kind }
function of(advice, type, ctx) {
    if (!advice || !advice.mix || !ctx || !(ctx.bb > 0)) return null;
    if (type === 'allin' && advice.allinIsCall) type = 'call';
    const key = GtoAdvice.actionKey(advice, type);
    const best = advice.bestAction, pct = advice.mix[key] || 0;
    const sizeWrong = GtoAdvice.wrongSize(advice, type);
    const bb = ctx.bb, pot = Math.max(0, ctx.pot || 0), toCall = Math.max(0, ctx.toCall || 0), putIn = Math.max(0, ctx.putIn || 0);
    // 지나치게 큰 벳·레이즈(올인이 기준이 아닌 자리에서 팟의 3배 넘게): 좋은 패는 상대를 다 접게 만들어 값을 못 받고, 나쁜 패는 받아 주는 패에게만 진다.
    //   어림: 3배를 넘긴 칩의 4%. (100bb 오픈 올인 ≈ 3.8bb)
    const allinOk = typeof advice.sizeHint === 'string' && advice.sizeHint.indexOf('올인') === 0;
    const over = ((type === 'raise' || type === 'allin') && !allinOk) ? Math.max(0, putIn - toCall - 3 * (pot + toCall)) * 0.04 : 0;
    if (over <= 0) {
        if (key === best && !sizeWrong) return { lossBB: 0, grade: 'best', kind: null };
        if (pct >= 25 && !sizeWrong) return { lossBB: 0, grade: 'good', kind: null };
    } else if (key === best || pct >= 25) {
        const l = Math.round(over / bb * 100) / 100;
        if (l < 0.1) return { lossBB: 0, grade: 'best', kind: null };
        return { lossBB: Math.min(MAX_LOSS, l), grade: l < 0.5 ? 'inacc' : l < 2 ? 'mistake' : 'blunder', kind: 'overraise' };
    }

    const eq = Math.max(0, Math.min(1, ctx.equity || 0));
    const pre = ctx.street === 'preflop', multi = (ctx.opponents || 1) >= 2;
    const ev = advice.ev || {};
    // 콜의 기대값(칩): 프리플랍은 조언이 준 값, 플랍 이후는 승률로 직접
    const evCall = toCall > 0 ? (typeof ev.call === 'number' ? ev.call : (pre ? null : eq * (pot + toCall) - toCall)) : null;
    const floor = x => Math.max(x, 0.1 * bb);          // 권장과 다른 선택의 최소 손실(0.1bb) — 계산이 0 근처로 나와도 "차이 없음"으로 치지 않는다
    // 플랍 이후의 승률은 "상대가 벳하는 범위"를 추정해서 낸 값이라 오차가 있다. 오차 범위(콜 뒤 팟의 8%) 안쪽은 실수로 세지 않는다 —
    //   안 그러면 추정이 틀린 만큼이 전부 플레이어의 손실로 잡힌다(한쪽으로만 쌓이는 오차).
    const margin = pre ? 0 : 0.08 * (pot + toCall);
    let kind, loss;

    if (sizeWrong) { kind = 'overraise'; loss = 0.5 * bb; }        // 올인이 기준인 스택에서 작게 레이즈 — 방향은 맞다
    else if (type === 'fold') {
        if (toCall <= 0) { kind = 'freefold'; loss = Math.max(pot * (pre ? 0.25 : Math.max(0.15, eq * 0.6)), 0.3 * bb); }      // 공짜인데 접음: 그 패가 가진 팟 지분을 버렸다(어림)
        else {
            kind = 'overfold';
            if (evCall != null && evCall > 0) loss = floor(evCall - margin);                          // 정확: 콜의 기대값을 버렸다
            else if (evCall != null) loss = floor(pot * 0.04);                                         // 콜의 기대값이 0 근처(임플라이드·드로우로 받는 자리) — 접어도 손실은 작다
            else if (pre && typeof ev.open === 'number' && ev.open > 0) loss = floor(ev.open);          // 열 수 있는 패를 접음
            else loss = floor(pot * (pre ? 0.2 : 0.1));                                                // 어림
        }
    } else if (type === 'call') {
        if (best === 'fold') {
            kind = 'overcall';
            if (evCall != null && evCall < 0) loss = floor(-evCall - margin);                         // 정확: 콜의 기대값이 음수
            else if (evCall != null) loss = floor(toCall * 0.05);                                      // 기대값은 0 근처인데 접는 쪽이 조금 나은 자리
            else if (pre && toCall > 0 && typeof ev.open === 'number') loss = floor(Math.max(-ev.open * 0.6, toCall * 0.15));   // 오픈도 못 할 패로 림프
            else loss = floor(toCall * (pre ? 0.3 : 0.15));                                            // 어림
        } else { kind = 'passive'; loss = floor(pre ? 0.3 * bb : pot * 0.08); }                        // 레이즈할 패로 콜만(어림: 놓친 값의 일부)
    } else if (type === 'check') {
        kind = 'missedvalue'; loss = floor(pot * Math.max(0.05, Math.min(0.35, (eq - 0.5) * 0.9)));     // 밸류 벳을 안 함(어림: 강할수록 크게)
    } else {
        const extra = Math.max(0, putIn - toCall);                                                     // 콜 금액보다 더 넣은 칩
        if (best === 'fold') {
            kind = 'spew';
            const base = evCall != null && evCall < 0 ? -evCall : toCall * (pre ? 0.3 : 0.15);
            const openLoss = pre && toCall <= bb && typeof ev.open === 'number' && ev.open < 0 ? -ev.open : null;     // 오픈 범위 밖 패로 오픈
            loss = floor(openLoss != null ? openLoss + Math.max(0, putIn - 4 * bb) * 0.04 : base + extra * (pre ? 0.2 : Math.max(0.1, 0.5 - eq)));          // 어림: 더 넣은 칩 중 승률이 모자란 만큼
        } else if (best === 'check') { kind = 'badbluff'; loss = floor(putIn * (multi ? 0.35 : 0.2)); }                 // 어림: 벳이 통할 확률이 낮은 자리
        else { kind = 'overraise'; loss = floor(extra * 0.12); }                                                        // 콜이 맞는 자리의 레이즈(어림)
    }
    // 권장 비중이 15~25% 인 선택은 "가끔은 나오는" 플레이 — 손실을 절반만 본다
    if (pct >= 15) loss *= 0.5;
    loss += over;
    // 한 결정의 손실은 최대 MAX_LOSS bb 로 센다 — 수백 bb 짜리 한 판이 점수 전체를 좌우하지 않게(그런 판은 승률 추정 오차도 가장 크다)
    const lossBB = Math.min(MAX_LOSS, Math.round(loss / bb * 100) / 100);
    const grade = lossBB < 0.5 ? 'inacc' : lossBB < 2 ? 'mistake' : 'blunder';
    return { lossBB, grade, kind };
}

// 실력 점수: 100판당 EV 손실(bb) → 0~100. 손실 0 = 100점, L0(bb/100판)을 잃으면 50점.
//   L0 = 25: 전부 접기만 하는 사람이 이론상 잃는 양(6인 약 25bb/100판)이 50점 근처가 되게 잡았다.
//   실측(scratch/score_check.js, 2026-10-09) 6인: 평범한 타이트 15bb → 63점 · 전부 폴드 21bb → 54점 · 무작위 282bb → 8점 · 전부 콜 823bb → 3점.
const L0 = 25;
function scoreFromLoss(loss100) { return Math.round(100 / (1 + Math.max(0, loss100) / L0)); }

// 누적 통계 → { loss100, se100, score, lo, hi, hands }.  obj: { evLoss(bb 합), evLossSq(판별 손실 제곱 합), evHands }
//   🪑 [인원 보정] 같은 실력이라도 인원이 적을수록 한 판에 잃는 양이 크다 — 블라인드가 그만큼 자주 돌아오고 결정도 많기 때문이다.
//      전부 접기만 하는 사람은 이론상 100판당 150 ÷ 인원 bb 를 잃는다(6인 25 · 4인 37.5 · 3인 50 · 헤즈업 75).
//      그래서 판마다 손실에 (인원 ÷ 6)을 곱해 "6인 기준"으로 맞춘 값(evLossN)으로 점수를 낸다. 안 그러면 헤즈업을 많이 친 사람의 점수가 낮게 나온다.
function seatFactor(seats) { return Math.max(2, Math.min(6, seats || 6)) / 6; }
function index(obj) {
    const n = obj && obj.evHands > 0 ? obj.evHands : 0;
    if (!n) return null;
    const hasN = obj.evLossN != null;
    const mean = ((hasN ? obj.evLossN : obj.evLoss) || 0) / n;
    const varr = Math.max(0, ((hasN ? obj.evLossNSq : obj.evLossSq) || 0) / n - mean * mean);
    const se = n > 1 ? Math.sqrt(varr / n) : mean;
    const loss100 = mean * 100, se100 = se * 100;
    const score = scoreFromLoss(loss100);
    // 95% 구간: 손실이 클수록 점수는 낮다 → 손실 하한이 점수 상한
    const hi = scoreFromLoss(Math.max(0, loss100 - 1.96 * se100)), lo = scoreFromLoss(loss100 + 1.96 * se100);
    // loss100 = 점수에 쓰는 값(6인 기준 환산), raw100 = 실제로 잃은 기대값 그대로, seats = 평균 인원
    return { loss100: Math.round(loss100 * 10) / 10, raw100: Math.round((obj.evLoss || 0) / n * 1000) / 10, seats: obj.evSeats > 0 ? Math.round(obj.evSeats / n * 10) / 10 : null,
        se100: Math.round(se100 * 10) / 10, score, lo, hi, pm: Math.max(1, Math.round((hi - lo) / 2)), hands: n };
}

module.exports = { GRADES, GRADE_KEYS, of, index, scoreFromLoss, seatFactor, L0, MAX_LOSS };
