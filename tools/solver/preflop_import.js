// 솔버에 딸려 온 프리플랍 범위(ranges/qb_ranges/100bb 2.5x 500rake — 6인 100bb, 2.5bb 오픈, 레이크 있는 캐시 게임의 솔버 해)를
// 게임이 쓰는 표로 바꾼다 → lib/preflopdata.json.gz
//   사용: node tools/solver/preflop_import.js "<…/ranges/qb_ranges/100bb 2.5x 500rake>"
//   열쇠: "지금까지의 행동>내 자리". 행동은 자리:R(레이즈)·C(콜)·F(이미 들어온 사람이 접음)를 순서대로. 예) "BTN:R>BB" · "CO:R,BTN:C>SB" · "BTN:R,BB:R>BTN"
//   값: { 패: [레이즈 %, 콜 %] } (둘 다 0 이면 뺀다)
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const ROOT = process.argv[2];
const POS = new Set(['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB']);
const files = [];
(function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach(e => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.txt')) files.push(p); }); })(ROOT);
const out = {}, sizes = {};
files.forEach(f => {
    const tok = path.basename(f, '.txt').split('_');
    // 토큰: 자리, 행동, 자리, 행동 … 마지막 쌍이 "내 자리, 내 행동"
    const pairs = [];
    for (let i = 0; i < tok.length; i += 2) { if (!POS.has(tok[i]) || tok[i + 1] == null) return; pairs.push([tok[i], tok[i + 1]]); }
    const [hero, act] = pairs.pop();
    const kind = a => (a === 'Call' ? 'C' : a === 'FOLD' ? 'F' : 'R');
    const key = pairs.map(p => p[0] + ':' + kind(p[1])).join(',') + '>' + hero;
    const k = kind(act);
    if (k === 'R') (sizes[key] = sizes[key] || new Set()).add(act);
    const T = (out[key] = out[key] || {});
    fs.readFileSync(f, 'utf8').trim().split(',').forEach(x => {
        const [h, v] = x.split(':'); if (!h || v == null) return;
        const code = h.trim(), p = Math.round(Number(v) * 100);
        const row = (T[code] = T[code] || [0, 0]);
        if (k === 'R') row[0] += p; else if (k === 'C') row[1] += p;
    });
});
Object.values(out).forEach(T => Object.keys(T).forEach(c => { T[c][0] = Math.min(100, T[c][0]); T[c][1] = Math.min(100 - T[c][0], T[c][1]); if (!T[c][0] && !T[c][1]) delete T[c]; }));
const meta = {}; Object.keys(sizes).forEach(k => { meta[k] = [...sizes[k]].join('/'); });
const outFile = path.join(__dirname, '../../lib/preflopdata.json.gz');
fs.writeFileSync(outFile, zlib.gzipSync(Buffer.from(JSON.stringify({ tables: out, sizes: meta })), { level: 9 }));
console.log('상황', Object.keys(out).length, '·', Math.round(fs.statSync(outFile).size / 1024), 'KB');
