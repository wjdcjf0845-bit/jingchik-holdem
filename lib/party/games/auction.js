// 💰 게임: 숫자 경매 — 예산 배분 + 비공개 동시 입찰 눈치싸움
//
// 규칙
//  - 전원 동일한 '입찰 예산'으로 시작 (파티 점수와 별개, 보충 없음)
//  - 물건 목록과 가치를 처음부터 전부 공개 → 어디에 몰빵할지 전략적으로 배분
//  - 매 라운드 비공개 입찰 → 동시 공개
//  - 최고가 단독 1명이 낙찰: 물건 가치만큼 파티 점수 획득, 입찰금은 예산에서 차감
//  - 동점이면 유찰: 아무도 갖지 못하는데 동점자는 입찰금을 잃음 (무난한 숫자 회피 유도)
//  - 미스터리 물건은 입찰이 끝난 뒤에야 가치 공개
const DATA = require('./auction-data');

const BID_MS = 45000;   // 라운드 입찰 제한시간

function buildItems() {
    return DATA.items.map(it => {
        if (it.mystery) {
            const span = DATA.mysteryMax - DATA.mysteryMin;
            return { ...it, value: DATA.mysteryMin + Math.floor(Math.random() * (span + 1)) };
        }
        return { ...it };
    });
}

function budgetOf(gs, pid) {
    return gs.budgets[pid] != null ? gs.budgets[pid] : DATA.budget;
}
function ensureBudget(gs, pid) {
    if (gs.budgets[pid] == null) gs.budgets[pid] = DATA.budget;
    return gs.budgets[pid];
}

// 입찰 전에는 미스터리 가치를 숨긴다
function publicItem(it, revealed) {
    return { emoji: it.emoji, name: it.name, mystery: !!it.mystery,
             value: (it.mystery && !revealed) ? null : it.value };
}

function startRound(gs) {
    gs.phase = 'bidding';
    gs.bids = {};
    gs.result = null;
    gs.deadline = Date.now() + BID_MS;
    gs._pushClock = true;
}

// 입찰 마감 → 낙찰/유찰 정산
function resolve(room, gs, ctx) {
    if (gs.phase !== 'bidding') return;
    const item = gs.items[gs.rIndex];
    const players = ctx.connectedPlayers();

    // 미제출자는 0원 입찰(패스)로 처리
    const rows = players.map(p => {
        ensureBudget(gs, p.id);
        const raw = gs.bids[p.id];
        const bid = Math.max(0, Math.min(budgetOf(gs, p.id), parseInt(raw) || 0));
        return { pid: p.id, nick: p.nick, color: p.color, bid };
    });

    const top = rows.reduce((m, r) => Math.max(m, r.bid), 0);
    const topRows = rows.filter(r => r.bid === top && r.bid > 0);

    let winner = null, passed = false, tied = [];
    if (top <= 0) {
        passed = true;                       // 전원 패스 → 유찰, 아무도 지불 안 함
    } else if (topRows.length === 1) {
        winner = topRows[0];
        gs.budgets[winner.pid] = budgetOf(gs, winner.pid) - winner.bid;
        ctx.award(winner.pid, item.value);   // 물건 가치만큼 파티 점수 획득
    } else {
        tied = topRows;                      // 동점 → 유찰이지만 동점자는 지불
        for (const t of tied) gs.budgets[t.pid] = budgetOf(gs, t.pid) - t.bid;
    }

    gs.result = {
        rows: rows.slice().sort((a, b) => b.bid - a.bid),
        winnerPid: winner ? winner.pid : null,
        winnerNick: winner ? winner.nick : null,
        winningBid: winner ? winner.bid : 0,
        tiedNicks: tied.map(t => t.nick),
        tiedBid: tied.length ? top : 0,
        passed,
        value: item.value,
    };
    gs.phase = 'reveal';
    gs.deadline = 0; gs._pushClock = false;
}

function boardOf(room, gs) {
    return room.order.map(id => room.players.get(id))
        .filter(p => p && p.connected)
        .map(p => ({ nick: p.nick, color: p.color, budget: budgetOf(gs, p.id),
                     bidDone: gs.bids[p.id] != null }));
}

module.exports = {
    id: 'auction', name: '숫자 경매', emoji: '💰',
    desc: '예산 배분 · 비공개 입찰 눈치싸움',

    rules: {
        goal: '한정된 예산을 잘 나눠 써서 비싼 물건을 낙찰받으세요',
        steps: [
            '전원 <b>예산 ' + DATA.budget.toLocaleString() + '점</b>으로 시작 (보충 없음)',
            '물건 ' + DATA.items.length + '개와 가치가 <b>처음부터 모두 공개</b>됩니다',
            '매 라운드 폰으로 <b>비공개 입찰</b> → 동시에 공개',
        ],
        scoring: [
            '최고가 <b>단독 1명</b>이 낙찰 — 물건 가치만큼 점수 획득',
            '<b>낙찰자만</b> 입찰금을 냅니다 (진 사람은 안 냄)',
            '💥 <b>동점이면 유찰</b> — 아무도 못 갖는데 동점자는 입찰금을 잃어요',
        ],
        tips: [
            '물건 가치 총합이 예산보다 큽니다 — 전부는 못 가져요',
            '남은 예산이 TV에 공개되니 상대 사정을 읽으세요',
            '100·200 같은 무난한 숫자는 동점 위험! 297처럼 비틀어 보세요',
        ],
    },

    create(room, ctx) {
        const gs = { items: buildItems(), rIndex: 0, phase: 'intro', budgets: {}, bids: {},
                     result: null, deadline: 0, _pushClock: false, budget: DATA.budget };
        gs.total = gs.items.length;
        for (const p of ctx.connectedPlayers()) gs.budgets[p.id] = DATA.budget;
        return gs;
    },

    action(room, gs, player, msg, ctx) {
        if (gs.phase !== 'bidding' || msg.type !== 'bid') return;
        const max = ensureBudget(gs, player.id);
        let amount = parseInt(msg.amount);
        if (!Number.isFinite(amount)) return;
        amount = Math.max(0, Math.min(max, Math.floor(amount)));
        gs.bids[player.id] = amount;          // 마감 전까지 수정 가능
        const connected = ctx.connectedPlayers();
        if (connected.length > 0 && connected.every(p => gs.bids[p.id] != null)) resolve(room, gs, ctx);
    },

    onDeadline(room, gs, ctx) { resolve(room, gs, ctx); },

    advance(room, gs, ctx) {
        if (gs.phase === 'intro') { startRound(gs); return; }
        if (gs.phase === 'bidding') { resolve(room, gs, ctx); return; }
        // reveal → 다음 물건 or 종료
        if (gs.rIndex + 1 >= gs.items.length) { ctx.finish(); return; }
        gs.rIndex++;
        startRound(gs);
    },

    hostView(room, gs) {
        const secLeft = gs._pushClock ? Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000)) : 0;
        const lineup = gs.items.map((it, i) => ({
            ...publicItem(it, i < gs.rIndex || (i === gs.rIndex && gs.phase === 'reveal')),
            done: i < gs.rIndex, current: i === gs.rIndex,
        }));
        const base = { round: gs.rIndex + 1, total: gs.items.length, budget: gs.budget,
                       lineup, players: boardOf(room, gs) };
        if (gs.phase === 'intro') return { screen: 'auc_intro', ...base };
        const item = publicItem(gs.items[gs.rIndex], gs.phase === 'reveal');
        if (gs.phase === 'bidding') {
            const done = base.players.filter(p => p.bidDone).length;
            return { screen: 'auc_bidding', ...base, item, secLeft, done, connected: base.players.length };
        }
        return { screen: 'auc_reveal', ...base, item, result: gs.result,
                 isLast: gs.rIndex + 1 >= gs.items.length };
    },

    playerView(room, gs, player) {
        const myBudget = budgetOf(gs, player.id);
        const lineup = gs.items.map((it, i) => ({
            ...publicItem(it, i < gs.rIndex || (i === gs.rIndex && gs.phase === 'reveal')),
            done: i < gs.rIndex, current: i === gs.rIndex,
        }));
        if (gs.phase === 'intro') {
            return { screen: 'auc_intro', budget: myBudget, lineup, total: gs.items.length };
        }
        const item = publicItem(gs.items[gs.rIndex], gs.phase === 'reveal');
        if (gs.phase === 'bidding') {
            const secLeft = Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000));
            return { screen: 'auc_bid', round: gs.rIndex + 1, total: gs.items.length,
                     item, budget: myBudget, myBid: gs.bids[player.id], secLeft };
        }
        const r = gs.result || {};
        const mine = (r.rows || []).find(x => x.pid === player.id);
        return { screen: 'auc_result', round: gs.rIndex + 1, total: gs.items.length, item,
                 myBid: mine ? mine.bid : 0, budget: myBudget,
                 won: r.winnerPid === player.id,
                 tied: (r.tiedNicks || []).includes(player.nick),
                 passed: !!r.passed, winnerNick: r.winnerNick, value: r.value };
    },
};
