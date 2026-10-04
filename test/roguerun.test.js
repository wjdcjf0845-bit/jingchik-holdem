const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/roguerun');

// 재현 가능한 난수 (테스트용)
function seq(...vals) { let i = 0; return () => vals[i++ % vals.length]; }
function lcg(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

test('층 표: 10층, 봇 1~5명, 목표는 시작 칩보다 크고 기한은 양수', () => {
    assert.strictEqual(R.FLOORS.length, 10);
    R.FLOORS.forEach((f, i) => {
        assert.ok(f.bots.length >= 1 && f.bots.length <= 5, `${i + 1}층 봇 수`);
        f.bots.forEach(d => assert.ok(['easy', 'normal', 'hard'].includes(d)));
        assert.ok(f.quota > 1 && f.hands > 0);
    });
    assert.ok(R.FLOORS[4].boss && R.FLOORS[9].boss, '5층·10층은 보스');
});

test('증강 표: 등급은 s/g/p 뿐이고 등급마다 3개 이상', () => {
    const by = { s: 0, g: 0, p: 0 };
    Object.values(R.AUGMENTS).forEach(a => { assert.ok(a.tier in by); by[a.tier]++; assert.ok(a.name && a.desc && a.icon); });
    Object.values(by).forEach(n => assert.ok(n >= 3));
});

test('새 런: 1층, 증강 없음, 고를 것 3개(서로 다름)', () => {
    const run = R.newRun(lcg(1));
    assert.strictEqual(run.floor, 1);
    assert.strictEqual(run.phase, 'pick');
    assert.strictEqual(run.offers.length, 3);
    assert.strictEqual(new Set(run.offers).size, 3);
    run.offers.forEach(id => assert.ok(R.AUGMENTS[id]));
});

test('보스 층을 깬 직후는 프리즘 확정', () => {
    const run = R.newRun(lcg(2));
    run.floor = 6;
    R.makeOffers(run, lcg(3), true).forEach(id => assert.strictEqual(R.AUGMENTS[id].tier, 'p'));
});

test('고르기: 범위 밖·고르는 중이 아닐 때는 거절, 고르면 증강이 붙고 play 로', () => {
    const run = R.newRun(lcg(4));
    [-1, 3, 1.5, NaN, undefined, '0'].forEach(i => assert.strictEqual(R.pick(run, i), null, String(i)));
    const want = run.offers[1];
    assert.strictEqual(R.pick(run, 1), want);
    assert.deepStrictEqual(run.augments, [want]);
    assert.strictEqual(run.phase, 'play');
    assert.strictEqual(R.pick(run, 0), null, '한 번 고르면 또 못 고른다');
});

test('다시 뽑기는 정해진 횟수만', () => {
    const run = R.newRun(lcg(5));
    for (let i = 0; i < R.REROLLS; i++) assert.strictEqual(R.reroll(run, lcg(10 + i)), true);
    assert.strictEqual(R.reroll(run, lcg(99)), false);
    assert.strictEqual(run.offers.length, 3);
});

test('겹칠 수 없는 증강은 다시 안 나오고, 겹치는 증강도 한도까지만', () => {
    const run = R.newRun(lcg(6));
    run.augments = ['blind', 'pair', 'seven', 'wallet', 'wallet', 'wallet', 'interest', 'interest', 'extra', 'extra'];
    for (let k = 0; k < 200; k++) {
        R.makeOffers(run, lcg(k), false).forEach(id => {
            assert.ok(R.count(run, id) < (R.AUGMENTS[id].max || 1), id + ' 가 한도를 넘어 나왔다');
        });
    }
});

test('고를 게 바닥나도 죽지 않는다 (전부 가진 경우 빈 목록)', () => {
    const run = R.newRun(lcg(7));
    run.augments = [];
    Object.keys(R.AUGMENTS).forEach(id => { for (let i = 0; i < (R.AUGMENTS[id].max || 1); i++) run.augments.push(id); });
    assert.deepStrictEqual(R.makeOffers(run, lcg(8), false), []);
});

test('층 구성: 기본값과 증강 반영', () => {
    const run = R.newRun(lcg(9));
    let fs = R.floorSetup(run);
    assert.deepStrictEqual({ s: fs.startChips, q: fs.quota, h: fs.hands, b: fs.botChips, m: fs.mull }, { s: 3000, q: 3750, h: 10, b: 3000, m: 0 });
    run.augments = ['wallet', 'double', 'discount', 'extra', 'nerf', 'mull'];
    fs = R.floorSetup(run);
    assert.strictEqual(fs.startChips, 5100);                 // 3000 × (1 + 0.2 + 0.5)
    assert.strictEqual(fs.quota, Math.round(5100 * 1.25 * 0.9 / 50) * 50);
    assert.strictEqual(fs.hands, 12);
    assert.strictEqual(fs.botChips, 2250);
    assert.strictEqual(fs.mull, 3);
    assert.ok(fs.quota > fs.startChips, '목표는 항상 시작 칩보다 커야 한다');
});

test('목표 할인을 겹쳐도 목표가 시작 칩 아래로 내려가지 않는다', () => {
    for (let f = 1; f <= 10; f++) {
        const run = R.newRun(lcg(f)); run.floor = f; run.augments = ['discount', 'discount'];
        const fs = R.floorSetup(run);
        assert.ok(fs.quota >= fs.startChips + R.BB, f + '층');
    }
});

test('딜 보너스: 블라인드 환급·포켓 보너스는 증강이 있을 때만', () => {
    const run = R.newRun(lcg(11));
    assert.deepStrictEqual(R.onDeal(run, { hand: ['7s', '7d'], blindPaid: 100 }), { bonus: 0, notes: [] });
    run.augments = ['blind', 'pair'];
    assert.strictEqual(R.onDeal(run, { hand: ['7s', '7d'], blindPaid: 100 }).bonus, 350);
    assert.strictEqual(R.onDeal(run, { hand: ['7s', '8d'], blindPaid: 0 }).bonus, 0);
});

test('핸드 뒤 수당: 진 핸드·본전에는 승리 수당이 없다', () => {
    const run = R.newRun(lcg(12));
    run.augments = ['bonus', 'seven', 'combo', 'jackpot'];
    assert.strictEqual(R.afterHand(run, { start: 3000, now: 3000, hand: ['7s', '7d'], rank: 9, allIn: false, rng: seq(0) }).bonus, 0);
    assert.strictEqual(R.afterHand(run, { start: 3000, now: 2500, hand: ['7s', '7d'], rank: 9, allIn: false, rng: seq(0) }).bonus, 0);
});

test('핸드 뒤 수당: 이긴 핸드는 증강대로 더한다', () => {
    const run = R.newRun(lcg(13));
    run.augments = ['bonus', 'seven', 'combo', 'jackpot'];
    // 1000 벌었다: 수당 200 + 세븐 400 + 족보 800 + 잭팟(확률 통과) 1000
    const r = R.afterHand(run, { start: 3000, now: 4000, hand: ['7s', 'Kd'], rank: 5, allIn: false, rng: seq(0.1) });
    assert.strictEqual(r.bonus, 2400);
    // 잭팟 확률 실패, 7 없음, 족보 낮음 → 수당만
    assert.strictEqual(R.afterHand(run, { start: 3000, now: 4000, hand: ['As', 'Kd'], rank: 2, allIn: false, rng: seq(0.9) }).bonus, 200);
});

test('올인 보험은 올인해서 진 핸드만', () => {
    const run = R.newRun(lcg(14));
    run.augments = ['insure'];
    assert.strictEqual(R.afterHand(run, { start: 3000, now: 0, hand: ['As', 'Kd'], rank: 0, allIn: true, rng: seq(0) }).bonus, 900);
    assert.strictEqual(R.afterHand(run, { start: 3000, now: 2000, hand: ['As', 'Kd'], rank: 0, allIn: false, rng: seq(0) }).bonus, 0);
});

test('이자는 수당을 받은 뒤 칩 기준, 겹치면 두 배', () => {
    const run = R.newRun(lcg(15));
    run.augments = ['interest'];
    assert.strictEqual(R.afterHand(run, { start: 3000, now: 3000, hand: ['As', 'Kd'], rank: 0, allIn: false, rng: seq(0) }).bonus, 60);
    run.augments = ['interest', 'interest'];
    assert.strictEqual(R.afterHand(run, { start: 3000, now: 3000, hand: ['As', 'Kd'], rank: 0, allIn: false, rng: seq(0) }).bonus, 120);
});

test('수당은 절대 음수가 아니다 (난수 훑기)', () => {
    const rng = lcg(77);
    const ids = Object.keys(R.AUGMENTS);
    for (let k = 0; k < 2000; k++) {
        const run = R.newRun(rng);
        run.augments = ids.filter(() => rng() < 0.4);
        const start = Math.floor(rng() * 9000), now = Math.floor(rng() * 12000);
        const a = R.afterHand(run, { start, now, hand: ['7s', '7d'], rank: Math.floor(rng() * 10), allIn: rng() < 0.5, rng });
        const d = R.onDeal(run, { hand: ['7s', '7d'], blindPaid: Math.floor(rng() * 100) });
        assert.ok(Number.isInteger(a.bonus) && a.bonus >= 0);
        assert.ok(Number.isInteger(d.bonus) && d.bonus >= 0);
    }
});

test('정산: 한 층도 못 깨면 보상 없음, 기록만 남는다', () => {
    const u = {};
    const run = R.newRun(lcg(16));
    const r = R.settle(u, run);
    assert.deepStrictEqual({ reward: r.reward, cores: r.cores, cleared: r.cleared }, { reward: 0, cores: 0, cleared: 0 });
    assert.deepStrictEqual(u.rogue, { best: 0, runs: 1, wins: 0 });
});

test('정산: 첫 돌파는 크게, 같은 층 반복은 작게', () => {
    const u = {};
    const run = R.newRun(lcg(17)); run.cleared = 3;
    const first = R.settle(u, run);
    assert.strictEqual(first.reward, 400 * (1 + 2 + 3) + 1500 * 3);
    assert.strictEqual(first.cores, 6);
    assert.strictEqual(first.newBest, true);
    const again = R.settle(u, Object.assign(R.newRun(lcg(18)), { cleared: 3 }));
    assert.strictEqual(again.reward, 400 * 6);
    assert.strictEqual(again.cores, 3);
    assert.strictEqual(again.newBest, false);
    assert.strictEqual(u.cores, 9);
    assert.deepStrictEqual(u.rogue, { best: 3, runs: 2, wins: 0 });
});

test('정산: 10층 완주는 승리로 기록, 코어 채굴은 코어만 2배', () => {
    const u = { rogue: { best: 10, runs: 5, wins: 1 }, cores: 2 };
    const run = R.newRun(lcg(19)); run.cleared = 10; run.augments = ['cores'];
    const r = R.settle(u, run);
    assert.strictEqual(r.win, true);
    assert.strictEqual(r.reward, 400 * 55);
    assert.strictEqual(r.cores, 20);
    assert.strictEqual(u.cores, 22);
    assert.strictEqual(u.rogue.wins, 2);
});

test('정산: 이상한 값(층 수 초과·음수·깨진 기록)에도 안전', () => {
    const u = { rogue: 'x', cores: -5 };
    const run = R.newRun(lcg(20)); run.cleared = 999;
    const r = R.settle(u, run);
    assert.strictEqual(r.cleared, 10);
    assert.ok(u.cores > 0);
    const r2 = R.settle({}, Object.assign(R.newRun(lcg(21)), { cleared: -3 }));
    assert.strictEqual(r2.reward, 0);
});
