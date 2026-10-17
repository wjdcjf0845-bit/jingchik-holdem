const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');

// server.js 의 홀인원 장부 함수(JP_FIRST ~ jpLedger)를 그대로 떼어 와서 돌린다 — 돈이 걸린 계산이라 실제 코드로 검산한다
function loadLedger() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const a = src.indexOf('    JP_FIRST: 5000'), b = src.indexOf('    // 🛡️ [관리자] 장부 고치기');
    assert.ok(a > 0 && b > a, '장부 코드 위치');
    return eval('({ users: new Map(), save() {}, ' + src.slice(a, b) + ' })');
}

test('홀인원: 참가비는 시작하자마자 상금에 · 딥스택 두 개가 겹치면 먼저 우승한 사람이 그때까지 쌓인 것을 전부 · 늦게 우승한 사람은 없음', () => {
    const DB = loadLedger();
    ['철수', '영희', '민수', '지영', '현우'].forEach(n => DB.users.set(n, { nickname: n }));
    ['철수', '영희'].forEach(n => DB.jpEnter(n, 'A')); ['민수', '지영'].forEach(n => DB.jpEnter(n, 'B'));
    const v = DB.jpView(null);
    assert.strictEqual(v.pot, 20000, '입금 확인 없이 바로 상금'); assert.strictEqual(v.pending, 0);
    const a = DB.jpAward('철수', 'A', 36);
    assert.strictEqual(a.amount, 20000); assert.strictEqual(a.pending, 0);
    assert.strictEqual(DB.jpAward('지영', 'B', 36), null, '늦게 끝난 대회의 우승자는 남은 상금이 없다');
    assert.strictEqual(DB.jpCycle(), 2, '회차는 한 번만 넘어간다');
    assert.strictEqual(DB.jpView(null).pot, 0, '새 회차는 0원부터');
    // 다음 회차: 봇이 우승하면 넘어가고, 다음 사람 우승자가 전부
    DB.jpEnter('영희', 'C'); DB.jpEnter('현우', 'C');
    assert.strictEqual(DB.users.get('영희').jpEntries.slice(-1)[0].fee, 5000, '새 회차 첫 참가는 5000원');
    DB.jpEnter('민수', 'D');
    assert.strictEqual(DB.jpAward('민수', 'D', 36).amount, 15000, '봇이 우승한 C 의 참가비 + D 참가비');
    // 같은 회차에 다시 참가하면 1000원
    DB.jpEnter('철수', 'E'); DB.jpEnter('철수', 'F');
    assert.deepStrictEqual(DB.users.get('철수').jpEntries.slice(-2).map(e => e.fee), [5000, 1000]);
    assert.strictEqual(DB.jpView(null).pot, 6000);
});

test('홀인원 관리자 장부: 사람마다 받을 돈(참가비) · 보낼 돈(상금) · 정산 차액 — 합이 맞는다', () => {
    const DB = loadLedger();
    ['철수', '영희', '민수'].forEach(n => DB.users.set(n, { nickname: n }));
    DB.jpEnter('철수', 'A'); DB.jpEnter('영희', 'A'); DB.jpEnter('영희', 'B'); DB.jpEnter('민수', 'B');   // 5000 + 5000 + 1000 + 5000
    DB.jpAward('영희', 'B', 36);                                                                          // 16000
    DB.jpEnter('철수', 'C');                                                                              // 다음 회차 5000
    const L = DB.jpLedger(), P = {}; L.people.forEach(p => { P[p.nick] = p; });
    assert.deepStrictEqual([P['철수'].fees, P['철수'].prize, P['철수'].net], [10000, 0, -10000]);
    assert.deepStrictEqual([P['영희'].fees, P['영희'].prize, P['영희'].net], [6000, 16000, 10000]);
    assert.deepStrictEqual([P['민수'].fees, P['민수'].prize, P['민수'].net], [5000, 0, -5000]);
    const fees = L.people.reduce((a, p) => a + p.fees, 0), prize = L.people.reduce((a, p) => a + p.prize, 0);
    assert.strictEqual(fees - prize, DB.jpView(null).pot, '받은 참가비 − 보낸 상금 = 지금 쌓인 상금');
    assert.strictEqual(L.people[0].nick, '영희', '보낼 돈이 큰 사람부터');
});
