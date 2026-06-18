'use strict';
// ════════════════════════════════════════════════════════════════
//  pots.test.js — 팟/사이드팟 분배 머니 로직 테스트 (node --test)
//  핵심 불변식: "칩은 생성되거나 사라지지 않는다(보존)" + "적격자만 받는다".
// ════════════════════════════════════════════════════════════════
const test = require('node:test');
const assert = require('node:assert');
const { calculateSidePots, rollDownFoldedPots, splitAmount, distributePots } = require('../lib/pots');

const sum = arr => arr.reduce((s, x) => s + x, 0);
const potTotal = pots => sum(pots.map(p => p.amount));
const invTotal = contribs => sum(contribs.map(c => c.invested));

// ───────────────────────── calculateSidePots ─────────────────────────
test('전원 동일 투자 → 단일 팟, 전원 적격', () => {
    const pots = calculateSidePots([{ nick: 'A', invested: 100 }, { nick: 'B', invested: 100 }, { nick: 'C', invested: 100 }]);
    assert.strictEqual(pots.length, 1);
    assert.strictEqual(pots[0].amount, 300);
    assert.deepStrictEqual(pots[0].eligible.sort(), ['A', 'B', 'C']);
});

test('한 명 숏 올인 → 메인팟 + 사이드팟, 금액/적격 정확', () => {
    // A=100, B=100, C=50(숏)
    const pots = calculateSidePots([{ nick: 'A', invested: 100 }, { nick: 'B', invested: 100 }, { nick: 'C', invested: 50 }]);
    assert.strictEqual(pots.length, 2);
    // 메인: 50*3 = 150, 전원 적격
    assert.strictEqual(pots[0].amount, 150);
    assert.deepStrictEqual(pots[0].eligible.sort(), ['A', 'B', 'C']);
    // 사이드: (100-50)*2 = 100, A·B만 적격
    assert.strictEqual(pots[1].amount, 100);
    assert.deepStrictEqual(pots[1].eligible.sort(), ['A', 'B']);
    assert.strictEqual(potTotal(pots), 250); // 보존
});

test('3단계 올인 → 레이어드 사이드팟 정확 + 보존', () => {
    // A=30, B=60, C=100, D=100
    const contribs = [{ nick: 'A', invested: 30 }, { nick: 'B', invested: 60 }, { nick: 'C', invested: 100 }, { nick: 'D', invested: 100 }];
    const pots = calculateSidePots(contribs);
    // L1: 30*4=120 [A,B,C,D] / L2: 30*3=90 [B,C,D] / L3: 40*2=80 [C,D]
    assert.strictEqual(pots.length, 3);
    assert.strictEqual(pots[0].amount, 120);
    assert.strictEqual(pots[1].amount, 90);
    assert.strictEqual(pots[2].amount, 80);
    assert.deepStrictEqual(pots[2].eligible.sort(), ['C', 'D']);
    assert.strictEqual(potTotal(pots), invTotal(contribs)); // 290 보존
});

test('단독 기여자(나머지 폴드, 투자 0) → 단일 팟', () => {
    const pots = calculateSidePots([{ nick: 'A', invested: 100 }, { nick: 'B', invested: 0 }]);
    assert.strictEqual(pots.length, 1);
    assert.strictEqual(pots[0].amount, 100);
    assert.deepStrictEqual(pots[0].eligible, ['A']);
});

test('빈 입력 → 빈 결과 (크래시 없음)', () => {
    assert.deepStrictEqual(calculateSidePots([]), []);
    assert.deepStrictEqual(calculateSidePots(null), []);
});

test('우승콜 미콜(언콜드 벳) 회수 — 큰 올인은 1인 사이드팟으로 환수', () => {
    // A 200 shove, B 100 call all-in, C fold(투자 0)
    const pots = calculateSidePots([{ nick: 'A', invested: 200 }, { nick: 'B', invested: 100 }]);
    assert.strictEqual(pots.length, 2);
    assert.strictEqual(pots[0].amount, 200); // [A,B]
    assert.strictEqual(pots[1].amount, 100); // [A] — A가 회수
    assert.deepStrictEqual(pots[1].eligible, ['A']);
});

// ───────────────────────── splitAmount (홀수 칩) ─────────────────────────
test('splitAmount — 균등 분배', () => {
    assert.deepStrictEqual(splitAmount(300, 1), { perWinner: 300, remainder: 0 });
    assert.deepStrictEqual(splitAmount(300, 2), { perWinner: 150, remainder: 0 });
    assert.deepStrictEqual(splitAmount(300, 3), { perWinner: 100, remainder: 0 });
});

test('splitAmount — 홀수 칩은 나머지로 (winners[0]에게)', () => {
    assert.deepStrictEqual(splitAmount(301, 2), { perWinner: 150, remainder: 1 });
    assert.deepStrictEqual(splitAmount(100, 3), { perWinner: 33, remainder: 1 });
    assert.deepStrictEqual(splitAmount(101, 3), { perWinner: 33, remainder: 2 });
    // 보존: perWinner*n + remainder === amount
    for (const [amt, n] of [[301, 2], [100, 3], [777, 4], [5, 3]]) {
        const { perWinner, remainder } = splitAmount(amt, n);
        assert.strictEqual(perWinner * n + remainder, amt, `${amt}/${n} 보존`);
    }
});

test('splitAmount — 승자 0 가드', () => {
    assert.deepStrictEqual(splitAmount(100, 0), { perWinner: 0, remainder: 100 });
});

// ───────────────────────── rollDownFoldedPots ─────────────────────────
test('상위 사이드팟 적격자 전원 폴드 → 하위 팟으로 롤다운, 보존', () => {
    const pots = [
        { amount: 150, eligible: ['A', 'B', 'C'] },
        { amount: 100, eligible: ['A', 'B'] },
    ];
    // B가 사이드팟 단독 생존이 아니라, A·B 둘 다 폴드라 가정 → 사이드팟 롤다운
    const folded = new Set(['A', 'B']);
    rollDownFoldedPots(pots, n => folded.has(n));
    assert.strictEqual(pots[1].amount, 0);
    assert.strictEqual(pots[0].amount, 250); // 100이 메인으로 내려감
    assert.strictEqual(potTotal(pots), 250); // 보존
});

test('폴드 없음 → 변화 없음', () => {
    const pots = [{ amount: 150, eligible: ['A', 'B', 'C'] }, { amount: 100, eligible: ['A', 'B'] }];
    const before = potTotal(pots);
    rollDownFoldedPots(pots, () => false);
    assert.strictEqual(pots[0].amount, 150);
    assert.strictEqual(pots[1].amount, 100);
    assert.strictEqual(potTotal(pots), before);
});

// ───────────────────────── distributePots (통합) ─────────────────────────
test('단순 — 한 명이 메인팟 독식', () => {
    const contribs = [{ nick: 'A', invested: 100 }, { nick: 'B', invested: 100 }, { nick: 'C', invested: 100 }];
    const { wonByNick } = distributePots(contribs, () => false, () => ['A']);
    assert.strictEqual(wonByNick['A'], 300);
    assert.strictEqual(sum(Object.values(wonByNick)), 300); // 보존
});

test('사이드팟 — 숏스택이 메인 우승, 빅스택이 사이드 우승', () => {
    // A=100, B=100, C=50. C가 메인(150) 우승, 사이드(100)는 A·B 중 A 우승
    const contribs = [{ nick: 'A', invested: 100 }, { nick: 'B', invested: 100 }, { nick: 'C', invested: 50 }];
    const pick = elig => elig.includes('C') ? ['C'] : ['A'];
    const { wonByNick } = distributePots(contribs, () => false, pick);
    assert.strictEqual(wonByNick['C'], 150); // 메인
    assert.strictEqual(wonByNick['A'], 100); // 사이드
    assert.strictEqual(sum(Object.values(wonByNick)), 250); // 보존
});

test('스플릿 + 홀수 칩 — 보존', () => {
    // 팟 합 = 101, 2명 동점 → 51 + 50
    const contribs = [{ nick: 'A', invested: 51 }, { nick: 'B', invested: 50 }];
    // 단일 레벨이 아니므로: A=51,B=50 → 메인 50*2=100[A,B], 사이드 1*1=1[A]
    const { wonByNick, pots } = distributePots(contribs, () => false, elig => elig.slice().sort()); // 둘 다 동점이면 [A,B]
    // 메인 100을 A·B 스플릿(50/50), 사이드 1은 A 단독
    assert.strictEqual(sum(Object.values(wonByNick)), 101); // 보존
    // 메인팟 홀수 없음, 사이드팟은 A 단독 1
    const main = pots.find(p => p.amount === 100);
    assert.ok(main && main.perWinner === 50 && main.remainder === 0);
});

test('폴드한 적격자 사이드팟 롤다운 통합 — 보존', () => {
    // A=200, B=100, C=100. A가 폴드(쇼다운서 카드 안 깜) → A 단독 사이드팟(100)은 메인으로 롤다운
    const contribs = [{ nick: 'A', invested: 200 }, { nick: 'B', invested: 100 }, { nick: 'C', invested: 100 }];
    const folded = new Set(['A']);
    const { wonByNick } = distributePots(contribs, n => folded.has(n), () => ['B']); // B가 다 가져감
    assert.strictEqual(sum(Object.values(wonByNick)), 400); // 보존 (A의 100도 굴러내려와 분배됨)
    assert.strictEqual(wonByNick['A'] || 0, 0); // 폴드한 A는 못 받음
});

// ───────────────────────── 프로퍼티 테스트 (랜덤 보존성) ─────────────────────────
test('프로퍼티: 랜덤 시나리오 2000개 — 칩 보존 + 적격성', () => {
    const rnd = (max) => Math.floor(Math.random() * max);
    for (let iter = 0; iter < 2000; iter++) {
        const n = 2 + rnd(5); // 2~6명
        const players = [];
        for (let i = 0; i < n; i++) {
            players.push({
                nick: 'P' + i,
                invested: rnd(1001),        // 0~1000 (0=비기여)
                strength: rnd(5),           // 핸드 강도 (동점 가능)
                folded: Math.random() < 0.4 // 40% 폴드
            });
        }
        const contributors = players.filter(p => p.invested > 0);
        if (contributors.length === 0) continue; // 기여자 없으면 스킵(핸드 성립 X)

        // 실제 쇼다운 전제: 카드 깐(폴드 안 한) 기여자가 최소 1명 — 없으면 한 명 강제 생존
        if (!contributors.some(p => !p.folded)) contributors[rnd(contributors.length)].folded = false;

        const byNick = Object.fromEntries(players.map(p => [p.nick, p]));
        const isFolded = nick => byNick[nick].folded;
        const pickWinners = (elig) => {
            const live = elig.filter(n => !isFolded(n));
            if (live.length === 0) return [];
            const maxStr = Math.max(...live.map(n => byNick[n].strength));
            return live.filter(n => byNick[n].strength === maxStr); // 동점이면 다수
        };

        const contribs = contributors.map(p => ({ nick: p.nick, invested: p.invested }));
        const { wonByNick, pots } = distributePots(contribs, isFolded, pickWinners);

        const totalIn = invTotal(contribs);
        const totalOut = sum(Object.values(wonByNick));

        // 1) 칩 보존: 들어온 칩 = 나간 칩
        assert.strictEqual(totalOut, totalIn, `보존 실패 iter=${iter}: in=${totalIn} out=${totalOut}`);

        // 2) 폴드한 사람은 한 칩도 못 받음
        for (const nick of Object.keys(wonByNick)) {
            assert.ok(!isFolded(nick), `폴드한 ${nick}가 칩 받음 iter=${iter}`);
        }

        // 3) 각 팟: 승자는 그 팟 적격자 중에서만, 분배합 = 팟액
        for (const p of pots) {
            for (const w of p.winners) {
                assert.ok(p.eligible.includes(w), `비적격 승자 iter=${iter}`);
            }
            assert.strictEqual(p.perWinner * p.winners.length + p.remainder, p.amount, `팟 분배 보존 실패 iter=${iter}`);
        }
    }
});
