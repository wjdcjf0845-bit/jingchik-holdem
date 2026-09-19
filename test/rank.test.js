const test = require('node:test');
const assert = require('node:assert');
const { RANKS, rankIndexOf, rankNeedText, unlockedFrames } = require('../lib/rank');

test('임계값은 오름차순이어야 한다 — 등급 건너뜀/역전 회귀 방어', () => {
    for (let i = 1; i < RANKS.length; i++) {
        assert.ok(RANKS[i].wins > RANKS[i - 1].wins, `wins 역전: ${i}`);
        assert.ok(RANKS[i].peak > RANKS[i - 1].peak, `peak 역전: ${i}`);
    }
});

test('테두리 id 는 중복이 없어야 한다', () => {
    const ids = RANKS.map(r => r.frame);
    assert.strictEqual(new Set(ids).size, ids.length);
});

test('아무것도 없는 새 계정은 입문(0)', () => {
    assert.strictEqual(rankIndexOf({}), 0);
    assert.strictEqual(rankIndexOf({ wins: 0, peakBankroll: 0 }), 0);
    assert.strictEqual(rankIndexOf(null), 0);
    assert.strictEqual(rankIndexOf(undefined), 0);
});

test('기본 뱅크롤 100,000 만으로는 아직 입문이다', () => {
    assert.strictEqual(rankIndexOf({ wins: 0, peakBankroll: 100000 }), 0);
});

test('우승만으로 올라간다 (뱅크롤 0이어도)', () => {
    assert.strictEqual(rankIndexOf({ wins: 1, peakBankroll: 0 }), 1);
    assert.strictEqual(rankIndexOf({ wins: 5, peakBankroll: 0 }), 2);
    assert.strictEqual(rankIndexOf({ wins: 15, peakBankroll: 0 }), 3);
    assert.strictEqual(rankIndexOf({ wins: 40, peakBankroll: 0 }), 4);
});

test('최고 뱅크롤만으로 올라간다 (우승 0이어도)', () => {
    assert.strictEqual(rankIndexOf({ wins: 0, peakBankroll: 300000 }), 1);
    assert.strictEqual(rankIndexOf({ wins: 0, peakBankroll: 1000000 }), 2);
    assert.strictEqual(rankIndexOf({ wins: 0, peakBankroll: 3000000 }), 3);
    assert.strictEqual(rankIndexOf({ wins: 0, peakBankroll: 10000000 }), 4);
});

test('두 조건은 OR — 더 높은 쪽을 따른다', () => {
    assert.strictEqual(rankIndexOf({ wins: 40, peakBankroll: 0 }), 4);
    assert.strictEqual(rankIndexOf({ wins: 0, peakBankroll: 10000000 }), 4);
    assert.strictEqual(rankIndexOf({ wins: 1, peakBankroll: 3000000 }), 3);
});

test('임계값 바로 아래는 오르지 않는다', () => {
    assert.strictEqual(rankIndexOf({ wins: 0, peakBankroll: 299999 }), 0);
    assert.strictEqual(rankIndexOf({ wins: 4, peakBankroll: 999999 }), 1);
    assert.strictEqual(rankIndexOf({ wins: 39, peakBankroll: 9999999 }), 3);
});

test('등급은 절대 내려가지 않는다 — 우승/최고뱅크롤이 늘면 단조 증가', () => {
    let prev = 0;
    for (let w = 0; w <= 50; w++) {
        const cur = rankIndexOf({ wins: w, peakBankroll: 0 });
        assert.ok(cur >= prev, `우승 ${w}회에서 등급이 내려갔다`);
        prev = cur;
    }
    prev = 0;
    for (let p = 0; p <= 12000000; p += 50000) {
        const cur = rankIndexOf({ wins: 0, peakBankroll: p });
        assert.ok(cur >= prev, `최고뱅크롤 ${p}에서 등급이 내려갔다`);
        prev = cur;
    }
});

test('이상한 값이 들어와도 터지지 않고 입문으로 떨어진다', () => {
    assert.strictEqual(rankIndexOf({ wins: NaN, peakBankroll: NaN }), 0);
    assert.strictEqual(rankIndexOf({ wins: '40', peakBankroll: null }), 4); // 문자열 비교도 숫자로 강제됨
    assert.strictEqual(rankIndexOf({ wins: -5, peakBankroll: -1 }), 0);
});

test('잠금 안내 문구 — 입문은 없고 그 위는 두 조건을 모두 알려준다', () => {
    assert.strictEqual(rankNeedText(0), '');
    assert.strictEqual(rankNeedText(-1), '');
    assert.strictEqual(rankNeedText(99), '');
    const t = rankNeedText(3);
    assert.match(t, /우승 15회/);
    assert.match(t, /3,000,000/);
});

test('열린 테두리 목록은 내 등급까지 누적이다', () => {
    assert.deepStrictEqual(unlockedFrames({ wins: 0 }), ['fr_none']);
    assert.deepStrictEqual(unlockedFrames({ wins: 5 }), ['fr_none', 'fr_bronze', 'fr_silver']);
    assert.strictEqual(unlockedFrames({ wins: 40 }).length, RANKS.length);
});
