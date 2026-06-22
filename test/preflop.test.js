'use strict';
// ════════════════════════════════════════════════════════════════
//  preflop.test.js — 프리플랍 GTO 레인지 데이터/로직 검증 (node --test)
//  봇(botDecide)과 학습모드 조언(getGtoAdvice)이 공유하는 단일 출처를 검증:
//   (1) 레인지 차트가 GTO 구조에 맞는가 (포지션별 확장·중첩·프리미엄/트래시)
//   (2) 핸드 표기/점수가 정확한가
//   (3) preflopRangeTier 가 올바른 등급(raise/call/fold)을 주는가
// ════════════════════════════════════════════════════════════════
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/preflop');

// ───────────────────────── handToCode ─────────────────────────
test('handToCode — 수딧/오프수트/페어/정렬', () => {
    assert.strictEqual(P.handToCode(['Ah', 'Kh']), 'AKs');
    assert.strictEqual(P.handToCode(['Ah', 'Kd']), 'AKo');
    assert.strictEqual(P.handToCode(['Ah', 'Ad']), 'AA');
    assert.strictEqual(P.handToCode(['Ks', 'Ah']), 'AKo'); // 높은 카드 먼저 정렬
    assert.strictEqual(P.handToCode(['2c', '2d']), '22');
    assert.strictEqual(P.handToCode(['5s', '6s']), '65s');
    assert.strictEqual(P.handToCode(['7h', '2d']), '72o');
});

// ───────────────────────── handRangeScore ─────────────────────────
test('handRangeScore — AA 최고, 트래시 최저, 페어 단조 증가', () => {
    assert.strictEqual(P.handRangeScore('AA'), 98);
    assert.ok(P.handRangeScore('AA') > P.handRangeScore('KK'));
    assert.ok(P.handRangeScore('KK') > P.handRangeScore('QQ'));
    // 페어 단조 증가 22<33<...<AA
    const pairs = ['22','33','44','55','66','77','88','99','TT','JJ','QQ','KK','AA'];
    for (let i = 1; i < pairs.length; i++) {
        assert.ok(P.handRangeScore(pairs[i]) > P.handRangeScore(pairs[i-1]), `${pairs[i]} > ${pairs[i-1]}`);
    }
    // 트래시는 아주 낮음
    assert.ok(P.handRangeScore('72o') < 30);
    assert.ok(P.handRangeScore('32o') < 30);
    // 수딧이 같은 오프수트보다 높음
    assert.ok(P.handRangeScore('AKs') > P.handRangeScore('AKo'));
    assert.ok(P.handRangeScore('98s') > P.handRangeScore('98o'));
    // 0~100 범위 보장
    ['AA','72o','J9s','K5o','22'].forEach(c => {
        const s = P.handRangeScore(c);
        assert.ok(s >= 0 && s <= 100, `${c} score in [0,100]`);
    });
});

// ───────────────────────── 레인지 차트 구조 (GTO 구조) ─────────────────────────
const POS = ['UTG', 'HJ', 'CO', 'BTN'];

test('레인지 — 포지션이 늦을수록 넓어진다 (UTG<HJ<CO<BTN)', () => {
    for (let i = 1; i < POS.length; i++) {
        assert.ok(P.PREFLOP_OPEN_RANGE[POS[i]].size > P.PREFLOP_OPEN_RANGE[POS[i-1]].size,
            `${POS[i]}(${P.PREFLOP_OPEN_RANGE[POS[i]].size}) > ${POS[i-1]}(${P.PREFLOP_OPEN_RANGE[POS[i-1]].size})`);
    }
});

test('레인지 — 중첩성: 좁은 포지션 레인지는 넓은 포지션의 부분집합', () => {
    // GTO RFI는 nested여야 한다 (UTG에서 여는 핸드는 BTN에서도 연다)
    for (let i = 0; i < POS.length - 1; i++) {
        const tight = P.PREFLOP_OPEN_RANGE[POS[i]];
        const wide = P.PREFLOP_OPEN_RANGE[POS[i + 1]];
        for (const h of tight) {
            assert.ok(wide.has(h), `${h}: ${POS[i]}에 있으나 ${POS[i+1]}에 없음(중첩성 위반)`);
        }
    }
});

test('레인지 — 프리미엄은 전 포지션 포함, 트래시는 전 포지션 제외', () => {
    const ALL = ['UTG', 'HJ', 'CO', 'BTN', 'SB'];
    ['AA','KK','QQ','JJ','TT','AKs','AKo','AQs','KQs'].forEach(h => {
        ALL.forEach(pos => assert.ok(P.PREFLOP_OPEN_RANGE[pos].has(h), `${h} 누락 @${pos}`));
    });
    ['72o','82o','32o','42o','93o','T2o','J2o'].forEach(h => {
        ALL.forEach(pos => assert.ok(!P.PREFLOP_OPEN_RANGE[pos].has(h), `${h} 오포함 @${pos}`));
    });
});

// ───────────────────────── preflopRangeTier (미오픈) ─────────────────────────
test('preflopRangeTier 미오픈 — 프리미엄 raise, 트래시 fold', () => {
    ['AA','KK','QQ','JJ','AKs','AKo'].forEach(c => {
        assert.strictEqual(P.preflopRangeTier(c, 'UTG', false).tier, 'raise', `${c} @UTG 오픈`);
    });
    ['72o','82o','32o'].forEach(c => {
        assert.strictEqual(P.preflopRangeTier(c, 'BTN', false).tier, 'fold', `${c} @BTN 폴드`);
    });
});

test('preflopRangeTier 미오픈 — 포지션 민감도 (BTN에선 열고 UTG에선 안 연다)', () => {
    // A9o, 22 는 BTN 레인지엔 있고 UTG엔 없음
    assert.strictEqual(P.preflopRangeTier('A9o', 'BTN', false).tier, 'raise');
    assert.notStrictEqual(P.preflopRangeTier('A9o', 'UTG', false).tier, 'raise');
    assert.strictEqual(P.preflopRangeTier('22', 'BTN', false).tier, 'raise');
    assert.strictEqual(P.preflopRangeTier('22', 'UTG', false).tier, 'fold');
});

// ───────────────────────── preflopRangeTier (레이즈 직면) ─────────────────────────
test('preflopRangeTier 레이즈 직면 — 프리미엄 3벳, 약한핸드 fold, 디펜스 콜', () => {
    // 프리미엄은 3벳(raise)
    ['AA','KK','QQ','JJ','AKs','AKo'].forEach(c => {
        assert.strictEqual(P.preflopRangeTier(c, 'UTG', true).tier, 'raise', `${c} 3벳`);
    });
    // 트래시는 폴드
    assert.strictEqual(P.preflopRangeTier('72o', 'BTN', true).tier, 'fold');
    // 오픈은 되지만 디펜스엔 약한 핸드(A9o)는 레이즈 직면 시 폴드
    assert.strictEqual(P.preflopRangeTier('A9o', 'BTN', true).tier, 'fold');
    // 충분히 강한 차트내 핸드(KQs)는 콜로 디펜스
    assert.strictEqual(P.preflopRangeTier('KQs', 'CO', true).tier, 'call');
});

test('preflopRangeTier 레이즈 직면이 미오픈보다 타이트하다 (디펜스 폭 ≤ 오픈 폭)', () => {
    // 같은 포지션에서 "레이즈 직면 시 계속 진행(raise|call)" 핸드 집합은
    // "미오픈 시 오픈(raise)" 핸드 집합보다 넓지 않아야 한다(방어가 더 타이트).
    const cells = [];
    const ranks = '23456789TJQKA';
    for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
        if (i === j) cells.push(ranks[i] + ranks[i]);
        else cells.push(ranks[Math.max(i,j)] + ranks[Math.min(i,j)] + (i < j ? 's' : 'o'));
    }
    for (const pos of POS) {
        const opens = cells.filter(c => P.preflopRangeTier(c, pos, false).tier === 'raise');
        const defends = cells.filter(c => P.preflopRangeTier(c, pos, true).tier !== 'fold');
        assert.ok(defends.length <= opens.length + 2, // 약간의 차트밖 콜(score>=70) 허용
            `${pos}: 디펜스 ${defends.length} > 오픈 ${opens.length} (방어가 더 넓음 — 비정상)`);
    }
});

// ───────────── 레이즈 디펜스 — 인원수/리레이즈 깊이 반응 (전략 튜닝) ─────────────
const defendsCount = (pos, ctx) => {
    const ranks = '23456789TJQKA';
    let n = 0;
    for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
        const c = i === j ? ranks[i] + ranks[i] : ranks[Math.max(i,j)] + ranks[Math.min(i,j)] + (i < j ? 's' : 'o');
        if (P.preflopRangeTier(c, pos, true, ctx).tier !== 'fold') n++;
    }
    return n;
};

test('디펜스 — 인원 적을수록 더 넓게 방어 (HU > 3way > 6max)', () => {
    const hu = defendsCount('BTN', { numActive: 2, threeBetPlus: false });
    const w3 = defendsCount('BTN', { numActive: 3, threeBetPlus: false });
    const m6 = defendsCount('BTN', { numActive: 6, threeBetPlus: false });
    assert.ok(hu > w3, `HU(${hu}) > 3way(${w3})`);
    assert.ok(w3 > m6, `3way(${w3}) > 6max(${m6})`);
});

test('디펜스 — 리레이즈(3벳+)엔 단일 레이즈보다 타이트하게 방어', () => {
    for (const na of [2, 3, 6]) {
        const single = defendsCount('BTN', { numActive: na, threeBetPlus: false });
        const reraise = defendsCount('BTN', { numActive: na, threeBetPlus: true });
        assert.ok(reraise <= single, `${na}인: 리레이즈디펜스(${reraise}) <= 단일디펜스(${single})`);
    }
});

test('디펜스 — HU/3way에선 중간 핸드도 콜, 6max에선 폴드', () => {
    // 44, KJo, 98s, Q9s 는 6max 단일레이즈엔 폴드, HU/3way엔 콜이어야(폴드 과다 방지)
    ['44', 'KJo', '98s', 'Q9s'].forEach(c => {
        assert.strictEqual(P.preflopRangeTier(c, 'BTN', true, { numActive: 6 }).tier, 'fold', `${c} 6max 폴드`);
        assert.notStrictEqual(P.preflopRangeTier(c, 'BTN', true, { numActive: 2 }).tier, 'fold', `${c} HU 디펜스`);
    });
});

test('디펜스 — 프리미엄/트래시는 인원·리레이즈와 무관하게 불변', () => {
    [{ numActive: 2 }, { numActive: 6 }, { numActive: 2, threeBetPlus: true }].forEach(ctx => {
        ['AA','KK','QQ','JJ','AKs','AKo'].forEach(c =>
            assert.strictEqual(P.preflopRangeTier(c, 'UTG', true, ctx).tier, 'raise', `${c} 항상 3벳`));
        ['72o','32o','82o'].forEach(c =>
            assert.strictEqual(P.preflopRangeTier(c, 'BTN', true, ctx).tier, 'fold', `${c} 항상 폴드`));
    });
});

test('디펜스 — ctx 미지정 시 기존 6맥스 동작 보존(하위호환)', () => {
    const ranks = '23456789TJQKA';
    for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
        const c = i === j ? ranks[i] + ranks[i] : ranks[Math.max(i,j)] + ranks[Math.min(i,j)] + (i < j ? 's' : 'o');
        for (const pos of ['UTG','HJ','CO','BTN']) {
            assert.strictEqual(
                P.preflopRangeTier(c, pos, true).tier,
                P.preflopRangeTier(c, pos, true, { numActive: 6, threeBetPlus: false }).tier,
                `${c}@${pos}: ctx없음 == 6max단일`);
        }
    }
});

// ───────────────────────── 단일 출처 계약 ─────────────────────────
test('단일 출처 — 봇/학습조언이 동일 모듈을 공유 (export 시그니처 보존)', () => {
    // server.js 의 botDecide / getGtoAdvice 가 import 하는 심볼이 모두 존재해야 한다
    ['handToCode', 'handRangeScore', 'openThreshold', 'preflopRangeTier', 'isInOpenRange'].forEach(fn => {
        assert.strictEqual(typeof P[fn], 'function', `${fn} export 누락`);
    });
    // preflopRangeTier 반환 구조 계약 (tier/label/score)
    const t = P.preflopRangeTier('AA', 'UTG', false);
    assert.ok(['raise', 'call', 'fold'].includes(t.tier));
    assert.strictEqual(typeof t.label, 'string');
    assert.strictEqual(typeof t.score, 'number');
});
