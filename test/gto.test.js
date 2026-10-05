const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/gtoadvice');
const Q = require('../lib/gtoquiz');
const SS = require('../lib/shortstack');
const PF = require('../lib/preflop');

function lcg(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const base = { equity: 0.4, potOdds: 0, toCall: 0, opponents: 1, inPosition: true, spr: 6, stackShare: 0 };
const adv = o => A.postflopAdvice(Object.assign({}, base, o));

// ══════════════ 상황별 조언 ══════════════

test('환산: 한 명 상대면 그대로, 여러 명이면 같은 승률이 더 강한 패', () => {
    assert.strictEqual(A.headsUpEquivalent(0.4, 1), 0.4);
    assert.ok(A.headsUpEquivalent(0.4, 3) > 0.7);
    assert.ok(A.headsUpEquivalent(0.4, 3) > A.headsUpEquivalent(0.4, 2));
});

test('같은 승률 40%: 헤즈업은 약~중간, 4명 팟(상대 3명)에서는 강한 패로 벳', () => {
    const hu = adv({ opponents: 1 }), four = adv({ opponents: 3 });
    assert.strictEqual(hu.bestAction, 'check');
    assert.strictEqual(four.bestAction, 'bet');
    assert.ok(four.tier > hu.tier);
    assert.notStrictEqual(hu.reason, four.reason, '상황이 다르면 설명도 달라야 한다');
});

test('약한 패 블러프: 상대가 늘수록 빈도가 줄어든다', () => {
    const b = n => adv({ equity: Math.pow(0.25, n), opponents: n }).mix.bet;   // 한 명 환산 25%로 맞춘다
    assert.ok(b(1) > b(2) && b(2) > b(3), `${b(1)} > ${b(2)} > ${b(3)}`);
    assert.ok(b(3) <= 8, '4명 팟에서는 블러프를 거의 안 한다');
});

test('포지션: 같은 중상 패라도 뒤에서 치면(IP) 벳이 늘고 앞에서 치면(OOP) 체크가 는다', () => {
    const ip = adv({ equity: 0.6, inPosition: true }), oop = adv({ equity: 0.6, inPosition: false });
    assert.ok(ip.mix.bet > oop.mix.bet);
    assert.strictEqual(ip.bestAction, 'bet');
    assert.strictEqual(oop.bestAction, 'check');
});

test('벳을 받았을 때: 승률이 팟오즈보다 낮으면 폴드, 넉넉히 높으면 레이즈, 조금 높으면 콜', () => {
    assert.strictEqual(adv({ toCall: 300, potOdds: 0.30, equity: 0.20 }).bestAction, 'fold');
    assert.strictEqual(adv({ toCall: 300, potOdds: 0.25, equity: 0.33 }).bestAction, 'call');
    assert.strictEqual(adv({ toCall: 300, potOdds: 0.25, equity: 0.80 }).bestAction, 'raise');
});

test('멀티웨이에서 벳을 받으면 헤즈업보다 더 높은 여유를 요구한다', () => {
    const ctx = { toCall: 300, potOdds: 0.25, equity: 0.28 };       // 여유 3%p
    assert.strictEqual(adv(Object.assign({ opponents: 1 }, ctx)).bestAction, 'call');
    assert.strictEqual(adv(Object.assign({ opponents: 3 }, ctx)).bestAction, 'fold');
});

test('스택이 얕으면(SPR 1 이하) 필요 승률만 넘으면 접지 않는다 · 깊으면 같은 승률로 레이즈까진 안 한다', () => {
    const shallow = adv({ toCall: 800, potOdds: 0.31, equity: 0.45, spr: 0.8, stackShare: 1 });
    assert.strictEqual(shallow.bestAction, 'call');
    assert.ok(shallow.notes.includes('올인성 콜'));
    assert.strictEqual(adv({ toCall: 800, potOdds: 0.31, equity: 0.20, spr: 0.8, stackShare: 1 }).bestAction, 'fold', '얕아도 승률이 모자라면 폴드');
});

test('조언 모양: 믹스 합은 100, 권장 액션은 믹스 안에 있다 (난수 훑기)', () => {
    const rng = lcg(5);
    for (let k = 0; k < 3000; k++) {
        const toCall = rng() < 0.5 ? 0 : 100 + Math.floor(rng() * 900);
        const a = A.postflopAdvice({ equity: rng(), potOdds: rng() * 0.5, toCall, opponents: 1 + Math.floor(rng() * 5), inPosition: rng() < 0.5, spr: rng() * 25, stackShare: rng() });
        const sum = Object.values(a.mix).reduce((x, y) => x + y, 0);
        assert.strictEqual(sum, 100, JSON.stringify(a.mix));
        assert.ok(a.mix[a.bestAction] !== undefined, a.bestAction + ' 가 믹스에 없다');
        Object.values(a.mix).forEach(v => assert.ok(v >= 0 && v <= 100));
        assert.ok(a.notes.length >= 2 && a.reason.length > 5 && a.tier >= 1 && a.tier <= 5);
        assert.ok(toCall > 0 ? a.mix.bet === undefined : a.mix.call === undefined, '상황에 안 맞는 액션이 믹스에 있다');
    }
});

// ══════════════ 문제 학습 ══════════════

test('분야 9개, 분야마다 문제가 만들어지고 정답이 보기 안에 있다', () => {
    assert.strictEqual(Q.CAT_IDS.length, 9);
    const rng = lcg(11);
    Q.CAT_IDS.forEach(cat => {
        for (let i = 0; i < 300; i++) {
            const q = Q.generate(cat, rng);
            assert.strictEqual(q.cat, cat, cat + ' 문제를 못 만들어 다른 분야로 떨어졌다');
            assert.ok(q.choices.length >= 2 && q.choices.length <= 4);
            assert.strictEqual(new Set(q.choices.map(c => c.id)).size, q.choices.length, '보기 중복');
            assert.ok(q.choices.some(c => c.id === q.answer), '정답이 보기에 없다');
            assert.ok(q.prompt && q.explain && q.ref && q.tags.length);
            if (q.hand) { assert.strictEqual(q.hand.length, 2); assert.notStrictEqual(q.hand[0], q.hand[1]); q.hand.forEach(c => assert.match(c, /^[2-9TJQKA][shdc]$/)); }
        }
    });
});

test('화면용 모양에는 정답·해설이 없다', () => {
    const v = Q.publicView(Q.generate('push', lcg(3)));
    assert.strictEqual(v.answer, undefined);
    assert.strictEqual(v.explain, undefined);
    assert.ok(v.prompt && v.choices.length);
});

test('없는 분야·이상한 값이면 아무 분야에서 낸다 (죽지 않는다)', () => {
    [undefined, null, 'all', 'nope', '__proto__', 'constructor', 5, {}].forEach(c => {
        const q = Q.generate(c, lcg(9));
        assert.ok(Q.CAT_IDS.includes(q.cat), String(c));
    });
});

test('푸시/폴드 문제의 정답은 기준표와 일치하고, 경계에서 떨어져 있다', () => {
    const rng = lcg(21);
    for (let i = 0; i < 400; i++) {
        const q = Q.generate('push', rng);
        const stack = Number(q.tags[0].match(/(\d+)bb/)[1]), behind = Number(q.tags[2].match(/(\d+)명/)[1]);
        const range = SS.pushPct(stack, behind);
        const p = SS.handPercentile(PF.handToCode(q.hand));
        if (q.answer === 'push') assert.ok(p <= range * 0.71, `${q.prompt} p=${p} range=${range}`);
        else { assert.strictEqual(q.answer, 'fold'); assert.ok(p >= range * 1.39, `${q.prompt} p=${p} range=${range}`); }
    }
});

test('올인 받기 문제: 정답은 범위 상대 승률과 팟오즈의 비교와 일치한다', () => {
    const rng = lcg(22);
    for (let i = 0; i < 300; i++) {
        const q = Q.generate('callshove', rng);
        const stack = Number(q.tags[1].match(/(\d+)bb/)[1]);
        const behind = { BTN: 2, CO: 3, HJ: 4, UTG: 5 }[q.tags[1].split(' ')[0]];
        const eq = SS.equityVs(PF.handToCode(q.hand), SS.shoverPct(stack, behind, 1));
        const odds = (stack - 1) / (stack + 1.5 + stack - 1);
        assert.strictEqual(q.answer, eq > odds ? 'call' : 'fold');
        assert.ok(Math.abs(eq - odds) >= 0.049, '경계 근처 문제가 나왔다');
    }
});

test('포지션 오픈 문제: 정답은 오픈 차트와 일치한다', () => {
    const rng = lcg(23);
    for (let i = 0; i < 300; i++) {
        const q = Q.generate('open', rng);
        const pos = q.tags[2].replace('내 자리 ', '');
        assert.strictEqual(q.answer === 'raise', PF.isInOpenRange(PF.handToCode(q.hand), pos), q.prompt);
    }
});

test('계산 문제: 필요 승률·MDF·블러프 손익분기 공식이 맞다', () => {
    const rng = lcg(24);
    let seen = 0;
    for (let i = 0; i < 600; i++) {
        const q = Q.generate('odds', rng);
        const pot = (q.tags.find(t => /^팟 /.test(t)) || '').replace(/[^\d]/g, '');
        const bet = ((q.tags.find(t => /벳|블러프/.test(t)) || '').match(/([\d,]+)/) || [])[1];
        if (!pot || !bet || q.answer === 'call' || q.answer === 'fold') continue;
        const P = Number(pot), B = Number(bet.replace(/,/g, ''));
        if (/최소 방어/.test(q.prompt)) { assert.strictEqual(Number(q.answer), Math.round(P / (P + B) * 100)); seen++; }
        else if (/순수 블러프/.test(q.prompt)) { assert.strictEqual(Number(q.answer), Math.round(B / (P + B) * 100)); seen++; }
        else if (/본전이 되려면/.test(q.prompt)) { assert.strictEqual(Number(q.answer), Math.round(B / (P + 2 * B) * 100)); seen++; }
    }
    assert.ok(seen > 100);
});

test('헤즈업 버튼 문제: 경계 점수(32~39)는 내지 않고, 기준 점수 초과면 오픈', () => {
    const rng = lcg(25);
    for (let i = 0; i < 400; i++) {
        const q = Q.generate('headsup', rng);
        if (!q.tags.includes('내 자리 버튼(SB)')) continue;
        const score = PF.handRangeScore(PF.handToCode(q.hand));
        assert.ok(score < 32 || score > 39, '경계 점수 ' + score);
        assert.strictEqual(q.answer, score > Q.HU_OPEN_SCORE ? 'raise' : 'fold');
    }
});

test('기록: 분야별 문제 수·정답 수·연속 정답', () => {
    const u = {};
    Q.record(u, 'push', true); Q.record(u, 'push', true); Q.record(u, 'odds', false);
    let s = Q.statsOf(u);
    assert.deepStrictEqual({ p: s.cats.push, o: s.cats.odds, total: s.total, ok: s.ok, streak: s.streak, best: s.best },
        { p: { n: 2, ok: 2 }, o: { n: 1, ok: 0 }, total: 3, ok: 2, streak: 0, best: 2 });
    Q.record(u, 'nope', true); Q.record(u, '__proto__', true);
    assert.strictEqual(Q.statsOf(u).total, 3, '없는 분야는 기록하지 않는다');
});

test('기록: 망가진 저장값에도 안전', () => {
    [{}, { quiz: 'x' }, { quiz: { cats: { push: { n: -3, ok: 99 } }, streak: 'a', best: -1 } }, null].forEach(u => {
        const s = Q.statsOf(u);
        assert.ok(s.total >= 0 && s.ok >= 0 && s.ok <= s.total && s.streak >= 0);
        Q.CAT_IDS.forEach(id => assert.ok(s.cats[id].ok <= s.cats[id].n));
    });
});

// ══════════════ 자리별 방어 · 권장 크기 ══════════════

test('방어 폭: 앞자리 오픈일수록 좁게, 버튼·SB 스틸일수록 넓게, BB는 다른 자리보다 넓게', () => {
    const w = c => (c.length === 2 ? 6 : c[2] === 's' ? 4 : 12);
    const frac = (hero, ctx) => Q.ALL_CODES.reduce((n, c) => n + (PF.preflopRangeTier(c, hero, true, ctx).tier !== 'fold' ? w(c) : 0), 0) / 1326;
    const bb = o => frac('BB', { openerPos: o, closing: true }), ip = o => frac('BTN', { openerPos: o });
    assert.ok(bb('UTG') < bb('CO') && bb('CO') < bb('BTN') && bb('BTN') <= bb('SB'));
    assert.ok(ip('UTG') < ip('CO'));
    ['UTG', 'HJ', 'CO'].forEach(o => assert.ok(bb(o) > ip(o) * 1.5, o + ': BB 가 훨씬 넓어야 한다'));
    assert.ok(bb('UTG') > 0.18 && bb('UTG') < 0.30 && bb('BTN') > 0.30 && bb('BTN') < 0.50);
    const hu = frac('BB', { headsUp: true, closing: true });
    assert.ok(hu > 0.55 && hu < 0.75, '헤즈업 BB 는 절반 넘게 지킨다: ' + hu);
});

test('방어 기준 입력이 없으면(봇) 예전 기준 그대로', () => {
    Q.ALL_CODES.forEach(c => {
        const a = PF.preflopRangeTier(c, 'BB', true, { numActive: 6 }), b = PF.preflopRangeTier(c, 'BB', true, { numActive: 6, openerPos: '', closing: false });
        assert.strictEqual(a.tier, b.tier, c);
    });
    assert.strictEqual(PF.studyDefense({ numActive: 4 }), null);
    assert.strictEqual(PF.studyDefense({ openerPos: 'nope' }), null);
});

test('오픈 받기 문제: 정답은 자리별 기준과 일치하고 경계에서 떨어져 있다', () => {
    const rng = lcg(31);
    for (let i = 0; i < 300; i++) {
        const q = Q.generate('defend', rng);
        const hero = q.tags[2].replace('내 자리 ', ''), opener = q.tags[3].split(' ')[0];
        const code = PF.handToCode(q.hand), ctx = { openerPos: opener, closing: hero === 'BB' };
        assert.strictEqual(q.answer, PF.preflopRangeTier(code, hero, true, ctx).tier, q.prompt);
        const th = PF.studyDefense(ctx).callTh + (PF.isInOpenRange(code, hero) ? 0 : 4);
        assert.ok(Math.abs(PF.handRangeScore(code) - th) > 2, '경계 근처: ' + q.prompt);
    }
});

test('권장 크기: 얕으면 작게 열고, 3벳은 포지션·콜러에 따라 커지고, 스택의 1/3을 넘으면 올인', () => {
    assert.match(A.openSize(15, false), /^2bb/);
    assert.match(A.openSize(100, false), /2\.2/);
    const ip = A.threeBetSize(250, 0, true, 100, 10000), oop = A.threeBetSize(250, 0, false, 100, 10000), sq = A.threeBetSize(250, 2, true, 100, 10000);
    assert.deepStrictEqual([ip.to, oop.to, sq.to], [800, 1000, 1300]);     // 3배 / 4배 / (3+2)배 — 100 단위 반올림
    assert.strictEqual(A.threeBetSize(250, 0, true, 100, 2000).allIn, true);
});

test('권장 크기(포스트플랍): 마른 보드 헤즈업은 작게, 멀티웨이·젖은 보드는 크게, SPR 이 낮으면 올인', () => {
    assert.strictEqual(A.betSize({ opponents: 1, dry: true, pot: 600, spr: 8 }).frac, 0.33);
    assert.ok(A.betSize({ opponents: 1, wet: true, pot: 600, spr: 8 }).frac >= 0.66);
    assert.ok(A.betSize({ opponents: 3, dry: true, pot: 600, spr: 8 }).frac >= 0.66);
    assert.strictEqual(A.betSize({ opponents: 1, dry: true, pot: 600, spr: 0.9 }).frac, 1);
});

test('근접도 점수: 권장 액션이면 95, 믹스 비중이 낮을수록 낮게, 믹스에 없으면 15', () => {
    const adv = { mix: { fold: 6, raise: 94 }, bestAction: 'raise', sizeHint: '2.2~2.5bb' };
    assert.strictEqual(A.scoreAction(adv, 'raise'), 95);
    assert.strictEqual(A.scoreAction(adv, 'allin'), 95, '올인은 레이즈로 본다');
    assert.strictEqual(A.scoreAction(adv, 'fold'), 40);
    assert.strictEqual(A.scoreAction(adv, 'call'), 15, '믹스에 없는 림프');
    assert.strictEqual(A.scoreAction({ mix: { check: 55, bet: 45 }, bestAction: 'check' }, 'raise'), 88, '체크 가능한 자리의 레이즈는 벳으로 본다');
    assert.strictEqual(A.scoreAction(null, 'call'), null);
});

test('근접도 점수: 올인이 기준인 자리에서 작게 레이즈하면 방향이 맞아도 감점', () => {
    const adv = { mix: { fold: 8, raise: 92 }, bestAction: 'raise', sizeHint: '올인' };
    assert.strictEqual(A.scoreAction(adv, 'allin'), 95);
    assert.strictEqual(A.scoreAction(adv, 'raise'), 55);
    assert.strictEqual(A.wrongSize(adv, 'allin'), false);
    assert.strictEqual(A.wrongSize({ sizeHint: '약 800 (상대 벳의 3배)' }, 'raise'), false);
});

test('모든 문제에 테이블 장면이 있다: 나는 정확히 한 명, 좌석 2~6개, 스택·벳은 0 이상', () => {
    const rng = lcg(41);
    Q.CAT_IDS.forEach(cat => {
        for (let i = 0; i < 300; i++) {
            const q = Q.generate(cat, rng);
            const sc = Q.publicView(q).scene;
            assert.ok(sc, cat + ': 장면이 없다 — ' + q.prompt.slice(0, 30));
            assert.strictEqual(sc.seats.filter(x => x.st === 'hero').length, 1, q.prompt.slice(0, 30));
            assert.ok(sc.seats.length >= 2 && sc.seats.length <= 6);
            sc.seats.forEach(x => { assert.ok(x.pos && x.stack >= 0 && x.bet >= 0, JSON.stringify(x)); assert.ok(['hero', 'fold', 'in', 'wait', 'allin'].includes(x.st)); });
            assert.ok(['bb', 'chips'].includes(sc.unit) && sc.pot >= 0);
            assert.strictEqual(new Set(sc.seats.map(x => x.pos)).size, sc.seats.length, '자리 이름 중복');
        }
    });
});

test('장면: 프리플랍은 블라인드가 놓이고, 내 앞자리는 폴드·뒷자리는 대기가 기본', () => {
    const sc = Q.preScene('CO', 10, {}, {}, 30);
    const by = Object.fromEntries(sc.seats.map(x => [x.pos, x]));
    assert.deepStrictEqual([by.UTG.st, by.HJ.st, by.CO.st, by.BTN.st, by.SB.st, by.BB.st], ['fold', 'fold', 'hero', 'wait', 'wait', 'wait']);
    assert.deepStrictEqual([by.SB.bet, by.BB.bet, by.CO.stack, by.BB.stack], [0.5, 1, 10, 29]);
    const sh = Q.preScene('BB', 40, { BTN: 'a9', SB: 'f' }, { BTN: 9 }, 40);
    const btn = sh.seats.find(x => x.pos === 'BTN');
    assert.deepStrictEqual([btn.st, btn.bet, btn.stack], ['allin', 9, 0]);
});

test('손으로 쓴 문제마다 장면이 하나씩 짝지어져 있다', () => {
    ['multiway', 'depth'].forEach(c => assert.strictEqual(Q.AUTHORED[c].length, Q.AUTHORED_SCENES[c].length, c));
});

test('드로우 찾기: 플러시 9 · 양방 8 · 것샷 4 · 겹치면 15, 완성된 패·리버·드로우 없음은 null', () => {
    assert.deepStrictEqual(A.detectDraws(['Td', 'Jd'], ['5c', 'Qd', '5h', '4d']), { outs: 9, label: '플러시 드로우', flush: true, straightRanks: 0, weak: false });
    assert.strictEqual(A.detectDraws(['9s', '8d'], ['7c', '6h', '2d']).outs, 8);
    assert.strictEqual(A.detectDraws(['9s', '8d'], ['6c', '5h', 'Kd']).outs, 4);
    assert.strictEqual(A.detectDraws(['9h', '8h'], ['7h', '6h', '2c']).outs, 15);
    assert.strictEqual(A.detectDraws(['Ah', '2s'], ['3c', '4d', 'Kh']).outs, 4, 'A-2-3-4 는 5 하나만 기다린다');
    assert.strictEqual(A.detectDraws(['As', 'Kd'], ['9c', '6h', '2d']), null);
    assert.strictEqual(A.detectDraws(['Ah', 'Kh'], ['2h', '7h', '9h']), null, '이미 플러시');
    assert.strictEqual(A.detectDraws(['9s', '8d'], ['7c', '6h', 'Td']), null, '이미 스트레이트');
    assert.strictEqual(A.detectDraws(['Td', 'Jd'], ['5c', 'Qd', '5h', '4d', '2s']), null, '리버');
    assert.strictEqual(A.detectDraws(['2c', '7d'], ['Ah', 'Kh', 'Qh', 'Jh']), null, '보드만으로 된 드로우는 내 드로우가 아니다');
    [null, [], ['xx', 'yy'], ['Td']].forEach(h => assert.strictEqual(A.detectDraws(h, ['5c', 'Qd', '5h']), null));
});

test('임플라이드 오즈: 깊은 스택의 강한 드로우는 가격이 조금 모자라도 콜, 얕으면 폴드', () => {
    const draw = A.detectDraws(['Td', 'Jd'], ['5c', 'Qd', '5h', '4d']);
    const ctx = { equity: 0.19, potOdds: 0.255, toCall: 287, opponents: 1, inPosition: true, draw, pot: 837 };
    const deep = A.postflopAdvice(Object.assign({ spr: 11, stackShare: 0.03, behind: 9176 }, ctx));
    assert.strictEqual(deep.bestAction, 'call');
    assert.ok(deep.notes.includes('임플라이드 오즈') && /아웃츠 9장/.test(deep.reason));
    const shallow = A.postflopAdvice(Object.assign({ spr: 3, stackShare: 0.5, behind: 150 }, ctx));
    assert.strictEqual(shallow.bestAction, 'fold');
    // 것샷(4아웃)이나 드로우가 없으면 임플라이드로 콜하지 않는다
    assert.strictEqual(A.postflopAdvice(Object.assign({ spr: 11, stackShare: 0.03, behind: 9176 }, ctx, { draw: { outs: 4, label: '것샷' }, equity: 0.10 })).bestAction, 'fold');
    assert.strictEqual(A.postflopAdvice(Object.assign({ spr: 11, stackShare: 0.03, behind: 9176 }, ctx, { draw: null })).bestAction, 'fold');
    // 벳이 너무 크면(팟의 2배) 깊어도 폴드
    assert.strictEqual(A.postflopAdvice({ equity: 0.19, potOdds: 0.4, toCall: 1600, opponents: 1, inPosition: true, spr: 5, stackShare: 0.2, draw, pot: 2400, behind: 8000 }).bestAction, 'fold');
});

test('점검: 약한 플러시 드로우는 임플라이드 콜 근거가 아니다 · 얇은 밸류는 작게 · 프리플랍 등급은 점수 기준', () => {
    // 보드에 다이아 3장 + 내 낮은 다이아 한 장 → 약한 드로우
    const weak = A.detectDraws(['3d', '2c'], ['4d', 'Ks', '9d', '7d']);
    assert.strictEqual(weak.weak, true);
    assert.match(weak.label, /약한 플러시 드로우/);
    // 에이스 한 장짜리(넛 드로우)와 두 장짜리는 약하지 않다
    assert.strictEqual(A.detectDraws(['Ad', '2c'], ['4d', 'Ks', '9d', '7d']).weak, false);
    assert.strictEqual(A.detectDraws(['3d', '2d'], ['4d', 'Ks', '9d', 'Jc']).weak, false);
    const ctx = { toCall: 500, pot: 1500, behind: 9000 };
    assert.strictEqual(A.impliedCall(Object.assign({ draw: weak }, ctx), 0.2), false);
    assert.strictEqual(A.impliedCall(Object.assign({ draw: A.detectDraws(['Td', 'Jd'], ['5c', 'Qd', '5h', '4d']) }, ctx), 0.2), true);

    // 얇은 밸류벳: 권장과 믹스가 같은 방향, 크기는 1/3
    const thin = A.postflopAdvice({ equity: 0.62, potOdds: 0, toCall: 0, opponents: 1, inPosition: true, spr: 5 });
    if (thin.thin) {
        assert.strictEqual(thin.bestAction, 'bet');
        assert.ok(thin.mix.bet > thin.mix.check);
        assert.match(A.betSize({ opponents: 1, wet: true, spr: 5, pot: 900, thin: true }).text, /1\/3/);
    }
    assert.strictEqual(A.betSize({ opponents: 1, wet: true, spr: 5, pot: 900, thin: true }).frac, 0.33);

    // 프리플랍 등급
    assert.strictEqual(A.preflopTier(90).tierLabel, '매우 강함');
    assert.strictEqual(A.preflopTier(72).tierLabel, '강함');
    assert.strictEqual(A.preflopTier(30).tierLabel, '매우 약함');

    // 림퍼가 있으면 오픈을 키운다
    assert.match(A.openSize(100, false, 2), /^5bb/);
    assert.match(A.openSize(100, false, 0), /2\.2/);

    // 체크할 수 있는 자리에서의 '레이즈'는 벳으로 채점된다
    assert.strictEqual(A.actionKey({ mix: { check: 40, bet: 60 } }, 'raise'), 'bet');
});
