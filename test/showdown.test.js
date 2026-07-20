'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeShowdown } = require('../lib/showdown');

// 헬퍼: awards 합계
const sum = (obj) => Object.values(obj).reduce((s, x) => s + x, 0);

// ─────────────────────────────────────────────
//  기본 시나리오 — 실제 족보로 승자 판정
// ─────────────────────────────────────────────
test('단일 팟: 더 강한 핸드가 전액 가져간다 (페어 > 하이카드)', () => {
    const r = computeShowdown({
        contributions: [{ nick: 'A', invested: 500 }, { nick: 'B', invested: 500 }],
        totalPot: 1000,
        boards: [['2h', '7d', 'Jc', '3s', '9h']],
        holeCards: { A: ['As', 'Ad'], B: ['Ks', 'Qd'] }, // A=에이스 페어, B=킹 하이
        isFolded: () => false
    });
    assert.deepStrictEqual(r.awards, { A: 1000 });
    assert.deepStrictEqual(r.winnersAll, ['A']);
    assert.strictEqual(r.results[0].winners[0].rankName, 'Pair');
    assert.strictEqual(r.sidePotCount, 1);
});

test('플러시가 스트레이트를 이긴다 (족보 서열 실검증)', () => {
    const r = computeShowdown({
        contributions: [{ nick: 'A', invested: 300 }, { nick: 'B', invested: 300 }],
        totalPot: 600,
        boards: [['2h', '5h', '9h', 'Jc', '3s']],
        holeCards: { A: ['Ah', 'Kh'], B: ['4d', '6c'] }, // A=하트 플러시, B=2~6 스트레이트
        isFolded: () => false
    });
    assert.deepStrictEqual(r.awards, { A: 600 });
    assert.strictEqual(r.results[0].winners[0].rankName, 'Flush');
});

test('무승부 스플릿: 홀수 칩은 첫 승자에게, 합은 정확히 보존', () => {
    const r = computeShowdown({
        contributions: [{ nick: 'A', invested: 501 }, { nick: 'B', invested: 500 }],
        totalPot: 1001,
        boards: [['Ah', 'Kd', 'Qc', 'Js', 'Th']], // 보드 브로드웨이 스트레이트 — 둘 다 찹
        holeCards: { A: ['2s', '3d'], B: ['4c', '5h'] },
        isFolded: () => false
    });
    assert.strictEqual(sum(r.awards), 1001, '칩 보존 실패');
    const won = Object.values(r.awards).sort((a, b) => b - a);
    assert.deepStrictEqual(won, [501, 500], '홀수 칩 1개가 한 명에게');
});

// ─────────────────────────────────────────────
//  사이드팟 — 올인 레이어
// ─────────────────────────────────────────────
test('교과서 사이드팟: 숏스택 올인 승자는 메인팟만, 사이드팟은 차순위에게', () => {
    // A(100 올인, 최강) / B(300) / C(300)
    const r = computeShowdown({
        contributions: [{ nick: 'A', invested: 100 }, { nick: 'B', invested: 300 }, { nick: 'C', invested: 300 }],
        totalPot: 700,
        boards: [['2h', '7d', '9c', '3s', 'Jh']],
        holeCards: {
            A: ['As', 'Ad'],  // 최강 (에이스 페어)
            B: ['Ks', 'Kd'],  // 2등 (킹 페어)
            C: ['4c', '5d']   // 꽝
        },
        isFolded: () => false
    });
    // 메인팟 300 (A·B·C 적격 → A 승) / 사이드팟 400 (B·C만 적격 → B 승)
    assert.deepStrictEqual(r.awards, { A: 300, B: 400 });
    assert.strictEqual(sum(r.awards), 700, '칩 보존 실패');
    assert.strictEqual(r.sidePotCount, 2);
});

test('3중 사이드팟: 올인 3단계 레이어가 각각 올바른 적격자에게', () => {
    // A(50) / B(150) / C(400) / D(400)
    const r = computeShowdown({
        contributions: [
            { nick: 'A', invested: 50 }, { nick: 'B', invested: 150 },
            { nick: 'C', invested: 400 }, { nick: 'D', invested: 400 }
        ],
        totalPot: 1000,
        boards: [['2h', '7d', '9c', '3s', 'Jh']],
        holeCards: {
            A: ['As', 'Ad'], // 최강 — 메인팟(200)만
            B: ['Ks', 'Kd'], // 2등 — 사이드1(300)
            C: ['Qs', 'Qd'], // 3등 — 사이드2(500)
            D: ['4c', '5d']  // 꽝
        },
        isFolded: () => false
    });
    assert.deepStrictEqual(r.awards, { A: 200, B: 300, C: 500 });
    assert.strictEqual(sum(r.awards), 1000, '칩 보존 실패');
    assert.strictEqual(r.sidePotCount, 3);
});

test('폴드 롤다운: 상위 사이드팟 적격자가 전원 폴드하면 아래 팟으로 흘러내린다', () => {
    // A(100 올인) vs B(300, 폴드) vs C(300, 폴드) — B·C만 적격이던 사이드팟 400은 메인으로
    const r = computeShowdown({
        contributions: [{ nick: 'A', invested: 100 }, { nick: 'B', invested: 300 }, { nick: 'C', invested: 300 }],
        totalPot: 700,
        boards: [['2h', '7d', '9c', '3s', 'Jh']],
        holeCards: { A: ['As', 'Ad'], B: ['Ks', 'Kd'], C: ['Qs', 'Qd'] },
        isFolded: (n) => n === 'B' || n === 'C'
    });
    assert.deepStrictEqual(r.awards, { A: 700 }, '롤다운으로 A가 전액');
    assert.strictEqual(sum(r.awards), 700, '칩 보존 실패');
});

test('실팟 보정: totalPot이 사이드팟 합보다 크면 차액이 마지막 팟에 붙는다 (기존 동작)', () => {
    const r = computeShowdown({
        contributions: [{ nick: 'A', invested: 500 }, { nick: 'B', invested: 500 }],
        totalPot: 1030, // 안테 등으로 30 더 있음
        boards: [['2h', '7d', 'Jc', '3s', '9h']],
        holeCards: { A: ['As', 'Ad'], B: ['Ks', 'Qd'] },
        isFolded: () => false
    });
    assert.deepStrictEqual(r.awards, { A: 1030 }, '차액 30까지 수여돼야 함');
});

// ─────────────────────────────────────────────
//  런잇트와이스 — 보드 2개 분배
// ─────────────────────────────────────────────
test('RIT 기본: 두 보드 승자가 다르면 팟을 반씩 나눈다', () => {
    const r = computeShowdown({
        contributions: [{ nick: 'A', invested: 500 }, { nick: 'B', invested: 500 }],
        totalPot: 1000,
        boards: [
            ['2h', '7d', 'Jc', '3s', '9h'],  // 런1: A의 에이스페어 승
            ['Kh', 'Kc', '4d', '8s', '2c']   // 런2: B의 킹 트리플 승
        ],
        holeCards: { A: ['As', 'Ad'], B: ['Ks', 'Qd'] },
        isFolded: () => false
    });
    assert.deepStrictEqual(r.awards, { A: 500, B: 500 });
    assert.strictEqual(sum(r.awards), 1000, '칩 보존 실패');
    // 결과가 런별로 2건, runIdx 구분
    assert.strictEqual(r.results.length, 2);
    assert.deepStrictEqual(r.results.map(x => x.runIdx), [0, 1]);
});

test('RIT 홀수 팟: 앞 런이 1칩 더 받는다 (101 → 51/50)', () => {
    const r = computeShowdown({
        contributions: [{ nick: 'A', invested: 51 }, { nick: 'B', invested: 50 }],
        totalPot: 101,
        boards: [
            ['2h', '7d', 'Jc', '3s', '9h'],
            ['Kh', 'Kc', '4d', '8s', '2c']
        ],
        holeCards: { A: ['As', 'Ad'], B: ['Ks', 'Qd'] },
        isFolded: () => false
    });
    assert.strictEqual(r.awards.A, 51, '런1(에이스페어 승)이 홀수 칩 포함 51');
    assert.strictEqual(r.awards.B, 50);
    assert.strictEqual(sum(r.awards), 101, '칩 보존 실패');
});

test('RIT × 사이드팟 조합: 각 팟이 런별로 갈리고 총합이 정확하다', () => {
    // A(100 올인) / B(300) / C(300) — 메인 300, 사이드 400, RIT 2런
    const r = computeShowdown({
        contributions: [{ nick: 'A', invested: 100 }, { nick: 'B', invested: 300 }, { nick: 'C', invested: 300 }],
        totalPot: 700,
        boards: [
            ['2h', '7d', '9c', '3s', 'Jh'],  // 런1: A>B>C
            ['Kh', 'Kc', '4d', '8s', '2c']   // 런2: B(킹 트리플) 최강
        ],
        holeCards: { A: ['As', 'Ad'], B: ['Ks', 'Qd'], C: ['6c', '5d'] },
        isFolded: () => false
    });
    // 메인 300 → 런1 150(A), 런2 150(B) / 사이드 400 → 런1 200(B), 런2 200(B)
    assert.deepStrictEqual(r.awards, { A: 150, B: 550 });
    assert.strictEqual(sum(r.awards), 700, '칩 보존 실패');
});

// ─────────────────────────────────────────────
//  출력 형식 (클라이언트 렌더 계약)
// ─────────────────────────────────────────────
test('best5는 5장이고 10은 T로 정규화된다', () => {
    const r = computeShowdown({
        contributions: [{ nick: 'A', invested: 100 }, { nick: 'B', invested: 100 }],
        totalPot: 200,
        boards: [['Th', 'Td', 'Qc', '3s', '9h']],
        holeCards: { A: ['Ts', 'Ad'], B: ['2c', '4d'] }, // A=텐 트리플
        isFolded: () => false
    });
    const b5 = r.results[0].winners[0].best5;
    assert.strictEqual(b5.length, 5);
    assert.ok(b5.every(c => /^[2-9TJQKA][shdc]$/.test(c)), `카드 코드 형식 위반: ${b5}`);
    assert.ok(b5.filter(c => c[0] === 'T').length >= 3, `T 정규화 실패: ${b5}`);
});

// ─────────────────────────────────────────────
//  칩 보존 프로퍼티 — 무작위 시나리오 대량 검증
// ─────────────────────────────────────────────
test('프로퍼티: 무작위 시나리오 300개에서 칩이 절대 생성/소멸되지 않는다', () => {
    const RANKS = '23456789TJQKA', SUITS = 'shdc';
    const DECK = [];
    for (const r of RANKS) for (const s of SUITS) DECK.push(r + s);

    let seed = 20260720;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

    for (let i = 0; i < 300; i++) {
        // 무작위 셔플 덱에서 겹치지 않게 배분
        const deck = DECK.slice();
        for (let k = deck.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [deck[k], deck[j]] = [deck[j], deck[k]]; }

        const numPlayers = 2 + Math.floor(rand() * 4); // 2~5명
        const rit = rand() < 0.3;
        const boards = rit
            ? [deck.slice(0, 5), deck.slice(0, 3).concat(deck.slice(5, 7))] // 플랍 공유 RIT
            : [deck.slice(0, 5)];
        let idx = 7;

        const contributions = [], holeCards = {}, folded = new Set();
        for (let pIdx = 0; pIdx < numPlayers; pIdx++) {
            const nick = 'P' + pIdx;
            contributions.push({ nick, invested: 1 + Math.floor(rand() * 5000) });
            holeCards[nick] = [deck[idx++], deck[idx++]];
            if (pIdx >= 2 && rand() < 0.3) folded.add(nick); // 최소 2명은 생존
        }
        const totalPot = contributions.reduce((s, c) => s + c.invested, 0) + (rand() < 0.2 ? Math.floor(rand() * 100) : 0);

        const r = computeShowdown({
            contributions, totalPot, boards, holeCards,
            isFolded: (n) => folded.has(n)
        });

        assert.strictEqual(sum(r.awards), totalPot,
            `시나리오#${i}: 수여합 ${sum(r.awards)} ≠ 팟 ${totalPot} (players=${numPlayers} rit=${rit} folded=${[...folded]})`);
        // 폴드한 사람은 절대 못 받는다
        for (const f of folded) assert.ok(!(f in r.awards), `시나리오#${i}: 폴드한 ${f}가 칩 수령`);
        // 수여액은 전부 양수
        for (const [n, w] of Object.entries(r.awards)) assert.ok(w > 0, `시나리오#${i}: ${n} 수여액 ${w}`);
    }
});
