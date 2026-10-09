// 🧮 플랍 솔버 조회 — 공개 솔버(TexasSolver)로 미리 풀어 둔 플랍 전략을 찾아 준다.
//   푼 상황: 단일 레이즈 팟(오픈 2.5bb → BB 콜, 100bb), 양쪽 범위는 이 게임의 범위표.
//   풀어 둔 보드는 대표 22종뿐이라, 실제 보드는 "가장 비슷한 대표 보드"로, 실제 패는 "그 보드에서의 패 종류"(탑페어·드로우…)로 바꿔 조회한다.
//   즉 솔버의 정확한 답이 아니라 "비슷한 보드에서 같은 종류의 패가 치는 평균 빈도"다 — 그 한계는 화면에도 적는다.
//   자료: lib/solverdata.json (scratch/solver_extract.js 가 솔버 출력에서 뽑아 만든다)
const RK = '23456789TJQKA';
const rv = c => RK.indexOf(c[0] === '1' ? 'T' : c[0]);
const su = c => c[c.length - 1];

// ── 패 종류: 만든 패 | 드로우 ──
const MADE_KO = { mon: '투페어 이상', op: '오버페어', tp1: '탑페어(좋은 키커)', tp2: '탑페어(약한 키커)', mp: '미들 페어', lp: '낮은 페어', ah: '에이스 하이', oc: '오버카드 두 장', air: '아무것도 없음' };
const DRAW_KO = { cd: '콤보 드로우', fd: '플러시 드로우', oe: '양방 스트레이트 드로우', gs: '거트샷', bd: '백도어 플러시 드로우', '-': '' };

function straightInfo(vals) {
    // vals: 중복 없는 랭크 값들(에이스는 12, 휠용으로 -1 도 넣는다). 4장으로 만드는 스트레이트 드로우를 본다.
    const set = new Set(vals); if (set.has(12)) set.add(-1);
    let made = false, outs = new Set();
    for (let lo = -1; lo <= 8; lo++) {
        const need = [lo, lo + 1, lo + 2, lo + 3, lo + 4];
        const have = need.filter(x => set.has(x));
        if (have.length === 5) made = true;
        else if (have.length === 4) outs.add(need.find(x => !set.has(x)));
    }
    return { made, outs: outs.size };       // outs 2 이상 = 양방(또는 더블 거트샷), 1 = 거트샷
}
function bucket(hand, board) {
    if (!hand || hand.length !== 2 || !board || board.length < 3) return null;
    const h = hand.map(rv), b = board.map(rv).sort((x, y) => y - x);
    const all = hand.concat(board);
    const cnt = {}; all.forEach(c => { cnt[rv(c)] = (cnt[rv(c)] || 0) + 1; });
    const bcnt = {}; board.forEach(c => { bcnt[rv(c)] = (bcnt[rv(c)] || 0) + 1; });
    const boardPaired = Object.values(bcnt).some(n => n >= 2);
    const suits = {}; all.forEach(c => { suits[su(c)] = (suits[su(c)] || 0) + 1; });
    const mySuits = new Set(hand.map(su));
    const flush = Object.keys(suits).some(s => suits[s] >= 5 && mySuits.has(s));
    const st = straightInfo(all.map(rv));
    const pocket = h[0] === h[1];
    const pairsWithBoard = h.filter(x => bcnt[x]).length;        // 보드와 맞은 내 카드 수
    const trips = h.some(x => cnt[x] >= 3);                        // 내 카드가 낀 트립스·셋
    const twoPair = !pocket && pairsWithBoard === 2;               // 내 두 장이 모두 맞음
    const top = b[0], second = b.find(x => x < top);
    let made;
    if (flush || st.made || trips || twoPair) made = 'mon';
    else if (pocket) made = h[0] > top ? 'op' : (second == null || h[0] > second) ? 'mp' : 'lp';
    else if (pairsWithBoard === 1) {
        const pr = h.find(x => bcnt[x]), kick = h.find(x => !bcnt[x]);
        if (pr === top) made = kick >= 9 ? 'tp1' : 'tp2';             // 키커 J 이상
        else made = pr === second ? 'mp' : 'lp';
    } else if (Math.max(h[0], h[1]) === 12) made = 'ah';
    else if (h[0] > top && h[1] > top) made = 'oc';
    else made = 'air';
    if (made === 'mon') return { made, draw: '-', key: 'mon|-' };
    // 드로우 (보드가 3장일 때만 백도어를 본다)
    const fdSuit = Object.keys(suits).find(s => suits[s] === 4 && mySuits.has(s));
    const sd = st.outs >= 2 ? 'oe' : st.outs === 1 ? 'gs' : null;
    // 스트레이트 드로우는 내 카드가 끼어 있어야 한다(보드만으로 4장이 이어진 경우 제외)
    const bst = straightInfo(board.map(rv));
    const mySd = sd && !(bst.outs >= st.outs) ? sd : null;
    let draw = '-';
    if (fdSuit && mySd) draw = 'cd';
    else if (fdSuit) draw = 'fd';
    else if (mySd) draw = mySd;
    else if (board.length === 3 && Object.keys(suits).some(s => suits[s] === 3 && hand.filter(c => su(c) === s).length === 2)) draw = 'bd';
    void boardPaired;
    return { made, draw, key: made + '|' + draw };
}
function bucketKo(bk) { return bk ? MADE_KO[bk.made] + (DRAW_KO[bk.draw] ? ' + ' + DRAW_KO[bk.draw] : '') : ''; }

// ── 보드 성격 ──
function texture(board) {
    const v = board.slice(0, 3).map(rv).sort((x, y) => y - x), s = board.slice(0, 3).map(su);
    const nSuit = new Set(s).size;                        // 1 모노톤 · 2 투톤 · 3 레인보우
    const paired = v[0] === v[1] || v[1] === v[2];
    const span = v[0] - v[2];
    return { hi: v[0], mid: v[1], lo: v[2], suit: nSuit, paired, conn: paired ? 0 : (span <= 4 ? 2 : span <= 6 ? 1 : 0) };
}
function distance(a, b) {
    return Math.abs(a.hi - b.hi) * 1.0 + Math.abs(a.mid - b.mid) * 0.5 + Math.abs(a.lo - b.lo) * 0.3
        + (a.paired !== b.paired ? 6 : 0) + Math.abs(a.suit - b.suit) * (a.suit === 1 || b.suit === 1 ? 5 : 2.5) + Math.abs(a.conn - b.conn) * 1.5;
}
function parseBoardKey(k) { return [k.slice(0, 2), k.slice(2, 4), k.slice(4, 6)]; }
function nearestBoard(board, keys) {
    const t = texture(board);
    let best = null, bd = Infinity;
    keys.forEach(k => { const d = distance(t, texture(parseBoardKey(k))); if (d < bd) { bd = d; best = k; } });
    return best ? { key: best, dist: Math.round(bd * 10) / 10 } : null;
}

let DATA = null;
function load() {
    if (DATA !== null) return DATA;
    try { DATA = require('./solverdata.json'); } catch (e) { DATA = false; }
    return DATA;
}
const SPOT_KO = { btn: '뒷자리 오픈 → BB 콜', utg: '앞자리 오픈 → BB 콜', hu: '헤즈업 버튼 오픈 → BB 콜' };
const MIN_W = 3;      // 그 종류의 패가 범위에 이만큼(콤보)은 있어야 쓴다

// q: { spot: 'btn'|'utg'|'hu', node, hand, board } → { freqs, labels, board(대표), dist, bucket, n } 또는 null
//   node: oop_root [체크, 벳] · ip_cbet [체크, 작은 벳, 큰 벳] · oop_vs_s / oop_vs_b / ip_vs_s / ip_vs_b / ip_xr [폴드, 콜, 레이즈]
function lookup(q, data) {
    const D = data || load();
    if (!D || !q || !D[q.spot]) return null;
    const near = nearestBoard(q.board, Object.keys(D[q.spot]));
    if (!near) return null;
    const node = (D[q.spot][near.key] || {})[q.node];
    if (!node) return null;
    const bk = bucket(q.hand, q.board);
    if (!bk) return null;
    let row = node[bk.key], level = 'full';
    if (!row || row[row.length - 1] < MIN_W) { row = node[bk.made + '|*']; level = 'made'; }
    if (!row || row[row.length - 1] < MIN_W) return null;
    return { freqs: row.slice(0, -1), n: row[row.length - 1], level, bucket: bk, board: near.key, dist: near.dist, spotName: SPOT_KO[q.spot] || q.spot };
}

module.exports = { bucket, bucketKo, texture, distance, nearestBoard, lookup, parseBoardKey, MADE_KO, DRAW_KO, SPOT_KO, MIN_W };
