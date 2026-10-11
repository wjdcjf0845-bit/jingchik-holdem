// 프리플랍 올인 승률표 만들기: 패 종류 169 × 169 의 "쇼다운까지 갔을 때 승률" + 두 종류가 동시에 나올 수 있는 조합 수
//   사용: node tools/pfeq_build.js [쌍마다 표본 수=4000]   → lib/pfeq.bin.gz
//   파일: Uint16 승률(×65535) 169×169 줄 다음에 Uint8 조합 수 169×169 줄. 패 순서는 lib/ranges.js 의 ALL.
//   승률은 몬테카를로(표본 4000 이면 한 쌍의 오차 ±0.8%p). 범위끼리의 승률은 여러 쌍의 평균이라 훨씬 정확하다.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const Ranges = require('../lib/ranges');
const N = Number(process.argv[2] || 4000);
const RK = '23456789TJQKA';

// 7장 평가: 값이 클수록 강하다. 카드는 0~51 (rank = c >> 2, suit = c & 3)
function eval7(cs) {
    const cnt = new Int8Array(13), su = [0, 0, 0, 0], sn = [0, 0, 0, 0];
    let mask = 0;
    for (let i = 0; i < 7; i++) { const r = cs[i] >> 2, s = cs[i] & 3; cnt[r]++; su[s] |= 1 << r; sn[s]++; mask |= 1 << r; }
    const straight = m => { for (let h = 12; h >= 4; h--) if (((m >> (h - 4)) & 31) === 31) return h; return (m & 0x100f) === 0x100f ? 3 : -1; };
    for (let s = 0; s < 4; s++) if (sn[s] >= 5) {
        const sh = straight(su[s]);
        if (sh >= 0) return (8 << 20) | sh;
        let v = 0, k = 0; for (let r = 12; r >= 0 && k < 5; r--) if (su[s] & (1 << r)) { v = v * 13 + r; k++; }
        return (5 << 20) | v;
    }
    let q = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
    for (let r = 12; r >= 0; r--) {
        if (cnt[r] === 4) q = r;
        else if (cnt[r] === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
        else if (cnt[r] === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
    }
    const kick = (n, a, b) => { let v = 0, k = 0; for (let r = 12; r >= 0 && k < n; r--) if (cnt[r] && r !== a && r !== b) { v = v * 13 + r; k++; } return v; };
    if (q >= 0) return (7 << 20) | (q * 13 + kick(1, q, -1));
    if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return (6 << 20) | (t1 * 13 + Math.max(t2, p1));
    const sh = straight(mask);
    if (sh >= 0) return (4 << 20) | sh;
    if (t1 >= 0) return (3 << 20) | (t1 * 169 + kick(2, t1, -1));
    if (p1 >= 0 && p2 >= 0) return (2 << 20) | (p1 * 169 + p2 * 13 + kick(1, p1, p2));
    if (p1 >= 0) return (1 << 20) | (p1 * 2197 + kick(3, p1, -1));
    return kick(5, -1, -1);
}

// 패 종류 → 실제 두 장의 조합 목록
function combosOf(code) {
    const a = RK.indexOf(code[0]), b = RK.indexOf(code[1]), out = [];
    if (code.length === 2) { for (let s = 0; s < 4; s++) for (let t = s + 1; t < 4; t++) out.push([a * 4 + s, a * 4 + t]); }
    else if (code[2] === 's') { for (let s = 0; s < 4; s++) out.push([a * 4 + s, b * 4 + s]); }
    else { for (let s = 0; s < 4; s++) for (let t = 0; t < 4; t++) if (s !== t) out.push([a * 4 + s, b * 4 + t]); }
    return out;
}

if (require.main === module) {
    const ALL = Ranges.ALL, C = ALL.map(combosOf), n = ALL.length;
    const eq = new Uint16Array(n * n), w = new Uint8Array(n * n);
    let seed = 20261011; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const t0 = Date.now(), deck = new Int8Array(52), h7 = new Int8Array(7), v7 = new Int8Array(7);
    for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) {
            const pairs = [];
            C[i].forEach(x => C[j].forEach(y => { if (x[0] !== y[0] && x[0] !== y[1] && x[1] !== y[0] && x[1] !== y[1]) pairs.push([x, y]); }));
            w[i * n + j] = w[j * n + i] = pairs.length;
            if (!pairs.length) { eq[i * n + j] = eq[j * n + i] = 32768; continue; }
            let win = 0;
            for (let k = 0; k < N; k++) {
                const [x, y] = pairs[k % pairs.length];
                let m = 0; for (let c = 0; c < 52; c++) if (c !== x[0] && c !== x[1] && c !== y[0] && c !== y[1]) deck[m++] = c;
                for (let b = 0; b < 5; b++) { const r = b + Math.floor(rnd() * (m - b)), tmp = deck[b]; deck[b] = deck[r]; deck[r] = tmp; h7[b] = deck[b]; v7[b] = deck[b]; }
                h7[5] = x[0]; h7[6] = x[1]; v7[5] = y[0]; v7[6] = y[1];
                const a = eval7(h7), bb = eval7(v7);
                win += a > bb ? 1 : a === bb ? 0.5 : 0;
            }
            const e = win / N;
            eq[i * n + j] = Math.round(e * 65535); eq[j * n + i] = Math.round((1 - e) * 65535);
        }
        if (i % 20 === 0) console.log(i + '/' + n, Math.round((Date.now() - t0) / 1000) + 's');
    }
    const buf = Buffer.concat([Buffer.from(eq.buffer), Buffer.from(w.buffer)]);
    const out = path.join(__dirname, '../lib/pfeq.bin.gz');
    fs.writeFileSync(out, zlib.gzipSync(buf, { level: 9 }));
    const at = (a, b) => (eq[ALL.indexOf(a) * n + ALL.indexOf(b)] / 655.35).toFixed(1);
    console.log('완료', Math.round(fs.statSync(out).size / 1024) + 'KB', '· AA vs KK', at('AA', 'KK'), '· AKs vs QQ', at('AKs', 'QQ'), '· AKo vs 22', at('AKo', '22'), '· 72o vs AA', at('72o', 'AA'), '· JTs vs AKo', at('JTs', 'AKo'));
}
module.exports = { eval7, combosOf };
