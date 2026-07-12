'use strict';
// ════════════════════════════════════════════════════════════════
//  storage.js — 전적 DB 원격 영속화 어댑터 (Turso / libSQL)
//
//  왜: Render 무료 플랜은 영구 디스크가 없어 재배포·재시작마다 로컬 파일
//  (poker_stats.json)이 초기화된다. 환경변수로 Turso(무료 SQLite 클라우드)를
//  연결하면 전적/뱅크롤이 배포와 무관하게 보존된다.
//
//  설계 (이중 저장):
//   - 로컬 JSON 파일 저장은 그대로 유지 (동기·크래시 안전·로컬 개발용)
//   - TURSO_DATABASE_URL 이 설정된 경우에만 원격 저장 활성화
//   - 저장 형태: storage(key, value) 테이블에 전체 JSON 블롭 1행 upsert
//     (기존 파일 저장과 동일한 의미론 — 단순·원자적, 이 규모에 충분)
//
//  ⚠️ 안전 규칙: "원격 로드에 한 번도 성공하지 못했으면 원격에 쓰지 않는다".
//   재배포 직후 로컬이 빈 상태에서 원격 로드가 일시 실패했을 때,
//   빈 데이터로 원격을 덮어써 전적이 증발하는 사고를 원천 차단한다.
// ════════════════════════════════════════════════════════════════

const BLOB_KEY = 'poker_stats';

// TURSO_DATABASE_URL 미설정 → null (로컬 파일만 사용, 기존 동작 그대로)
function createRemoteStorage() {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) return null;

    const { createClient } = require('@libsql/client');
    const client = createClient({
        url,
        authToken: process.env.TURSO_AUTH_TOKEN || undefined
    });

    let _tableReady = null;
    const ensureTable = () => {
        if (!_tableReady) {
            _tableReady = client.execute(
                'CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)'
            ).catch(e => { _tableReady = null; throw e; }); // 실패 시 다음 호출에서 재시도
        }
        return _tableReady;
    };

    return {
        kind: 'turso',
        // 저장된 JSON 문자열 반환 (없으면 null)
        async load() {
            await ensureTable();
            const rs = await client.execute({ sql: 'SELECT value FROM storage WHERE key = ?', args: [BLOB_KEY] });
            return rs.rows.length > 0 ? String(rs.rows[0].value) : null;
        },
        // 전체 JSON 블롭 upsert
        async save(json) {
            await ensureTable();
            await client.execute({
                sql: `INSERT INTO storage (key, value, updated_at) VALUES (?, ?, datetime('now'))
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
                args: [BLOB_KEY, json]
            });
        }
    };
}

module.exports = { createRemoteStorage, BLOB_KEY };
