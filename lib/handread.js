'use strict';
// ════════════════════════════════════════════════════════════════
//  handread.js — 상대 레인지 추정 (핸드 리딩)
//
//  왜: 기존 봇의 승률 계산(estimateBotEquity)은 몬테카를로에서 상대에게
//  "완전 무작위 핸드"를 돌렸다. 그래서 프리플랍 3벳 후 세 스트리트를 배럴한
//  상대나, 체크만 하며 따라온 상대나 똑같이 랜덤으로 취급했다.
//  → 강한 라인에 과하게 콜하고(호구), 약한 라인에 과하게 폴드하는(호구) 원인.
//
//  개선: 이번 핸드의 상대 액션으로 레인지를 좁힌 뒤, 그 레인지에서만 상대
//  핸드를 뽑아 승률을 계산한다. "3벳한 놈은 쓰레기를 안 들고 있다"를 봇이 안다.
//
//  ⚠️ 밸런스 장치 2개 — 봇이 순진해지지 않게:
//   1) offRangeRate: 레인지 밖 핸드도 일정 비율 허용 (상대의 블러프/밸런스 반영).
//      이게 없으면 봇이 "3벳했으니 무조건 강함"으로 단정해 블러프에 무력해진다.
//   2) skill 스케일링: 실력 낮은 봇은 리딩을 거의 못 한다 (초보는 그냥 랜덤 가정).
//      난이도 구분이 유지되어야 한다.
//
//  순수 함수 (난수 주입 가능) → 단위 테스트로 검증.
// ════════════════════════════════════════════════════════════════

// 이번 핸드의 액션 로그에서 특정 상대의 행동 요약을 뽑는다.
//   actionLog: [{ nick, type, street, amount }]  (server의 this.actionLog)
//   반환: { raisedPreflop, threeBetPlus, aggroStreets, calls, checks, sawAction }
function summarizeVillain(actionLog, nick) {
    const log = (actionLog || []).filter(a => a && a.nick === nick);
    let raisedPreflop = 0, aggroStreets = new Set(), calls = 0, checks = 0;
    for (const a of log) {
        const isAggro = (a.type === 'raise' || a.type === 'allin');
        if (isAggro) {
            aggroStreets.add(a.street);
            if (a.street === 1) raisedPreflop++;
        }
        if (a.type === 'call') calls++;
        if (a.type === 'check') checks++;
    }
    return {
        raisedPreflop,                       // 프리플랍 레이즈 횟수 (2+ = 3벳/4벳)
        threeBetPlus: raisedPreflop >= 2,    // 프리플랍에서 리레이즈까지 함
        aggroStreets: aggroStreets.size,     // 공격한 스트리트 수 (배럴 깊이)
        calls, checks,
        sawAction: log.length > 0
    };
}

// 행동 요약 → 상대 레인지의 "최소 프리플랍 핸드 강도" 임계값.
//   서버 preflopStrength 스케일 기준 (페어 0.5~0.92, AKs≈0.70, 72o≈0.25)
//   skill: 봇 실력(0~1). 낮으면 리딩을 거의 안 해 임계값이 0으로 수렴한다.
//   반환: 0~1 (0 = 레인지 안 좁힘 = 완전 랜덤)
function villainMinStrength(summary, skill) {
    const s = summary || {};
    const sk = Math.max(0, Math.min(1, skill != null ? skill : 0.8));
    if (!s.sawAction) return 0; // 액션 정보 없음 → 못 좁힘

    let min = 0;
    // 프리플랍 공격성 — 가장 강한 신호
    if (s.threeBetPlus) min = 0.62;        // 3벳+ = 프리미엄 위주
    else if (s.raisedPreflop === 1) min = 0.46; // 오픈 레이즈 = 상위 레인지
    else if (s.calls > 0) min = 0.28;      // 콜만 = 마지널 포함한 넓은 레인지
    // 순수 체크/폴드만 했으면 좁힐 근거 없음 → min 그대로 0

    // 포스트플랍 배럴 깊이 — 스트리트를 거듭 공격할수록 레인지가 더 강해진다
    if (s.aggroStreets >= 3) min += 0.12;
    else if (s.aggroStreets === 2) min += 0.07;

    min = Math.min(0.80, min); // 너무 좁히면 표본이 안 나옴 — 상한
    return min * sk;           // 실력 스케일링: 초보 봇은 리딩 거의 못 함
}

// 이 상대 핸드를 레인지 표본으로 받아들일지.
//   strength:    후보 핸드의 프리플랍 강도
//   minStrength: villainMinStrength 결과
//   offRangeRate: 레인지 밖도 허용할 비율 (기본 0.15 = 상대의 블러프/밸런스 몫)
//   rand: [0,1) 난수 (테스트 주입용)
function acceptOppHand(strength, minStrength, offRangeRate, rand) {
    const min = minStrength || 0;
    if (min <= 0) return true;                  // 안 좁힘 → 전부 수용
    if ((strength || 0) >= min) return true;    // 레인지 안
    const rate = offRangeRate != null ? offRangeRate : 0.15;
    const r = rand != null ? rand : Math.random();
    return r < rate;                            // 레인지 밖이어도 일정 비율은 수용 (블러프 반영)
}

module.exports = { summarizeVillain, villainMinStrength, acceptOppHand };
