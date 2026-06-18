'use strict';
// ════════════════════════════════════════════════════════════════
//  preflop.js — 프리플랍 GTO 레인지 로직 (서버 봇 + 학습모드 조언 + 테스트가 공유)
//  핵심: 169칸 핸드 표기 → 포지션별 RFI(Raise First In) 차트로 raise/call/fold 등급.
//  상태(this)·소켓 의존성이 없는 순수 로직이라, "학습모드가 보여주는 GTO 데이터"와
//  "봇이 실제로 쓰는 데이터"가 동일한 단일 출처임을 단위 테스트로 보장한다.
// ════════════════════════════════════════════════════════════════

// 핸드 두 장 → 169칸 표기 (예: 'AKs','AJo','TT')
function handToCode(hand) {
    const order = '23456789TJQKA';
    const r1 = hand[0][0], r2 = hand[1][0];
    const v1 = order.indexOf(r1), v2 = order.indexOf(r2);
    const hi = v1 >= v2 ? r1 : r2, lo = v1 >= v2 ? r2 : r1;
    if (r1 === r2) return hi + lo;                 // 페어
    const suited = hand[0][1] === hand[1][1];
    return hi + lo + (suited ? 's' : 'o');
}

// 핸드의 "강도 순위" 점수 (레인지 임계값 비교용, 0~100). Chen 변형 + 승률 근사 혼합.
function handRangeScore(code) {
    const order = '23456789TJQKA';
    const a = order.indexOf(code[0]), b = order.indexOf(code[1]);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    const pair = code[0] === code[1];
    const suited = code[2] === 's';
    const gap = hi - lo;
    let s;
    if (pair) {
        s = 50 + hi * 4;                            // 22=50 ... AA=98
    } else {
        s = 18 + hi * 2.6 + lo * 1.4;               // 하이/로우 가중
        if (suited) s += 7;
        if (gap === 1) s += 6;                      // 커넥터
        else if (gap === 2) s += 3;
        else if (gap === 3) s += 1;
        else if (gap >= 5) s -= 4;                  // 큰 갭 페널티
        // 수딧 커넥터/원갭퍼는 낮은 카드여도 플레이성 보너스 (54s~JTs류 BTN 오픈)
        if (suited && gap === 1 && lo >= 2) s += 4; // 43s 이상 수딧 커넥터
        if (suited && gap === 2 && lo >= 3) s += 2; // 수딧 원갭퍼
        // A는 별도 보너스(너트 잠재력)
        if (hi === 12) s += suited ? 5 : 2;
        // 오프수트 약한 갭 핸드 추가 페널티 (J8o, T8o, K5o 류 — 플레이성 낮음)
        if (!suited && gap >= 2 && hi < 12) s -= 3;
        // 매우 낮은 오프수트(둘 다 9 이하)는 더 페널티
        if (!suited && hi <= 7 && gap >= 2) s -= 2;
    }
    return Math.max(0, Math.min(100, Math.round(s)));
}

// 포지션별 오픈(레이즈) 임계값 — 차트에 없는 핸드의 보조 판단용
const POSITION_OPEN_THRESHOLD = {
    'UTG': 60, 'UTG+1': 60, 'UTG+2': 59, 'LJ': 59, 'HJ': 58, 'CO': 55, 'BTN': 49, 'SB': 51, 'BB': 44
};
function openThreshold(position) {
    if (POSITION_OPEN_THRESHOLD[position] !== undefined) return POSITION_OPEN_THRESHOLD[position];
    if (position && position.startsWith('UTG')) return 64;
    return 58;
}

// 📊 표준 6맥스 RFI(Raise First In) 오픈 레인지 차트 — GTO 솔버 근사, 학습 정확도용
const PREFLOP_OPEN_RANGE = {
  'UTG': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','QJs','QTs','JTs','J9s','T9s','98s','87s','76s','65s','54s','AKo','AQo','AJo','KQo']),
  'HJ': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','QJs','QTs','Q9s','JTs','J9s','T9s','T8s','98s','97s','87s','76s','65s','54s','AKo','AQo','AJo','ATo','KQo','KJo','QJo']),
  'CO': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s','QJs','QTs','Q9s','Q8s','JTs','J9s','J8s','T9s','T8s','98s','97s','87s','76s','65s','54s','43s','AKo','AQo','AJo','ATo','A9o','KQo','KJo','KTo','QJo','QTo','JTo']),
  'BTN': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s','K4s','K3s','K2s','QJs','QTs','Q9s','Q8s','Q7s','Q6s','Q5s','Q4s','JTs','J9s','J8s','J7s','J6s','T9s','T8s','T7s','T6s','98s','97s','96s','87s','86s','85s','76s','75s','65s','64s','54s','53s','43s','AKo','AQo','AJo','ATo','A9o','A8o','A7o','A6o','A5o','A4o','A3o','A2o','KQo','KJo','KTo','K9o','K8o','QJo','QTo','Q9o','JTo','J9o','T9o','98o','87o','76o']),
  'SB': new Set(['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s','K4s','K3s','K2s','QJs','QTs','Q9s','Q8s','Q7s','Q6s','Q5s','JTs','J9s','J8s','J7s','T9s','T8s','T7s','98s','97s','87s','76s','65s','54s','43s','AKo','AQo','AJo','ATo','A9o','A8o','A7o','A5o','KQo','KJo','KTo','K9o','QJo','QTo','Q9o','JTo','J9o','T9o'])
};
function rangeKeyFor(position) {
    if (!position) return 'CO';
    if (PREFLOP_OPEN_RANGE[position]) return position;
    if (position.startsWith('UTG')) return 'UTG';
    if (position === 'LJ') return 'HJ';
    return 'CO';
}
function isInOpenRange(code, position) {
    const set = PREFLOP_OPEN_RANGE[rangeKeyFor(position)];
    return set ? set.has(code) : false;
}
// 차트 기반 분류 — 오픈 레인지에 있으면 raise, 약간 밑이면 call, 아니면 fold
function preflopRangeTier(code, position, facingRaise) {
    const score = handRangeScore(code);
    const inRange = isInOpenRange(code, position);
    // AK/AA/KK/QQ는 항상 3벳급 프리미엄 (점수와 무관하게 명시)
    const isPremium3bet = (code === 'AKs' || code === 'AKo' || code === 'AA' || code === 'KK' || code === 'QQ' || code === 'JJ');
    if (facingRaise) {
        if (isPremium3bet) return { tier: 'raise', label: '3벳/밸류', score };
        if (inRange) {
            // 차트 내 핸드라도 레이즈 직면 시엔 "디펜스 콜" — 점수 충분해야 콜, 약하면 폴드
            if (score >= 85) return { tier: 'raise', label: '3벳/밸류', score };
            if (score >= 66) return { tier: 'call', label: '콜', score };  // 콜 디펜스
            return { tier: 'fold', label: '폴드', score };  // 오픈은 되지만 디펜스엔 약함
        }
        // 차트 밖 — 어지간히 강하지 않으면 폴드
        if (score >= 70) return { tier: 'call', label: '콜', score };
        return { tier: 'fold', label: '폴드', score };
    }
    if (inRange) return { tier: 'raise', label: '오픈 레이즈', score };
    const th = openThreshold(position);
    if (score >= th - 6) return { tier: 'call', label: '마지널', score };
    return { tier: 'fold', label: '폴드', score };
}

module.exports = {
    handToCode, handRangeScore, openThreshold, preflopRangeTier,
    isInOpenRange, rangeKeyFor, POSITION_OPEN_THRESHOLD, PREFLOP_OPEN_RANGE
};
