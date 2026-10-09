// 솔버로 푸는 상황 목록 — 양쪽 범위(패 코드 → 무게 0~1)와 팟·남은 스택(bb).
//   범위는 이 게임의 범위표(lib/ranges.js · lib/preflop.js)에서 그대로 만든다. gen.js(입력 만들기)와 extract.js(결과 뽑기)가 같이 쓴다.
const PF = require('../../lib/preflop'), R = require('../../lib/ranges');
const open = pos => c => (PF.isInOpenRange(c, pos) ? 1 : 0);
const huOpen = c => (PF.handRangeScore(c) > 35 ? 1 : 0);
const f = (ctx, k) => c => { const x = R.lookup(ctx, c); return x ? x[k] / 100 : 0; };
const mul = (a, b) => c => a(c) * b(c);
const bbCall = op => f({ heroPos: 'BB', openerPos: op }, 'call');
const huBBCall = f({ headsUp: true, heroPos: 'BB' }, 'call');
// 단일 레이즈 팟(오픈 → BB 콜): 깊이별. 얕은 스택 전용 범위표는 없어 100bb 범위를 그대로 쓴다(근사).
const srp = (ip, oop, pot) => depth => ({ ip, oop, pot, stack: Math.round((depth - (pot - 0.5) / 2) * 10) / 10 });
const SRP = { btn: srp(open('BTN'), bbCall('BTN'), 5.5), co: srp(open('CO'), bbCall('CO'), 5.5), utg: srp(open('UTG'), bbCall('UTG'), 5.5), hu: srp(huOpen, huBBCall, 5) };
const SPOTS = {};
Object.keys(SRP).forEach(k => { SPOTS[k] = SRP[k](100); SPOTS[k + '40'] = SRP[k](40); SPOTS[k + '25'] = SRP[k](25); });
// 블라인드 대결: SB 3bb 오픈 → BB 콜. 오픈한 SB 가 먼저 행동한다(포지션 없음).
SPOTS.sbb = { oop: open('SB'), ip: bbCall('SB'), pot: 6, stack: 97 };
SPOTS.sbb40 = { oop: open('SB'), ip: bbCall('SB'), pot: 6, stack: 37 };
SPOTS.sbb25 = { oop: open('SB'), ip: bbCall('SB'), pot: 6, stack: 22 };
// 3벳 팟
//   tbo: 블라인드가 버튼 오픈에 3벳(11bb) → 버튼 콜. 3벳한 쪽이 먼저 행동.
SPOTS.tbo = { oop: f({ heroPos: 'BB', openerPos: 'BTN' }, 'raise'), ip: mul(open('BTN'), f({ heroPos: 'BTN', raises: 2, iRaised: true, inPosition: true }, 'call')), pot: 22.5, stack: 89 };
//   tbi: 버튼이 CO 오픈에 3벳(7.5bb) → CO 콜. 3벳한 쪽이 나중에 행동.
SPOTS.tbi = { ip: f({ heroPos: 'BTN', openerPos: 'CO' }, 'raise'), oop: mul(open('CO'), f({ heroPos: 'CO', raises: 2, iRaised: true, inPosition: false }, 'call')), pot: 16.5, stack: 92.5 };
//   hutb: 헤즈업 BB 3벳(9bb) → 버튼 콜.
SPOTS.hutb = { oop: f({ headsUp: true, heroPos: 'BB' }, 'raise'), ip: mul(huOpen, f({ headsUp: true, raises: 2, iRaised: true }, 'call')), pot: 18, stack: 91 };

const rangeStr = w => R.ALL.map(c => { const x = w(c); return x <= 0 ? null : x >= 1 ? c : `${c}:${x.toFixed(2)}`; }).filter(Boolean).join(',');
module.exports = { SPOTS, rangeStr };
