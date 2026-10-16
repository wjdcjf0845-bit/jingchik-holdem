const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/aicoach');
const { createAI } = require('../lib/ai');

const rv = { place: 7, played: 120, hands: [
    { n: 12, lv: 4, pos: 'BB', stk: 38, seats: 9, alive: 31, h: ['As', 'Td'], b: ['Kh', '7c', '2d'], net: -12, loss: 3.4,
      d: [{ st: 'flop', b: 3, pot: 6, call: 4, act: 'fold', amt: 0, best: 'call', mix: { call: 70, fold: 30 }, loss: 3.4, k: 'overfold', why: '승률 41% 가 팟오즈 29% 보다 높습니다' }] },
    { n: 30, lv: 6, pos: 'BTN', stk: 22, seats: 8, alive: 20, h: ['7c', '2d'], b: [], net: 0, loss: 0,
      d: [{ st: 'preflop', b: 0, pot: 1.5, call: 0, act: 'fold', amt: 0, best: 'fold', mix: { fold: 100 }, loss: 0, k: null, why: '' }] }
] };

test('AI 코치: 리포트 질문에 실수 판의 숫자와 앱의 이유를 넣고, 판단을 지어내지 말라고 한다', () => {
    const p = C.coachPrompt(rv, { kinds: { overfold: { name: '이길 만한 패를 접음' } }, entrants: 50 });
    assert.strictEqual(p.decisions, 1);
    assert.match(p.user, /7위 \/ 50명/);
    assert.match(p.user, /판 #12/);
    assert.match(p.user, /이길 만한 패를 접음: 1번 · 3.4bb/);
    assert.match(p.user, /승률 41% 가 팟오즈 29% 보다 높습니다/);
    assert.ok(!/판 #30/.test(p.user), '손실 없는 판은 넣지 않는다');
    assert.match(p.system, /지어내지 마세요/);
    const e = C.explainPrompt(rv.hands[0], rv.hands[0].d[0], {});
    assert.match(e.user, /A♠ 10♦/); assert.match(e.user, /권장: 콜/); assert.match(e.user, /손실 3.4bb/);
});

test('AI 봇 말투: 대사를 한 줄로 다듬고 너무 길거나 비면 버린다 · AI 설정이 없으면 꺼진 채 null', async () => {
    assert.strictEqual(C.cleanLine('"좋아, 한번 가 보자!"\n(설명)'), '좋아, 한번 가 보자!');
    assert.strictEqual(C.cleanLine(''), null);
    assert.strictEqual(C.cleanLine('가'.repeat(60)), null);
    const p = C.botPrompt({ nick: '🤖불도저', style: '광폭', event: 'win', potBB: 40 });
    assert.match(p.user, /불도저/); assert.ok(!p.user.includes('🤖'));
    const off = createAI({});
    assert.strictEqual(off.enabled(), false);
    assert.strictEqual(await off.text({ system: 'x', user: 'y' }), null);
});

test('AI 한도: 봇 대사와 코치는 따로 센다 — 대사가 한도를 다 써도 코치는 된다', async () => {
    const http = require('http');
    const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: { content: '답' } })); }); });
    await new Promise(r => srv.listen(0, r));
    const ai = createAI({ OLLAMA_URL: 'http://127.0.0.1:' + srv.address().port, AI_CHAT_LIMIT: '2', AI_COACH_LIMIT: '1' });
    assert.strictEqual(await ai.text({ system: 's', user: 'u', bucket: 'chat' }), '답');
    assert.strictEqual(await ai.text({ system: 's', user: 'u', bucket: 'chat' }), '답');
    assert.strictEqual(await ai.text({ system: 's', user: 'u', bucket: 'chat' }), null, '대사 한도 초과');
    assert.strictEqual(await ai.text({ system: 's', user: 'u', bucket: 'coach' }), '답', '코치는 따로');
    assert.strictEqual(await ai.text({ system: 's', user: 'u', bucket: 'coach' }), null);
    srv.close();
});

test('AI 왜?: 작은 모델이 보드를 내 패로 읽지 않게 손패와 보드를 따로 적는다', () => {
    const h = { n: 40, lv: 6, pos: 'BB', stk: 42, seats: 9, alive: 37, h: ['Ah', '7h'], b: ['Kh', '7c', '2d', 'Qs', '3c'] };
    const p = C.explainPrompt(h, { st: 'river', b: 5, pot: 18, call: 12, act: 'fold', best: 'call', loss: 4.1, why: '필요 승률 29%' }, {});
    assert.match(p.user, /내 손에 든 패\(2장\): \[A♥ 7♥\]/);
    assert.match(p.user, /보드\): \[K♥ 7♣ 2♦ Q♠ 3♣\] — 내 패가 아닙니다/);
    assert.ok(!/친구에게/.test(p.system), '반말 호칭을 부르는 말이 없다');
});

test('AI Ollama: 기본 모델은 exaone3.5:7.8b · 모델을 30분 올려 둔다 · 온도를 주면 그대로 보낸다', async () => {
    let body = null;
    const http = require('http');
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { body = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: { content: '답' } })); }); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const ai = createAI({ OLLAMA_URL: 'http://127.0.0.1:' + srv.address().port });
    assert.strictEqual(ai.model, 'exaone3.5:7.8b');
    assert.strictEqual(await ai.text({ system: 's', user: 'u', bucket: 'coach', temperature: 0.3 }), '답');
    assert.strictEqual(body.options.temperature, 0.3);
    assert.strictEqual(body.keep_alive, '30m');
    await ai.text({ system: 's', user: 'u', bucket: 'chat' });
    assert.ok(!('temperature' in body.options), '안 주면 모델 기본값');
    srv.close();
});

test('주간 성장 리포트: 주 시작 전 마지막 합계와 주 끝 합계의 차이로 그 주만 센다', () => {
    const EvLoss = require('../lib/evloss');
    const D = 24 * 3600 * 1000, w0 = C.weekStart(new Date(2026, 9, 14, 15).getTime());   // 2026-10-14(수) → 그 주 월요일 10/12 0시
    assert.strictEqual(new Date(w0).getDay(), 1);
    assert.strictEqual(new Date(w0).getDate(), 12);
    const F = (h, l, kn) => ({ evHands: h, evLoss: l, evLossSq: l * 2, evLossN: l, evLossNSq: l * 2, lkN_overfold: kn, lkB_overfold: kn * 1.5 });
    const snaps = [C.snapOf(F(100, 10, 2), w0 - 3 * D, ['overfold']), C.snapOf(F(250, 22, 5), w0 + D, ['overfold']), C.snapOf(F(400, 30, 6), w0 + 4 * D, ['overfold'])];
    const results = [{ t: w0 - 3 * D, place: 3, paid: 6 }, { t: w0 + D, place: 1, paid: 6 }, { t: w0 + 4 * D, place: 9, paid: 6 }];
    const s = C.periodStats(snaps, results, w0, w0 + C.WEEK, EvLoss.index);
    assert.strictEqual(s.partial, false);
    assert.strictEqual(s.hands, 300, '400 − 100');
    assert.deepStrictEqual(s.kinds.overfold, [4, 6]);
    assert.strictEqual(s.games, 2); assert.strictEqual(s.wins, 1); assert.strictEqual(s.itm, 1); assert.strictEqual(s.best, 1);
    assert.strictEqual(s.score, EvLoss.index({ evHands: 300, evLoss: 20, evLossSq: 40, evLossN: 20, evLossNSq: 40 }).score);
    // 주 시작 전 기록이 없으면 그 주에 처음 찍은 것부터(partial)
    const p = C.periodStats(snaps.slice(1), results, w0, w0 + C.WEEK, EvLoss.index);
    assert.strictEqual(p.partial, true); assert.strictEqual(p.hands, 150);
    assert.strictEqual(C.periodStats(snaps, results, w0 + C.WEEK, w0 + 2 * C.WEEK, EvLoss.index), null, '그 주에 끝난 대회가 없으면 없음');
    const pr = C.weekPrompt(s, null, { kinds: { overfold: { name: '너무 많이 접음' } } });
    assert.match(pr.user, /대회 2번 · 입상 1번 · 우승 1번/);
    assert.match(pr.user, /너무 많이 접음 4번 6bb/);
    assert.match(pr.user, /그 전 기간: 기록 없음/);
});

test('딥스택 중계: 기본 문장은 사실만 · AI 문장은 주인공 이름이 있고 없는 숫자가 없을 때만 쓴다', () => {
    const e = { kind: 'out', nick: '철수', place: 5, alive: 4, paid: 6 };
    assert.strictEqual(C.castTemplate(e), '💀 철수 님 5위로 탈락합니다. 남은 사람 4명 (입상).');
    assert.strictEqual(C.castCheck('🔥 철수 님, 5위로 아쉽게 퇴장합니다!', e), '🔥 철수 님, 5위로 아쉽게 퇴장합니다!');
    assert.strictEqual(C.castCheck('철수 님이 3위로 떨어집니다', e), null, '사실에 없는 숫자');
    assert.strictEqual(C.castCheck('한 명이 탈락했습니다', e), null, '주인공 이름 없음');
    assert.strictEqual(C.castCheck('철수 님 탈락'.repeat(20), e), null, '너무 김');
    const b = { kind: 'bubble', alive: 7, paid: 6, leader: '🤖돌부처', leaderBB: 42 };
    assert.match(C.castTemplate(b), /7명 남았고 6위까지 입상.*돌부처 님\(42bb\)/);
    assert.strictEqual(C.castCheck('🫧 버블! 7명 중 한 명만 더 떨어지면 입상, 선두는 돌부처 님 42bb!', b), '🫧 버블! 7명 중 한 명만 더 떨어지면 입상, 선두는 돌부처 님 42bb!');
    assert.strictEqual(C.castTemplate({ kind: '없는것' }), null);
});

test('AI Ollama: 긴 글(코치)을 쓰는 동안 들어온 짧은 대사는 기다리지 않고 바로 null', async () => {
    const http = require('http');
    let hits = 0;
    const srv = http.createServer((req, res) => { hits++; req.resume(); req.on('end', () => setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: { content: '답' } })); }, 300)); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const ai = createAI({ OLLAMA_URL: 'http://127.0.0.1:' + srv.address().port });
    const long = ai.text({ system: 's', user: 'u', bucket: 'coach' });
    assert.strictEqual(ai.busy(), true);
    assert.strictEqual(await ai.text({ system: 's', user: 'u', bucket: 'chat' }), null);
    assert.strictEqual(await long, '답');
    assert.strictEqual(ai.busy(), false);
    assert.strictEqual(hits, 1, '짧은 대사는 보내지도 않았다');
    assert.strictEqual(ai.usedToday().chat, 0, '한도도 쓰지 않았다');
    assert.strictEqual(await ai.text({ system: 's', user: 'u', bucket: 'chat' }), '답', '끝난 뒤에는 된다');
    srv.close();
});
