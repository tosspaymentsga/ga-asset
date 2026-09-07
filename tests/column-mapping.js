/**
 * 실제 회사 시트 연결 시뮬레이션 (§3 컬럼 매핑 검증).
 *
 * 회사 자산대장이 아래처럼 되어 있다고 가정한다.
 *   - 시트 이름:  `자산대장`      (Asset_Master 아님)
 *   - 컬럼 이름:  사번 / 성명 / 이메일 / 조직 / 자산번호 / 자산명 /
 *                모델명 / Serial / TAG번호 / 지급상태
 *   - 컬럼 순서:  표준 스키마와 다름
 *   - 여분 컬럼:  비고 (코드가 모르는 컬럼)
 *
 * 코드는 한 줄도 고치지 않고, 스크립트 속성(SHEET_ASSET_MASTER)과
 * config.gs 의 COLUMN_ALIASES 만으로 동작해야 한다.
 *
 * 실행: node tests/column-mapping.js
 */
'use strict';

const { createRuntime } = require('./harness/gas-runtime');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected)
  );
}

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* 회사 자산대장 (컬럼명·순서 모두 다르고, 코드가 모르는 `비고` 컬럼 포함) */
const COMPANY_HEADER = [
  '사번', '성명', '이메일', '조직', '자산번호', '자산명',
  '모델명', 'Serial', 'TAG번호', '지급상태', '비고',
];

const COMPANY_ROWS = [
  ['E1001', '김세호', 'seho@company.com', '경영지원팀', 'A001', 'MacBook Air 13', 'Apple M3', 'SN0001', 'Q12345', 'ASSIGNED', '2024년 지급'],
  ['E1001', '김세호', 'seho@company.com', '경영지원팀', 'A002', '모니터 27형', 'LG 27UP850N', 'SN0002', 'Q12346', 'ASSIGNED', ''],
  ['E1002', '이지은', 'jieun@company.com', '프로덕트디자인팀', 'A003', 'iPad', 'iPad Air 11', 'SN0003', 'Q12347', 'ASSIGNED', ''],
  ['E1002', '이지은', 'jieun@company.com', '프로덕트디자인팀', 'A004', '키보드', 'Magic Keyboard', 'SN0004', 'Q12348', 'ASSIGNED', ''],
  ['E1003', '박자산', 'asset.admin@company.com', '자산관리팀', 'A005', 'MacBook Pro 14', 'Apple M3 Pro', 'SN0005', 'Q12349', 'ASSIGNED', ''],
  ['E1004', '최민서', 'minseo@company.com', '영업1팀', 'A006', 'iPhone', 'iPhone 15', 'SN0006', 'Q12350', 'ASSIGNED', ''],
  // 미지급 재고 — 실사 대상이 아니어야 한다
  ['', '', '', '', 'A007', '모니터 27형', 'Dell U2723QE', 'SN0007', 'Q12351', 'IN_STOCK', '창고'],
  // Tag 가 없는 자산 — 대상에서 제외되어야 한다
  ['E1005', '한지우', 'jiwoo@company.com', '개발1팀', 'A008', '마우스', 'MX Master', 'SN0008', '', 'ASSIGNED', ''],
];

function buildRuntime() {
  const rt = createRuntime({
    activeEmail: '',
    properties: {
      MODE: 'GOOGLE_SHEETS',
      ALLOW_MOCK_USER: 'true',
      ALLOW_DEV_TAG_INPUT: 'true',
      // 시트 이름이 다르다 → 스크립트 속성으로 지정
      SHEET_ASSET_MASTER: '자산대장',
      ADMIN_EMAILS: 'asset.admin@company.com',
    },
  });

  // 회사가 이미 가지고 있는 자산대장을 만든다
  rt.resetExecution();
  const ss = rt.context.SpreadsheetApp.create('회사 자산 관리');
  rt.scriptProps.setProperty('SPREADSHEET_ID', ss.getId());

  const master = ss.insertSheet('자산대장');
  master.getRange(1, 1, 1, COMPANY_HEADER.length).setValues([COMPANY_HEADER]);
  master
    .getRange(2, 1, COMPANY_ROWS.length, COMPANY_HEADER.length)
    .setValues(COMPANY_ROWS);

  // 나머지 시트는 앱이 만든다 (자산대장은 이미 데이터가 있으므로 건드리지 않아야 한다)
  rt.call('setupSpreadsheet');
  return { rt, ss };
}

console.log('실제 시트 연결 시뮬레이션 (컬럼명/순서/시트명이 모두 다른 경우)');

const { rt, ss } = buildRuntime();

/* -------- 1. 시트 준비 -------- */
console.log('\n[1] 시트 준비');
check('자산대장 헤더를 덮어쓰지 않는다',
  ss.getSheetByName('자산대장').getRange(1, 1, 1, 11).getValues()[0].join(',') ===
    COMPANY_HEADER.join(','));
check('실사용 시트가 생성된다', !!ss.getSheetByName('Audit_Log'));
check('자산대장 데이터가 그대로다',
  ss.getSheetByName('자산대장').getLastRow() === COMPANY_ROWS.length + 1);

/* -------- 2. 컬럼 매핑 -------- */
console.log('\n[2] 컬럼 매핑');
rt.resetExecution();
const assets = rt.context.SheetIO.objects('ASSET_MASTER');
eq('자산 8건 인식', assets.length, 8);
eq('자산번호 → asset_id', assets[0].asset_id, 'A001');
eq('TAG번호 → asset_tag', assets[0].asset_tag, 'Q12345');
eq('성명 → user_name', assets[0].user_name, '김세호');
eq('이메일 → user_email', assets[0].user_email, 'seho@company.com');
eq('조직 → department', assets[0].department, '경영지원팀');
eq('모델명 → model', assets[0].model, 'Apple M3');
eq('Serial → serial_number', assets[0].serial_number, 'SN0001');
eq('지급상태 → asset_status', assets[0].asset_status, 'ASSIGNED');
eq('사번 → employee_no (선택 항목)', assets[0].employee_no, 'E1001');
check('모르는 컬럼(비고)은 무시된다', assets[0]['비고'] === undefined);

/* -------- 3. 차수 · 대상 스냅샷 -------- */
console.log('\n[3] 차수 생성과 대상 Snapshot');
let res = rt.call('createAuditCampaign', [
  'PILOT_2026_09', '2026 하반기 파일럿', '2026-09-01', '2026-09-30', true,
]);
check('차수 생성', typeof res === 'string' || res === 'PILOT_2026_09');

// 파일럿: 지정한 사용자만 대상에 넣는다
res = rt.call('createAuditTargetsFromMaster', [
  'PILOT_2026_09',
  ['seho@company.com', 'jieun@company.com', 'asset.admin@company.com'],
]);
eq('대상 5건 (미지급·Tag없음·필터 제외)', res.created, 5);
eq('미지급 제외', res.skipped.notAssigned, 1);
eq('Tag 없음 제외', res.skipped.noTag, 1);
eq('파일럿 필터 제외', res.skipped.filtered, 1);

// 중복 실행은 거부되어야 한다 (실사 분모 보호)
let refused = null;
try {
  rt.call('createAuditTargetsFromMaster', ['PILOT_2026_09', null]);
} catch (err) {
  refused = err;
}
check('재실행은 거부된다', refused !== null);
check(
  '거부 사유를 알려준다',
  refused && String(refused.message).indexOf('이미') >= 0,
  refused && refused.message
);
rt.resetExecution();
eq(
  '대상 건수 불변',
  rt.context.Repository.listTargetsByCampaign('PILOT_2026_09').length,
  5
);

/* -------- 4. Asset_Master 는 변하지 않는다 -------- */
console.log('\n[4] Asset_Master 불변');
const masterAfter = ss.getSheetByName('자산대장');
eq('행 수 유지', masterAfter.getLastRow(), COMPANY_ROWS.length + 1);
eq(
  '첫 행 값 유지',
  masterAfter.getRange(2, 1, 1, COMPANY_HEADER.length).getValues()[0],
  COMPANY_ROWS[0]
);

/* -------- 5. 직원 플로우 -------- */
console.log('\n[5] 직원 플로우');
rt.call('devSignInAs', ['seho@company.com']);
let view = rt.call('getMyAssets').data;
eq('사용자 이름', view.user.name, '김세호');
eq('부서', view.user.department, '경영지원팀');
eq('내 자산 2건', view.assets.length, 2);
eq('자산 목록', view.assets.map((a) => a.asset_id), ['A001', 'A002']);
check('타인 정보 미노출', JSON.stringify(view).indexOf('이지은') < 0);
check('serial 미노출', JSON.stringify(view).indexOf('SN0001') < 0);
check('사번 미노출', JSON.stringify(view).indexOf('E1001') < 0);

res = rt.call('verifyQr', ['Q12345', '']);
eq('QR 확인', res.data.result, 'MATCHED');
eq('자산명', res.data.asset.asset_name, 'MacBook Air 13');
eq('진행률', [res.data.progress.responded, res.data.progress.total], [1, 2]);

res = rt.call('verifyQr', ['Q12345', '']);
eq('재스캔 idempotent', res.data.already_verified, true);
rt.resetExecution();
const logs = rt.context.Repository.listLogsByCampaign('PILOT_2026_09');
eq('로그 1건만', logs.filter((l) => l.asset_id === 'A001').length, 1);

res = rt.call('verifyQr', ['Q12347', '']); // 이지은 자산
eq('타인 자산은 NOT_MINE', res.data.result, 'NOT_MINE');
check('소유자 정보 미노출', JSON.stringify(res.data).indexOf('jieun') < 0);

res = rt.call('submitPhoto', ['A002', TINY_PNG, 'image/png']);
eq('사진 제출', res.data.asset.audit_status, 'PHOTO_SUBMITTED');

view = rt.call('getMyAssets').data;
eq('전체 응답 완료', view.progress.completed, true);

/* -------- 6. Audit_Log 기록이 실제 컬럼에 들어갔는지 -------- */
console.log('\n[6] Audit_Log 기록 위치');
const logSheet = ss.getSheetByName('Audit_Log');
const logHeader = logSheet.getRange(1, 1, 1, logSheet.getLastColumn()).getValues()[0];
const logRow = logSheet.getRange(2, 1, 1, logSheet.getLastColumn()).getValues()[0];
const col = (name) => logRow[logHeader.indexOf(name)];
eq('campaign_id', col('campaign_id'), 'PILOT_2026_09');
eq('asset_id', col('asset_id'), 'A001');
eq('user_email', col('user_email'), 'seho@company.com');
eq('audit_status', col('audit_status'), 'QR_VERIFIED');
check('사진 바이너리 미저장', logSheet.getRange(3, 1, 1, logSheet.getLastColumn())
  .getValues()[0].join('').indexOf(TINY_PNG.slice(0, 30)) < 0);

/* -------- 7. 컬럼 순서가 달라도 동작 -------- */
console.log('\n[7] Audit_Log 컬럼 순서를 뒤집어도 동작');
{
  // 헤더와 데이터를 역순으로 재배치한다
  const lastRow = logSheet.getLastRow();
  const lastCol = logSheet.getLastColumn();
  const all = logSheet.getRange(1, 1, lastRow, lastCol).getValues();
  const reversed = all.map((row) => row.slice().reverse());
  logSheet.getRange(1, 1, lastRow, lastCol).setValues(reversed);

  rt.resetExecution();
  const found = rt.context.SheetRepository.findLog(
    'PILOT_2026_09', 'A001', 'seho@company.com'
  );
  check('역순 헤더에서도 로그를 찾는다', !!found, JSON.stringify(found));
  eq('상태 값 정상', found && found.audit_status, 'QR_VERIFIED');

  // 역순 상태에서 추가 upsert 도 정상 동작해야 한다
  const before = logSheet.getLastRow();
  rt.call('devSignInAs', ['asset.admin@company.com']);
  const scan = rt.call('verifyQr', ['Q12349', '']);
  eq('역순 헤더에서도 QR 확인', scan.data.result, 'MATCHED');
  eq('행이 1개만 늘어난다', logSheet.getLastRow(), before + 1);

  rt.resetExecution();
  const reloaded = rt.context.SheetRepository.findLog(
    'PILOT_2026_09', 'A005', 'asset.admin@company.com'
  );
  eq('새 로그도 올바른 컬럼에 기록', reloaded && reloaded.audit_status, 'QR_VERIFIED');
}

/* -------- 8. 관리자 -------- */
console.log('\n[8] 관리자');
res = rt.call('getAdminDashboard', ['']);
check('관리자 조회 가능', res.ok === true, JSON.stringify(res).slice(0, 200));
eq('전체 대상 5건', res.data.asset.total, 5);
eq('완료 3건 (QR 2 + 사진 1)', res.data.asset.completed, 3);
eq('전체 대상 사용자 3명', res.data.user.total, 3);

const list = rt.call('getAdminAuditList', [{ query: 'Q12345' }]).data;
eq('Tag 검색', list.rows.length, 1);
eq('검색 결과 사용자', list.rows[0].user_name, '김세호');

/* -------- 9. validateSetup -------- */
console.log('\n[9] 연결 점검 (validateSetup)');
const validation = rt.call('validateSetup');
check('오류 없음', validation.ok === true, JSON.stringify(validation.errors));
eq('활성 차수', validation.info.activeCampaign, 'PILOT_2026_09');
eq('대상 자산 수', validation.info.targets.assets, 5);
eq('대상 사용자 수', validation.info.targets.users, 3);
eq('자산대장 행 수', validation.info.assetMaster.rows, 8);
eq('Tag 중복 없음', validation.info.assetMaster.duplicateTags, 0);
check(
  'Tag 없는 자산을 경고한다',
  validation.warnings.some((w) => w.indexOf('asset_tag') >= 0),
  JSON.stringify(validation.warnings)
);
check(
  '데모 모드를 경고한다',
  validation.warnings.some((w) => w.indexOf('ALLOW_MOCK_USER') >= 0)
);

/* -------- 10. 매핑 누락 감지 -------- */
console.log('\n[10] 매핑 누락 감지');
{
  const rt2 = createRuntime({
    activeEmail: '',
    properties: { MODE: 'GOOGLE_SHEETS', SHEET_ASSET_MASTER: '자산대장' },
  });
  rt2.resetExecution();
  const ss2 = rt2.context.SpreadsheetApp.create('잘못된 자산대장');
  rt2.scriptProps.setProperty('SPREADSHEET_ID', ss2.getId());
  const bad = ss2.insertSheet('자산대장');
  // TAG 컬럼이 알 수 없는 이름이다
  bad.getRange(1, 1, 1, 4).setValues([['자산번호', '자산명', '큐알코드', '이메일']]);
  bad.getRange(2, 1, 1, 4).setValues([['A001', '노트북', 'Q1', 'a@b.com']]);
  rt2.call('setupSpreadsheet');

  const v2 = rt2.call('validateSetup');
  check('필수 컬럼 누락을 오류로 잡는다', v2.ok === false);
  check(
    '어떤 컬럼이 없는지 알려준다',
    v2.errors.some((e) => e.indexOf('asset_tag') >= 0 && e.indexOf('COLUMN_ALIASES') >= 0),
    JSON.stringify(v2.errors)
  );
}

console.log('\n----------------------------------------');
console.log('통과 ' + passed + ' / 실패 ' + failed);
if (failures.length) {
  console.log('\n실패 목록:');
  failures.forEach((f) => console.log(' - ' + f));
}
process.exit(failed ? 1 : 0);
