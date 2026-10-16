// 🧑‍🏫 AI 코치 · 🤖 AI 봇 말투 — AI 에게 줄 글(프롬프트)을 만든다. 순수 함수라 시험한다.
//   원칙: "무엇이 실수인가"는 앱의 솔버·기대값 계산이 이미 정했다. AI 는 그 숫자와 이유를 사람 말로 풀어 줄 뿐,
//         새 포커 판단(다른 권장 · 지어낸 승률)을 만들지 않는다 — 그럴듯하게 틀린 말을 막으려고.
const ST = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };
const ACT = { fold: '폴드', check: '체크', call: '콜', raise: '레이즈', allin: '올인', bet: '벳' };
const card = c => (c ? c[0].replace('T', '10') + ({ s: '♠', h: '♥', d: '♦', c: '♣' }[c[1]] || '') : '');

const COACH_SYSTEM = `당신은 한국 홀덤펍 "파이널나인" 대회 입상을 준비하는 친구에게 딥스택 연습 대회를 복기해 주는 포커 코치입니다.
지켜야 할 것:
- 무엇이 실수인지, 무엇이 권장인지는 아래 자료(앱의 솔버·기대값 계산 결과)가 이미 정했습니다. 그 판단을 바꾸거나 자료에 없는 승률·빈도·권장을 지어내지 마세요.
- 자료의 숫자와 "이유" 문장을 근거로, 왜 그런지 쉬운 말로 풀어 주세요. 확실하지 않으면 그렇다고 말하세요.
- 한국어 표준어, 존댓말. 친구에게 말하듯 따뜻하지만 군더더기 없이.
- 결과(운)와 결정의 좋고 나쁨을 구분하세요.`;

// 대회 하나 → 코칭 리포트 질문. rv: fnReviews 의 한 대회 { place, played, skipped, hands:[{ n, lv, pos, stk, seats, alive, h, b, net, loss, d:[…] }] }
function coachPrompt(rv, opt) {
    opt = opt || {};
    const hands = (rv.hands || []).slice();
    const decisions = [];
    hands.forEach(h => (h.d || []).forEach((x, i) => { if (x.loss > 0) decisions.push({ h, x, i }); }));
    const byKind = {};
    decisions.forEach(({ x }) => { const k = x.k || '기타'; const e = byKind[k] || (byKind[k] = { n: 0, bb: 0 }); e.n++; e.bb += x.loss; });
    const kindName = k => (opt.kinds && opt.kinds[k] && opt.kinds[k].name) || k;
    const top = decisions.sort((a, b) => b.x.loss - a.x.loss).slice(0, opt.top || 8);
    const totalLoss = Math.round(decisions.reduce((a, d) => a + d.x.loss, 0) * 10) / 10;
    const lines = [];
    lines.push(`대회 결과: ${rv.place ? rv.place + '위' : '진행 중/기록 없음'}${opt.entrants ? ' / ' + opt.entrants + '명' : ''} · 친 판 ${rv.played || hands.length}판 · 권장과 다른 결정 ${decisions.length}번 · 잃은 기대값 합계 ${totalLoss}bb`);
    lines.push('실수 종류별(횟수 · 잃은 bb):');
    Object.entries(byKind).sort((a, b) => b[1].bb - a[1].bb).forEach(([k, e]) => lines.push(`- ${kindName(k)}: ${e.n}번 · ${Math.round(e.bb * 10) / 10}bb`));
    lines.push('');
    lines.push('가장 크게 잃은 결정들:');
    top.forEach(({ h, x }, j) => {
        lines.push(`${j + 1}) 판 #${h.n} · 레벨 ${h.lv} · ${h.pos || '-'} · 내 스택 ${h.stk}bb · ${h.seats}인 · 남은 ${h.alive}명 · 내 패 ${(h.h || []).map(card).join(' ')}` +
            ` · ${ST[x.st] || x.st}(보드 ${x.b || 0}장) · 팟 ${x.pot}bb${x.call > 0 ? ' · 콜 ' + x.call + 'bb' : ''}`);
        lines.push(`   내 선택 ${ACT[x.act] || x.act}${x.amt > 0 && x.act !== 'fold' && x.act !== 'check' ? ' ' + x.amt + 'bb' : ''} → 권장 ${ACT[x.best] || x.best} · 손실 ${x.loss}bb · 종류 ${kindName(x.k || '기타')}`);
        if (x.why) lines.push(`   앱의 이유: ${x.why}`);
    });
    const user = `${lines.join('\n')}

위 자료로 코칭 리포트를 써 주세요. 형식:
1. 한 줄 총평
2. 가장 크게 새는 곳 2~3가지 — 각각 해당 판 번호(#)를 들어서, 왜 손해인지 앱의 이유를 쉬운 말로
3. 다음 연습에서 집중할 것 2가지(구체적인 행동으로)
800자 안팎, 마크다운 제목 없이 번호 목록으로.`;
    return { system: COACH_SYSTEM, user, decisions: decisions.length };
}

// 결정 하나 → "왜 이게 실수인가" 질문
function explainPrompt(h, x, opt) {
    opt = opt || {};
    const kn = (opt.kinds && x.k && opt.kinds[x.k] && opt.kinds[x.k].name) || x.k || '';
    const mix = Object.entries(x.mix || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${ACT[k] || k} ${v}%`).join(' · ');
    const user = `판 #${h.n} · 레벨 ${h.lv} · ${h.pos || '-'} · 내 스택 ${h.stk}bb · ${h.seats}인 테이블 · 남은 ${h.alive}명
내 패 ${(h.h || []).map(card).join(' ')} · 보드 ${(h.b || []).slice(0, x.b || 0).map(card).join(' ') || '없음'} · ${ST[x.st] || x.st} · 팟 ${x.pot}bb${x.call > 0 ? ' · 콜해야 할 금액 ' + x.call + 'bb' : ''}
내 선택: ${ACT[x.act] || x.act}${x.amt > 0 && x.act !== 'fold' && x.act !== 'check' ? ' ' + x.amt + 'bb' : ''}
앱의 권장: ${ACT[x.best] || x.best}${x.size ? ' (크기 ' + x.size + ')' : ''} · 권장 빈도 ${mix || '-'}
판정: ${x.loss > 0 ? '손실 ' + x.loss + 'bb' : '손실 없음'}${kn ? ' · ' + kn : ''}${x.ic ? ` · 상금 기준(ICM) 필요 승률 ${x.ic[0]}% → ${x.ic[1]}%` : ''}
앱의 이유: ${x.why || '(없음)'}

이 결정이 왜 ${x.loss > 0 ? '손해였는지' : '괜찮았는지'}, 앱의 판정과 이유를 근거로 3~5문장으로 설명해 주세요. 비슷한 상황에서 기억할 한 줄 요령으로 끝내 주세요.`;
    return { system: COACH_SYSTEM, user };
}

// 🤖 봇 한마디. c: { nick, style, event, potBB, street, opp }
const BOT_SYSTEM = `당신은 온라인 홀덤 게임의 AI 플레이어입니다. 테이블 채팅에 한마디만 합니다.
- 한국어 표준어, 25자 이내 한 문장. 이모지는 많아야 하나.
- 성격에 맞는 말투로. 욕설·비하·사투리·개인 정보 금지.
- 자기 패나 남의 패를 밝히지 말고, 실제 전략 조언도 하지 마세요.
- 대사만 출력하세요(따옴표·설명 없이).`;
const EVENT_KO = { win: '방금 팟을 이겼다', lose: '방금 팟을 졌다', bigbet: '크게 베팅했다', bluff: '블러프 중이다', tank: '어려운 결정에 고민 중이다', taunt: '상대가 오래 고민해서 재촉한다', call: '상대 베팅을 받았다', fold: '패를 접었다', join: '테이블에 막 앉았다' };
function botPrompt(c) {
    const user = `내 이름: ${String(c.nick || '').replace('🤖', '')} · 성격: ${c.style || '보통'}
상황: ${EVENT_KO[c.event] || c.event}${c.potBB ? ` · 팟 약 ${c.potBB}bb` : ''}${c.street ? ' · ' + c.street : ''}${c.opp ? ' · 상대 ' + String(c.opp).replace('🤖', '') : ''}`;
    return { system: BOT_SYSTEM, user };
}
// AI 가 돌려준 대사를 테이블에 띄워도 되게 다듬는다(한 줄 · 길이 · 따옴표). 쓸 수 없으면 null
function cleanLine(t) {
    if (!t) return null;
    let s = String(t).split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
    s = s.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
    if (!s || s.length > 40) return null;
    return s;
}

module.exports = { coachPrompt, explainPrompt, botPrompt, cleanLine, COACH_SYSTEM };
