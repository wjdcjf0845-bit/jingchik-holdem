// 🧮 플랍 솔버 조회 — 공개 솔버(TexasSolver)로 미리 풀어 둔 플랍 전략을 찾아 준다.
//   푼 상황: 단일 레이즈 팟(오픈 → BB 콜) 깊이별 · 블라인드 대결 · 3벳 팟 (목록은 tools/solver/spots.js), 양쪽 범위는 이 게임의 범위표.
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
// 턴 카드의 종류(플랍 기준): fl 플러시가 가능해짐 · pr 보드가 페어가 됨 · ov 플랍보다 높은 카드 · cn 플랍 카드 둘 이상과 이어지는 카드 · bl 그 밖(블랭크)
function turnClass(flop, card) {
    const fs3 = flop.slice(0, 3), s = su(card), v = rv(card), fv = fs3.map(rv);
    const same = fs3.filter(c => su(c) === s).length;
    if (same >= 2) return 'fl';
    if (fv.includes(v)) return 'pr';
    if (v > Math.max(...fv)) return 'ov';
    if (fv.filter(x => Math.abs(x - v) <= 2).length >= 2) return 'cn';
    return 'bl';
}
const TURN_KO = { fl: '플러시가 가능해진 턴', pr: '보드가 페어가 된 턴', ov: '플랍보다 높은 턴 카드', cn: '이어지는 턴 카드', bl: '블랭크 턴' };
function parseBoardKey(k) { return [k.slice(0, 2), k.slice(2, 4), k.slice(4, 6)]; }
function nearestBoard(board, keys) {
    const t = texture(board);
    let best = null, bd = Infinity;
    keys.forEach(k => { const d = distance(t, texture(parseBoardKey(k))); if (d < bd) { bd = d; best = k; } });
    return best ? { key: best, dist: Math.round(bd * 10) / 10 } : null;
}

const BASE22 = new Set(['As7d2c', 'AsKd6h', 'Ah9h8d', 'AdJsTc', 'Ks7d2c', 'KhQh5d', 'Kd9s8s', 'Qs6d3c', 'QdJh9h', 'Js8d4c', 'JhTh6d', 'Td9s5c', '9h8h6d', '8s5d2c', '7d6s5s', '6s4d3c', 'Ks8d8c', '9s9d4c', 'As5d5c', 'QsQd7c', 'Kh9h4h', '8h6h3h']);
let DATA = null;
function load() {
    if (DATA !== null) return DATA;
    // 자료는 압축해서 싣는다(숫자 표라 8분의 1쯤으로 줄어든다)
    try { DATA = JSON.parse(require('zlib').gunzipSync(require('fs').readFileSync(require('path').join(__dirname, 'solverdata.json.gz'))).toString('utf8')); } catch (e) { DATA = false; }
    return DATA;
}
const SPOT_KO = { btn: '뒷자리 오픈 → BB 콜', utg: '앞자리 오픈 → BB 콜', hu: '헤즈업 버튼 오픈 → BB 콜',
    btn40: '뒷자리 오픈 → BB 콜 · 40bb', utg40: '앞자리 오픈 → BB 콜 · 40bb', hu40: '헤즈업 버튼 오픈 → BB 콜 · 40bb',
    btn25: '뒷자리 오픈 → BB 콜 · 25bb', utg25: '앞자리 오픈 → BB 콜 · 25bb', hu25: '헤즈업 버튼 오픈 → BB 콜 · 25bb',
    co: 'CO 오픈 → BB 콜', co40: 'CO 오픈 → BB 콜 · 40bb', co25: 'CO 오픈 → BB 콜 · 25bb', sbb: 'SB 오픈 → BB 콜', sbb40: 'SB 오픈 → BB 콜 · 40bb', sbb25: 'SB 오픈 → BB 콜 · 25bb', tbo: '3벳 팟 · 3벳한 쪽이 먼저 행동', tbi: '3벳 팟 · 3벳한 쪽이 나중에 행동', hutb: '헤즈업 3벳 팟' };
const MIN_W = 3;      // 그 종류의 패가 범위에 이만큼(콤보)은 있어야 쓴다

// q: { spot: 'btn'|'utg'|'hu', node, hand, board } → { freqs, labels, board(대표), dist, bucket, n } 또는 null
//   node: oop_root [체크, 벳] · ip_cbet [체크, 작은 벳, 큰 벳] · oop_vs_s / oop_vs_b / ip_vs_s / ip_vs_b / ip_xr [폴드, 콜, 레이즈]
function lookup(q, data) {
    const D = data || load();
    if (!D || !q) return null;
    //   자료가 아직 없는 상황은 가까운 것으로 대신한다: CO → 뒷자리(btn), 40bb → 100bb. (25bb 는 너무 달라 대신하지 않는다)
    const cands = [q.spot, String(q.spot || '').replace(/^co/, 'btn')];
    cands.slice().forEach(c => { if (/40$/.test(c)) cands.push(c.slice(0, -2)); });
    const spot = cands.find(c => c && D[c]) || null;
    if (!spot) return null;
    // q.baseOnly: 처음 풀었던 대표 22보드만 쓴다(보드를 늘린 효과를 재는 맞대결용)
    const near = nearestBoard(q.board, q.baseOnly ? Object.keys(D[spot]).filter(k => BASE22.has(k)) : Object.keys(D[spot]));
    if (!near) return null;
    const node = (D[spot][near.key] || {})[q.node];
    if (!node) return null;
    const bk = bucket(q.hand, q.board);
    if (!bk) return null;
    let row = node[bk.key], level = 'full';
    if (!row || row[row.length - 1] < MIN_W) { row = node[bk.made + '|*']; level = 'made'; }
    if (!row || row[row.length - 1] < MIN_W) return null;
    return { freqs: row.slice(0, -1), n: row[row.length - 1], level, bucket: bk, board: near.key, dist: near.dist, spot, spotName: SPOT_KO[spot] || spot, table: tableOf(node, bk, MIN_W) };
}
// 그 노드의 "패 종류별 빈도표" — 학습 화면에 보여 준다. 만든 패 9종(강한 순) + 내 패가 드로우면 그 줄을 따로.
const MADE_ORDER = ['mon', 'op', 'tp1', 'tp2', 'mp', 'lp', 'ah', 'oc', 'air'];
function tableOf(node, bk, minW) {
    const rows = [];
    MADE_ORDER.forEach(m => {
        const r = node[m + '|*'];
        if (!r || r[r.length - 1] < minW) return;
        rows.push({ name: MADE_KO[m], f: r.slice(0, -1), me: !!bk && bk.made === m && (bk.draw === '-' || !node[bk.key] || node[bk.key][node[bk.key].length - 1] < minW) });
        if (bk && bk.made === m && bk.draw !== '-') {
            const d = node[bk.key];
            if (d && d[d.length - 1] >= minW) rows.push({ name: '└ ' + DRAW_KO[bk.draw], f: d.slice(0, -1), me: true, sub: true });
        }
    });
    return rows;
}

// 턴 조회. q: { spot, line('xx' 플랍 체크-체크 · 'xbc_s'/'xbc_b' 체크-벳-콜), node, hand, board(4장) }
//   node: t_oop [체크, 벳] · t_ip [체크, 벳] · t_oop_vs / t_ip_vs [폴드, 콜, 레이즈]
//   플랍은 가장 비슷한 대표 보드로, 턴 카드는 종류(turnClass)로, 패는 4장 보드에서의 패 종류로 바꿔 찾는다.
const MIN_W_TURN = 8;
function lookupTurn(q, data) {
    const D = data || load();
    if (!D || !q || !q.board || q.board.length !== 4) return null;
    const cands = [q.spot, String(q.spot || '').replace(/^co/, 'btn')];
    cands.slice().forEach(c => { if (/40$/.test(c)) cands.push(c.slice(0, -2)); });
    const flop = q.board.slice(0, 3), cls = turnClass(flop, q.board[3]);
    for (const spot of cands) {
        if (!spot || !D[spot]) continue;
        const keys = Object.keys(D[spot]).filter(k => { const t = D[spot][k].turn; return t && t[q.line] && t[q.line][cls] && t[q.line][cls][q.node]; });
        if (!keys.length) continue;
        const near = nearestBoard(flop, keys);
        const node = D[spot][near.key].turn[q.line][cls][q.node];
        const bk = bucket(q.hand, q.board);
        if (!bk) return null;
        let row = node[bk.key], level = 'full';
        if (!row || row[row.length - 1] < MIN_W_TURN) { row = node[bk.made + '|*']; level = 'made'; }
        if (!row || row[row.length - 1] < MIN_W_TURN) return null;
        return { freqs: row.slice(0, -1), n: row[row.length - 1], level, bucket: bk, board: near.key, dist: near.dist, spot, spotName: SPOT_KO[spot] || spot, turnClass: cls, line: q.line, table: tableOf(node, bk, MIN_W_TURN) };
    }
    return null;
}

module.exports = { load, lookupTurn, turnClass, TURN_KO, bucket, bucketKo, texture, distance, nearestBoard, lookup, parseBoardKey, MADE_KO, DRAW_KO, SPOT_KO, MIN_W };
