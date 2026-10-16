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
