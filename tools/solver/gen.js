// 솔버 입력 만들기: node tools/solver/gen.js <상황> <보드 "Ks,7d,2c"> <출력 json(솔버 폴더 기준 상대 경로)> [반복] [덤프 라운드: 1 플랍만 · 2 턴까지(기본)]
//   상황 목록은 spots.js. 벳 크기: 플랍 33%·75%, 턴·리버 66%, 레이즈 50%, 올인 문턱 0.67
const { SPOTS, rangeStr } = require('./spots');
const [spot, board, out, iters, rounds] = process.argv.slice(2);
const S = SPOTS[spot];
if (!S) { console.error('모르는 상황: ' + spot + ' (' + Object.keys(SPOTS).join(', ') + ')'); process.exit(1); }
const L = [`set_pot ${S.pot}`, `set_effective_stack ${S.stack}`, `set_board ${board}`, `set_range_ip ${rangeStr(S.ip)}`, `set_range_oop ${rangeStr(S.oop)}`];
for (const who of ['oop', 'ip']) {
  L.push(`set_bet_sizes ${who},flop,bet,33,75`, `set_bet_sizes ${who},flop,raise,50`);
  L.push(`set_bet_sizes ${who},turn,bet,66`, `set_bet_sizes ${who},turn,raise,50`);
  L.push(`set_bet_sizes ${who},river,bet,66`, `set_bet_sizes ${who},river,raise,50`);
}
L.push('set_allin_threshold 0.67', 'build_tree', 'set_thread_num 32', 'set_accuracy 1.0', `set_max_iteration ${iters || 120}`, 'set_print_interval 10', 'set_use_isomorphism 1', 'start_solve', `set_dump_rounds ${rounds || 2}`, `dump_result ${out}`);
console.log(L.join('\n'));
