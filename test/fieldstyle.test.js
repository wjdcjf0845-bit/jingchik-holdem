const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/fieldstyle');

test('매장형 스타일: 50인 구성 비율 · 스타일마다 프리플랍이 다르다', () => {
    const m = F.mix(47);
    assert.strictEqual(m.length, 47);
    const c = k => m.filter(x => x === k).length;
    assert.ok(c('pro') >= 22 && c('pro') <= 26, '정석 고수 약 절반: ' + c('pro'));
    F.KEYS.forEach(k => assert.ok(c(k) >= 4, k + ' ' + c(k)));
    // 같은 패(상위 30% · 컷오프)로 먼저 들어갈 때: 광폭만 레이즈
    const s = style => F.preflop({ style, pct: 0.3, pos: 'CO', extra: 0, facing: 'none', effBB: 100, toCallBB: 1, stackBB: 100, curBB: 1 }).act;
    assert.strictEqual(s('maniac'), 'raise');
    assert.strictEqual(s('nit'), 'fold');
    // 오픈을 받을 때(상위 25% · BB): 콜링스테이션은 콜, 초타이트는 폴드 · 아주 강하면 초타이트도 3벳
    const r = (style, pct) => F.preflop({ style, pct, pos: 'BB', extra: 0, facing: 'raise', effBB: 100, toCallBB: 1.5, stackBB: 100, curBB: 2.5 }).act;
    assert.strictEqual(r('station', 0.25), 'call');
    assert.strictEqual(r('nit', 0.25), 'fold');
    assert.strictEqual(r('nit', 0.01), 'raise');
    // 별명: 스타일마다 다른 이름, 겹치지 않는다
    const used = new Set(); for (let i = 0; i < 30; i++) used.add(F.nameFor('nit', used));
    assert.strictEqual(used.size, 30);
    assert.ok([...used].every(n => n.startsWith('🤖')));
    // 짧은 스택은 올인 아니면 폴드
    assert.strictEqual(F.preflop({ style: 'maniac', pct: 0.3, pos: 'BTN', extra: 0, facing: 'none', effBB: 10, toCallBB: 1, stackBB: 10, curBB: 1 }).act, 'jam');
    // 앞자리일수록 좁게
    assert.ok(F.posFactor('UTG', 3) < F.posFactor('LJ', 0) && F.posFactor('LJ', 0) < F.posFactor('BTN', 0));
});
