// HRC(Holdem Resources Calculator)로 직접 푼 대회용 프리플랍 결과를 게임이 쓰는 표로 바꾼다 → lib/preflop_mtt.json.gz
//   HRC 에서: Hand → Export Strategies → Complete Export → zip 저장 → 풀어서 그 폴더를 넘긴다.
//   사용: node tools/hrc_import.js <깊이bb>=<폴더> [<깊이bb>=<폴더> …]     예) node tools/hrc_import.js 25=C:/Poker/out/x25 20=C:/Poker/out/x20
//   열쇠: lib/preflopdata.json.gz 와 같다 — "지금까지의 행동>내 자리". 행동은 자리:R(레이즈)·A(올인)·C(콜)·F(들어왔다가 접음). 아직 안 들어온 사람의 폴드는 적지 않는다.
//   값: { 패: [레이즈 %(올인 포함), 콜 %, 그중 올인 %] } — 전부 0 인 패는 뺀다.
//   이 자료는 우리가 직접 푼 계산 결과다(구조: 6인 · BB 앤티 · 스택 동일). 설정은 meta 에 같이 남긴다.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const Ranges = require('../lib/ranges');
const POSN = { 6: ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'] };

function importDir(dir) {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    const stacks = settings.handdata.stacks, bb = settings.handdata.blinds[0] > settings.handdata.blinds[1] ? settings.handdata.blinds[0] : settings.handdata.blinds[1];
    const POS = POSN[stacks.length]; if (!POS) throw new Error('6인만 지원: ' + stacks.length);
    const tables = {}, reach = {};
    fs.readdirSync(path.join(dir, 'nodes')).forEach(f => {
        const n = JSON.parse(fs.readFileSync(path.join(dir, 'nodes', f), 'utf8'));
        if (n.street !== 0 || !n.actions || !n.hands) return;
        // 지금까지의 행동 → 열쇠
        const inPot = new Set(), tok = []; let hi = bb;
        n.sequence.forEach(s => {
            const p = POS[s.player];
            if (s.type === 'F') { if (inPot.has(s.player)) tok.push(p + ':F'); return; }
            const allin = s.amount >= stacks[s.player] - 1;
            if (s.type === 'R') { tok.push(p + (allin ? ':A' : ':R')); hi = s.amount; }
            else tok.push(p + (allin && s.amount > hi ? ':A' : ':C'));
            inPot.add(s.player);
        });
        const key = tok.join(',') + '>' + POS[n.player];
        const T = {}; let w = 0;
        Ranges.ALL.forEach(code => {
            const h = n.hands[code]; if (!h) return;
            let r = 0, c = 0, a = 0;
            n.actions.forEach((act, i) => {
                const p = h.played[i] || 0;
                if (act.type === 'R') { r += p; if (act.amount >= stacks[n.player] - 1) a += p; }
                else if (act.type === 'C') c += p;
            });
            w += h.weight * Ranges.combos(code);
            const R = Math.round(r * 100), C = Math.min(100 - R, Math.round(c * 100)), A = Math.min(R, Math.round(a * 100));
            if (R || C) T[code] = A ? [R, C, A] : [R, C];
        });
        // 같은 열쇠가 둘이면(레이즈 크기만 다른 가지) 더 자주 오는 쪽을 쓴다
        if (tables[key] && reach[key] >= w) return;
        tables[key] = T; reach[key] = w;
    });
    const pf = settings.treeconfig.preflop.settings;
    return { tables, meta: { players: stacks.length, stackBB: stacks[0] / bb, ante: settings.handdata.anteType, open: pf.SIZES_OPEN_OTHERS, threeBetIP: pf.SIZES_3BET_IP, threeBetBB: pf.SIZES_3BET_BB_VS_OTHER, engine: settings.engine.type } };
}

if (require.main === module) {
    const out = {};
    process.argv.slice(2).forEach(a => {
        const [d, dir] = a.split('=');
        out[d] = importDir(dir);
        const T = out[d].tables, w = k => { const t = T[k]; if (!t) return '없음'; let r = 0, c = 0, j = 0; Ranges.ALL.forEach(x => { const f = t[x] || [0, 0, 0], n = Ranges.combos(x); r += f[0] * n; c += f[1] * n; j += (f[2] || 0) * n; }); return `레이즈 ${(r / 1326).toFixed(1)}% (그중 올인 ${(j / 1326).toFixed(1)}) · 콜 ${(c / 1326).toFixed(1)}%`; };
        console.log(`[${d}bb] 상황 ${Object.keys(T).length}개`, JSON.stringify(out[d].meta));
        ['>UTG', '>MP', '>CO', '>BTN', '>SB', 'UTG:R>BB', 'CO:R>BTN', 'BTN:R>SB', 'BTN:R>BB', 'SB:R>BB', 'SB:C>BB', 'BTN:R,BB:R>BTN', 'CO:R,BTN:R>CO', 'BTN:R,SB:A>BTN'].forEach(k => console.log('  ', k.padEnd(18), w(k)));
    });
    const file = path.join(__dirname, '../lib/preflop_mtt.json.gz');
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }));
    console.log('저장', Math.round(fs.statSync(file).size / 1024) + 'KB');
}
module.exports = { importDir };
