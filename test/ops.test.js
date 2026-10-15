const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');
const Ops = require('../lib/ops');

test('운영: 새벽 4시가 지나고 오늘 백업이 없을 때만 백업한다 · 30개만 남긴다 · 백업을 풀면 원본과 같다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-')), src = path.join(dir, 'poker_stats.json'), bdir = path.join(dir, 'backup');
    fs.writeFileSync(src, JSON.stringify({ 철수: { chips: 1234 } }));
    const at = h => new Date(2026, 9, 16, h, 5);
    assert.strictEqual(Ops.backupDue(bdir, at(3)), false, '4시 전에는 안 한다');
    assert.strictEqual(Ops.backupDue(bdir, at(4)), true);
    const out = Ops.backupNow(src, bdir, at(4));
    assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(fs.readFileSync(out))), { 철수: { chips: 1234 } });
    assert.strictEqual(Ops.backupDue(bdir, at(23)), false, '같은 날 두 번은 안 한다');
    for (let d = 1; d <= 35; d++) fs.writeFileSync(path.join(bdir, `poker_stats-2026-08-${String(d).padStart(2, '0')}.json.gz`), 'x');
    Ops.pruneBackups(bdir, 30);
    const left = fs.readdirSync(bdir).sort();
    assert.strictEqual(left.length, 30);
    assert.ok(left.includes('poker_stats-2026-10-16.json.gz'), '가장 최근 것은 남는다');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('운영: 같은 종류의 알림은 10분에 한 번만', () => {
    const ok = Ops.makeLimiter(600000);
    assert.strictEqual(ok('a', 0), true);
    assert.strictEqual(ok('a', 1000), false);
    assert.strictEqual(ok('b', 1000), true, '다른 종류는 따로');
    assert.strictEqual(ok('a', 600001), true);
});

test('운영: 비정상 종료 표식 — 정상 종료하면 다음 시작에 알리지 않고, 표식이 남아 있으면 알린다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-')), logs = [];
    const mk = () => Ops.createOps({ dataDir: dir, dataFile: path.join(dir, 'x.json'), flush() {}, topic: '', log: m => logs.push(m) });
    const a = mk(); assert.strictEqual(a.crashedBefore, false);
    const b = mk(); assert.strictEqual(b.crashedBefore, true, '첫 번째가 정상 종료하지 않았다');
    assert.ok(logs.some(m => /갑자기 꺼졌다가/.test(m)));
    b.cleanExit();
    const c = mk(); assert.strictEqual(c.crashedBefore, false);
    c.cleanExit(); fs.rmSync(dir, { recursive: true, force: true });
});
