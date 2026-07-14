'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { summarizeVillain, villainMinStrength, acceptOppHand } = require('../lib/handread');

// ─────────────────────────────────────────────
//  summarizeVillain — 액션 로그 → 행동 요약
// ─────────────────────────────────────────────
test('summarizeVillain: 3벳 상대를 식별한다', () => {
    const log = [
        { nick: 'A', type: 'raise', street: 1 },
        { nick: 'B', type: 'raise', street: 1 }, // B가 3벳
        { nick: 'B', type: 'raise', street: 2 },
    ];
    const s = summarizeVillain(log.filter(x => x.nick === 'B').concat(log.filter(x => x.nick === 'B')), 'B');
    assert.ok(s.raisedPreflop >= 1);
    // B의 프리플랍 레이즈가 2회 이상이면 3벳+
    const s2 = summarizeVillain([
        { nick: 'B', type: 'raise', street: 1 },
        { nick: 'B', type: 'raise', street: 1 }
    ], 'B');
    assert.strictEqual(s2.threeBetPlus, true);
});

test('summarizeVillain: 다른 사람 액션은 섞이지 않는다', () => {
    const log = [
        { nick: 'A', type: 'raise', street: 1 },
        { nick: 'A', type: 'raise', street: 1 },
        { nick: 'B', type: 'call', street: 1 }
    ];
    const b = summarizeVillain(log, 'B');
    assert.strictEqual(b.threeBetPlus, false);
    assert.strictEqual(b.raisedPreflop, 0);
    assert.strictEqual(b.calls, 1);
});

test('summarizeVillain: 배럴 깊이(공격한 스트리트 수)를 센다', () => {
    const s = summarizeVillain([
        { nick: 'V', type: 'raise', street: 2 },
        { nick: 'V', type: 'raise', street: 3 },
        { nick: 'V', type: 'raise', street: 4 }
    ], 'V');
    assert.strictEqual(s.aggroStreets, 3);
});

test('summarizeVillain: 같은 스트리트 중복 공격은 1로 센다', () => {
    const s = summarizeVillain([
        { nick: 'V', type: 'raise', street: 2 },
        { nick: 'V', type: 'raise', street: 2 }
    ], 'V');
    assert.strictEqual(s.aggroStreets, 1);
});

test('summarizeVillain: 올인도 공격으로 센다', () => {
    const s = summarizeVillain([{ nick: 'V', type: 'allin', street: 3 }], 'V');
    assert.strictEqual(s.aggroStreets, 1);
});

test('summarizeVillain: 액션이 없으면 sawAction=false', () => {
    assert.strictEqual(summarizeVillain([], 'V').sawAction, false);
    assert.strictEqual(summarizeVillain(null, 'V').sawAction, false);
});

// ─────────────────────────────────────────────
//  villainMinStrength — 요약 → 레인지 임계값
// ─────────────────────────────────────────────
test('villainMinStrength: 액션 없으면 레인지를 안 좁힌다', () => {
    assert.strictEqual(villainMinStrength({ sawAction: false }, 1.0), 0);
});

test('villainMinStrength: 3벳 > 오픈레이즈 > 콜 순으로 좁아진다', () => {
    const sk = 1.0;
    const threeBet = villainMinStrength({ sawAction: true, threeBetPlus: true, raisedPreflop: 2, aggroStreets: 1 }, sk);
    const open = villainMinStrength({ sawAction: true, raisedPreflop: 1, aggroStreets: 1 }, sk);
    const caller = villainMinStrength({ sawAction: true, raisedPreflop: 0, calls: 1, aggroStreets: 0 }, sk);
    assert.ok(threeBet > open, `3벳(${threeBet}) > 오픈(${open})`);
    assert.ok(open > caller, `오픈(${open}) > 콜(${caller})`);
    assert.ok(caller > 0, '콜도 약간은 좁혀야 함');
});

test('villainMinStrength: 체크만 한 상대는 좁힐 근거가 없다', () => {
    const s = { sawAction: true, raisedPreflop: 0, calls: 0, checks: 3, aggroStreets: 0 };
    assert.strictEqual(villainMinStrength(s, 1.0), 0);
});

test('villainMinStrength: 배럴이 깊을수록 레인지가 강해진다', () => {
    const base = { sawAction: true, raisedPreflop: 1 };
    const one = villainMinStrength({ ...base, aggroStreets: 1 }, 1.0);
    const two = villainMinStrength({ ...base, aggroStreets: 2 }, 1.0);
    const three = villainMinStrength({ ...base, aggroStreets: 3 }, 1.0);
    assert.ok(three > two && two > one, `배럴 깊이 미반영: ${one}/${two}/${three}`);
});

test('villainMinStrength: 핵심 — 실력 낮은 봇은 리딩을 거의 못 한다', () => {
    const s = { sawAction: true, threeBetPlus: true, raisedPreflop: 2, aggroStreets: 3 };
    const pro = villainMinStrength(s, 1.0);
    const fish = villainMinStrength(s, 0.2);
    assert.ok(fish < pro * 0.35, `초보(${fish})가 고수(${pro}) 대비 충분히 낮아야 함`);
    // skill 0이면 아예 안 좁힘 = 기존 랜덤 가정과 동일
    assert.strictEqual(villainMinStrength(s, 0), 0);
});

test('villainMinStrength: 임계값에 상한이 있다 (표본이 말라붙지 않게)', () => {
    const extreme = { sawAction: true, threeBetPlus: true, raisedPreflop: 4, aggroStreets: 3 };
    const v = villainMinStrength(extreme, 1.0);
    assert.ok(v <= 0.80, `상한 초과: ${v}`);
});

// ─────────────────────────────────────────────
//  acceptOppHand — 레인지 필터 + 밸런스
// ─────────────────────────────────────────────
test('acceptOppHand: 안 좁히는 상황이면 전부 수용', () => {
    assert.strictEqual(acceptOppHand(0.05, 0, 0.15, 0.99), true);
});

test('acceptOppHand: 레인지 안 핸드는 항상 수용', () => {
    assert.strictEqual(acceptOppHand(0.75, 0.6, 0.15, 0.99), true);
    assert.strictEqual(acceptOppHand(0.60, 0.6, 0.15, 0.99), true); // 경계 포함
});

test('acceptOppHand: 레인지 밖은 원칙적으로 거절', () => {
    assert.strictEqual(acceptOppHand(0.30, 0.6, 0.15, 0.99), false);
});

test('acceptOppHand: 핵심 — 레인지 밖도 일정 비율 수용 (상대 블러프 반영)', () => {
    // 난수가 offRangeRate 미만이면 수용 → 봇이 "무조건 강함"으로 단정하지 않는다
    assert.strictEqual(acceptOppHand(0.30, 0.6, 0.15, 0.10), true);
    assert.strictEqual(acceptOppHand(0.30, 0.6, 0.15, 0.20), false);
});

test('acceptOppHand: offRangeRate=0이면 레인지 밖 완전 배제', () => {
    assert.strictEqual(acceptOppHand(0.30, 0.6, 0, 0.0001), false);
});

test('acceptOppHand: 통계적으로 offRangeRate 비율만큼 통과한다', () => {
    let pass = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) if (acceptOppHand(0.2, 0.6, 0.15, i / N)) pass++;
    const rate = pass / N;
    assert.ok(Math.abs(rate - 0.15) < 0.02, `실제 통과율 ${rate} — 0.15에서 벗어남`);
});
