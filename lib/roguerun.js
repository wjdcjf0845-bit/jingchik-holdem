'use strict';
// ═══════════════════════════════════════════════════════════
//  roguerun.js — 🍀 증강 컴까기 (로그라이크 런)
//
//  한 번의 "런"은 10층짜리 탑이다. 층마다 봇들과 앉아 **기한(핸드 수) 안에 목표 칩**을
//  채우면 다음 층으로 올라가고(클로버핏의 "기한 안에 빚 갚기"), 층 사이마다
//  **증강 3개 중 1개**를 골라 규칙을 내 쪽으로 비튼다(증강 칼바람).
//  실패하면 런이 끝나고, 올라간 층만큼 보상을 받는다.
//
//  서버 본문이 아니라 여기 둔 이유: 증강은 칩을 찍어내는 규칙이라
//  계산을 순수 함수로 떼어 단위 테스트로 못박아 둬야 한다.
//  (런 방의 칩은 뱅크롤과 무관한 자유 칩이다 — 보상만 settle() 이 정한다)
// ═══════════════════════════════════════════════════════════

const START_CHIPS = 3000;
const BB = 100;
const REROLLS = 2;          // 런 하나에 증강 다시 뽑기 횟수

// quota: 그 층 시작 칩의 몇 배를 만들어야 하는가. hands: 기한(핸드 수).
const FLOORS = [
    { name: '골목 판',       bots: ['easy', 'easy'],                         hands: 10, quota: 1.25 },
    { name: '동네 하우스',   bots: ['easy', 'easy', 'easy'],                 hands: 10, quota: 1.30 },
    { name: '단골 손님들',   bots: ['normal', 'normal'],                     hands: 10, quota: 1.35 },
    { name: '주말 토너',     bots: ['normal', 'normal', 'normal'],           hands: 11, quota: 1.40 },
    { name: '하우스 매니저', bots: ['normal', 'normal', 'hard'],             hands: 12, quota: 1.50, boss: true },
    { name: '레귤러 테이블', bots: ['normal', 'hard', 'hard'],               hands: 11, quota: 1.50 },
    { name: '하이롤러 룸',   bots: ['hard', 'hard', 'hard'],                 hands: 11, quota: 1.55 },
    { name: '프로 서킷',     bots: ['hard', 'hard', 'hard', 'hard'],         hands: 12, quota: 1.60 },
    { name: '파이널 테이블', bots: ['hard', 'hard', 'hard', 'hard', 'hard'], hands: 12, quota: 1.70 },
    { name: '더 핏',         bots: ['hard', 'hard', 'hard', 'hard', 'hard'], hands: 14, quota: 2.00, boss: true, botChipsMult: 1.5 }
];

// tier: s(실버) g(골드) p(프리즘). max: 몇 번까지 겹쳐 고를 수 있는가(기본 1).
const AUGMENTS = {
    wallet:   { tier: 's', icon: '💼', name: '두둑한 지갑', desc: '매 층 시작 칩 +20%', max: 3 },
    interest: { tier: 's', icon: '🏦', name: '이자',        desc: '핸드가 끝날 때마다 가진 칩의 2%를 받는다', max: 2 },
    blind:    { tier: 's', icon: '🎟️', name: '블라인드 할인', desc: '내가 낸 블라인드의 절반을 돌려받는다' },
    pair:     { tier: 's', icon: '👯', name: '포켓 보너스', desc: '포켓 페어를 받으면 +300' },
    extra:    { tier: 's', icon: '⏱️', name: '연장전',      desc: '매 층 기한 +2핸드', max: 2 },
    seven:    { tier: 's', icon: '7️⃣', name: '럭키 세븐',   desc: '내 패에 7이 있는 핸드를 이기면 +400' },
    bonus:    { tier: 'g', icon: '💰', name: '승리 수당',   desc: '핸드를 이기면 번 칩의 20%를 더 받는다', max: 2 },
    discount: { tier: 'g', icon: '🏷️', name: '목표 할인',   desc: '매 층 목표 칩 -10%', max: 2 },
    insure:   { tier: 'g', icon: '🛡️', name: '올인 보험',   desc: '올인해서 진 핸드는 잃은 칩의 30%를 돌려받는다' },
    mull:     { tier: 'g', icon: '🔄', name: '멀리건',      desc: '층마다 3번, 프리플랍에서 내 패를 새로 받는다' },
    peek:     { tier: 'g', icon: '👁️', name: '엿보기',      desc: '매 핸드 상대 한 명의 카드 1장을 본다' },
    combo:    { tier: 'g', icon: '🃏', name: '족보 수당',   desc: '스트레이트 이상으로 이기면 +800' },
    revive:   { tier: 'p', icon: '🍀', name: '네잎클로버',  desc: '층을 실패해도 한 번은 그 층을 다시 한다' },
    nerf:     { tier: 'p', icon: '😵', name: '기선 제압',   desc: '상대 전원의 시작 칩 -25%' },
    jackpot:  { tier: 'p', icon: '🎰', name: '잭팟',        desc: '핸드를 이길 때마다 15% 확률로 번 칩만큼 한 번 더 받는다' },
    double:   { tier: 'p', icon: '✨', name: '더블 스타트', desc: '매 층 시작 칩 +50%' },
    cores:    { tier: 'p', icon: '🔷', name: '코어 채굴',   desc: '이 런의 코어 보상 2배' }
};
const TIER_NAME = { s: '실버', g: '골드', p: '프리즘' };
const STRAIGHT_RANK = 5;      // pokersolver rank: 1 하이카드 … 5 스트레이트 … 9 스트레이트 플러시

function count(run, id) { return run.augments.filter(a => a === id).length; }
function has(run, id) { return run.augments.includes(id); }

// 다음에 고를 증강의 등급 — 층이 오를수록 좋은 게 나온다. 보스 층을 깬 직후는 프리즘 확정.
function rollTier(floorNext, rng, afterBoss) {
    if (afterBoss) return 'p';
    const r = rng();
    if (floorNext <= 3) return r < 0.70 ? 's' : (r < 0.97 ? 'g' : 'p');
    if (floorNext <= 6) return r < 0.45 ? 's' : (r < 0.90 ? 'g' : 'p');
    return r < 0.25 ? 's' : (r < 0.75 ? 'g' : 'p');
}

function available(run, tier) {
    return Object.keys(AUGMENTS).filter(id => AUGMENTS[id].tier === tier && count(run, id) < (AUGMENTS[id].max || 1));
}

// 증강 3개 뽑기 (같은 등급에서. 그 등급이 모자라면 다른 등급으로 채운다)
function makeOffers(run, rng, afterBoss) {
    const tier = rollTier(run.floor, rng, afterBoss);
    const order = tier === 's' ? ['s', 'g', 'p'] : tier === 'g' ? ['g', 's', 'p'] : ['p', 'g', 's'];
    const out = [];
    for (const t of order) {
        const pool = available(run, t);
        while (pool.length && out.length < 3) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
        if (out.length >= 3) break;
    }
    return out;
}

function newRun(rng) {
    const run = { floor: 1, cleared: 0, augments: [], rerolls: REROLLS, revive: 0, phase: 'pick', offers: [], inFloor: false };
    run.offers = makeOffers(run, rng, false);
    return run;
}

function pick(run, idx) {
    if (run.phase !== 'pick' || !Number.isInteger(idx) || idx < 0 || idx >= run.offers.length) return null;
    const id = run.offers[idx];
    run.augments.push(id);
    if (id === 'revive') run.revive += 1;
    run.offers = [];
    run.phase = 'play';
    return id;
}

function reroll(run, rng, afterBoss) {
    if (run.phase !== 'pick' || run.rerolls <= 0) return false;
    run.rerolls -= 1;
    run.offers = makeOffers(run, rng, afterBoss);
    return true;
}

// 이번 층의 판 구성 — 증강이 반영된 시작 칩·목표·기한
function floorSetup(run) {
    const f = FLOORS[run.floor - 1];
    const startChips = Math.round(START_CHIPS * (1 + 0.2 * count(run, 'wallet') + (has(run, 'double') ? 0.5 : 0)) / 100) * 100;
    const botChips = Math.round(START_CHIPS * (f.botChipsMult || 1) * (has(run, 'nerf') ? 0.75 : 1) / 50) * 50;
    const quota = Math.round(startChips * f.quota * (1 - 0.1 * count(run, 'discount')) / 50) * 50;
    return {
        floor: run.floor, total: FLOORS.length, name: f.name, boss: !!f.boss, bots: f.bots.slice(),
        startChips, botChips, quota: Math.max(quota, startChips + BB),
        hands: f.hands + 2 * count(run, 'extra'), mull: has(run, 'mull') ? 3 : 0
    };
}

// 카드를 받은 직후 — 블라인드 환급·포켓 보너스
//   ctx: { hand: ['As','Kd'], blindPaid }
function onDeal(run, ctx) {
    const notes = []; let bonus = 0;
    if (has(run, 'blind') && ctx.blindPaid > 0) { const b = Math.floor(ctx.blindPaid / 2); bonus += b; notes.push({ id: 'blind', amount: b }); }
    if (has(run, 'pair') && ctx.hand && ctx.hand.length === 2 && ctx.hand[0][0] === ctx.hand[1][0]) { bonus += 300; notes.push({ id: 'pair', amount: 300 }); }
    return { bonus, notes };
}

// 핸드가 끝난 뒤 — 이긴 핸드의 수당, 올인 보험, 이자
//   ctx: { start(핸드 전 칩), now(핸드 후 칩), hand, rank(쇼다운 족보 등급, 없으면 0), allIn(올인했는가), rng }
function afterHand(run, ctx) {
    const notes = []; let bonus = 0;
    const profit = ctx.now - ctx.start;
    const add = (id, amount) => { if (amount > 0) { bonus += amount; notes.push({ id, amount }); } };
    if (profit > 0) {
        add('bonus', Math.floor(profit * 0.2 * count(run, 'bonus')));
        if (has(run, 'seven') && (ctx.hand || []).some(c => c && c[0] === '7')) add('seven', 400);
        if (has(run, 'combo') && ctx.rank >= STRAIGHT_RANK) add('combo', 800);
        if (has(run, 'jackpot') && ctx.rng() < 0.15) add('jackpot', profit);
    } else if (profit < 0 && ctx.allIn && has(run, 'insure')) {
        add('insure', Math.floor(-profit * 0.3));
    }
    if (has(run, 'interest')) add('interest', Math.floor((ctx.now + bonus) * 0.02 * count(run, 'interest')));
    return { bonus, notes };
}

function progressOf(u) {
    const r = (u && u.rogue && typeof u.rogue === 'object') ? u.rogue : {};
    const n = v => (Number.isInteger(v) && v > 0 ? v : 0);
    return { best: Math.min(FLOORS.length, n(r.best)), runs: n(r.runs), wins: n(r.wins) };
}

// 런 종료 정산 — 깬 층만큼 뱅크롤과 코어. 내 최고 기록을 넘긴 층에는 첫 돌파 보너스.
//   반복 보상은 작게(층당 400×층), 첫 돌파는 크게(층당 +1500·코어 +1) — 같은 층 반복으로 뱅크롤을 찍어내지 못하게.
function settle(u, run) {
    const p = progressOf(u);
    const cleared = Math.max(0, Math.min(FLOORS.length, run.cleared || 0));
    let reward = 0, cores = 0;
    for (let f = 1; f <= cleared; f++) { reward += 400 * f; cores += 1; if (f > p.best) { reward += 1500; cores += 1; } }
    if (run.augments.includes('cores')) cores *= 2;
    const win = cleared === FLOORS.length;
    u.rogue = { best: Math.max(p.best, cleared), runs: p.runs + 1, wins: p.wins + (win ? 1 : 0) };
    u.cores = (Number.isInteger(u.cores) && u.cores > 0 ? u.cores : 0) + cores;
    return { cleared, reward, cores, win, best: u.rogue.best, newBest: cleared > p.best };
}

// 화면에 내려보낼 증강 설명
function describe(id) { const a = AUGMENTS[id]; return a ? { id, tier: a.tier, tierName: TIER_NAME[a.tier], icon: a.icon, name: a.name, desc: a.desc } : null; }

module.exports = { START_CHIPS, BB, REROLLS, FLOORS, AUGMENTS, makeOffers, newRun, pick, reroll, floorSetup, onDeal, afterHand, progressOf, settle, describe, count, has };
