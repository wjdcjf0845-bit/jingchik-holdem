const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/flopsolve');

const k = (h, b) => F.bucket(h, b).key;

test('패 종류: 만든 패', () => {
    assert.strictEqual(k(['Ah', 'Kd'], ['Ks', '7d', '2c']), 'tp1|-');
    assert.strictEqual(k(['Kh', '9d'], ['Ks', '7d', '2c']), 'tp2|-');
    assert.strictEqual(k(['7h', '7s'], ['Ks', '7d', '2c']), 'mon|-');          // 셋
    assert.strictEqual(k(['Kh', '7s'], ['Ks', '7d', '2c']), 'mon|-');          // 투페어
    assert.strictEqual(k(['Qh', 'Qd'], ['Js', '8d', '4c']), 'op|-');
    assert.strictEqual(k(['9h', '9d'], ['Js', '8d', '4c']), 'mp|-');           // 탑과 둘째 사이의 포켓
    assert.strictEqual(k(['5h', '5d'], ['Js', '8d', '4c']), 'lp|-');
    assert.strictEqual(k(['8h', '6s'], ['Js', '8d', '4c']), 'mp|-');
    assert.strictEqual(k(['4h', '3s'], ['Js', '8d', '4c']), 'lp|-');
    assert.strictEqual(k(['Ah', 'Qd'], ['Js', '8d', '4c']), 'ah|-');
    assert.strictEqual(k(['Kh', 'Qc'], ['Js', '8d', '4c']), 'oc|-');
    assert.strictEqual(k(['6h', '5c'], ['Ks', '7d', '2c']), 'air|-');
    // 보드 페어: 내 카드가 낀 트립스만 강한 패, 포켓 페어는 그냥 페어
    assert.strictEqual(k(['9h', '8d'], ['Ks', '9d', '9c']), 'mon|-');
    assert.strictEqual(k(['8h', '8d'], ['Ks', '9d', '9c']), 'lp|-');
});

test('패 종류: 드로우', () => {
    assert.strictEqual(k(['Ah', '5h'], ['Ks', '7h', '2h']), 'ah|fd');
    assert.strictEqual(k(['9h', '8h'], ['7h', '6d', '2c']), 'oc|oe');
    assert.strictEqual(k(['Jd', 'Td'], ['Qd', '9d', '2c']), 'air|cd');
    assert.strictEqual(k(['Jd', '9c'], ['Qd', '8s', '2c']), 'air|gs');
    assert.strictEqual(k(['Qc', 'Jc'], ['Ks', '7c', '2d']), 'air|bd');
    assert.strictEqual(k(['Ah', '4s'], ['5d', '3c', '2h']), 'mon|-');          // 휠
    assert.strictEqual(F.bucketKo(F.bucket(['Ah', '5h'], ['Ks', '7h', '2h'])), '에이스 하이 + 플러시 드로우');
});

test('비슷한 보드 찾기: 높은 카드·페어·무늬·이어짐이 가까운 쪽', () => {
    const keys = ['Ks7d2c', 'As7d2c', 'Kh9h4h', 'Ks8d8c', '9h8h6d', '7d6s5s', 'Td9s5c'];
    assert.strictEqual(F.nearestBoard(['Kc', '8h', '3d'], keys).key, 'Ks7d2c');
    assert.strictEqual(F.nearestBoard(['Kc', '7c', '2c'], keys).key, 'Kh9h4h');
    assert.strictEqual(F.nearestBoard(['Qs', '7d', '7c'], keys).key, 'Ks8d8c');
    assert.strictEqual(F.nearestBoard(['Th', '7h', '6s'], keys).key, '9h8h6d');
    assert.strictEqual(F.nearestBoard(['Ks', '7d', '2c'], keys).dist, 0);
});

test('조회: 패 종류 → 빈도, 표본이 적으면 "만든 패"만으로, 그것도 없으면 null', () => {
    const data = { btn: { Ks7d2c: { ip_cbet: { 'tp1|-': [10, 60, 30, 40], 'air|*': [40, 50, 10, 200], 'air|bd': [20, 70, 10, 1], '*': [30, 55, 15, 500] } } } };
    const a = F.lookup({ spot: 'btn', node: 'ip_cbet', hand: ['Ah', 'Kd'], board: ['Kc', '8h', '3d'] }, data);
    assert.deepStrictEqual(a.freqs, [10, 60, 30]); assert.strictEqual(a.level, 'full'); assert.strictEqual(a.board, 'Ks7d2c');
    const b = F.lookup({ spot: 'btn', node: 'ip_cbet', hand: ['Qc', 'Jc'], board: ['Ks', '7c', '2d'] }, data);
    assert.deepStrictEqual(b.freqs, [40, 50, 10]); assert.strictEqual(b.level, 'made');
    assert.strictEqual(F.lookup({ spot: 'btn', node: 'ip_cbet', hand: ['Qh', 'Qd'], board: ['Ks', '7c', '2d'] }, data), null);
    assert.strictEqual(F.lookup({ spot: 'hu', node: 'ip_cbet', hand: ['Ah', 'Kd'], board: ['Kc', '8h', '3d'] }, data), null);
    assert.strictEqual(F.lookup({ spot: 'btn', node: 'oop_root', hand: ['Ah', 'Kd'], board: ['Kc', '8h', '3d'] }, data), null);
});
