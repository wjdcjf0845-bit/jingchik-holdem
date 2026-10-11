// 🏆 ICM(Independent Chip Model) — 대회에서는 칩이 곧 상금이 아니다.
//   칩을 두 배로 불려도 받을 상금의 기대값은 두 배가 안 되고, 다 잃으면 0(또는 그 순위 상금)이다.
//   그래서 입상권 근처에서는 "칩으로는 이득인 콜"이 상금으로는 손해일 수 있다.
//
//   계산: Malmuth–Harville. 1등 확률 = 내 칩 / 전체 칩. 2등 확률 = Σ(다른 사람 j 가 1등) × 내 칩 / (전체 − j 의 칩) … 를 입상 순위까지.
//   한계(솔직하게): 블라인드 위치·실력 차·앞으로의 플레이는 반영하지 않는 표준 근사다. 실전 도구(ICMIZER 등)도 같은 모델을 쓴다.

// 한 사람의 상금 기대값. stacks: 살아 있는 사람들의 칩(0 은 넣지 않는다), idx: 그 사람의 위치, payouts: [1등, 2등, …]
function equity(stacks, idx, payouts) {
    const n = stacks.length, places = Math.min(payouts.length, n);
    if (!(stacks[idx] > 0)) return 0;
    const used = new Array(n).fill(false);
    // place 번째 자리부터, 지금까지 위 순위를 가져간 사람들(used)을 빼고 남은 칩 remain 에서 내가 각 순위를 차지할 확률 × 상금
    const walk = (place, remain, prob) => {
        let ev = prob * (stacks[idx] / remain) * payouts[place];
        if (place + 1 >= places) return ev;
        for (let j = 0; j < n; j++) {
            if (j === idx || used[j] || !(stacks[j] > 0)) continue;
            used[j] = true;
            ev += walk(place + 1, remain - stacks[j], prob * stacks[j] / remain);
            used[j] = false;
        }
        return ev;
    };
    const total = stacks.reduce((a, b) => a + (b > 0 ? b : 0), 0);
    return total > 0 ? walk(0, total, 1) : 0;
}

function equities(stacks, payouts) { return stacks.map((_, i) => equity(stacks, i, payouts)); }

// 입상 인원에 따른 상금 비율(합 100). 파이널나인 구조표를 받기 전이라 흔한 비율을 쓴다(3명: 50/30/20).
function payoutsFor(paid) {
    if (paid <= 1) return [100];
    if (paid === 2) return [65, 35];
    if (paid === 3) return [50, 30, 20];
    if (paid === 4) return [40, 30, 20, 10];
    const w = []; for (let i = 0; i < paid; i++) w.push(paid - i + 1);
    const s = w.reduce((a, b) => a + b, 0);
    return w.map(x => x / s * 100);
}

// 탈락까지 반영한 상금 기대값: 칩이 0 이면 "지금 남은 인원" 순위의 상금(입상권 밖이면 0)
function evOf(hero, others, payouts) {
    const live = others.filter(x => x > 0);
    if (!(hero > 0)) return payouts[live.length] || 0;      // 내가 탈락 → (남은 사람 수 + 1)등
    return equity([hero].concat(live), 0, payouts);
}

// 올인을 받을지(더 이상 벳이 없는 콜) — 상금 기준으로 필요한 승률.
//   hero·vill: 지금 손에 남은 칩(이미 낸 칩 제외) · toCall: 내가 더 낼 칩 · potAfter: 콜한 뒤 이긴 쪽이 가져가는 팟(내 콜 포함)
//   others: 이 승부와 무관한 나머지 사람들의 칩
//   반환: { req 상금 기준 필요 승률, chip 칩 기준 필요 승률, tax 그 차이, fold·win·lose 각 경우의 상금 기대값(%) }
function callReq(o) {
    const pay = o.payouts, others = o.others || [];
    const fold = evOf(o.hero, others.concat([o.vill + o.potAfter - o.toCall]), pay);
    const win = evOf(o.hero - o.toCall + o.potAfter, others.concat([o.vill]), pay);
    const lose = evOf(o.hero - o.toCall, others.concat([o.vill + o.potAfter]), pay);
    const chip = o.potAfter > 0 ? o.toCall / o.potAfter : 0;
    if (!(win - lose > 1e-9)) return { req: chip, chip, tax: 0, fold, win, lose };
    const req = Math.max(0, Math.min(1, (fold - lose) / (win - lose)));
    return { req, chip, tax: req - chip, fold, win, lose };
}

// 내가 먼저 올인(푸시)하는 범위가 상금 기준으로 얼마나 달라지나.
//   같은 계산을 "칩 기준"과 "상금 기준"으로 한 번씩 해서, 올인이 접는 것보다 나은 패의 비율을 견준다.
//   받는 쪽은 버블에서 더 좁게 받으므로(위 callReq) 미는 쪽은 넓어질 수 있고, 내가 지면 탈락하는 자리면 좁아진다 — 둘 다 이 계산에 들어 있다.
//   가정(어림): 받는 사람은 한 명씩만 본다(둘 이상이 같이 받는 경우는 무시) · 받는 범위는 "내 푸시 범위 상대 승률이 필요 승률 이상인 패" · 범위는 늘 '위에서부터 x%'.
//   o: { stack 내 전체 칩, posted 내가 이미 낸 칩, dead 팟에 깔린 칩 전부(내 것 포함),
//        callers: [{ stack, posted }] 뒤에 남은 사람들(행동 순서), others: 이 판과 무관한 사람들의 칩, payouts, base 내 푸시 범위(0~1),
//        hands: [{ code, w }] 패 종류와 조합 수, eqVs(code, x) 상위 x 범위 상대 승률 }
//   반환: { chip, icm 올인이 이득인 패의 비율(0~1), ratio = icm / chip }
function pushShift(o) {
    const total = o.hands.reduce((a, h) => a + h.w, 0);
    const once = (useIcm, base) => {
        const V = (hero, rest) => (useIcm ? evOf(hero, rest, o.payouts) : Math.max(0, hero));
        const behind = o.callers.map(c => c.stack - c.posted);
        const cs = o.callers.map((c, i) => {
            const eff = Math.min(o.stack, c.stack), toCall = eff - c.posted, potAfter = o.dead - o.posted - c.posted + 2 * eff;
            const rest = o.others.concat(behind.filter((_, j) => j !== i));
            let req = potAfter > 0 ? toCall / potAfter : 1;
            if (useIcm) req = callReq({ hero: behind[i], vill: o.stack - eff, toCall, potAfter, others: rest, payouts: o.payouts }).req;
            let w = 0; o.hands.forEach(h => { if (o.eqVs(h.code, base) >= req) w += h.w; });
            const call = Math.max(0.005, w / total);
            const win = V(o.stack - eff + potAfter, rest.concat([c.stack - eff])), lose = V(o.stack - eff, rest.concat([c.stack - eff + potAfter]));
            return { call, win, lose };
        });
        const everyone = o.others.concat(behind);
        const steal = V(o.stack + o.dead - o.posted, everyone);
        // 접으면: 깔린 칩은 마지막 사람(대개 BB)이 가져간다고 본다
        const foldRest = o.others.concat(behind.map((b, i) => (i === behind.length - 1 ? b + o.dead : b)));
        const fold = V(o.stack - o.posted, foldRest);
        let ok = 0;
        o.hands.forEach(h => {
            let pNo = 1, ev = 0;
            cs.forEach(c => { const e = o.eqVs(h.code, c.call); ev += pNo * c.call * (e * c.win + (1 - e) * c.lose); pNo *= 1 - c.call; });
            ev += pNo * steal;
            if (ev > fold) ok += h.w;
        });
        return ok / total;
    };
    // 내가 미는 범위와 상대가 받는 범위는 서로에게 달려 있다(내가 좁게 밀면 상대도 좁게 받고, 그러면 나는 더 넓게 밀 수 있다).
    //   그래서 한 번에 끝내지 않고 "내 범위 → 상대 범위 → 내 범위"를 몇 번 되풀이해 서로 맞는 지점을 찾는다.
    const run = useIcm => {
        let base = Math.max(0.02, Math.min(1, o.base));
        for (let k = 0; k < 12; k++) base = Math.max(0.02, 0.5 * base + 0.5 * once(useIcm, base));
        return base;
    };
    const chip = run(false), icm = run(true);
    return { chip, icm, ratio: icm / Math.max(0.01, chip) };
}

module.exports = { equity, equities, payoutsFor, evOf, callReq, pushShift };
