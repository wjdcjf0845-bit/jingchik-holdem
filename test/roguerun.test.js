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
    assert.deepStrictEqual({ s: fs.startChips, q: fs.quota, h: fs.hands, b: fs.botChips, m: fs.mull }, { s: 3000, q: 3250, h: 16, b: 3000, m: 0 });
    run.augments = ['wallet', 'double', 'discount', 'extra', 'nerf', 'mull'];
    fs = R.floorSetup(run);
    assert.strictEqual(fs.startChips, 5100);                 // 3000 × (1 + 0.2 + 0.5)
    assert.strictEqual(fs.quota, Math.max(Math.round(5100 * 1.08 * 0.92 / 50) * 50, Math.ceil(5100 * R.MIN_QUOTA / 50) * 50));
    assert.strictEqual(fs.hands, 18);
    assert.strictEqual(fs.botChips, 2250);
    assert.strictEqual(fs.mull, 3);
});

test('층이 오를수록 목표 배율이 커진다 (난이도 곡선이 뒤집히지 않게)', () => {
    for (let i = 1; i < R.FLOORS.length; i++) assert.ok(R.FLOORS[i].quota >= R.FLOORS[i - 1].quota, (i + 1) + '층');
});

test('어떤 증강·상점 할인을 겹쳐도 목표는 시작 칩의 MIN_QUOTA 배 밑으로 안 내려간다', () => {
    for (let f = 1; f <= 10; f++) {
        const run = R.newRun(lcg(f)); run.floor = f;
        run.augments = ['discount', 'wallet', 'wallet', 'wallet', 'double'];
        run.boost = { quota: 0.06, chips: 400, hands: 2 };
        const fs = R.floorSetup(run);
        assert.ok(fs.quota >= fs.startChips + 2 * R.BB && fs.quota >= 5100 * R.MIN_QUOTA, f + '층: ' + fs.quota + ' / ' + fs.startChips);
    }
});

test('겹치면 구멍이 되던 증강(이자·목표 할인)은 한 번만 고를 수 있다', () => {
    assert.strictEqual(R.AUGMENTS.interest.max || 1, 1);
    assert.strictEqual(R.AUGMENTS.discount.max || 1, 1);
});

test('딜 보너스: 블라인드 환급은 증강이 있을 때만 (낸 블라인드의 절반)', () => {
    const run = R.newRun(lcg(11));
    assert.deepStrictEqual(R.onDeal(run, { hand: ['7s', '7d'], blindPaid: 100 }), { bonus: 0, notes: [] });
    run.augments = ['blind', 'pair'];
    assert.strictEqual(R.onDeal(run, { hand: ['7s', '7d'], blindPaid: 100 }).bonus, 50);
    assert.strictEqual(R.onDeal(run, { hand: ['7s', '8d'], blindPaid: 0 }).bonus, 0);
});

test('포켓 보너스는 포켓 페어로 "참여한" 핸드에만 — 받고 폴드하면 없다', () => {
    const run = R.newRun(lcg(11)); run.augments = ['pair'];
    const base = { start: 3000, now: 2900, rank: 0, allIn: false, rng: seq(0.9) };
    assert.strictEqual(R.afterHand(run, Object.assign({ hand: ['7s', '7d'], vpip: true }, base)).bonus, 300);
    assert.strictEqual(R.afterHand(run, Object.assign({ hand: ['7s', '7d'], vpip: false }, base)).bonus, 0);
    assert.strictEqual(R.afterHand(run, Object.assign({ hand: ['7s', '8d'], vpip: true }, base)).bonus, 0);
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

test('이자는 칩을 걸고 참여한 핸드에만, 핸드당 최대 80', () => {
    const run = R.newRun(lcg(15));
    run.augments = ['interest'];
    const base = { start: 3000, now: 3000, hand: ['As', 'Kd'], rank: 0, allIn: false, rng: seq(0) };
    assert.strictEqual(R.afterHand(run, Object.assign({ vpip: false }, base)).bonus, 0, '폴드만 한 핸드에는 이자가 없다');
    assert.strictEqual(R.afterHand(run, Object.assign({ vpip: true }, base)).bonus, 60);
    assert.strictEqual(R.afterHand(run, Object.assign({ vpip: true }, base, { now: 9000 })).bonus, 80, '상한');
});

test('전부 폴드하면 증강 수입이 0 — 폴드만으로는 어떤 층도 못 깬다', () => {
    const run = R.newRun(lcg(31));
    run.augments = Object.keys(R.AUGMENTS);
    let chips = R.floorSetup(run).startChips;
    for (let h = 0; h < 30; h++) {
        // 폴드: 블라인드는 환급(절반)을 받아도 손해, 참여하지 않았으니 이자 없음
        chips += R.afterHand(run, { start: chips, now: chips, hand: ['2s', '7d'], rank: 0, allIn: false, vpip: false, rng: seq(0.99) }).bonus;
    }
    assert.strictEqual(chips, R.floorSetup(run).startChips);
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

// ══════════════ 상점 ══════════════

test('코인: 기본 2 + 남긴 핸드(최대 4) + 초과 칩 200당 1(최대 6)', () => {
    assert.strictEqual(R.coinsFor({ chips: 3350, quota: 3350, handsLeft: 0 }), 2);
    assert.strictEqual(R.coinsFor({ chips: 3350, quota: 3350, handsLeft: 9 }), 6);
    assert.strictEqual(R.coinsFor({ chips: 3350 + 450, quota: 3350, handsLeft: 0 }), 4);
    assert.strictEqual(R.coinsFor({ chips: 99999, quota: 3350, handsLeft: 99 }), 12);
    assert.strictEqual(R.coinsFor({ chips: 100, quota: 3350, handsLeft: -3 }), 2, '음수는 0으로');
});

test('층 클리어: 다음 층으로, 코인 지급, 일회성 효과 초기화, 증강 제안', () => {
    const run = R.newRun(lcg(40)); R.pick(run, 0);
    run.boost = { hands: 2, chips: 400 }; run.bought = ['hands', 'chips']; run.inFloor = true;
    const r = R.clearFloor(run, { chips: 3550, quota: 3350, handsLeft: 3 }, lcg(41));
    assert.deepStrictEqual({ done: r.done, coins: r.coins }, { done: false, coins: 6 });   // 2 + 남긴 3핸드 + 초과 200칩
    assert.deepStrictEqual({ f: run.floor, c: run.cleared, p: run.phase, coins: run.coins, boost: run.boost, bought: run.bought, inFloor: run.inFloor },
        { f: 2, c: 1, p: 'pick', coins: 6, boost: {}, bought: [], inFloor: false });
    assert.strictEqual(run.offers.length, 3);
});

test('마지막 층을 깨면 done — 층 번호는 넘어가지 않는다', () => {
    const run = R.newRun(lcg(42)); run.floor = 10; run.phase = 'play';
    const r = R.clearFloor(run, { chips: 9000, quota: 4800, handsLeft: 5 }, lcg(43));
    assert.strictEqual(r.done, true);
    assert.deepStrictEqual({ f: run.floor, c: run.cleared }, { f: 10, c: 10 });
});

test('상점: 코인이 모자라면 못 사고, 일회성 물건은 층마다 한 번, 다시 뽑기는 여러 번', () => {
    const run = R.newRun(lcg(44));
    assert.strictEqual(R.buy(run, 'hands'), false, '코인 0');
    run.coins = 20;
    assert.strictEqual(R.buy(run, 'hands'), true);
    assert.strictEqual(R.buy(run, 'hands'), false, '같은 층에 두 번');
    assert.strictEqual(run.boost.hands, 2);
    const rr = run.rerolls;
    assert.strictEqual(R.buy(run, 'reroll'), true);
    assert.strictEqual(R.buy(run, 'reroll'), true);
    assert.strictEqual(run.rerolls, rr + 2);
    assert.strictEqual(run.coins, 20 - 4 - 3 - 3);
    ['', 'nope', '__proto__', 'constructor', null, undefined, 5].forEach(id => assert.strictEqual(R.buy(run, id), false, String(id)));
    assert.strictEqual(run.coins, 10, '거절된 구매는 코인을 건드리지 않는다');
});

test('상점: 산 것이 다음 층 구성에 반영된다 — 벌어야 할 칩이 줄고 기한이 는다', () => {
    const run = R.newRun(lcg(45)); run.coins = 99; run.floor = 5;
    const before = R.floorSetup(run);
    R.buy(run, 'chips'); R.buy(run, 'hands'); R.buy(run, 'quota');
    const after = R.floorSetup(run);
    assert.strictEqual(after.startChips, before.startChips + 400);
    assert.strictEqual(after.hands, before.hands + 2);
    assert.ok(after.quota <= before.quota, '칩을 사도 목표는 안 오른다');
    assert.ok(after.quota - after.startChips < before.quota - before.startChips, '벌어야 할 칩이 줄어든다');
    assert.ok(after.quota >= after.startChips + 2 * R.BB);
});

test('상점: 네잎클로버는 하나만, 층을 치는 중에는 아무것도 못 산다', () => {
    const run = R.newRun(lcg(46)); run.coins = 99;
    assert.strictEqual(R.buy(run, 'clover'), true);
    assert.strictEqual(run.revive, 1);
    run.bought = [];
    assert.strictEqual(R.buy(run, 'clover'), false, '이미 하나 있다');
    run.phase = 'play';
    assert.strictEqual(R.buy(run, 'reroll'), false);
});

test('상점: 증강 하나 더 — 고른 뒤 한 번 더 고르고 나서야 play 로', () => {
    const run = R.newRun(lcg(47)); run.coins = 10;
    assert.strictEqual(R.buy(run, 'pick'), true);
    assert.ok(R.pick(run, 0, lcg(48)));
    assert.strictEqual(run.phase, 'pick');
    assert.strictEqual(run.offers.length, 3);
    assert.ok(R.pick(run, 0, lcg(49)));
    assert.strictEqual(run.phase, 'play');
    assert.strictEqual(run.augments.length, 2);
});

// ══════════════ 저장·복구 ══════════════

test('저장했다 되살리면 같은 런', () => {
    const run = R.newRun(lcg(50)); run.coins = 7; R.buy(run, 'hands'); R.pick(run, 1);
    R.clearFloor(run, { chips: 4000, quota: 3350, handsLeft: 2 }, lcg(51));
    const back = R.restore(JSON.parse(JSON.stringify(R.serialize(run))), lcg(52));
    assert.deepStrictEqual(R.serialize(back), R.serialize(run));
    assert.strictEqual(back.revive, R.count(back, 'revive'));
});

test('복구: 망가진·조작된 저장값은 버리거나 안전한 값으로 고친다', () => {
    [null, undefined, 'x', 5, {}, { floor: 0 }, { floor: 11 }, { floor: 1.5 }, { floor: '3' }].forEach(o => assert.strictEqual(R.restore(o, lcg(1)), null, JSON.stringify(o)));
    const r = R.restore({ floor: 4, cleared: 99, augments: ['interest', 'interest', 'nope', 7, '__proto__', 'wallet', 'wallet', 'wallet', 'wallet'],
        rerolls: -5, coins: 1e9, phase: 'weird', offers: ['nope', 'interest'], boost: { hands: 99, chips: 1e6, quota: 0.9 }, bought: ['zzz', 'hands'], extraPicks: 50 }, lcg(2));
    assert.strictEqual(r.cleared, 3, '깬 층은 층 번호에서 다시 계산');
    assert.deepStrictEqual(r.augments, ['interest', 'wallet', 'wallet', 'wallet'], '없는 증강·한도 초과는 버린다');
    assert.deepStrictEqual({ rr: r.rerolls, coins: r.coins, phase: r.phase, boost: r.boost, bought: r.bought, ep: r.extraPicks },
        { rr: 0, coins: 0, phase: 'pick', boost: {}, bought: ['hands'], ep: 0 });
    assert.strictEqual(r.offers.length, 3, '제안이 망가졌으면 새로 뽑는다');
    r.offers.forEach(id => assert.ok(R.AUGMENTS[id] && id !== 'interest'));
});

test('복구: 층을 치던 중이었으면 play·inFloor 로 돌아온다 (서버 재시작 → 그 층 다시)', () => {
    const run = R.newRun(lcg(53)); R.pick(run, 0); run.inFloor = true;
    const back = R.restore(R.serialize(run), lcg(54));
    assert.deepStrictEqual({ p: back.phase, i: back.inFloor, f: back.floor }, { p: 'play', i: true, f: 1 });
});
