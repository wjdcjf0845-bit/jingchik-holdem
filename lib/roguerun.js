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
    { name: '골목 판',       bots: ['easy', 'easy'],                         hands: 16, quota: 1.08 },
    { name: '동네 하우스',   bots: ['easy', 'easy', 'easy'],                 hands: 16, quota: 1.10 },
    { name: '단골 손님들',   bots: ['normal', 'normal'],                     hands: 15, quota: 1.13 },
    { name: '주말 토너',     bots: ['normal', 'normal', 'normal'],           hands: 15, quota: 1.16 },
    { name: '하우스 매니저', bots: ['normal', 'normal', 'hard'],             hands: 15, quota: 1.20, boss: true },
    { name: '레귤러 테이블', bots: ['normal', 'hard', 'hard'],               hands: 15, quota: 1.22 },
    { name: '하이롤러 룸',   bots: ['hard', 'hard', 'hard'],                 hands: 15, quota: 1.23 },
    { name: '프로 서킷',     bots: ['hard', 'hard', 'hard', 'hard'],         hands: 15, quota: 1.27 },
    { name: '파이널 테이블', bots: ['hard', 'hard', 'hard', 'hard', 'hard'], hands: 15, quota: 1.30 },
    { name: '더 핏',         bots: ['hard', 'hard', 'hard', 'hard', 'hard'], hands: 17, quota: 1.45, boss: true, botChipsMult: 1.5 }
];
const MIN_QUOTA = 1.05;      // 어떤 증강·상점 할인을 겹쳐도 목표는 시작 칩의 이 배수 밑으로 안 내려간다 (폴드만 해서 깨지는 것 방지)

// tier: s(실버) g(골드) p(프리즘). max: 몇 번까지 겹쳐 고를 수 있는가(기본 1).
const AUGMENTS = {
    wallet:   { tier: 's', icon: '💼', name: '두둑한 지갑', desc: '매 층 시작 칩 +20%', max: 3 },
    interest: { tier: 's', icon: '🏦', name: '이자',        desc: '칩을 걸고 참여한 핸드가 끝나면 가진 칩의 2%(최대 80)를 받는다' },
    blind:    { tier: 's', icon: '🎟️', name: '블라인드 할인', desc: '내가 낸 블라인드의 절반을 돌려받는다' },
    pair:     { tier: 's', icon: '👯', name: '포켓 보너스', desc: '포켓 페어로 참여한 핸드가 끝나면 +300' },
    extra:    { tier: 's', icon: '⏱️', name: '연장전',      desc: '매 층 기한 +2핸드', max: 2 },
    seven:    { tier: 's', icon: '7️⃣', name: '럭키 세븐',   desc: '내 패에 7이 있는 핸드를 이기면 +400' },
    bonus:    { tier: 'g', icon: '💰', name: '승리 수당',   desc: '핸드를 이기면 번 칩의 20%를 더 받는다', max: 2 },
    discount: { tier: 'g', icon: '🏷️', name: '목표 할인',   desc: '매 층 목표 칩 -8%' },
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
    const run = { floor: 1, cleared: 0, augments: [], rerolls: REROLLS, revive: 0, phase: 'pick', offers: [], inFloor: false,
        coins: 0, boost: {}, bought: [], extraPicks: 0, afterBoss: false };
    run.offers = makeOffers(run, rng, false);
    return run;
}

function pick(run, idx, rng) {
    if (run.phase !== 'pick' || !Number.isInteger(idx) || idx < 0 || idx >= run.offers.length) return null;
    const id = run.offers[idx];
    run.augments.push(id);
    if (id === 'revive') run.revive += 1;
    // 상점에서 "증강 하나 더"를 샀으면 한 번 더 고른다 (고를 게 남아 있을 때만)
    if ((run.extraPicks || 0) > 0 && rng) {
        run.extraPicks -= 1;
        run.offers = makeOffers(run, rng, false);
        if (run.offers.length) return id;
    }
    run.offers = [];
    run.phase = 'play';
    return id;
}

// ── 🪙 층 사이 상점 ──────────────────────────────────────────
//   층을 깨면 코인을 받는다: 기본 2 + 남긴 핸드(최대 4) + 목표를 넘긴 칩 200당 1(최대 6).
//   빨리, 크게 깰수록 많이 받으니 "목표만 넘기고 폴드"가 최선이 아니게 된다.
const SHOP = {
    reroll: { cost: 3,  icon: '🎲', name: '다시 뽑기 +1',   desc: '증강 다시 뽑기 횟수를 1 늘린다' },
    hands:  { cost: 4,  icon: '⏱️', name: '기한 +2핸드',    desc: '다음 층 한 번만 기한이 2핸드 늘어난다' },
    chips:  { cost: 4,  icon: '💵', name: '시작 칩 +400',   desc: '다음 층 한 번만 시작 칩 +400' },
    quota:  { cost: 6,  icon: '🏷️', name: '목표 -6%',       desc: '다음 층 한 번만 목표 칩 -6%' },
    pick:   { cost: 10, icon: '➕', name: '증강 하나 더',   desc: '이번에 증강을 하나 더 고른다' },
    clover: { cost: 14, icon: '🍀', name: '네잎클로버',     desc: '층을 실패해도 한 번은 다시 한다 (1개만 가질 수 있다)' }
};
function coinsFor(ctx) {
    const surplus = Math.max(0, (ctx.chips || 0) - (ctx.quota || 0));
    return 2 + Math.max(0, Math.min(4, ctx.handsLeft || 0)) + Math.min(6, Math.floor(surplus / 200));
}
// 층 클리어 처리 — 다음 층으로 올리고 코인을 주고 증강을 뽑아 둔다. 마지막 층이면 done.
function clearFloor(run, ctx, rng) {
    run.cleared = run.floor;
    run.inFloor = false;
    run.boost = {}; run.bought = [];                       // 상점에서 산 일회성 효과는 그 층에서 끝
    if (run.floor >= FLOORS.length) return { done: true, coins: 0 };
    const coins = coinsFor(ctx || {});
    run.coins = (run.coins || 0) + coins;
    run.afterBoss = !!FLOORS[run.floor - 1].boss;
    run.floor += 1; run.phase = 'pick';
    run.offers = makeOffers(run, rng, run.afterBoss);
    return { done: false, coins };
}
function canBuy(run, id) {
    const it = Object.prototype.hasOwnProperty.call(SHOP, id) ? SHOP[id] : null;
    if (!it || run.phase !== 'pick') return false;
    if ((run.coins || 0) < it.cost) return false;
    if (id !== 'reroll' && (run.bought || []).includes(id)) return false;   // 일회성 물건은 층마다 한 번
    if (id === 'clover' && (run.revive > 0 || count(run, 'revive') >= 1)) return false;
    return true;
}
function buy(run, id) {
    if (!canBuy(run, id)) return false;
    run.coins -= SHOP[id].cost;
    run.bought = (run.bought || []).concat(id);
    run.boost = run.boost || {};
    if (id === 'reroll') run.rerolls += 1;
    else if (id === 'hands') run.boost.hands = 2;
    else if (id === 'chips') run.boost.chips = 400;
    else if (id === 'quota') run.boost.quota = 0.06;
    else if (id === 'pick') run.extraPicks = (run.extraPicks || 0) + 1;
    else if (id === 'clover') { run.revive += 1; run.augments.push('revive'); }
    return true;
}
function shopView(run) {
    return Object.keys(SHOP).map(id => Object.assign({ id, can: canBuy(run, id), bought: id !== 'reroll' && (run.bought || []).includes(id) }, SHOP[id]));
}

// ── 💾 저장·복구 ────────────────────────────────────────────
//   런은 계정에 저장해 둔다(서버가 재시작돼도 이어 하게). 저장된 값은 믿지 않고 전부 다시 검증한다.
function serialize(run) {
    return {
        floor: run.floor, cleared: run.cleared, augments: run.augments.slice(), rerolls: run.rerolls, phase: run.phase,
        offers: run.offers.slice(), inFloor: !!run.inFloor, coins: run.coins || 0, boost: Object.assign({}, run.boost || {}),
        bought: (run.bought || []).slice(), extraPicks: run.extraPicks || 0, afterBoss: !!run.afterBoss
    };
}
function restore(o, rng) {
    if (!o || typeof o !== 'object') return null;
    const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
    const floor = int(o.floor, 1, FLOORS.length, 0);
    if (!floor) return null;
    const run = { floor, cleared: floor - 1, augments: [], rerolls: int(o.rerolls, 0, 30, 0), revive: 0, phase: o.phase === 'play' ? 'play' : 'pick',
        offers: [], inFloor: o.phase === 'play' && !!o.inFloor, coins: int(o.coins, 0, 999, 0), boost: {}, bought: [],
        extraPicks: int(o.extraPicks, 0, 3, 0), afterBoss: !!o.afterBoss };
    const valid = id => typeof id === 'string' && Object.prototype.hasOwnProperty.call(AUGMENTS, id) && count(run, id) < (AUGMENTS[id].max || 1);
    (Array.isArray(o.augments) ? o.augments : []).forEach(id => { if (valid(id)) run.augments.push(id); });
    run.revive = count(run, 'revive');
    const b = (o.boost && typeof o.boost === 'object') ? o.boost : {};
    if (b.hands === 2) run.boost.hands = 2;
    if (b.chips === 400) run.boost.chips = 400;
    if (b.quota === 0.06) run.boost.quota = 0.06;
    run.bought = (Array.isArray(o.bought) ? o.bought : []).filter(id => typeof id === 'string' && Object.prototype.hasOwnProperty.call(SHOP, id)).slice(0, 12);
    if (run.phase === 'pick') {
        const off = (Array.isArray(o.offers) ? o.offers : []).filter(valid);
        run.offers = (off.length && new Set(off).size === off.length && off.length <= 3) ? off : makeOffers(run, rng, run.afterBoss);
        if (!run.offers.length) run.phase = 'play';      // 고를 게 없으면 바로 다음 층으로
    }
    return run;
}

function reroll(run, rng, afterBoss) {
    if (run.phase !== 'pick' || run.rerolls <= 0) return false;
    run.rerolls -= 1;
    run.offers = makeOffers(run, rng, afterBoss);
    return true;
}

// 이번 층의 판 구성 — 증강과 상점에서 산 것(boost)이 반영된 시작 칩·목표·기한
function floorSetup(run) {
    const f = FLOORS[run.floor - 1];
    const bs = run.boost || {};
    const base = Math.round(START_CHIPS * (1 + 0.2 * count(run, 'wallet') + (has(run, 'double') ? 0.5 : 0)) / 100) * 100;
    const startChips = base + (bs.chips || 0);            // 상점의 추가 칩은 목표 계산에 안 들어간다(그래서 값어치가 있다) — 단 아래 바닥(시작 칩 + 2bb)은 지킨다
    const botChips = Math.round(START_CHIPS * (f.botChipsMult || 1) * (has(run, 'nerf') ? 0.75 : 1) / 50) * 50;
    const cut = 1 - (has(run, 'discount') ? 0.08 : 0) - (bs.quota || 0);
    const quota = Math.round(base * f.quota * cut / 50) * 50;
    return {
        floor: run.floor, total: FLOORS.length, name: f.name, boss: !!f.boss, bots: f.bots.slice(),
        // 바닥 둘: 증강·할인을 겹쳐도 기본 칩의 MIN_QUOTA 배, 상점에서 칩을 사도 시작 칩 + 2bb 는 벌어야 한다
        startChips, botChips, quota: Math.max(quota, Math.ceil(base * MIN_QUOTA / 50) * 50, startChips + 2 * BB),
        hands: f.hands + 2 * count(run, 'extra') + (bs.hands || 0), mull: has(run, 'mull') ? 3 : 0
    };
}

// 카드를 받은 직후 — 블라인드 환급 (포켓 보너스는 "참여한 핸드"여야 해서 핸드가 끝난 뒤에 준다)
//   ctx: { hand: ['As','Kd'], blindPaid }
function onDeal(run, ctx) {
    const notes = []; let bonus = 0;
    if (has(run, 'blind') && ctx.blindPaid > 0) { const b = Math.floor(ctx.blindPaid / 2); bonus += b; notes.push({ id: 'blind', amount: b }); }
    return { bonus, notes };
}

// 핸드가 끝난 뒤 — 이긴 핸드의 수당, 올인 보험, 이자
//   ctx: { start(핸드 전 칩), now(핸드 후 칩), hand, rank(쇼다운 족보 등급, 없으면 0), allIn(올인했는가), vpip(자발적으로 칩을 넣었는가), rng }
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
    if (has(run, 'pair') && ctx.vpip && (ctx.hand || []).length === 2 && ctx.hand[0][0] === ctx.hand[1][0]) add('pair', 300);
    // 이자는 "참여한 핸드"에만 — 폴드만 하면서 이자로 목표를 채우는 구멍을 막는다. 핸드당 상한도 둔다.
    if (has(run, 'interest') && ctx.vpip) add('interest', Math.min(80, Math.floor((ctx.now + bonus) * 0.02)));
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

module.exports = { START_CHIPS, BB, REROLLS, FLOORS, AUGMENTS, SHOP, MIN_QUOTA, makeOffers, newRun, pick, reroll, floorSetup, onDeal, afterHand, progressOf, settle, describe, count, has,
    coinsFor, clearFloor, canBuy, buy, shopView, serialize, restore };
