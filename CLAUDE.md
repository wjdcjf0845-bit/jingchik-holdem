# 징칡홀덤

친구들끼리 치는 텍사스 홀덤 웹 게임. 목표는 홀덤펍 "파이널나인" 대회 입상 — 딥스택 연습(36인 MTT · 6위까지 입상 · 9인 테이블 · 파이널나인 챔피언스컵 구조표 · 리바인 없음)이 가장 중요하다.
Node 20+ · Express · Socket.IO. 사용자와는 한국어(표준어)로 대화하고, 게임 안 문구도 표준어로 쓴다(사투리 말투 금지).

## 구조
- `server.js` — 서버 전부(방·봇·대회 MTTManager·전적 MockDB). 약 8천 줄이라 필요한 곳만 찾아 읽는다.
- `public/index.html` — 클라이언트 전부(한 파일). `admin.js` — 관리자 페이지(/admin).
- `lib/` — 순수 모듈(테스트 대상). `test/` — `node --test`. `tools/` — 자료 변환·미니 PC 운영 스크립트.
- 대회용 프리플랍 자료 `lib/preflop_mtt.json.gz` 는 HRC 로 직접 푼 결과(`tools/hrc_import.js`).

## 배포 = main 에 push
서버는 집의 **미니 PC(192.168.0.148, Windows)** 에서 돈다. Render 는 더 이상 쓰지 않는다.
미니 PC 의 감시기(`tools/minipc/runner.js`, 작업 스케줄러 JingchikHoldem)가 2분마다 GitHub main 을 확인해
새 커밋이 있으면 받아서 서버를 재시작한다. 진행 중인 대회(딥스택·MTT)가 있으면 끝날 때까지(최대 4시간) 미룬다.

사용자가 "배포해" 라고 하면:
1. `node --test` 통과 확인(실패하면 배포하지 말고 알린다)
2. 커밋 → `git push origin main`
3. `node tools/minipc/deploycheck.js` — 서버 /version 이 내 커밋과 같아질 때까지 기다린 뒤 봇과 판을 돌려 확인
4. 보고: 무엇을 바꿨는지, 확인한 것/못 한 것. 재시작으로 진행 중이던 판이 끊길 수 있음을 적는다.

- 설정·비밀값은 미니 PC 의 `C:\jingchik-data\server.env` 에만 있다(Turso DB 주소·토큰, 관리자 비밀번호, 계좌). 전적은 Turso 에 저장된다.
- 서버 로그: 미니 PC `C:\jingchik-data\server.log` · `runner.log` · 멈춤 감시 `watchdog.log`.
- 전적 백업: 매일 새벽 4시 이후 `C:\jingchik-data\backup\poker_stats-날짜.json.gz`(30일치). 폰 알림은 server.env 의 `ALERT_NTFY`(ntfy 주제) — `lib/ops.js`.
- AI(선택): `lib/ai.js` — server.env 에 `ANTHROPIC_API_KEY`(Claude, 기본 claude-opus-5-5) 또는 `OLLAMA_URL` 이 있을 때만 켜진다. 대회 복기 AI 코치·"왜?"(`lib/aicoach.js`)와 봇 말투. 포커 판단은 AI 가 하지 않고 앱의 솔버·기대값 계산을 설명만 한다.

## 지킬 것
- **공개 저장소**: 비밀번호·토큰·계좌번호를 코드나 커밋에 절대 넣지 않는다. `access_log.json`·`poker_stats.json` 커밋 금지.
- `scratch/` 는 커밋하지 않는 실험 폴더(시험 스크립트·임시 서버 데이터).
- 로컬 시험 서버: `DATA_DIR=scratch/x MAX_PLAYERS=0 BOT_FAST=1 DEV_FAST_HANDS=1 PORT=30xx node server.js`
  (딥스택 시험: `DEV_FN_ENTRANTS` · `DEV_FN_LEVEL` · `DEV_FN_REBUY_LV` · `DEV_MTTCHECK=1` 규칙 검사 · `DEV_BOTSRC=1` 봇 판단 근거 로그)
- 돈이 걸린 기능(홀인원 상금 장부)·칩 계산은 고친 뒤 반드시 시험으로 검산한다.
