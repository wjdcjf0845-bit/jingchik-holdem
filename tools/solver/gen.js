// 솔버 입력 만들기: node scratch/solver_gen.js <btn|utg|hu> <보드 "Ks,7d,2c"> <출력 json(상대 경로)> [반복]
//   단일 레이즈 팟(오픈 2.5bb → BB 콜, 100bb). 범위는 이 게임의 범위표 그대로(lib/ranges.js · lib/preflop.js).
const PF = require('../../lib/preflop'), R = require('../../lib/ranges');
const [spot, board, out, iters] = process.argv.slice(2);
const w = (c, f) => f >= 100 ? c : `${c}:${(f / 100).toFixed(2)}`;
let ip, oop, pot = 5.5;
if (spot === 'hu') {
  ip = R.ALL.filter(c => PF.handRangeScore(c) > 35).join(',');
  oop = R.ALL.map(c => { const f = R.lookup({ headsUp: true, heroPos: 'BB' }, c); return f.call > 0 ? w(c, f.call) : null; }).filter(Boolean).join(',');
  pot = 5;
} else {
  const op = spot === 'utg' ? 'UTG' : 'BTN';
  ip = R.ALL.filter(c => PF.isInOpenRange(c, op)).join(',');
  oop = R.ALL.map(c => { const f = R.lookup({ heroPos: 'BB', openerPos: op }, c); return f.call > 0 ? w(c, f.call) : null; }).filter(Boolean).join(',');
}
const L = [`set_pot ${pot}`, `set_effective_stack 97.5`, `set_board ${board}`, `set_range_ip ${ip}`, `set_range_oop ${oop}`];
for (const who of ['oop', 'ip']) {
  L.push(`set_bet_sizes ${who},flop,bet,33,75`, `set_bet_sizes ${who},flop,raise,50`);
  L.push(`set_bet_sizes ${who},turn,bet,66`, `set_bet_sizes ${who},turn,raise,50`);
  L.push(`set_bet_sizes ${who},river,bet,66`, `set_bet_sizes ${who},river,raise,50`);
}
L.push('set_allin_threshold 0.67', 'build_tree', 'set_thread_num 32', 'set_accuracy 1.0', `set_max_iteration ${iters || 120}`, 'set_print_interval 10', 'set_use_isomorphism 1', 'start_solve', 'set_dump_rounds 1', `dump_result ${out}`);
console.log(L.join('\n'));
