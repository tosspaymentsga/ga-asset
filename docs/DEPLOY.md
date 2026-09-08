# Apps Script 배포 가이드

배포 방법은 세 가지입니다. **A(clasp)** 를 권장하고, Google 계정 외 도구를 쓸 수 없으면 **B(편집기 붙여넣기)** 를 쓰세요.

| 방법 | 소요 | 언제 |
|---|---|---|
| **A. clasp** | 5분 | 로컬에 Node 설치 가능. 이후 수정도 `clasp push` 한 번 |
| **B. 편집기 붙여넣기** | 20분 | 로컬 설치 없이 브라우저만으로. 파일 21개 수동 생성 |
| **C. GitHub Actions** | 30분(1회) | 팀이 GitHub 기준으로 배포를 자동화하고 싶을 때 |

> **GitHub 에 올려두면 자동으로 배포되지 않습니다.** Apps Script 프로젝트는 Google Drive 에
> 있고 GitHub 연동 기능이 없습니다. 반드시 위 셋 중 하나로 코드를 올려야 합니다.

---

## A. clasp 로 배포 (권장)

```bash
# 1) clasp 설치 · 로그인
npm install -g @google/clasp
clasp login                       # 브라우저에서 회사 계정으로 로그인

# 2) 저장소 받기
git clone -b claude/asset-audit-poc-8kjb8b <저장소 URL>
cd ga-asset

# 3) Apps Script 프로젝트 생성 (기존 프로젝트가 있으면 건너뛴다)
clasp create --type webapp --title "자산실사" --rootDir src

# 4) .clasp.json 준비  ── 이미 3)에서 만들어졌다면 생략
cp .clasp.json.example .clasp.json
#    scriptId 를 채운다 (편집기 URL 의 /projects/<여기>/edit)

# 5) 업로드
clasp push

# 6) 편집기 열기
clasp open
```

`.clasp.json` 은 scriptId 를 담고 있어 커밋하지 않습니다(`.gitignore` 처리됨).

코드를 고친 뒤에는 `clasp push` 만 다시 실행하고, 웹 앱은 **새 버전으로 다시 배포**해야
접속자에게 반영됩니다.

---

## B. 편집기에 직접 붙여넣기

`dist/appsscript-flat/` 폴더를 사용합니다. 폴더 구조 없이 파일 21개가 평면으로 들어 있고,
`include()` 경로도 폴더 없이 맞춰져 있습니다.

```bash
node tools/build-flat.js     # dist/appsscript-flat/ 재생성 (이미 있으면 생략)
```

1. <https://script.google.com> → **새 프로젝트**
2. 좌측 **⚙ 프로젝트 설정** → “**‘appsscript.json’ 매니페스트 파일을 편집기에서 보기**” 체크
3. `appsscript.json` 내용을 `dist/appsscript-flat/appsscript.json` 으로 **교체**
4. 기본 `Code.gs` 를 `config` 로 이름 바꾸고 `config.gs` 내용 붙여넣기
5. 나머지 `.gs` 파일 12개를 **파일 + → 스크립트**로 추가
   (`PASTE_ORDER.md` 의 순서 참고 — 이름이 정확해야 합니다)
6. `.html` 파일 8개를 **파일 + → HTML** 로 추가
   - 이름에서 확장자는 빼고 입력합니다: `index`, `styles`, `app` …
   - `vendor_jsqr` 는 약 257KB 라 붙여넣기에 몇 초 걸립니다
7. 저장 후 **배포 → 새 배포 → 웹 앱**

파일 이름이 하나라도 다르면 `include()` 가 실패해 빈 화면이 됩니다.
`PASTE_ORDER.md` 의 이름과 정확히 일치시키세요.

---

## C. GitHub Actions 로 자동 배포 (선택)

`clasp` 는 CI 에서도 동작합니다. 다만 **로그인 자격증명을 저장소 시크릿에 넣어야** 하므로
운영 정책을 먼저 확인하세요.

1. 로컬에서 `clasp login` 후 `~/.clasprc.json` 내용을 복사
2. GitHub 저장소 → Settings → Secrets → `CLASPRC_JSON`, `SCRIPT_ID` 등록
3. 아래 워크플로를 `.github/workflows/deploy.yml` 로 추가

```yaml
name: Deploy to Apps Script
on:
  workflow_dispatch:          # 수동 실행만 (자동 배포를 원하면 push 트리거 추가)
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install -g @google/clasp
      - name: 자격증명 복원
        run: echo '${{ secrets.CLASPRC_JSON }}' > ~/.clasprc.json
      - name: clasp 설정
        run: echo '{"scriptId":"${{ secrets.SCRIPT_ID }}","rootDir":"src"}' > .clasp.json
      - run: clasp push --force
      # 새 버전 배포까지 자동화하려면 (배포 ID 필요)
      # - run: clasp deploy --deploymentId ${{ secrets.DEPLOYMENT_ID }} --description "CI ${{ github.sha }}"
```

- **`workflow_dispatch` 만 두어 자동 실행되지 않게 했습니다.** 자동 배포를 원하면
  `on: push: branches: [main]` 을 추가하세요.
- 저장소에는 이 워크플로 파일이 **포함되어 있지 않습니다.** 필요하면 위 내용을 그대로 추가하세요.
- `~/.clasprc.json` 에는 refresh token 이 들어 있습니다. 시크릿 관리 정책을 반드시 확인하세요.

---

## 배포 후 필수 설정

### 1) 웹 앱 배포 설정

**배포 → 새 배포 → 유형: 웹 앱**

| 항목 | 값 |
|---|---|
| 실행 주체 | **나** (배포자) |
| 액세스 권한 | **도메인 내 사용자** |

이 조합이라야 `Session.getActiveUser().getEmail()` 로 접속자를 식별할 수 있고,
직원에게 스프레드시트 권한을 주지 않아도 됩니다. 자세한 이유와 검증 항목은
[README §6](../README.md#6-인증--배포-설정과-반드시-검증할-것) 참고.

### 2) 스크립트 속성

**⚙ 프로젝트 설정 → 스크립트 속성**

먼저 **MOCK 모드 그대로** 배포해 화면을 확인한 뒤, 실제 데이터로 전환하는 순서를 권장합니다.

```
# 데모 확인 단계 (속성 없이도 동작합니다)
MODE=MOCK

# 실제 데이터 연결 단계
MODE=GOOGLE_SHEETS
SPREADSHEET_ID=<스프레드시트 URL 의 /d/ 와 /edit 사이>
DRIVE_ROOT_FOLDER_ID=<사진 저장 폴더 URL 의 /folders/ 뒤>
ADMIN_EMAILS=<관리자 이메일, 쉼표 구분>
ALLOW_MOCK_USER=false
ALLOW_DEV_TAG_INPUT=false
```

전체 목록은 [README §2](../README.md#2-실제-sheet-연결에-필요한-값),
전환 절차는 [README §5](../README.md#5-mock--google_sheets-전환-절차),
파일럿 진행은 [운영 체크리스트](PILOT_CHECKLIST.md) 를 따르세요.

### 3) 첫 실행 확인

편집기에서 함수를 선택해 실행하면 권한 승인 화면이 뜹니다(최초 1회).

| 순서 | 실행할 함수 | 확인 |
|---|---|---|
| 1 | `setupSpreadsheet` | 로그에 시트 URL. **기존 시트는 `유지:` 로 표시** |
| 2 | `validateSetup` | 오류 0건 |
| 3 | `createAuditCampaign('PILOT_2026_09','파일럿','2026-09-01','2026-09-30')` | `Audit_Campaign` 에 ACTIVE 1건 |
| 4 | `createAuditTargetsFromMaster('PILOT_2026_09', ['a@사내','b@사내', …])` | 로그의 생성 건수 |
| 5 | `validateSetup` | 다시 오류 0건 |

`MODE=MOCK` 으로 화면만 볼 때는 위 단계 없이 배포 URL 접속만으로 동작합니다.

---

## 문제가 생기면

| 증상 | 원인 | 조치 |
|---|---|---|
| 빈 화면 | HTML 파일 이름 불일치 | `PASTE_ORDER.md` 와 이름 대조 (`index`, `styles` …) |
| `include is not defined` | `main.gs` 를 안 올림 | `main.gs` 추가 |
| 인사말에 배포자 이름 | 액세스 권한이 `Anyone` | 배포 설정을 **도메인 내 사용자**로 |
| "로그인 정보를 확인하지 못했습니다" | 외부 계정 접속 또는 배포 설정 | [README §6-3](../README.md#6-3-이메일-식별이-실패할-때-점검-순서) |
| "시트를 찾을 수 없습니다" | 시트 이름 불일치 | `SHEET_*` 스크립트 속성 지정 |
| 수정했는데 반영 안 됨 | 웹 앱은 배포 버전 기준 | **배포 → 배포 관리 → 새 버전** |
