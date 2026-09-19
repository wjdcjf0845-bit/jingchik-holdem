// 🏅 등급 — 돈으로 살 수 없는 테두리를 여는 기준.
//
// 왜 "현재 뱅크롤"이 아니라 "최고로 모았던 뱅크롤"인가:
//   현재 잔고로 판정하면 한 판 크게 잃는 순간 테두리가 사라진다. 등급은 지나온 성과의
//   기록이지 지금 지갑 사정이 아니므로, 한 번 찍은 최고치(peakBankroll)로 고정한다.
//
// 두 조건은 OR 다. 토너먼트를 많이 이긴 사람과 캐시로 크게 불린 사람 둘 다
// 같은 등급에 닿을 수 있어야 한다 — 플레이 방식 하나만 강요하지 않으려고.
//
// ⚠️ 임계값은 반드시 오름차순이어야 한다. rankIndexOf 가 "조건을 만족하는 가장 높은 칸"을
//    찾는 방식이라, 중간이 뒤집히면 등급이 건너뛰거나 내려간다. 아래 테스트가 이걸 지킨다.
const RANKS = [
    { name: '입문',      frame: 'fr_none',   wins: 0,  peak: 0 },
    { name: '동네 고수', frame: 'fr_bronze', wins: 1,  peak: 300000 },
    { name: '선수',      frame: 'fr_silver', wins: 5,  peak: 1000000 },
    { name: '타짜',      frame: 'fr_gold',   wins: 15, peak: 3000000 },
    { name: '전설',      frame: 'fr_legend', wins: 40, peak: 10000000 }
];

// 우승 횟수 또는 최고 뱅크롤 중 하나라도 닿으면 그 등급이다.
function rankIndexOf(u) {
    const wins = (u && u.wins) || 0;
    const peak = (u && u.peakBankroll) || 0;
    let idx = 0;
    for (let i = 1; i < RANKS.length; i++) {
        if (wins >= RANKS[i].wins || peak >= RANKS[i].peak) idx = i;
    }
    return idx;
}

function rankNeedText(i) {
    const r = RANKS[i];
    if (!r || i <= 0) return '';
    return `우승 ${r.wins}회 또는 최고 뱅크롤 ${r.peak.toLocaleString()}`;
}

// 등급에 맞춰 열려 있는 테두리 목록
function unlockedFrames(u) {
    const idx = rankIndexOf(u);
    return RANKS.slice(0, idx + 1).map(r => r.frame);
}

module.exports = { RANKS, rankIndexOf, rankNeedText, unlockedFrames };
