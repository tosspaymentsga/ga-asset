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

---

## 1. 저장소 구조

```
src/
  appsscript.json            매니페스트 (clasp rootDir)
  server/
    config.gs                설정·상수·시트 스키마 (MODE 전환 지점)
    util.gs                  공통 유틸 / AppError / CacheService 래퍼
    auth.gs                  사용자 식별·권한  ← Workspace 로그인 격리 지점
    repository.gs            Repository 인터페이스 (Facade)
    mockRepository.gs        MOCK 드라이버 + 테스트 데이터
    sheetRepository.gs       Google Sheets 드라이버
    mockStorage.gs           사진 저장 (MOCK)
    driveService.gs          사진 저장 (Google Drive) + 스토리지 선택
    assetService.gs          내 자산 조회 · 상태 표기 · 진행률
    auditService.gs          QR / 사진 / 예외 / 목록 외 자산
    adminService.gs          Dashboard / 실사 현황 / Reconciliation
    setup.gs                 시트 생성 · 시드 · 대상 Snapshot · 대량 데이터
    main.gs                  doGet + 모든 RPC 진입점 (+ 공통 에러 처리)
  html/
    index.html               HTMLService 템플릿 (유일하게 스크립틀릿 사용)
    styles.html              디자인 토큰 + 컴포넌트 CSS
    components.html          렌더 헬퍼 · 사진 리사이즈 · 이미지 QR 디코딩
    qr.html                  QR 스캐너 (BarcodeDetector → jsQR → 대체 수단)
    app.html                 직원 화면 9종
    admin.html               관리자 화면 3종
    scripts.html             google.script.run Promise 래퍼 · 상태 · 라우팅
    vendor_jsqr.html         jsQR 1.4.0 벤더링 (Apache-2.0, 외부 CDN 미사용)
tests/                       검증 도구 (배포되지 않음) — tests/README.md 참고
.clasp.json.example          clasp 설정 예시
```

---

## 2. 배포

### 2-1. clasp 준비

```bash
npm install -g @google/clasp
clasp login
clasp create --type webapp --title "자산실사" --rootDir src   # 또는 기존 프로젝트 사용
cp .clasp.json.example .clasp.json                            # scriptId 를 채운다
clasp push
```

`.clasp.json` 은 scriptId 를 포함하므로 커밋하지 않습니다(`.gitignore` 처리됨).

### 2-2. 웹 앱 배포 설정

`src/appsscript.json` 기본값:

| 항목 | 값 | 이유 |
|---|---|---|
| 실행 주체 | **나(USER_DEPLOYING)** | 스프레드시트·Drive 폴더를 한 곳으로 모으고, 직원에게 시트 편집 권한을 주지 않기 위함 |
| 액세스 권한 | **도메인 내 사용자(DOMAIN)** | `Session.getActiveUser().getEmail()` 로 접속자를 식별하기 위함 |

> 접속자 식별은 항상 `getActiveUser()` 만 사용합니다.
> `getEffectiveUser()` 는 이 설정에서 **배포자**를 가리키므로 신원 판별에 절대 쓰지 않습니다.
> 이메일이 빈 값이면 사용자에게 안내 화면을 보여주고, 원인은 `Error_Log` 에만 남깁니다.

### 2-3. 데이터 준비 (MOCK → GOOGLE_SHEETS)

Apps Script 편집기에서 순서대로 실행합니다.

1. `setupSpreadsheet()` — 스프레드시트/시트/헤더 생성 후 `SPREADSHEET_ID` 저장
2. `seedSampleData()` — 샘플 `Asset_Master` / `Audit_Campaign` / `Admin` 기록 (선택)
3. `buildAuditTargets()` — **실사 대상 Snapshot 생성 (실사 시작 시 1회)**
4. 스크립트 속성에 `MODE = GOOGLE_SHEETS` 설정

### 2-4. 스크립트 속성

| 키 | 기본값 | 설명 |
|---|---|---|
| `MODE` | `MOCK` | `MOCK` / `GOOGLE_SHEETS` |
| `SPREADSHEET_ID` | (없음) | `setupSpreadsheet()` 가 채웁니다 |
| `DRIVE_ROOT_FOLDER_ID` | (없음) | 비우면 `Asset Audit` 폴더를 이름으로 찾거나 생성 |
| `ALLOW_MOCK_USER` | `true` | **운영에서는 반드시 `false`** (데모 계정 전환 차단) |
| `ALLOW_DEV_TAG_INPUT` | `true` | **운영에서는 `false`** (스캐너의 개발용 Tag 입력 숨김) |
| `ADMIN_EMAILS` | `asset.admin@company.com` | `Admin` 시트와 별개로 항상 관리자로 취급할 이메일 |
| `CACHE_TTL_SECONDS` | `300` | 사용자별 대상 캐시 |
| `DASHBOARD_CACHE_TTL_SECONDS` | `60` | 관리자 집계 캐시 |
| `LOCK_WAIT_MS` | `20000` | Audit_Log upsert 락 대기 |

---

## 3. Sheet 스키마

| 시트 | 컬럼 |
|---|---|
| `Asset_Master` | asset_id, asset_tag, asset_name, model, serial_number, user_name, user_email, department, asset_status, updated_at |
| `Audit_Campaign` | campaign_id, campaign_name, start_date, end_date, status, created_at |
| `Audit_Target` | campaign_id, asset_id, asset_tag, asset_name, user_name, user_email, department |
| `Audit_Log` | campaign_id, asset_id, asset_tag, user_email, verification_method, scanned_tag, photo_file_id, photo_url, audit_status, exception_type, note, verified_at, created_at, updated_at, **review_state, review_note, reviewed_by, reviewed_at** |
| `Audit_Unlisted` | campaign_id, user_email, scanned_tag, photo_file_id, **photo_url**, note, created_at, status, **report_type, review_note, reviewed_by, reviewed_at** |
| `Admin` | email, name, added_at |
| `Error_Log` | timestamp, user_email, fn, message, detail |

**굵게** 표시한 컬럼은 관리자 Reconciliation 처리 결과를 저장하기 위해 추가한 것입니다.

- `Audit_Log` 논리 unique key = `campaign_id + asset_id + user_email` → **insert 가 아니라 upsert**
- `Audit_Unlisted` unique key = `campaign_id + user_email + scanned_tag`
  (`report_type` 으로 목록에 없는 자산 / 타인 QR / Tag 불일치를 구분)
- 실사율의 분모는 항상 `Audit_Target` 입니다. 실사 도중 `Asset_Master` 가 바뀌어도 흔들리지 않습니다.
- 실사 결과가 `Asset_Master` 를 자동 수정하는 경로는 없습니다.

### 상태값

내부 상태는 `NOT_STARTED / QR_VERIFIED / PHOTO_SUBMITTED / NOT_IN_POSSESSION /
UNLISTED_ASSET / REVIEW_REQUIRED` 6가지이며, 직원 화면에는
**미실사 / 완료 / 사진 제출 / 확인 필요** 4가지로만 보여줍니다.

사용자 기준 실사 완료 = 모든 `Audit_Target` 자산에 `QR_VERIFIED`,
`PHOTO_SUBMITTED`, `NOT_IN_POSSESSION` 중 하나가 기록된 상태입니다.

---

## 4. 서버 인터페이스 (google.script.run)

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

## 5. 보안 원칙

- **클라이언트는 자기 신원을 서버에 전달하지 않습니다.** `verifyQr(scannedTag)` 처럼
  "무엇을 스캔했는지" 만 보내고, "그게 내 자산인지" 는 서버가 `Audit_Target` 으로 판정합니다.
- 본인 자산이 아닌 QR 을 스캔하면 **소유자의 이름·이메일·부서·자산명을 일절 반환하지 않습니다.**
- 사진은 Drive 링크를 화면에 노출하지 않고, `getPhotoDataUrl()` 이 **본인 또는 관리자**인지
  서버에서 확인한 뒤에만 내려줍니다.
- 관리자 판정은 `Admin` 시트/`ADMIN_EMAILS` 기준으로 **매 요청 서버에서** 수행합니다.
  클라이언트의 `isAdmin` 값은 화면 표시용일 뿐 권한 근거가 아닙니다.
- `Asset_Master` 전량이 직원 화면으로 내려가지 않습니다. 서버에서 본인 행만 필터링합니다.

---

## 6. 성능 설계

- 셀 단위 `getValue()` 를 쓰지 않습니다. 항상 `getValues()` 로 일괄 조회 후 배열에서 탐색합니다.
- 한 요청에서 같은 시트를 두 번 읽지 않습니다(실행 단위 memo).
- QR 스캔 upsert 는 전체 `Audit_Log` 를 읽지 않고 **키 컬럼 4개만** 읽어 행 번호를 찾습니다.
- 사용자별 대상 목록·관리자 집계·관리자 목록을 `CacheService` 에 캐싱하고,
  쓰기 시 관련 키를 무효화합니다. 기준 데이터 변경 시에는 `Cache.invalidateAll()` 로 일괄 무효화합니다.
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

## 7. QR 스캔

1. `BarcodeDetector` (Android Chrome 등) — 네이티브, 의존성 없음
2. `getUserMedia` + canvas + **jsQR** (iOS Safari 포함)
3. 카메라를 쓸 수 없으면 **`capture="environment"` 로 촬영한 정지 이미지를 jsQR 로 디코딩**
   — Apps Script 샌드박스 iframe 에서 카메라가 막혀도 동작합니다
4. `ALLOW_DEV_TAG_INPUT=true` 일 때만 개발용 Tag 직접 입력

권한 거부 / 카메라 없음 / 사용 중 / 인식 실패를 각각 구분해 안내하고, 항상 대체 수단을 함께 제시합니다.
QR 페이로드는 Tag ID 뿐 아니라 `https://…/t/Q12345`, `TAG:Q12345` 형태도 인식합니다.
**QR 에는 사용자명이나 지급정보를 넣지 않고, 변하지 않는 Tag ID 만 담습니다.**

---

## 8. 사진 저장 (Drive)

```
Asset Audit / {campaign_id} / {user_email} / {asset_id}_{timestamp}.jpg
```

시트에는 이미지 바이너리를 저장하지 않고 `photo_file_id`, `photo_url` 만 기록합니다.
폴더 ID 는 Script Properties 에 캐싱해 매 요청 폴더를 탐색하지 않습니다.
파일은 공개 공유하지 않으며, 열람은 서버 RPC 를 통해서만 가능합니다.

---

## 9. 검증

```bash
node tests/scenarios.js      # 서버 로직 (MOCK / GOOGLE_SHEETS 양쪽)  206 checks
node tests/performance.js    # Apps Script 성능 규칙 (자산 1,222건)    15 checks
cd tests && npm install && npx playwright test    # 실제 화면 (390px / 1440px)  54 tests
```

자세한 내용은 [`tests/README.md`](tests/README.md) 를 참고하세요.

---

## 10. 이번 단계에서 하지 않은 것

- 실제 운영 Excel 수정
- 실제 Google Workspace 인증 연결 (인터페이스만 준비, 배포 설정으로 전환)
- 실제 Google Drive 업로드 (코드는 있으나 폴더 ID 미설정 시 MOCK 스토리지 사용)
- `Asset_Master` 자동 수정
- ERP/AMS 직접 연동
