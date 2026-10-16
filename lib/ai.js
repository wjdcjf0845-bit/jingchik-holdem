// 🤖 AI 연결 — AI 코치(대회 복기 설명)와 봇 말투에 쓴다. 포커 판단은 하지 않는다(그건 솔버·기대값 계산이 이미 한다 — AI 는 설명과 말만).
//   server.env 설정으로 고른다(없으면 AI 를 끈 채 예전처럼 돈다):
//     · ANTHROPIC_API_KEY=…  → Claude(클라우드). 모델은 AI_MODEL(기본 claude-opus-5-5).
//     · OLLAMA_URL=http://127.0.0.1:11434 (+ OLLAMA_MODEL, 기본 exaone3.5:2.4b — 한국어가 되는 작은 모델, 메모리 약 2GB) → 미니 PC 에서 직접 돌리는 모델.
//     · 하루에 부르는 횟수 한도 — 돈·속도 안전장치. 봇 대사(AI_CHAT_LIMIT, 기본 150)와 코치(AI_COACH_LIMIT, 기본 100)를 따로 센다
//       (대사가 한도를 다 써서 정작 코치를 못 쓰는 일이 없게).
//   ⚠️ Claude 를 쓰면 판 기록(패·보드·닉네임)이 Anthropic 으로 나간다.
const Anthropic = (() => { try { const m = require('@anthropic-ai/sdk'); return m.default || m; } catch (e) { return null; } })();

function createAI(env) {
    env = env || process.env;
    const key = env.ANTHROPIC_API_KEY, ollama = (env.OLLAMA_URL || '').replace(/\/+$/, '');
    const provider = key && Anthropic ? 'claude' : ollama ? 'ollama' : null;
    const model = provider === 'claude' ? (env.AI_MODEL || 'claude-opus-5-5') : (env.OLLAMA_MODEL || 'exaone3.5:2.4b');
    const limits = { chat: Number(env.AI_CHAT_LIMIT) || 150, coach: Number(env.AI_COACH_LIMIT) || 100 };
    const client = provider === 'claude' ? new Anthropic({ apiKey: key, maxRetries: 1 }) : null;
    let day = '', used = { chat: 0, coach: 0 };
    const budget = bucket => {
        const d = new Date().toDateString(), k = bucket === 'chat' ? 'chat' : 'coach';
        if (d !== day) { day = d; used = { chat: 0, coach: 0 }; }
        if (used[k] >= limits[k]) return false;
        used[k]++; return true;
    };

    // 한 번 묻고 한 번 답(텍스트). 실패·시간 초과·한도 초과면 null — 부르는 쪽은 AI 없이 하던 대로 한다.
    // o: { system, user, maxTokens, effort('low'|'medium'|'high'), timeoutMs, bucket('chat'|'coach'), temperature(Ollama 만 — 낮추면 자료에 충실) }
    async function text(o) {
        if (!provider || !budget(o.bucket)) return null;
        const timeout = o.timeoutMs || 30000;
        try {
            if (provider === 'claude') {
                // 정책상 거절되면 서버가 알아서 다른 모델로 다시 돌린다(fallbacks: 'default')
                const r = await client.beta.messages.create({
                    model, max_tokens: o.maxTokens || 2000,
                    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
                    output_config: { effort: o.effort || 'medium' },
                    system: o.system,
                    messages: [{ role: 'user', content: o.user }]
                }, { timeout });
                if (r.stop_reason === 'refusal') return null;
                const t = r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
                return t || null;
            }
            const res = await fetch(ollama + '/api/chat', {
                method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeout),
                body: JSON.stringify({ model, stream: false, options: Object.assign({ num_predict: o.maxTokens || 800 }, o.temperature != null ? { temperature: o.temperature } : {}),
                    messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }] })
            });
            if (!res.ok) return null;
            const j = await res.json();
            const t = j && j.message && j.message.content ? String(j.message.content).trim() : '';
            return t || null;
        } catch (e) {
            if (Anthropic && e instanceof Anthropic.APIError) console.error('🤖 [AI] API 오류', e.status, String(e.message || '').slice(0, 120));
            else console.error('🤖 [AI] 실패:', String(e && e.message || e).slice(0, 120));
            return null;
        }
    }
    return { enabled: () => !!provider, provider, model, text, usedToday: () => Object.assign({}, used), limits };
}

module.exports = { createAI };
