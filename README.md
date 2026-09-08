# ga-asset — 사내 OA 자산 셀프 실사 시스템

직원이 공용 URL 하나로 접속해 **본인 보유 자산만** 확인하고, QR·사진·미보유 신고로 실사를
끝내는 Google Apps Script 웹앱입니다. 관리자는 같은 앱에서 실사 현황과 확인 필요 항목을 관리합니다.

```
브라우저 (모바일/PC)
   │  공용 URL 하나  https://script.google.com/macros/s/…/exec
   ▼
Google Apps Script Web App  (doGet + google.script.run)
   ▼
Google Sheets (데이터)  ·  Google Drive (사진 증빙)
```

별도의 Node 서버, 프론트엔드 빌드, 데이터베이스는 사용하지 않습니다.
(`tests/` 아래 검증 도구만 Node 를 쓰며 배포물에 포함되지 않습니다.)

> **실제 데이터 연결을 준비 중이라면** → [운영 체크리스트](docs/PILOT_CHECKLIST.md) 를 따라가세요.

---

## 1. 저장소 구조

```
src/
  appsscript.json            매니페스트 (clasp rootDir)
  server/
    config.gs                설정 · 시트 이름 · ★컬럼 매핑(COLUMN_ALIASES)
    util.gs                  공통 유틸 / AppError / CacheService 래퍼
    auth.gs                  사용자 식별·권한  ← Workspace 로그인 격리 지점
    repository.gs            Repository 인터페이스 (Facade)
    mockRepository.gs        MOCK 드라이버 + 테스트 데이터
    sheetRepository.gs       Google Sheets 드라이버 + SheetMapper/SheetIO
    mockStorage.gs           사진 저장 (MOCK)
    driveService.gs          사진 저장 (Google Drive) + 스토리지 선택
    assetService.gs          내 자산 조회 · 상태 표기 · 진행률
    auditService.gs          QR / 사진 / 예외 / 목록 외 자산
    adminService.gs          Dashboard / 실사 현황 / Reconciliation
    setup.gs                 연결 점검 · 차수 생성 · 대상 Snapshot (편집기 실행)
    main.gs                  doGet + 모든 RPC 진입점 (+ 공통 에러 처리)
  html/
    index.html               HTMLService 템플릿 (유일하게 스크립틀릿 사용)
    styles.html              디자인 토큰 + 컴포넌트 CSS
    components.html          렌더 헬퍼 · 사진 리사이즈 · 이미지 QR 디코딩
    qr.html                  QR 스캐너 (촬영 디코딩 기본 / 실시간 카메라 보조)
    app.html                 직원 화면 9종
    admin.html               관리자 화면 3종
    scripts.html             google.script.run Promise 래퍼 · 상태 · 라우팅
    vendor_jsqr.html         jsQR 1.4.0 벤더링 (Apache-2.0, 외부 CDN 미사용)
docs/
  DEPLOY.md                  Apps Script 배포 가이드 (clasp / 편집기 / GitHub Actions)
  PILOT_CHECKLIST.md         실제 데이터 연결 · 파일럿 운영 체크리스트
dist/
  appsscript-flat/           편집기에 붙여넣기용 평면 빌드 (생성물 — src/ 가 원본)
tools/
  build-flat.js              평면 빌드 생성기
tests/                       검증 도구 (배포되지 않음) — tests/README.md 참고
.clasp.json.example          clasp 설정 예시
```

배포 방법은 [`docs/DEPLOY.md`](docs/DEPLOY.md) 를 참고하세요.

---

## 2. 실제 Sheet 연결에 필요한 값

전부 **스크립트 속성**(Apps Script 편집기 → 프로젝트 설정 → 스크립트 속성)에 넣습니다.
코드에는 어떤 ID 도 하드코딩하지 않습니다.

### 2-1. 필수

| 키 | 예시 | 설명 |
|---|---|---|
| `MODE` | `GOOGLE_SHEETS` | `MOCK` / `GOOGLE_SHEETS` |
| `SPREADSHEET_ID` | `1AbC...xyz` | 스프레드시트 URL 의 `/d/` 와 `/edit` 사이 문자열 |
| `ADMIN_EMAILS` | (비어 있음) | 쉼표 구분. `Admin` 시트와 함께 사용. **코드에는 관리자 이메일을 하드코딩하지 않습니다** |

### 2-2. 시트 이름 (기본값과 다를 때만)

| 키 | 기본 시트 이름 |
|---|---|
| `SHEET_ASSET_MASTER` | `Asset_Master` |
| `SHEET_AUDIT_CAMPAIGN` | `Audit_Campaign` |
| `SHEET_AUDIT_TARGET` | `Audit_Target` |
| `SHEET_AUDIT_LOG` | `Audit_Log` |
| `SHEET_AUDIT_UNLISTED` | `Audit_Unlisted` |
| `SHEET_ADMIN` | `Admin` |
| `SHEET_ERROR_LOG` | `Error_Log` |

예: 회사 자산대장 시트 이름이 `자산대장` 이면 `SHEET_ASSET_MASTER = 자산대장`.

### 2-3. Drive

| 키 | 예시 | 설명 |
|---|---|---|
| `DRIVE_ROOT_FOLDER_ID` | `1XyZ...` | 사진 저장 루트 폴더. 폴더 URL 의 `/folders/` 뒤 문자열 |
| `DRIVE_ROOT_FOLDER_NAME` | `Asset Audit` | ID 를 비웠을 때 이름으로 찾거나 생성 |

`DRIVE_ROOT_FOLDER_ID` 가 비어 있고 `MODE=MOCK` 이면 사진은 임시 캐시에만 저장됩니다.
**운영 전환 시에는 반드시 폴더 ID 를 지정하세요.**

### 2-4. 운영 전환 시 반드시 바꾸는 값

| 키 | 개발 | 운영 |
|---|---|---|
| `ALLOW_MOCK_USER` | `true` | **`false`** — 데모 계정 전환 차단 |
| `ALLOW_DEV_TAG_INPUT` | `true` | **`false`** — 스캐너의 개발용 Tag 입력 숨김 |

### 2-5. 성능 관련 (기본값 사용 권장)

| 키 | 기본값 | 설명 |
|---|---|---|
| `CACHE_TTL_SECONDS` | `300` | 사용자별 대상/프로필 캐시 |
| `DASHBOARD_CACHE_TTL_SECONDS` | `60` | 관리자 집계 캐시 |
| `LOCK_WAIT_MS` | `20000` | Audit_Log upsert 락 대기 |
| `MAX_PHOTO_BYTES` | `6291456` | 업로드 상한 |

---

## 3. ★ 컬럼 매핑 — 실제 컬럼명이 달라도 되는 이유

코드 전체는 **표준 필드명**(`asset_id`, `asset_tag`, `user_email` …)만 사용합니다.
실제 시트 헤더와의 연결은 **`src/server/config.gs` 의 `COLUMN_ALIASES` 한 곳**에서만 정의됩니다.

```js
// src/server/config.gs
var COLUMN_ALIASES = {
  ASSET_MASTER: {
    asset_id:      ['asset_id', '자산번호', '자산ID', '자산코드'],
    asset_tag:     ['asset_tag', 'TAG번호', 'Tag번호', '태그번호', 'QR번호'],
    user_name:     ['user_name', '성명', '사용자', '사용자명', '이름'],
    user_email:    ['user_email', '이메일', '회사이메일', '메일'],
    department:    ['department', '조직', '부서', '소속'],
    model:         ['model', '모델명', '모델'],
    serial_number: ['serial_number', 'Serial', 'S/N', '시리얼'],
    employee_no:   ['employee_no', '사번', '사원번호'],   // 선택 항목
    ...
  },
  ...
};
```

- 회사 컬럼명이 목록에 없으면 **해당 배열에 문자열 하나만 추가**하면 됩니다.
- 비교 시 공백·밑줄·하이픈·대소문자를 무시합니다 → `TAG 번호`, `tag_번호`, `TAG번호` 동일 취급.
- **컬럼 순서는 상관없습니다.** 헤더 이름으로 위치를 찾습니다.
- **충돌은 자동으로 해결하지 않습니다.** 시트의 두 컬럼(`TAG번호`, `태그번호`)이 같은
  표준 필드로 인식되면 임의로 하나를 고르지 않고 `validateSetup()` 이 ERROR 로 보고하며,
  이 상태에서는 `createAuditTargetsFromMaster()` 도 거부됩니다.
- 코드가 모르는 컬럼(예: `비고`)은 무시되며, 쓰기 시에도 기존 값이 보존됩니다.
- `사번(employee_no)` 은 읽기만 하고 현재 로직에서 사용하지 않습니다.

필수 컬럼이 없으면 `validateSetup()` 이 **어떤 시트의 어떤 필드가 없는지** 알려줍니다.

> 검증: `node tests/column-mapping.js` — 시트 이름 `자산대장`, 컬럼명
> `사번/성명/이메일/조직/자산번호/자산명/모델명/Serial/TAG번호/지급상태`,
> 표준과 다른 컬럼 순서, 미지의 `비고` 컬럼 조합으로 전체 플로우(66개 검사)를 확인합니다.

---

## 4. Sheet 스키마

| 시트 | 표준 필드 |
|---|---|
| `Asset_Master` | asset_id, asset_tag, asset_name, model, serial_number, user_name, user_email, department, asset_status, updated_at *(+ employee_no 선택)* |
| `Audit_Campaign` | campaign_id, campaign_name, start_date, end_date, status, created_at |
| `Audit_Target` | campaign_id, asset_id, asset_tag, asset_name, user_name, user_email, department |
| `Audit_Log` | campaign_id, asset_id, asset_tag, user_email, verification_method, scanned_tag, photo_file_id, photo_url, audit_status, exception_type, note, verified_at, created_at, updated_at, **review_state, review_note, reviewed_by, reviewed_at** |
| `Audit_Unlisted` | campaign_id, user_email, scanned_tag, photo_file_id, **photo_url**, note, created_at, status, **report_type, review_note, reviewed_by, reviewed_at** |
| `Admin` | email, name, added_at |
| `Error_Log` | timestamp, user_email, fn, message, detail |

**굵게** 표시한 필드는 관리자 Reconciliation 처리 결과를 저장하기 위해 추가한 것입니다.

- `Audit_Log` 논리 unique key = `campaign_id + asset_id + user_email` → **insert 가 아니라 upsert**
- `Audit_Unlisted` unique key = `campaign_id + user_email + scanned_tag`
  (`report_type` 으로 목록에 없는 자산 / 타인 QR / Tag 불일치를 구분)
- 실사율의 분모는 항상 `Audit_Target` 입니다. 실사 도중 `Asset_Master` 가 바뀌어도 흔들리지 않습니다.
- **`Asset_Master` 에 쓰는 코드 경로는 없습니다.** (테스트용 `generateBulkMockData` 만 예외이며
  확인 토큰 없이는 실행되지 않습니다.)

### 상태값

내부 상태는 `NOT_STARTED / QR_VERIFIED / PHOTO_SUBMITTED / NOT_IN_POSSESSION /
UNLISTED_ASSET / REVIEW_REQUIRED` 6가지이며, 직원 화면에는
**미실사 / 완료 / 사진 제출 / 확인 필요** 4가지로만 보여줍니다.

사용자 기준 실사 완료 = 모든 `Audit_Target` 자산에 `QR_VERIFIED`,
`PHOTO_SUBMITTED`, `NOT_IN_POSSESSION` 중 하나가 기록된 상태입니다.

---

## 5. MOCK → GOOGLE_SHEETS 전환 절차

전환은 **스크립트 속성 변경 + 편집기 함수 실행**만으로 이루어집니다. 코드 수정은 없습니다.

| # | 작업 | 방법 | 확인 |
|---|---|---|---|
| 1 | 스프레드시트 준비 | 회사 자산대장이 이미 있으면 그 파일을 사용 | URL 에서 `SPREADSHEET_ID` 확보 |
| 2 | 속성 입력 | `SPREADSHEET_ID`, 필요 시 `SHEET_*` | — |
| 3 | 부속 시트 생성 | 편집기에서 `setupSpreadsheet()` | 로그의 `생성:` 목록. **기존 시트는 `유지:` 로 표시되고 헤더가 보존됨** |
| 4 | 컬럼 매핑 확인 | `validateSetup()` | `오류 0건`. 누락 컬럼이 나오면 `COLUMN_ALIASES` 에 추가 후 재실행 |
| 5 | 관리자 등록 | `Admin` 시트에 행 추가 또는 `ADMIN_EMAILS` | `validateSetup()` 의 `admins` |
| 6 | 실사 차수 생성 | `createAuditCampaign('PILOT_2026_09','2026 파일럿','2026-09-01','2026-09-30')` | `Audit_Campaign` 에 `ACTIVE` 1건 |
| 7 | 대상 Snapshot 생성 | `createAuditTargetsFromMaster('PILOT_2026_09', ['a@x','b@x',...])` | 로그의 생성 건수 · 제외 사유 |
| 8 | Drive 폴더 지정 | `DRIVE_ROOT_FOLDER_ID` | `validateSetup()` 에 폴더명 표시 |
| 9 | 모드 전환 | `MODE = GOOGLE_SHEETS` | `validateSetup()` 재실행 → `오류 0건` |
| 10 | 데모 기능 차단 | `ALLOW_MOCK_USER=false`, `ALLOW_DEV_TAG_INPUT=false` | 웹앱에 데모 바·개발용 입력이 사라짐 |
| 11 | 배포 | `clasp push` 후 새 버전 배포 | 아래 §6 인증 검증 |

되돌리려면 `MODE = MOCK` 으로 바꾸기만 하면 됩니다. 시트 데이터는 그대로 남습니다.

### 편집기에서 실행하는 함수

| 함수 | 하는 일 | Asset_Master |
|---|---|---|
| `setupSpreadsheet()` | 없는 시트·헤더 생성. **기존 시트는 건드리지 않음** | 쓰지 않음 |
| `validateSetup()` | 연결 전/후 점검. 오류·경고 목록 반환 | 읽기만 |
| `createAuditCampaign(id, name, start, end, activate)` | 차수 생성 (ACTIVE 중복 시 거부) | 쓰지 않음 |
| `closeAuditCampaign(id)` | 차수 종료 (`status=CLOSED`) | 쓰지 않음 |
| `createAuditTargetsFromMaster(campaignId, onlyEmails)` | 대상 Snapshot 생성. `onlyEmails` 로 파일럿 인원 한정 | **읽기만** |
| `seedSampleData(token)` | 데모 데이터 기록. 데이터가 있으면 `'OVERWRITE'` 없이는 거부 | 덮어씀(데모 전용) |
| `generateBulkMockData(u, n, 'ADD-TEST-DATA')` | 성능 테스트용 대량 자산 추가 | **추가함 — 운영 시트 금지** |

---

## 6. 인증 — 배포 설정과 반드시 검증할 것

### 6-1. 배포 설정

`src/appsscript.json` 기본값:

| 항목 | 값 | 이유 |
|---|---|---|
| 실행 주체 | **나(USER_DEPLOYING)** | 스프레드시트·Drive 폴더를 한 곳으로 모으고, 직원에게 시트 편집 권한을 주지 않기 위함 |
| 액세스 권한 | **도메인 내 사용자(DOMAIN)** | `Session.getActiveUser().getEmail()` 로 접속자를 식별하기 위함 |

사용자 식별은 `src/server/auth.gs` 의 `Auth.resolveEmail()` 한 곳에서만 이루어지며,
**`Session.getActiveUser().getEmail()` 만 사용합니다.**

> `getEffectiveUser()` 는 이 배포 설정에서 **배포자**를 가리킵니다.
> 이를 fallback 으로 쓰면 모든 접속자가 배포자로 인식되어, 전 직원이 배포자의 자산 목록을
> 보고 배포자 이름으로 실사를 기록하게 됩니다. 그래서 **fallback 으로 사용하지 않습니다.**
> 이메일을 얻지 못하면 오류가 아니라 안내 화면을 보여주고, 원인은 `Error_Log` 에만 남깁니다.

### 6-2. 실제 Workspace 에서 반드시 검증할 항목

에뮬레이터로는 확인할 수 없습니다. **배포 후 실제 계정으로** 확인해야 합니다.

| # | 검증 항목 | 방법 | 통과 기준 | 실패 시 |
|---|---|---|---|---|
| A | **도메인 사용자별 이메일 식별** | 서로 다른 3명 이상이 같은 URL 접속 | 각자 **자기 이름**과 **자기 자산만** 표시 | §6-3 |
| B | **다른 사람 자산이 섞이지 않음** | A 와 동시에 확인 | 목록에 타인 자산·이름·이메일이 없음 | 대상 Snapshot 의 `user_email` 확인 |
| C | **빈 이메일 반환** | 시크릿 창 / 외부 계정 / 다른 도메인 계정으로 접속 | "로그인 정보를 확인하지 못했습니다" 안내 화면. 오류 코드·스택 미노출 | §6-3 |
| D | **배포자 계정으로 잘못 식별** | 배포자가 아닌 직원이 접속 | 화면 인사말이 **접속자 본인 이름**. 배포자 이름이면 즉시 중단 | §6-3, 배포 설정 재확인 |
| E | **관리자 판정** | 일반 직원 / 관리자 각각 접속 | 일반 직원에게 관리자 메뉴가 보이지 않음 | `Admin` 시트·`ADMIN_EMAILS` 확인 |
| F | **로그 기록 주체** | A 수행 후 `Audit_Log` 확인 | `user_email` 이 실제 접속자 | D 와 동일 |
| G | **사진 소유·열람** | 직원이 사진 제출 → 관리자가 증빙 보기 | 관리자가 열람 가능, 타인은 불가 | Drive 폴더 소유자 확인 |

**D 는 가장 위험한 실패 모드입니다.** 직원 2명이 동시에 접속했을 때 둘 다 같은 이름이 보이면
즉시 배포를 중단하고 배포 설정(실행 주체/액세스 권한)을 재확인하세요.

### 6-3. 이메일 식별이 실패할 때 점검 순서

1. 웹앱 배포 설정: **액세스 권한 = 도메인 내 사용자** (`Anyone` 이면 이메일이 비어 옵니다)
2. 접속 계정이 **같은 Workspace 도메인** 인지 (개인 Gmail·외부 도메인은 빈 값)
3. `appsscript.json` 의 `oauthScopes` 에 `userinfo.email` 포함 여부
4. 배포를 **새 버전**으로 다시 만들었는지 (설정 변경은 새 버전부터 적용)
5. Workspace 관리 콘솔에서 Apps Script 웹앱 접근이 제한되어 있지 않은지
6. 그래도 비면 `Error_Log` 시트의 `NOT_SIGNED_IN` 항목과 배포 설정을 함께 확인

**어떤 경우에도 `getEffectiveUser()` 로 우회하지 마세요.**

---

## 7. 서버 인터페이스 (google.script.run)

```
getMyAssets()                                    내 자산 + 진행률 + 화면 옵션
getMyAuditStatus()                               진행률만
verifyQr(scannedTag, expectedAssetId)            QR 검증 (MATCHED / OTHER_OWN_ASSET / NOT_MINE)
registerForeignScan(scannedTag, expectedAssetId) 내 목록에 없는 QR 을 확인 필요로 등록
submitPhoto(assetId, base64, mimeType)           사진 증빙 제출
submitException(assetId, exceptionType, note)    보유하지 않음 신고
submitUnlistedAsset(tag, note, base64, mime)     목록에 없는 자산 등록
getPhotoDataUrl(fileId)                          증빙 열람 (본인 또는 관리자만)
getAdminDashboard(campaignId)                    KPI
getAdminAuditList(filters)                       실사 현황 (필터/검색/페이징)
getAdminReconciliation(filters)                  확인 필요 목록
resolveReviewItem(key, state, note)              확인 필요 처리
```

모든 RPC 는 `{ ok: true, data }` 또는 `{ ok: false, code, message }` 만 반환합니다.
Apps Script 내부 오류 문자열은 사용자에게 노출되지 않고 `Error_Log` 시트에만 남습니다.

---

## 8. 보안 원칙

- **클라이언트는 자기 신원을 서버에 전달하지 않습니다.** `verifyQr(scannedTag)` 처럼
  "무엇을 스캔했는지" 만 보내고, "그게 내 자산인지" 는 서버가 `Audit_Target` 으로 판정합니다.
- 본인 자산이 아닌 QR 을 스캔하면 **소유자의 이름·이메일·부서·자산명을 일절 반환하지 않습니다.**
- 사진은 Drive 링크를 화면에 노출하지 않고, `getPhotoDataUrl()` 이 **본인 또는 관리자**인지
  서버에서 확인한 뒤에만 내려줍니다.
- 관리자 판정은 `Admin` 시트/`ADMIN_EMAILS` 기준으로 **매 요청 서버에서** 수행합니다.
- `Asset_Master` 전량이 직원 화면으로 내려가지 않습니다. 서버에서 본인 행만 필터링합니다.
  `serial_number`, `employee_no` 는 직원 화면에 내려보내지 않습니다.

---

## 9. 성능 설계

- 셀 단위 `getValue()` 를 쓰지 않습니다. 항상 `getValues()` 로 일괄 조회 후 배열에서 탐색합니다.
- 한 요청에서 같은 시트를 두 번 읽지 않습니다(실행 단위 memo).
- QR 스캔 upsert 는 전체 `Audit_Log` 를 읽지 않고 **키 컬럼만** 읽어 행 번호를 찾습니다.
  컬럼 위치는 헤더에서 찾으므로 시트의 컬럼 순서가 달라도 동작합니다.
- 사용자별 대상 목록·프로필·관리자 집계를 `CacheService` 에 캐싱하고, 쓰기 시 무효화합니다.
  기준 데이터 변경 시에는 `Cache.invalidateAll()` 로 일괄 무효화합니다.
- `Audit_Log` / `Audit_Unlisted` 쓰기 구간만 `LockService` 로 감싸 동시 실사 충돌을 방지합니다.
- 사진은 업로드 전에 브라우저에서 장변 1600px · JPEG 0.82 로 리사이즈해 전송합니다.

실측(자산 1,222건, `MODE=GOOGLE_SHEETS`):

| 동작 | 시트 조회 | 읽은 셀 |
|---|---|---|
| 내 자산 조회 (cold) | 시트별 1회씩 5회 | 8,873 |
| 내 자산 조회 (warm) | 2회 | 306 |
| QR 스캔 1회 | 키 컬럼 + 대상 행 | 410 (쓰기 1회) |
| 관리자 Dashboard (cold) | 시트별 1회씩 4회 | 8,885 |
| 관리자 Dashboard (warm) | 1회 | 18 |

---

## 10. QR 확인 방식

Apps Script 웹앱은 샌드박스 iframe 안에서 실행되므로 **실시간 카메라(getUserMedia)가
항상 가능하다고 가정하지 않습니다.** 따라서 기본 확인 방식은 촬영한 사진의 디코딩입니다.

| 순위 | 방식 | 비고 |
|---|---|---|
| **기본** | `<input capture="environment">` 로 **촬영 → jsQR 디코딩** | 카메라 권한이 iframe 에서 막혀도 동작. 기본(파란) 버튼 |
| 보조 | 실시간 미리보기: `BarcodeDetector` → `getUserMedia` + jsQR | 가능한 환경에서만 자동 활성화 |
| 대체 | `[QR 없이 사진으로 확인]` → `PHOTO_SUBMITTED` | QR Tag 훼손 시 |
| 개발 | `ALLOW_DEV_TAG_INPUT=true` 일 때만 Tag 직접 입력 | 운영에서는 숨김 |

권한 거부 / 카메라 없음 / 사용 중 / 인식 실패를 각각 구분해 안내하고, 실시간 미리보기가
실패해도 **기본 촬영 버튼으로 실사를 끝까지 진행할 수 있습니다.**

QR 페이로드는 Tag ID 뿐 아니라 `https://…/t/Q12345`, `TAG:Q12345` 형태도 인식합니다.
**QR 에는 사용자명이나 지급정보를 넣지 않고, 변하지 않는 Tag ID 만 담습니다.**

---

## 11. 사진 저장 (Drive)

```
{DRIVE_ROOT_FOLDER} / {campaign_id} / {user_email} / {asset_id}_{timestamp}.jpg
```

시트에는 이미지 바이너리를 저장하지 않고 `photo_file_id`, `photo_url` 만 기록합니다.
폴더 ID 는 Script Properties 에 캐싱해 매 요청 폴더를 탐색하지 않습니다.
파일은 공개 공유하지 않으며, 열람은 서버 RPC 를 통해서만 가능합니다.

---

## 12. 검증

```bash
node tests/scenarios.js        # 서버 로직 (MOCK / GOOGLE_SHEETS)         206 checks
node tests/column-mapping.js   # 실제 회사 시트 컬럼명/순서 시뮬레이션      66 checks
node tests/safety.js           # 배포 전 안전성 (충돌/정규화/분모/동시성/권한) 81 checks
node tests/performance.js      # Apps Script 성능 규칙 (자산 1,222건)      15 checks
node tests/flat-build.js      # 편집기 배포용 평면 빌드 검증                41 checks
cd tests && npm install && npx playwright test    # 실제 화면 (390px/1440px)  54 tests
```

### validateSetup() 분류

| 구분 | 항목 |
|---|---|
| **ERROR** (파일럿 시작 불가) | 필수 시트 없음 · 필수 컬럼 매핑 실패 · **컬럼 충돌** · Tag/자산번호 중복 · ACTIVE 차수 0개 또는 2개 이상 · 활성 차수의 대상 Snapshot 없음 · Drive 폴더 접근 불가 · `SPREADSHEET_ID` 미설정 |
| **WARNING** (운영 가능, 확인 필요) | 이메일 없는 지급 자산 · Tag 없는 지급 자산 · 관리자 미설정 · 이메일에 공백 섞임 · 이메일 형식 이상 · `ALLOW_MOCK_USER`/`ALLOW_DEV_TAG_INPUT` 활성 · `MODE≠GOOGLE_SHEETS` · Drive 폴더 ID 미지정 · Master 에 없는 대상 |

자세한 내용은 [`tests/README.md`](tests/README.md) 를 참고하세요.

---

## 13. 이번 단계에서 하지 않은 것

- 실제 운영 Excel 수정
- `Asset_Master` 자동 수정 (읽기 전용 — 확인 필요 항목도 분류만 하고 기준정보는 그대로)
- ERP/AMS 직접 연동
