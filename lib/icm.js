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

module.exports = { equity, equities, payoutsFor, evOf, callReq };
