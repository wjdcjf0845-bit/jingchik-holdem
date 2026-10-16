const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');

// server.js 의 홀인원 장부 함수(JP_FIRST ~ jpAward)를 그대로 떼어 와서 돌린다 — 돈이 걸린 계산이라 실제 코드로 검산한다
function loadLedger() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const a = src.indexOf('    JP_FIRST: 5000'), b = src.indexOf('    // 🛡️ [관리자] 장부 전체');
    assert.ok(a > 0 && b > a, '장부 코드 위치');
    return eval('({ users: new Map(), save() {}, ' + src.slice(a, b) + ' })');
}

test('홀인원: 딥스택 두 개가 겹치면 먼저 우승한 사람이 그때까지 쌓인 것을 전부 · 늦게 우승한 사람은 없음 · 늦은 입금 확인도 먼저 우승자 몫', () => {
    const DB = loadLedger();
    ['철수', '영희', '민수', '지영', '현우'].forEach(n => DB.users.set(n, { nickname: n }));
    const ok = who => DB.users.forEach(u => (u.jpEntries || []).forEach(e => { if (!who || who.includes(u.nickname)) e.ok = true; }));
    ['철수', '영희'].forEach(n => DB.jpEnter(n, 'A')); ['민수', '지영'].forEach(n => DB.jpEnter(n, 'B')); ok(['철수', '영희', '민수']);
    const a = DB.jpAward('철수', 'A', 50);
    assert.strictEqual(a.amount, 15000); assert.strictEqual(a.pending, 5000);
    assert.strictEqual(DB.jpAward('지영', 'B', 50), null, '늦게 끝난 대회의 우승자는 남은 상금이 없다');
    assert.strictEqual(DB.jpCycle(), 2, '회차는 한 번만 넘어간다');
    ok(['지영']);
    assert.strictEqual(DB.jpView(null).history[0].amount, 20000, '늦게 확인된 참가비도 그 회차 우승자 몫');
    // 다음 회차: 봇이 우승하면 넘어가고, 다음 사람 우승자가 전부
    DB.jpEnter('영희', 'C'); DB.jpEnter('현우', 'C'); ok();
    assert.strictEqual(DB.users.get('영희').jpEntries.slice(-1)[0].fee, 5000, '새 회차 첫 참가는 5000원');
    DB.jpEnter('민수', 'D'); ok();
    assert.strictEqual(DB.users.get('민수').jpEntries.slice(-1)[0].fee, 5000);
    assert.strictEqual(DB.jpAward('민수', 'D', 50).amount, 15000, '봇이 우승한 C 의 참가비 + D 참가비');
    // 같은 회차에 다시 참가하면 1000원
    DB.jpEnter('철수', 'E'); DB.jpEnter('철수', 'F');
    const fees = DB.users.get('철수').jpEntries.slice(-2).map(e => e.fee);
    assert.deepStrictEqual(fees, [5000, 1000]);
});
