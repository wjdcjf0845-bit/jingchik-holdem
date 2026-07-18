'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rawBlockerMult, bluffBlockerMult } = require('../lib/blockers');

// ─────────────────────────────────────────────
//  rawBlockerMult — 넛 블로커 배수
// ─────────────────────────────────────────────
test('rawBlockerMult: 보드가 3장 미만이면 중립(1.0)', () => {
    assert.strictEqual(rawBlockerMult(['As', 'Kd'], ['Qh', '7h']), 1.0);
    assert.strictEqual(rawBlockerMult(['As', 'Kd'], []), 1.0);
    assert.strictEqual(rawBlockerMult(null, ['Qh', '7h', '2h']), 1.0);
});

test('rawBlockerMult: 핵심 — 플러시 보드 + 넛플러시 A 보유 = 강한 블로커', () => {
    // 하트 3장 보드, A♥ 보유 → 넛플러시 차단
    const withNut = rawBlockerMult(['Ah', 'Kd'], ['Qh', '7h', '2h']);
    // 같은 보드, 넛 블로커 없음(스페이드/다이아)
    const without = rawBlockerMult(['As', 'Kd'], ['Qh', '7h', '2h']);
    assert.ok(withNut > without, `넛플러시 A(${withNut}) > 무블로커(${without})`);
    assert.ok(withNut >= 1.25, `넛플러시 블로커가 충분히 커야 함: ${withNut}`);
    assert.strictEqual(without, 1.0);
});

test('rawBlockerMult: 넛플러시 A > 세컨넛 K > 잡플러시 카드', () => {
    const ace = rawBlockerMult(['Ah', '3d'], ['Qh', '7h', '2h']);
    const king = rawBlockerMult(['Kh', '3d'], ['Qh', '7h', '2h']);
    const low = rawBlockerMult(['5h', '3d'], ['Qh', '7h', '2h']);
    assert.ok(ace > king && king > low, `A(${ace}) > K(${king}) > low(${low})`);
    assert.ok(low > 1.0, '잡플러시 카드도 일부 차단');
});

test('rawBlockerMult: 플러시 드로우(2장)는 넛플러시 A만 소폭 인정', () => {
    const nutDraw = rawBlockerMult(['Ah', '3d'], ['Qh', '7h', '2s']); // 하트 2장
    const lowDraw = rawBlockerMult(['5h', '3d'], ['Qh', '7h', '2s']);
    assert.ok(nutDraw > 1.0, `넛플러시 드로우 카드 인정: ${nutDraw}`);
    assert.strictEqual(lowDraw, 1.0, '드로우 단계 잡카드는 중립');
});

test('rawBlockerMult: 무지개(레인보우) 보드는 플러시 블로커 없음', () => {
    const m = rawBlockerMult(['Ah', 'Kd'], ['Qs', '7c', '2d']); // 서로 다른 무늬 3장, A는 하트뿐
    // 플러시 텍스처 없음 → 탑카드 블로커만 (보드 최고 Q, 내 A는 아님) → 1.0
    assert.strictEqual(m, 1.0);
});

test('rawBlockerMult: 에이스 하이 보드 + A 보유 = 탑카드 블로커', () => {
    const withAce = rawBlockerMult(['Ad', '3c'], ['As', '8h', '2c']); // 보드 최고 A, 내 A 보유
    const without = rawBlockerMult(['Kd', '3c'], ['As', '8h', '2c']);
    assert.ok(withAce > without, `A 블로커(${withAce}) > 무(${without})`);
    assert.strictEqual(without, 1.0);
});

test('rawBlockerMult: 두 홀카드가 모두 넛 무늬면 블로커가 더 크다 (A+K 하트)', () => {
    const both = rawBlockerMult(['Ah', 'Kh'], ['Qh', '7h', '2h']);
    const onlyAce = rawBlockerMult(['Ah', '3d'], ['Qh', '7h', '2h']);
    assert.ok(both > onlyAce, `AK 스华이티드(${both}) > A만(${onlyAce})`);
});

test('rawBlockerMult: 배수 상한은 1.5', () => {
    const m = rawBlockerMult(['Ah', 'Kh'], ['Ah', 'Kh', 'Qh', 'Jh', 'Th'].slice(2)); // 극단 케이스 방지용
    const m2 = rawBlockerMult(['Ah', 'Kh'], ['Qh', '7h', '2h', '5h']);
    assert.ok(m <= 1.5 && m2 <= 1.5, `상한 초과: ${m}, ${m2}`);
});

// ─────────────────────────────────────────────
//  bluffBlockerMult — skill 스케일링
// ─────────────────────────────────────────────
test('bluffBlockerMult: 고수는 블로커를 온전히 반영', () => {
    const raw = rawBlockerMult(['Ah', '3d'], ['Qh', '7h', '2h']);
    const pro = bluffBlockerMult(['Ah', '3d'], ['Qh', '7h', '2h'], 1.0);
    assert.ok(Math.abs(pro - raw) < 1e-9, `고수는 원배수와 동일해야 함 (raw ${raw}, pro ${pro})`);
});

test('bluffBlockerMult: 핵심 — 초보는 블로커를 거의 못 읽는다', () => {
    const pro = bluffBlockerMult(['Ah', '3d'], ['Qh', '7h', '2h'], 1.0);
    const fish = bluffBlockerMult(['Ah', '3d'], ['Qh', '7h', '2h'], 0.2);
    assert.ok(fish < pro, `초보(${fish}) < 고수(${pro})`);
    assert.ok(fish > 1.0 && fish < 1.15, `초보는 1.0에 가까워야 함: ${fish}`);
    // skill 0이면 완전 중립
    assert.strictEqual(bluffBlockerMult(['Ah', '3d'], ['Qh', '7h', '2h'], 0), 1.0);
});

test('bluffBlockerMult: 블로커가 없으면 skill과 무관하게 1.0', () => {
    assert.strictEqual(bluffBlockerMult(['As', 'Kd'], ['Qh', '7h', '2h'], 1.0), 1.0);
    assert.strictEqual(bluffBlockerMult(['As', 'Kd'], ['Qh', '7h', '2h'], 0.5), 1.0);
});
