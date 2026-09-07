# 검증 도구 (배포되지 않음)

Apps Script 웹앱은 배포 없이는 로컬에서 실행할 수 없습니다.
그래서 `src/server/*.gs` 와 `src/html/*.html` 을 **수정 없이 그대로** 구동할 수 있는
Apps Script 런타임 에뮬레이터를 두고, 여기서 §26 검증 시나리오를 실제로 실행합니다.

이 디렉터리는 clasp push 대상이 아니며(`rootDir=src`), 배포물에는 Node 의존성이 전혀 없습니다.

```
harness/
  gas-runtime.js   PropertiesService / CacheService / LockService / Session /
                   Utilities / Logger / SpreadsheetApp / DriveApp / HtmlService 에뮬레이션
                   (HtmlService 는 <? ?> · <?= ?> · <?!= ?> 스크립틀릿까지 평가)
  server.js        doGet 결과를 서빙하고 google.script.run 을 /rpc 로 연결하는 검증 서버
  qrgen.js         테스트용 최소 QR 인코더 (버전 1~4 / EC L / 바이트 모드) + PNG 출력
scenarios.js       서버 로직 시나리오 (MOCK / GOOGLE_SHEETS 양쪽에서 동일하게 실행)
performance.js     Sheets 호출 횟수·읽은 셀 수 계측 (자산 1,222건 규모)
ui/                Playwright 화면 검증 (390px / 1440px)
screenshots.js     화면 캡처
```

에뮬레이터는 RPC 호출마다 실행 단위 상태(`Config`, `Auth`, `SheetIO`, `MockStore` 메모)를
초기화해, **요청마다 컨텍스트가 새로 뜨는 실제 Apps Script 동작**을 재현합니다.
`PropertiesService` / `CacheService` 는 실제와 같이 요청 사이에 값을 유지합니다.

## 실행

```bash
# 1) 서버 로직 (브라우저 불필요)
node scenarios.js
node performance.js

# 2) 화면 (Playwright)
npm install
npx playwright test                       # 390px + 1440px 전체
npx playwright test --project=mobile-390  # 모바일만

# 3) 검증 서버를 직접 띄워 눈으로 확인
node harness/server.js --port 8110
#   http://localhost:8110/?user=seho@company.com
#   http://localhost:8110/?user=asset.admin@company.com   (관리자)
#   MODE=GOOGLE_SHEETS 로 확인하려면 --mode GOOGLE_SHEETS

# 4) 화면 캡처
node screenshots.js      # ../screenshots 에 저장
```

Chromium 은 환경에 설치된 것을 사용합니다(`playwright.config.js` 의 `chromiumPath()`).
다른 경로라면 `CHROMIUM_PATH` 환경변수로 지정하세요.

## 검증 서버 전용 엔드포인트

테스트 격리를 위한 훅이며 실제 웹앱에는 존재하지 않습니다.

| 경로 | 용도 |
|---|---|
| `POST /__reset` | 저장소를 시드 상태로 되돌림 |
| `POST /__config` | 스크립트 속성 / Workspace 로그인 이메일 변경 (운영 설정 재현) |
| `GET /__health` | 상태 확인 |

## QR 인코더

`qrgen.js` 는 실제 QR 이미지를 만들어 **벤더링한 jsQR 이 정말 디코딩하는지** 확인하기 위한
테스트 전용 도구입니다. 문자열 6종 × 마스크 8종 = 56 조합에서 라운드트립을 확인했습니다.
