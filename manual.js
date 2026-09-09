// ════════════════════════════════════════════════════════════
// 승강설비 현장조회 — /manual 경로에 마운트되는 라우터
//
// server.js 에서:
//     app.use('/manual', require('./manual'));
//
// 환경변수 MANUAL_USER / MANUAL_PASS 가 없으면 라우터가 비활성화되고
// /manual 접근 시 503 을 돌려줍니다(사내 문서 무방비 공개 방지).
// 포커 게임 쪽에는 인증이 걸리지 않습니다.
// ════════════════════════════════════════════════════════════
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const BASE = path.join(__dirname, 'manual');
const DATA_DIR = path.join(BASE, 'data');

const USER = process.env.MANUAL_USER;
const PASS = process.env.MANUAL_PASS;
const ENABLED = !!(USER && PASS);

if (!ENABLED) {
    console.warn('[manual] MANUAL_USER / MANUAL_PASS 미설정 — /manual 비활성화');
    router.use((req, res) => res.status(503).send('매뉴얼 서비스가 설정되지 않았습니다.'));
    module.exports = router;
    return;
}

// ── 접근 제어 (이 라우터 전체) ────────────────────────────────
router.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
        const [u, p] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
        if (u === USER && p === PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="lift-manual", charset="UTF-8"');
    res.status(401).send('인증이 필요합니다.');
});

// ── 데이터 적재 ──────────────────────────────────────────────
function loadJSON(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

const index = loadJSON(path.join(DATA_DIR, 'index.json'), {
    builtAt: null, codes: [], procedures: [], manuals: [], equipment: [],
});

const docsDir = path.join(DATA_DIR, 'docs');
const docs = [];
if (fs.existsSync(docsDir)) {
    for (const f of fs.readdirSync(docsDir).filter(f => f.endsWith('.json'))) {
        const d = loadJSON(path.join(docsDir, f), null);
        if (d && d.text) docs.push(d);
    }
}
console.log(`[manual] 코드 ${index.codes.length}건 / 절차 ${index.procedures.length}건 / 원문 ${docs.length}건 적재`);

const norm = s => (s || '').toLowerCase().replace(/[\s\-_·.]/g, '');

// ── API ─────────────────────────────────────────────────────
router.get('/api/index', (req, res) => {
    res.set('Cache-Control', 'no-cache').json(index);
});

router.get('/api/search', (req, res) => {
    const raw = (req.query.q || '').trim();
    if (raw.length < 2) return res.json({ q: raw, hits: [] });
    const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];

    for (const doc of docs) {
        const hay = doc.text.toLowerCase();
        if (!terms.every(t => hay.includes(t))) continue;
        const snippets = [];
        let from = 0;
        while (snippets.length < 3) {
            const at = hay.indexOf(terms[0], from);
            if (at === -1) break;
            const s = Math.max(0, at - 90);
            snippets.push(doc.text.slice(s, at + 190).replace(/\s+/g, ' ').trim());
            from = at + terms[0].length;
        }
        hits.push({ id: doc.id, title: doc.title, source: doc.source, tags: doc.tags, kind: doc.kind, snippets });
        if (hits.length >= 60) break;
    }
    res.json({ q: raw, hits });
});

router.get('/api/doc/:id', (req, res) => {
    const doc = docs.find(d => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: '문서를 찾을 수 없습니다.' });
    res.json(doc);
});

router.get('/api/equipment/:key', (req, res) => {
    const key = norm(req.params.key);
    res.json({
        key: req.params.key,
        codes: index.codes.filter(c => (c.tags || []).some(t => norm(t) === key)),
        manuals: index.manuals.filter(m => (m.tags || []).some(t => norm(t) === key)),
        procedures: index.procedures.filter(p => (p.tags || []).some(t => norm(t) === key)),
    });
});

// ── 정적 파일 ────────────────────────────────────────────────
// 클라이언트가 'api/index' 같은 상대경로로 호출하므로 반드시
// /manual/ (뒤 슬래시 포함) 로 열려야 합니다. 없으면 리다이렉트.
router.get('/', (req, res, next) => {
    if (!req.originalUrl.endsWith('/')) return res.redirect(301, req.originalUrl + '/');
    next();
});

router.use(express.static(path.join(BASE, 'public'), { maxAge: '1h' }));

module.exports = router;
