// 🧑‍🏫 AI 코치 · 🤖 AI 봇 말투 — AI 에게 줄 글(프롬프트)을 만든다. 순수 함수라 시험한다.
//   원칙: "무엇이 실수인가"는 앱의 솔버·기대값 계산이 이미 정했다. AI 는 그 숫자와 이유를 사람 말로 풀어 줄 뿐,
//         새 포커 판단(다른 권장 · 지어낸 승률)을 만들지 않는다 — 그럴듯하게 틀린 말을 막으려고.
const ST = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };
const ACT = { fold: '폴드', check: '체크', call: '콜', raise: '레이즈', allin: '올인', bet: '벳' };
const card = c => (c ? c[0].replace('T', '10') + ({ s: '♠', h: '♥', d: '♦', c: '♣' }[c[1]] || '') : '');

const COACH_SYSTEM = `당신은 한국 홀덤펍 "파이널나인" 대회 입상을 준비하는 플레이어에게 딥스택 연습 대회를 복기해 주는 포커 코치입니다.
지켜야 할 것:
- 무엇이 실수인지, 무엇이 권장인지는 아래 자료(앱의 솔버·기대값 계산 결과)가 이미 정했습니다. 그 판단을 바꾸거나 자료에 없는 승률·빈도·권장을 지어내지 마세요.
- 자료의 숫자와 "이유" 문장을 근거로, 왜 그런지 쉬운 말로 풀어 주세요. 확실하지 않으면 그렇다고 말하세요.
- 한국어 표준어, 반드시 존댓말(~요, ~습니다). "친구야" 같은 반말 호칭은 쓰지 마세요. 따뜻하지만 군더더기 없이.
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
내 손에 든 패(2장): [${(h.h || []).map(card).join(' ')}]
바닥에 깔린 공용 카드(보드): [${(h.b || []).slice(0, x.b || 0).map(card).join(' ') || '없음'}] — 내 패가 아닙니다
${ST[x.st] || x.st} · 팟 ${x.pot}bb${x.call > 0 ? ' · 콜해야 할 금액 ' + x.call + 'bb' : ''}
내 선택: ${ACT[x.act] || x.act}${x.amt > 0 && x.act !== 'fold' && x.act !== 'check' ? ' ' + x.amt + 'bb' : ''}
앱의 권장: ${ACT[x.best] || x.best}${x.size ? ' (크기 ' + x.size + ')' : ''} · 권장 빈도 ${mix || '-'}
판정: ${x.loss > 0 ? '손실 ' + x.loss + 'bb' : '손실 없음'}${kn ? ' · ' + kn : ''}${x.ic ? ` · 상금 기준(ICM) 필요 승률 ${x.ic[0]}% → ${x.ic[1]}%` : ''}
앱의 이유: ${x.why || '(없음)'}

이 결정이 왜 ${x.loss > 0 ? '손해였는지' : '괜찮았는지'}, 앱의 판정과 이유를 근거로 존댓말 3~5문장으로 설명해 주세요. 패는 위에 적힌 2장만 말하세요. 비슷한 상황에서 기억할 한 줄 요령으로 끝내 주세요.`;
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
function cleanLine(t, max) {
    if (!t) return null;
    let s = String(t).split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
    s = s.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
    if (!s || s.length > (max || 40)) return null;
    return s;
}

// ═══ 📅 주간 성장 리포트 ═══
//   연습 기록(fnStats)은 처음부터 쌓인 합계뿐이라, 대회가 끝날 때마다 합계를 찍어 둔다(snapOf → u.fnSnaps).
//   한 주의 기록 = 그 주 끝 무렵 찍은 것 − 그 주 시작 전 마지막으로 찍은 것.
const EV_KEYS = ['evHands', 'evLoss', 'evLossSq', 'evLossN', 'evLossNSq'];
function snapOf(F, t, kindKeys) {
    const s = { t };
    EV_KEYS.forEach(k => { s[k] = (F && F[k]) || 0; });
    s.k = {};
    (kindKeys || []).forEach(k => { const n = (F && F['lkN_' + k]) || 0; if (n) s.k[k] = [n, Math.round(((F && F['lkB_' + k]) || 0) * 10) / 10]; });
    return s;
}
function snapDiff(a, b) {
    const d = {};
    EV_KEYS.forEach(k => { d[k] = (b[k] || 0) - ((a && a[k]) || 0); });
    d.k = {};
    Object.keys(b.k || {}).forEach(k => {
        const n = b.k[k][0] - ((a && a.k && a.k[k] && a.k[k][0]) || 0), bb = b.k[k][1] - ((a && a.k && a.k[k] && a.k[k][1]) || 0);
        if (n > 0) d.k[k] = [n, Math.round(bb * 10) / 10];
    });
    return d;
}
// 기간 [from, to) 의 기록. snaps: 시간순, results: fnResults({ t, place, paid, total }), index: EvLoss.index
//   그 기간 전에 찍은 것이 없으면(기록을 막 찍기 시작함) 가장 먼저 찍은 것부터 센다 → partial
function periodStats(snaps, results, from, to, index) {
    snaps = (snaps || []).slice().sort((a, b) => a.t - b.t);
    const before = snaps.filter(s => s.t < from), inside = snaps.filter(s => s.t >= from && s.t < to);
    if (!inside.length) return null;
    const base = before.length ? before[before.length - 1] : null, end = inside[inside.length - 1];
    const partial = !base;
    const d = snapDiff(base || inside[0], end);
    const rs = (results || []).filter(r => r.t >= from && r.t < to);
    const ix = d.evHands > 0 ? index(d) : null;
    return {
        from, to, partial, games: rs.length, itm: rs.filter(r => r.place <= r.paid).length, wins: rs.filter(r => r.place === 1).length,
        best: rs.length ? Math.min(...rs.map(r => r.place)) : null, avgPlace: rs.length ? Math.round(rs.reduce((a, r) => a + r.place, 0) / rs.length * 10) / 10 : null,
        hands: d.evHands, score: ix ? ix.score : null, pm: ix ? ix.pm : null, loss100: ix ? ix.raw100 : null, kinds: d.k
    };
}
const WEEK = 7 * 24 * 3600 * 1000;
// 그 시각이 든 주의 월요일 0시(이 PC 시간)
function weekStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return d.getTime(); }
const md = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
function weekPrompt(cur, prev, opt) {
    opt = opt || {};
    const kn = k => (opt.kinds && opt.kinds[k] && opt.kinds[k].name) || k;
    const line = (s, label) => !s ? `${label}: 기록 없음(비교하지 마세요)` : `${label}(${md(s.from)}~${md(s.to - 1)}${s.partial ? ' · 기록을 이 기간 중간부터 찍기 시작함' : ''}): 대회 ${s.games}번 · 입상 ${s.itm}번 · 우승 ${s.wins}번${s.best ? ' · 최고 ' + s.best + '위' : ''}${s.avgPlace != null ? ' · 평균 ' + s.avgPlace + '위' : ''} · 판 ${s.hands}판${s.score != null ? ` · 연습 점수 ${s.score}점(±${s.pm}) · 100판당 잃은 기대값 ${s.loss100}bb` : ' · 연습 점수 없음(판이 적음 — 점수 변화를 말하지 마세요)'}`;
    const kinds = s => !s ? '' : Object.entries(s.kinds || {}).sort((a, b) => b[1][1] - a[1][1]).slice(0, 5).map(([k, v]) => `${kn(k)} ${v[0]}번 ${v[1]}bb`).join(' · ') || '없음';
    const user = `${line(cur, '이번 기간')}
이번 기간 실수 종류(횟수 · 잃은 bb): ${kinds(cur)}
${line(prev, '그 전 기간')}
그 전 기간 실수 종류: ${kinds(prev)}
(입상 = ${opt.paid || 6}위 안 · 대회는 ${opt.entrants || 50}명)

위 숫자로 주간 성장 리포트를 써 주세요. 형식:
1. 한 줄 요약(점수가 오르거나 내렸으면 숫자로)
2. 좋아진 점 1~2개
3. 아직 새는 곳 1~2개 — 실수 종류 이름과 잃은 bb 를 들어서
4. 다음 주 목표 1가지(구체적인 행동)
500자 안팎, 번호 목록으로. 위에 없는 숫자(점수 변화 · 판 수 · bb)는 절대 만들지 마세요. 판 수가 100판보다 적으면 "표본이 적어 점수는 참고만" 이라고 말해 주세요. 그 전 기간 기록이 없으면 비교하지 마세요.`;
    return { system: COACH_SYSTEM, user };
}

// ═══ 🎙️ 딥스택 중계 해설 ═══
//   e: { kind, nick, place, alive, paid, total, leader, leaderBB, players:[{nick, bb}], a, b, title, sub }
//   template 은 사실만 담은 기본 문장(AI 가 없거나 늦으면 이것을 쓴다)
function castTemplate(e) {
    const ps = (e.players || []).map(p => `${p.nick} ${p.bb}bb`).join(', ');
    switch (e.kind) {
        case 'bubble': return `🫧 버블입니다! ${e.alive}명 남았고 ${e.paid}위까지 입상 — 한 명만 더 떨어지면 모두 입상합니다.${e.leader ? ` 칩 리더는 ${e.leader} 님(${e.leaderBB}bb).` : ''}`;
        case 'itm': return `💰 버블이 터졌습니다! 남은 ${e.alive}명 모두 입상 확정입니다.${e.nick ? ` ${e.nick} 님이 아쉽게 ${e.place}위로 탈락했습니다.` : ''}`;
        case 'final': return `🏆 파이널 테이블이 만들어졌습니다! ${e.alive}명 — ${ps}`;
        case 'out': return `💀 ${e.nick} 님 ${e.place}위로 탈락합니다. 남은 사람 ${e.alive}명${e.paid && e.place <= e.paid ? ' (입상)' : ''}.`;
        case 'hu': return `⚔️ 헤즈업! ${ps} — 우승을 두고 마지막 1대1입니다.`;
        case 'champ': return `🎉 ${e.nick} 님이 ${e.total}명 딥스택 연습에서 우승했습니다!`;
        case 'hl': return `🎬 ${e.title || ''} ${e.sub || ''}`.trim();
        default: return null;
    }
}
const CAST_SYSTEM = `당신은 친구들끼리 하는 온라인 홀덤 대회의 중계 캐스터입니다.
- 주어진 사실만으로 한두 문장, 70자 안으로 생동감 있게 중계하세요. 이모지는 하나만.
- 이름과 숫자는 주어진 그대로 쓰고, 패·승률·이유 같은 주어지지 않은 사실을 지어내지 마세요.
- 한국어 표준어 존댓말. 비하·욕설 금지. 중계 문장만 출력하세요(따옴표·설명 없이).`;
function castPrompt(e) { return { system: CAST_SYSTEM, user: `사실: ${castTemplate(e)}` }; }
// AI 문장을 쓸 수 있는가: 한 줄 · 80자 이내 · 주인공 이름이 들어 있고 · 사실에 없는 숫자가 없다
function castCheck(t, e) {
    const s = cleanLine(t, 80);
    if (!s) return null;
    const names = [e.nick, e.leader].concat((e.players || []).map(p => p.nick)).filter(Boolean).map(n => String(n).replace('🤖', ''));
    if (e.nick && !s.includes(String(e.nick).replace('🤖', ''))) return null;
    if (!e.nick && names.length && !names.some(n => s.includes(n))) return null;
    const facts = castTemplate(e);
    const nums = (s.match(/\d+/g) || []).filter(n => !facts.includes(n));
    if (nums.length) return null;
    return s;
}

module.exports = { coachPrompt, explainPrompt, botPrompt, cleanLine, COACH_SYSTEM, snapOf, periodStats, weekStart, weekPrompt, WEEK, castTemplate, castPrompt, castCheck };
