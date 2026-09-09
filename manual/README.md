# 승강설비 현장조회 — /manual

`jingchik-holdem` 서버의 `/manual` 경로에 붙는 설비 매뉴얼 조회 앱.
포커 게임(`/`)은 인증 없이 열리고, `/manual` 만 Basic 인증이 걸린다.

대상: 에스컬레이터·엘리베이터·자동문 **매뉴얼, 에러코드, 현장조치 절차**
제외: 계약·법정검사·공문·보고·사고·인사·근무일지 (파일명 기준 자동 차단)

## 1. 설치

압축을 풀어 저장소 루트에 넣는다.

```
jingchik-holdem/
├── server.js       ← 아래 한 줄 추가
├── manual.js
└── manual/
    ├── public/
    ├── data/           ← build_index.py 결과가 여기 생성됨
    └── build_index.py
```

`server.js` 의 `app.use(express.static(...))` **바로 위**에:

```js
app.use('/manual', require('./manual'));
```

## 2. 데이터 생성 (회사 PC)

먼저 무엇이 포함/제외되는지만 확인:

```
cd manual
python build_index.py "C:\Users\정철\Desktop\국제선 승강파일" --dry
```

제외 목록이 사유별로 출력된다. 매뉴얼인데 빠진 게 있으면 파일명에
`매뉴얼`, `설명서`, `취급`, `보수`, `제어반` 같은 단어가 들어가게 바꾸거나
`--all` 로 전체 텍스트를 포함시킨다(단 제외 필터는 계속 적용됨).

확인 후 실제 생성:

```
python build_index.py "C:\Users\정철\Desktop\국제선 승강파일"
```

`manual/data/index.json` 과 `manual/data/docs/*.json` 이 만들어진다.

## 3. 로컬 확인

```
set MANUAL_USER=test&& set MANUAL_PASS=test&& npm start
```

- `http://localhost:3000/`        포커 게임 (인증 없음)
- `http://localhost:3000/manual/` 승강설비 조회 (test / test)

## 4. 배포

**먼저 GitHub 저장소를 Private 으로 바꿀 것.** (Settings → General → Change repository visibility)

Render → Environment 에 등록:

| 키 | 값 |
|---|---|
| `MANUAL_USER` | 팀에서 쓸 아이디 |
| `MANUAL_PASS` | 충분히 긴 비밀번호 |

미등록 시 `/manual` 은 503으로 막히고 포커 게임만 동작한다.

```
git add .
git commit -m "승강설비 현장조회 /manual 추가"
git push origin main
```

## 5. 휴대폰 등록

`/manual/` 접속 → 공유 → 홈 화면에 추가.
코드·절차는 캐시되어 기계실·피트에서 신호가 없어도 열린다. 원문검색만 통신이 필요하다.

## 알아둘 것

- 제조사 매뉴얼은 업체 자료다. 팀 내부 조회용으로 인증 뒤에 두고 쓰는 것이지,
  공개 URL로 뿌리면 안 된다. `MANUAL_PASS` 를 팀 외부로 넘기지 말 것.
- Render 무료 플랜은 15분 무접속 시 잠들고 재시작에 40~60초 걸린다.
  홈 화면에 추가해두면 코드·절차는 캐시에서 즉시 열린다.
- PDF·이미지 매뉴얼 원본은 포함하지 않는다. 텍스트화된 것만 대상.
- 자료가 바뀌면 `build_index.py` 재실행 → `git push` 하면 자동 반영된다.
