const test = require('node:test');
const assert = require('node:assert');
const { AccessLog } = require('../lib/accesslog');

const NOW = 1790000000000;
const ev = (t, nick, type) => ({ t: NOW - t, type: type || 'login', nick, ip: '1.2.3.4', ua: 'x', detail: '' });

test('합치기: 원격 기록과 서버 시작 후 쌓인 기록을 시간순으로 합친다', () => {
    const log = new AccessLog();
    log.push(ev(1000, '새로온사람'), NOW);                       // 서버가 켜진 뒤 들어온 접속
    log.merge([ev(90000, '어제'), ev(50000, '아까')], NOW);      // 원격에 있던 예전 기록
    assert.deepStrictEqual(log.events.map(e => e.nick), ['어제', '아까', '새로온사람']);
    assert.strictEqual(log.dirty, true);
});

test('합치기: 같은 기록은 한 번만 (재시작마다 두 배로 불어나지 않는다)', () => {
    const log = new AccessLog();
    const rows = [ev(3000, 'a'), ev(2000, 'b')];
    log.merge(rows, NOW); log.merge(rows, NOW); log.merge(JSON.parse(JSON.stringify(log.toJSON())), NOW);
    assert.strictEqual(log.events.length, 2);
});

test('합치기: 상한·보관 기간은 그대로 지킨다, 망가진 값은 무시', () => {
    const log = new AccessLog({ max: 3, maxAgeMs: 10000 });
    log.merge([ev(99999, '너무오래됨'), ev(5, 'd'), ev(4, 'c'), ev(3, 'b'), ev(2, 'a')], NOW);
    assert.deepStrictEqual(log.events.map(e => e.nick), ['c', 'b', 'a']);
    ['x', null, 5, {}].forEach(v => log.merge(v, NOW));
    log.merge([null, 'str', 7, { t: 'bad' }], NOW);
    assert.ok(log.events.length <= 3);
});
