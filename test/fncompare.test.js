const test = require('node:test');
const assert = require('node:assert');
const FC = require('../lib/fncompare');

const F = (o) => Object.assign({ seatSum: 700, seatCnt: 100, preflopOpps: 400, vpipHands: 92, pfrHands: 72, threeBetOpps: 100, threeBetCount: 8, aggrBets: 120, aggrCalls: 50,
    faceBet: 200, foldToBet: 100, wentToShowdown: 60, wonAtShowdown: 32, netBB: 50, netHands: 400, evHands: 400, lkB_overcall: 20, lkN_overcall: 6, lkB_spew: 8, lkN_spew: 2 }, o);
const kinds = { overcall: { name: '접어야 할 패로 콜' }, spew: { name: '접어야 할 패로 레이즈·올인' } };

test('딥스택 비교: 표준 지표 계산(VPIP · PFR · 3벳 · AF · 벳에 폴드 · 쇼다운 승률) · 표본이 적으면 비움', () => {
    const m = FC.metrics(F());
    assert.deepStrictEqual([m.seats, m.vpip, m.pfr, m.tb, m.af, m.ftb, m.wsd, m.net100], [7, 23, 18, 8, 2.4, 50, 53.3, 13]);
    const few = FC.metrics(F({ preflopOpps: 20, threeBetOpps: 5, faceBet: 10, wentToShowdown: 3 }));
    assert.deepStrictEqual([few.vpip, few.tb, few.ftb, few.wsd], [null, null, null, null]);
    assert.deepStrictEqual(FC.topLeak(F(), kinds), { key: 'overcall', name: '접어야 할 패로 콜', n: 6, per100: 5 });
});

test('딥스택 비교: 기준을 벗어난 지표를 크게 벗어난 순으로 2개까지 · 최대 누수 · 1위 표시 · 표본 경고', () => {
    const rows = FC.analyze([
        { nick: '정석', score: 70, loss100: 8, hands: 400, st: FC.metrics(F()), leak: FC.topLeak(F(), kinds) },
        { nick: '콜러', score: 40, loss100: 30, hands: 200, st: FC.metrics(F({ vpipHands: 200, pfrHands: 40, aggrBets: 30, aggrCalls: 60 })), leak: null }
    ]);
    const a = rows[0], b = rows[1];
    assert.strictEqual(a.cells.vpip.s, 'ok');
    assert.deepStrictEqual(a.notes.map(n => n.s), ['실력 점수 1위(70)', '최대 누수: 접어야 할 패로 콜 5bb/100', '표준 지표가 모두 기준 범위 안']);
    assert.strictEqual(b.cells.vpip.s, 'hi'); assert.strictEqual(b.cells.af.s, 'lo');
    const warns = b.notes.filter(n => n.t === 'warn').map(n => n.s);
    assert.strictEqual(warns.length, 2);
    assert.match(warns[0], /^VPIP−PFR 40%p 콜 위주/, '가장 크게 벗어난 것부터');
    assert.match(warns[1], /^VPIP 50% 넓음\(기준 17~28%\)/);
    assert.ok(b.notes.some(n => n.s === '표본 200판 — 아직 참고만'));
    // 평균 인원이 적으면 VPIP 기준이 넓어진다
    assert.deepStrictEqual(FC.ranges(3).vpip, [30, 55]);
});
