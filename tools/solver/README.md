# 플랍 솔버 자료 만들기

`lib/solverdata.json` 은 공개 솔버 [TexasSolver](https://github.com/bupticybee/TexasSolver) v0.2.0 (콘솔판)으로 푼 결과에서 뽑은 것입니다.
솔버 실행 파일은 이 저장소에 없습니다 — 따로 내려받아 저장소 밖에 두고 씁니다.

1. 입력 만들기: `node tools/solver/gen.js <btn|utg|hu> "Ks,7d,2c" out.json 120 > in.txt`
   - 상황: 단일 레이즈 팟(2.5bb 오픈 → BB 콜, 100bb). 범위는 `lib/ranges.js` · `lib/preflop.js` 의 범위표.
   - 벳 크기: 플랍 33%·75%, 턴·리버 66%, 레이즈 50%, 올인 문턱 0.67
2. 풀기: 솔버 폴더에서 `console_solver.exe -i in.txt` (출력 경로는 솔버 폴더 기준 상대 경로로 — 한글이 든 절대 경로에는 저장되지 않았습니다)
3. 뽑기: `node tools/solver/extract.js <출력 json 들이 있는 폴더>` — 파일 이름은 `<상황>_<보드>.json` (예: `btn_Ks7d2c.json`)

2026-10-09 기준: 상황 3종 × 대표 플랍 22종 = 66개, 각 120회 반복(오차 0.7~1.6%), 32스레드로 보드당 40초~2분.
범위표를 바꾸면 다시 풀어야 합니다.
