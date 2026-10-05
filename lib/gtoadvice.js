'use strict';
// ═══════════════════════════════════════════════════════════
//  gtoadvice.js — 🎓 학습모드 포스트플랍 조언 (상황별)
//
//  예전 조언은 "내 승률" 하나로만 갈랐다. 그래서 헤즈업이든 4명이든, 포지션이 좋든 나쁘든,
//  스택이 팟의 절반이든 20배든 같은 말을 했다. 여기서는 같은 승률이라도
//    · 상대 수   — 4명 상대로 승률 40%는 평균(20%)의 두 배인 강한 패다. 블러프는 사람이 늘수록 안 통한다.
//    · 포지션    — 뒤에서 치면(IP) 얇게 벳할 수 있고, 앞에서 치면(OOP) 체크가 늘어난다.
//    · 스택 깊이 — 남은 스택이 팟보다 작으면(SPR 낮음) 강한 패는 그대로 올인까지 간다.
//  를 반영한다. 서버 본문에서 떼어 순수 함수로 둔 이유는 단위 테스트로 "상황이 다르면 조언이 달라진다"를 못박기 위해서다.
// ═══════════════════════════════════════════════════════════

// 여러 명 상대 승률을 "한 명 상대였다면"으로 환산 (독립 가정: 전원을 이길 확률 = p^n)
function headsUpEquivalent(equity, opponents) {
    const n = Math.max(1, opponents || 1);
    const e = Math.max(0, Math.min(1, equity));
    return Math.pow(e, 1 / n);
}

// 임플라이드 오즈로 콜할 만한가: 강한 드로우(8아웃 이상)이고, 완성됐을 때 더 받아야 하는 칩이
//   "리버에 팟의 60% 벳 한 번" 이내이며, 상대에게 그 1.5배 이상이 남아 있을 때.
function impliedCall(ctx, equity) {
    const d = ctx.draw;
    if (!d || d.outs < 8 || d.weak || !(equity > 0.05) || !(ctx.toCall > 0) || !(ctx.pot > 0)) return false;
    const potAfter = ctx.pot + ctx.toCall;
    const extra = ctx.toCall / equity - potAfter;          // 본전이 되려면 완성 후 더 받아야 하는 칩
    if (extra <= 0) return false;                           // 이미 가격이 맞는다(다른 분기에서 처리)
    return extra <= potAfter * 0.6 && (ctx.behind || 0) >= extra * 1.5;
}

function tierOf(pHU) {
    if (pHU >= 0.75) return { tier: 5, tierLabel: '매우 강함', tierColor: '#7bedaa' };
    if (pHU >= 0.60) return { tier: 4, tierLabel: '강함', tierColor: '#a8e063' };
    if (pHU >= 0.47) return { tier: 3, tierLabel: '중간', tierColor: '#ffd97a' };
    if (pHU >= 0.33) return { tier: 2, tierLabel: '약함', tierColor: '#ffa94d' };
    return { tier: 1, tierLabel: '매우 약함', tierColor: '#ff6b6b' };
}

// 프리플랍 등급 — 핸드 점수 기준. (예전엔 "승률 추정치 ÷ √상대 수"로 매겨서 6인 테이블의 TT 가 '약함', AK 가 '중간'으로 나왔다)
function preflopTier(score) {
    if (score >= 85) return { tier: 5, tierLabel: '매우 강함', tierColor: '#7bedaa' };
    if (score >= 70) return { tier: 4, tierLabel: '강함', tierColor: '#a8e063' };
    if (score >= 55) return { tier: 3, tierLabel: '중간', tierColor: '#ffd97a' };
    if (score >= 42) return { tier: 2, tierLabel: '약함', tierColor: '#ffa94d' };
    return { tier: 1, tierLabel: '매우 약함', tierColor: '#ff6b6b' };
}

// ── 드로우 찾기 ──────────────────────────────────────────────
//   내 홀카드를 쓰는 플러시 드로우(9아웃) · 양방 스트레이트 드로우(8) · 것샷(4). 이미 완성된 패는 드로우가 아니다.
//   반환: { outs, label, flush, straightRanks } 또는 null. (리버에는 드로우가 없다)
const _ORD = '23456789TJQKA';
function detectDraws(hand, board) {
    if (!Array.isArray(hand) || hand.length !== 2 || !Array.isArray(board) || board.length < 3 || board.length > 4) return null;
    const all = hand.concat(board);
    if (all.some(c => typeof c !== 'string' || c.length < 2 || _ORD.indexOf(c[0]) < 0)) return null;
    // 플러시 드로우
    const suitCount = {};
    all.forEach(c => { suitCount[c[1]] = (suitCount[c[1]] || 0) + 1; });
    if (Object.values(suitCount).some(n => n >= 5)) return null;                     // 이미 플러시
    const flush = hand.some(c => suitCount[c[1]] === 4);
    // 내 홀카드 한 장만 쓰는(보드에 그 무늬가 3장) 낮은 플러시 드로우는 완성돼도 자주 진다 → '약한'으로 표시하고 임플라이드 콜 근거로 쓰지 않는다
    const fSuit = flush ? hand.find(c => suitCount[c[1]] === 4)[1] : null;
    const myOfSuit = flush ? hand.filter(c => c[1] === fSuit) : [];
    const weakFlush = flush && myOfSuit.length === 1 && _ORD.indexOf(myOfSuit[0][0]) < 9;      // J 미만 한 장
    // 스트레이트: 숫자 하나를 더했을 때 내 홀카드를 포함한 5연속이 생기는가
    const have = new Set(all.map(c => _ORD.indexOf(c[0])));
    const holes = new Set(hand.map(c => _ORD.indexOf(c[0])));
    const run = (set, needHole) => {
        for (let lo = -1; lo <= 8; lo++) {                                           // lo=-1 은 A-2-3-4-5
            let ok = true, usesHole = false;
            for (let k = 0; k < 5; k++) {
                const r = lo + k === -1 ? 12 : lo + k;
                if (!set.has(r)) { ok = false; break; }
                if (holes.has(r)) usesHole = true;
            }
            if (ok && (!needHole || usesHole)) return true;
        }
        return false;
    };
    if (run(have, false)) return null;                                                 // 이미 스트레이트
    let straightRanks = 0;
    for (let r = 0; r <= 12; r++) {
        if (have.has(r)) continue;
        const s2 = new Set(have); s2.add(r);
        if (run(s2, true)) straightRanks++;
    }
    if (!flush && straightRanks === 0) return null;
    const outs = (flush ? 9 : 0) + straightRanks * 4 - (flush ? straightRanks : 0);   // 겹치는 카드(그 무늬의 스트레이트 카드)는 한 번만
    const parts = [];
    if (flush) parts.push(weakFlush ? '약한 플러시 드로우' : '플러시 드로우');
    if (straightRanks >= 2) parts.push('양방 스트레이트 드로우'); else if (straightRanks === 1) parts.push('것샷');
    return { outs, label: parts.join(' + '), flush, straightRanks, weak: weakFlush && straightRanks < 2 };
}

// ctx: { equity(전원 상대 승률 0~1), potOdds(0~1), toCall, opponents, inPosition, spr(남은 유효 스택 / 팟), stackShare(콜 금액 / 내 스택),
//        draw(detectDraws 결과), pot(콜 전 팟), behind(콜하고도 남는 유효 스택) }
function postflopAdvice(ctx) {
    const n = Math.max(1, ctx.opponents || 1);
    const equity = Math.max(0, Math.min(1, ctx.equity));
    const pHU = headsUpEquivalent(equity, n);
    const ip = !!ctx.inPosition;
    const spr = (typeof ctx.spr === 'number' && ctx.spr >= 0) ? ctx.spr : 99;
    const multi = n >= 2;                       // 상대 2명 이상 = 멀티웨이
    const fair = Math.round(100 / (n + 1));     // 평균 승률(%)
    const eqPct = Math.round(equity * 100);
    const notes = [];
    notes.push(n === 1 ? '상대 1명 (헤즈업 팟)' : `${n + 1}명 멀티웨이`);
    notes.push(ip ? '포지션 유리(IP)' : '포지션 불리(OOP)');
    if (spr <= 3) notes.push(`SPR ${spr.toFixed(1)} (얕음)`); else if (spr >= 10) notes.push(`SPR ${Math.round(spr)} (깊음)`);
    const strengthNote = multi ? ` (${n}명 상대 평균은 ${fair}% — 승률 ${eqPct}%는 그 ${(equity * (n + 1)).toFixed(1)}배)` : '';
    let mix, bestAction, reason, thin = false;

    if (!(ctx.toCall > 0)) {
        // ── 체크가 가능한 상황: 벳 or 체크 ──
        const valueTh = 0.66 + 0.03 * (n - 1);          // 사람이 많을수록 "누군가는 맞았다" → 밸류 기준을 올린다
        if (pHU >= valueTh) {
            const bet = multi ? 82 : (ip ? 78 : 70);
            mix = { check: 100 - bet, bet };
            bestAction = 'bet';
            reason = multi
                ? `강한 패${strengthNote}. 멀티웨이는 드로우가 여럿이라 크게(팟의 2/3 이상) 쳐서 값을 받으세요.`
                : '강한 밸류 핸드 — 베팅으로 팟을 키우세요.';
            if (spr <= 1.5) reason += ` 남은 스택이 팟보다 작아(SPR ${spr.toFixed(1)}) 올인까지 가도 됩니다.`;
        } else if (pHU >= 0.52) {
            bestAction = (!multi && ip && pHU >= 0.58) ? 'bet' : 'check';
            // 🐛 권장이 '벳'인데 믹스는 체크 52 / 벳 48 로 나와 서로 어긋났다 → 권장하는 쪽이 항상 더 크게
            const bet = multi ? 22 : (bestAction === 'bet' ? 58 : (ip ? 42 : 30));
            mix = { check: 100 - bet, bet };
            thin = bestAction === 'bet';
            reason = multi
                ? `중간 패${strengthNote}. 멀티웨이에서는 얇은 밸류벳이 잘 안 통합니다 — 체크로 팟을 작게 가져가세요.`
                : (ip ? '중상 패 + 포지션 — 작게(팟의 1/3) 얇은 밸류벳을 섞을 만합니다.' : '중상 패지만 포지션이 불리 — 체크해서 팟을 조절하는 쪽이 무난합니다.');
        } else if (pHU <= 0.33) {
            const bet = n >= 3 ? 6 : n === 2 ? 16 : (ip ? 40 : 30);
            mix = { check: 100 - bet, bet };
            bestAction = 'check';
            reason = multi
                ? `약한 패 — 상대가 ${n}명이면 전원이 접어야 블러프가 성공합니다(각자 55% 접어도 ${Math.round(Math.pow(0.55, n) * 100)}%). 블러프는 거의 접으세요.`
                : '약한 패 — 헤즈업이라 가끔 블러프벳을 섞되, 기본은 체크입니다.';
        } else {
            const bet = multi ? 8 : (ip ? 22 : 14);
            mix = { check: 100 - bet, bet };
            bestAction = 'check';
            reason = '쇼다운 가치는 있지만 밸류벳하기엔 약함 — 체크가 최적.';
        }
    } else {
        // ── 벳을 받은 상황: 콜/폴드/레이즈 ──
        const potOdds = Math.max(0, Math.min(1, ctx.potOdds || 0));
        const oddsPct = Math.round(potOdds * 100);
        const margin = equity - potOdds;
        const callMargin = 0.02 + 0.02 * (n - 1);      // 뒤에 사람이 더 있으면 레이즈·역전 위험만큼 더 요구
        const committed = (ctx.stackShare || 0) >= 0.7 || spr <= 1;   // 콜이 사실상 올인
        const raiseOk = margin >= 0.15 && pHU >= (multi ? 0.75 : 0.68);
        if (committed) {
            notes.push('올인성 콜');
            if (margin >= callMargin) {
                mix = raiseOk ? { fold: 0, call: 40, raise: 60 } : { fold: 5, call: 90, raise: 5 };
                bestAction = raiseOk ? 'raise' : 'call';
                reason = `남은 스택이 팟보다 작습니다(SPR ${spr.toFixed(1)}). 승률(${eqPct}%)이 필요 승률(${oddsPct}%)을 넘으니 ${raiseOk ? '올인' : '콜'} — 여기서 접으면 팟에 넣은 칩이 아깝습니다.`;
            } else {
                mix = { fold: 85, call: 15, raise: 0 };
                bestAction = 'fold';
                reason = `스택이 얕아도 승률(${eqPct}%)이 필요 승률(${oddsPct}%)에 못 미치면 폴드입니다.`;
            }
        } else if (raiseOk) {
            mix = { fold: 0, call: multi ? 40 : 45, raise: multi ? 60 : 55 };
            bestAction = 'raise';
            reason = `승률(${eqPct}%)이 팟오즈(${oddsPct}%)보다 훨씬 높음${strengthNote} — 레이즈로 밸류!`;
        } else if (margin >= callMargin) {
            mix = { fold: 5, call: multi ? 85 : 75, raise: multi ? 10 : 20 };
            bestAction = 'call';
            reason = multi
                ? `승률(${eqPct}%)이 팟오즈(${oddsPct}%)보다 높아 콜. 멀티웨이라 레이즈로 블러프를 접게 하긴 어렵습니다 — 콜이 기본.`
                : `승률(${eqPct}%)이 팟오즈(${oddsPct}%)보다 높아 콜은 +EV입니다.`;
        } else if (impliedCall(ctx, equity)) {
            // 드로우: 지금 가격으로는 모자라지만, 완성됐을 때 더 받을 칩(임플라이드 오즈)이 충분하면 콜
            const extra = Math.ceil((ctx.toCall / equity - (ctx.pot + ctx.toCall)) / 10) * 10;
            mix = { fold: 30, call: 65, raise: 5 };
            bestAction = 'call';
            notes.push('임플라이드 오즈');
            reason = `${ctx.draw.label}(아웃츠 ${ctx.draw.outs}장) — 지금 가격만으로는 모자랍니다(승률 ${eqPct}% < 필요 ${oddsPct}%). 하지만 완성됐을 때 ${extra.toLocaleString()}쯤만 더 받으면 본전이고, 상대 스택이 깊어 충분히 가능합니다 — 콜.`;
        } else if (margin >= -0.03) {
            mix = multi ? { fold: 70, call: 28, raise: 2 } : { fold: 55, call: 42, raise: 3 };
            bestAction = 'fold';
            reason = multi
                ? `경계선 — 멀티웨이에선 벳한 사람의 블러프가 드뭅니다. 승률(${eqPct}%)이 팟오즈(${oddsPct}%)를 확실히 넘지 않으면 폴드.`
                : `경계선 — 승률(${eqPct}%)이 팟오즈(${oddsPct}%)와 비슷. 헤즈업이라 상대 블러프가 의심되면 콜, 아니면 폴드.`;
        } else {
            mix = { fold: multi ? 88 : 80, call: multi ? 11 : 18, raise: multi ? 1 : 2 };
            bestAction = 'fold';
            reason = `승률(${eqPct}%)이 팟오즈(${oddsPct}%)보다 낮음 — 폴드가 정석.`;
            if (ctx.draw && ctx.draw.outs >= 4) reason += ` (${ctx.draw.label} 아웃츠 ${ctx.draw.outs}장이지만, 벳이 크거나 남은 스택이 얕아 완성돼도 모자란 만큼을 더 받기 어렵습니다.)`;
        }
    }
    if (ctx.draw && ctx.draw.outs >= 4) notes.push(`${ctx.draw.label} · 아웃츠 ${ctx.draw.outs}장`);
    return Object.assign({ mix, bestAction, reason, notes, headsUpEquity: pHU, thin }, tierOf(pHU));
}

// ── 권장 벳 크기 ─────────────────────────────────────────────
// 프리플랍 오픈: 스택이 얕을수록 작게. 헤즈업 버튼은 넓게 여는 대신 작게.
//   림퍼(먼저 콜만 한 사람)가 있으면 한 명마다 1bb 씩 더 — 같은 크기로 열면 모두 싼값에 따라온다.
function openSize(effBB, headsUp, limpers) {
    const L = Math.max(0, Math.min(5, Math.floor(limpers || 0)));
    if (L > 0) return `${3 + L}bb (기본 3bb + 림퍼 ${L}명 × 1bb)`;
    if (effBB <= 20) return '2bb (스택이 얕아 작게)';
    if (headsUp) return '2~2.5bb';
    if (effBB >= 150) return '2.5~3bb (스택이 깊어 조금 크게)';
    return '2.2~2.5bb';
}
// 3벳: 포지션이 있으면 상대 벳의 3배, 없으면 4배, 콜러 한 명마다 한 배 더. 스택의 1/3을 넘으면 올인이 낫다.
function threeBetSize(openTo, callers, inPosition, bb, stack) {
    const mult = (inPosition ? 3 : 4) + Math.max(0, callers || 0);
    const to = Math.round(openTo * mult / (bb || 1)) * (bb || 1);
    if (stack > 0 && to >= stack / 3) return { to: stack, allIn: true, text: '올인 (3벳 크기가 스택의 1/3을 넘어 어차피 못 접습니다)' };
    return { to, allIn: false, text: `약 ${to.toLocaleString()} (상대 벳의 ${mult}배${inPosition ? '' : ' — 포지션이 불리해 크게'}${callers > 0 ? `, 콜러 ${callers}명 반영` : ''})` };
}
// 포스트플랍 벳: 마른 보드 + 헤즈업은 작게, 젖은 보드나 멀티웨이는 크게.
//   ctx: { opponents, wet, dry, spr, pot }
function betSize(ctx) {
    const n = Math.max(1, ctx.opponents || 1);
    let frac, why;
    if ((ctx.spr || 99) <= 1.2) return { frac: 1, text: '올인 (남은 스택이 팟 크기 이하)' };
    // 얇은 밸류벳은 보드와 상관없이 작게 — 크게 치면 더 좋은 패만 따라온다
    if (ctx.thin) return { frac: 0.33, text: `팟의 1/3${ctx.pot > 0 ? ` ≈ ${Math.round(ctx.pot * 0.33).toLocaleString()}` : ''} (얇은 밸류라 작게)` };
    if (n >= 2) { frac = ctx.wet ? 0.75 : 0.66; why = '멀티웨이라 크게'; }
    else if (ctx.wet) { frac = 0.66; why = '드로우가 많은 보드라 크게'; }
    else if (ctx.dry) { frac = 0.33; why = '마른 보드라 작게'; }
    else { frac = 0.5; why = '중간 보드'; }
    const label = frac === 0.33 ? '1/3' : frac === 0.5 ? '절반' : frac === 0.66 ? '2/3' : '3/4';
    const amt = ctx.pot > 0 ? ` ≈ ${Math.round(ctx.pot * frac).toLocaleString()}` : '';
    return { frac, text: `팟의 ${label}${amt} (${why})` };
}

// ── 한 액션의 GTO 근접도 점수(0~100) ─────────────────────────
//   조언(mix·bestAction)과 실제 액션을 비교한다. 프로필의 "GTO 근접도"가 이 점수의 평균이다.
//   예전 점수는 조언과 따로 놀았다 — "아무 패 상대 승률 vs 팟오즈"만 봐서 버튼 스틸 오픈이나 숏스택 푸시 같은
//   정석 플레이를 낮게, 큰 벳에 넓게 콜하는 걸 높게 쳤다. 이제 조언과 같은 기준으로 매긴다.
function actionKey(advice, actualType) {
    const mix = (advice && advice.mix) || {};
    if (actualType === 'allin') return mix.raise !== undefined ? 'raise' : (mix.bet !== undefined ? 'bet' : 'raise');
    if (actualType === 'raise' && mix.raise === undefined && mix.bet !== undefined) return 'bet';
    if (actualType === 'check' && mix.check === undefined) return 'call';
    return actualType;
}
function scoreAction(advice, actualType) {
    if (!advice || !advice.mix) return null;
    const key = actionKey(advice, actualType);
    const pct = advice.mix[key] || 0;
    let score;
    if (key === advice.bestAction) score = 95;
    else if (pct >= 40) score = 88;
    else if (pct >= 25) score = 75;
    else if (pct >= 12) score = 60;
    else if (pct >= 5) score = 40;
    else score = 15;
    // 방향은 맞아도 크기가 틀린 경우: 올인이 기준인 자리에서 작게 레이즈
    if (wrongSize(advice, actualType)) score = Math.min(score, 55);
    return score;
}
function wrongSize(advice, actualType) {
    return !!(advice && typeof advice.sizeHint === 'string' && advice.sizeHint.indexOf('올인') === 0 && actualType === 'raise');
}

module.exports = { headsUpEquivalent, tierOf, postflopAdvice, openSize, threeBetSize, betSize, scoreAction, actionKey, wrongSize, detectDraws, impliedCall, preflopTier };
