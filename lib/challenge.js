'use strict';
// ═══════════════════════════════════════════════════════════
//  challenge.js — 🤖 컴까기(AI 도장깨기) 단계표와 보상 규칙
//
//  혼자서 봇들과 토너먼트를 치러 1등을 하면 다음 단계가 열린다.
//  단계가 오를수록 상대가 많아지고 강해진다(초보 → 중수 → 고수 → 보스).
//
//  규칙을 서버 본문이 아니라 여기 둔 이유: 보상·해금 조건은 돈과 직결돼서
//  단위 테스트로 못박아 둬야 한다(건너뛰기·중복 수령·음수 같은 사고 방지).
// ═══════════════════════════════════════════════════════════

// bots: 상대 봇 난이도 목록. botChipsMult: 봇 시작 칩 배율(보스전 핸디캡).
const STAGES = [
    { name: '동네 초보',       bots: ['easy'],                                  reward: 3000,   desc: '초보 1명과 맞대결' },
    { name: '초보 둘',         bots: ['easy', 'easy'],                          reward: 5000,   desc: '초보 2명' },
    { name: '중수 입문',       bots: ['normal', 'normal'],                      reward: 8000,   desc: '중수 2명' },
    { name: '중수 셋',         bots: ['normal', 'normal', 'normal'],            reward: 12000,  desc: '중수 3명' },
    { name: '섞인 테이블',     bots: ['normal', 'normal', 'normal', 'hard'],    reward: 16000,  desc: '중수 3명 + 고수 1명' },
    { name: '고수와 1:1',      bots: ['hard'],                                  reward: 22000,  desc: '고수 1명과 헤즈업' },
    { name: '고수 둘',         bots: ['hard', 'hard'],                          reward: 30000,  desc: '고수 2명' },
    { name: '고수 넷',         bots: ['hard', 'hard', 'hard', 'hard'],          reward: 45000,  desc: '고수 4명' },
    { name: '풀 테이블',       bots: ['hard', 'hard', 'hard', 'hard', 'hard'],  reward: 65000,  desc: '고수 5명 풀링' },
    { name: '보스전',          bots: ['hard', 'hard', 'hard', 'hard', 'hard'],  reward: 150000, desc: '고수 5명 — 상대는 칩 1.5배로 시작', botChipsMult: 1.5 }
];
const START_CHIPS = 3000;        // 30bb 시작 — 한 판이 10분 안쪽으로 끝나게
const BLIND_UP_MIN = 2;
const REPEAT_RATE = 0.2;         // 이미 깬 단계를 다시 깨면 보상의 20%만 (같은 단계 반복으로 뱅크롤을 찍어내지 못하게)
const CLEAR_TITLE = 'ti_bot';    // 10단계를 깨면 열리는 칭호
const COOP_MAX = 3;              // 협동 인원 상한 — 더 많으면 봇 자리가 없어 싸움이 안 된다(6인 테이블)

// 🔷 코어 — 컴까기에서만 나오는 재화. 첫 클리어는 단계 번호만큼, 다시 깨면 조금(1~3개).
function coresFor(stage, first) { return first ? stage : Math.ceil(stage / 4); }

// 협동일 때의 상대 구성. 사람이 늘면 봇을 한 명씩 더 붙이고(자리가 되는 만큼),
// 자리가 모자라 못 붙인 몫과 인원 이점은 봇 칩 배율로 메운다.
function coopSetup(stage, humans) {
    const st = STAGES[stage - 1];
    const h = Math.max(1, Math.min(COOP_MAX, humans || 1));
    const hardest = st.bots.includes('hard') ? 'hard' : (st.bots.includes('normal') ? 'normal' : 'easy');
    const bots = st.bots.slice();
    for (let i = 1; i < h; i++) bots.push(hardest);
    const seats = 6 - h;
    return { bots: bots.slice(0, seats), mult: (st.botChipsMult || 1) * (1 + 0.3 * (h - 1)) };
}

// 협동도 잠금 없이 전 단계를 고를 수 있다
function partyMaxStage() { return STAGES.length; }

// 계정의 진행 상황을 항상 온전한 모양으로 돌려준다 (구버전/손상 값 방어)
//   단계를 아무거나 골라 들어갈 수 있게 되면서 "몇 단계까지 깼나" 하나로는 부족해졌다
//   (10단계를 먼저 깨면 1~9단계가 깬 걸로 쳐져 첫 클리어 보상을 못 받는다) → 단계별로 기록한다.
//   예전 기록(best 만 있는 계정)은 1~best 를 깬 것으로 읽는다.
function progressOf(u) {
    const c = (u && u.challenge && typeof u.challenge === 'object') ? u.challenge : {};
    const oldBest = Number.isInteger(c.best) ? Math.max(0, Math.min(STAGES.length, c.best)) : 0;
    const set = new Set();
    if (Array.isArray(c.cleared)) c.cleared.forEach(n => { if (Number.isInteger(n) && n >= 1 && n <= STAGES.length) set.add(n); });
    else for (let i = 1; i <= oldBest; i++) set.add(i);
    const cleared = [...set].sort((a, b) => a - b);
    return {
        cleared, best: cleared.length ? cleared[cleared.length - 1] : 0, count: cleared.length,
        clears: Number.isInteger(c.clears) && c.clears > 0 ? c.clears : 0, tries: Number.isInteger(c.tries) && c.tries > 0 ? c.tries : 0
    };
}

// stage 는 1부터. 어느 단계든 바로 골라 들어갈 수 있다(잠금 없음) — 번호만 검증한다.
function canPlay(u, stage) {
    return Number.isInteger(stage) && stage >= 1 && stage <= STAGES.length;
}

// 클리어 처리: 진행 상황을 갱신하고 지급할 보상을 돌려준다.
function applyClear(u, stage) {
    if (!canPlay(u, stage)) return null;
    const p = progressOf(u);
    const first = !p.cleared.includes(stage);        // 그 단계를 처음 깼는가 (단계별로 따로 본다)
    const full = STAGES[stage - 1].reward;
    const reward = first ? full : Math.floor(full * REPEAT_RATE);
    const cleared = first ? p.cleared.concat(stage).sort((a, b) => a - b) : p.cleared;
    u.challenge = { cleared, best: cleared[cleared.length - 1], clears: p.clears + 1, tries: p.tries };
    const cores = coresFor(stage, first);
    u.cores = (Number.isInteger(u.cores) && u.cores > 0 ? u.cores : 0) + cores;
    return { stage, first, reward, cores, best: u.challenge.best, allClear: first && stage === STAGES.length, next: stage < STAGES.length ? stage + 1 : null };
}

// 화면에 내려보낼 단계표
function ladder(u) {
    const p = progressOf(u);
    return STAGES.map((s, i) => ({
        no: i + 1, name: s.name, desc: s.desc, bots: s.bots.length, reward: s.reward,
        repeatReward: Math.floor(s.reward * REPEAT_RATE),
        cores: coresFor(i + 1, true), repeatCores: coresFor(i + 1, false), boss: i === STAGES.length - 1,
        cleared: p.cleared.includes(i + 1), open: true
    }));
}

module.exports = { STAGES, START_CHIPS, BLIND_UP_MIN, REPEAT_RATE, CLEAR_TITLE, COOP_MAX, coresFor, coopSetup, partyMaxStage, progressOf, canPlay, applyClear, ladder };
