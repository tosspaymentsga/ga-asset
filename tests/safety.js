/**
 * Pilot 배포 전 안전성 검증.
 *
 *  1. COLUMN_ALIASES 충돌 검출
 *  2. 이메일 정규화 (대소문자 / 공백)
 *  3. Audit_Target Snapshot 보호
 *  4. Audit_Log 동시성 (Lock 범위 · flush 순서 · 동시 upsert)
 *  5. Drive 사진 권한
 *  6. validateSetup 의 ERROR / WARNING 분류
 *
 * 실행: node tests/safety.js
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

function throws(name, fn, contains) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  check(
    name,
    err !== null && (!contains || String(err.message).indexOf(contains) >= 0),
    err ? err.message : '예외가 발생하지 않음'
  );
  return err;
}

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 헤더/행을 지정해 자산대장을 만든 런타임 */
function buildWithMaster(header, rows, extraProps) {
  const props = Object.assign(
    {
      MODE: 'GOOGLE_SHEETS',
      ALLOW_MOCK_USER: 'true',
      SHEET_ASSET_MASTER: '자산대장',
      ADMIN_EMAILS: 'asset.admin@company.com',
    },
    extraProps || {}
  );
  const rt = createRuntime({ activeEmail: '', properties: props });
  rt.resetExecution();
  const ss = rt.context.SpreadsheetApp.create('파일럿 시트');
  rt.scriptProps.setProperty('SPREADSHEET_ID', ss.getId());

  const master = ss.insertSheet('자산대장');
  master.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length) {
    master.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
  rt.call('setupSpreadsheet');
  return { rt, ss };
}

const STD_HEADER = [
  '자산번호', '자산명', 'TAG번호', '이메일', '성명', '조직', '지급상태',
];
const STD_ROWS = [
  ['A001', 'MacBook Air', 'Q12345', 'seho@company.com', '김세호', '경영지원팀', 'ASSIGNED'],
  ['A002', '모니터', 'Q12346', 'seho@company.com', '김세호', '경영지원팀', 'ASSIGNED'],
  ['A003', 'iPad', 'Q12347', 'jieun@company.com', '이지은', '디자인팀', 'ASSIGNED'],
  ['A004', 'MacBook Pro', 'Q12348', 'asset.admin@company.com', '박자산', '자산관리팀', 'ASSIGNED'],
];

console.log('Pilot 배포 전 안전성 검증');

/* ================================================================== */
console.log('\n[1] COLUMN_ALIASES 충돌 검출');
/* ================================================================== */
{
  // 별칭 표 자체에 필드 간 충돌이 없는지 (설정 자체의 건강성)
  const rt0 = createRuntime({});
  const aliases = rt0.context.COLUMN_ALIASES;
  const norm = rt0.context.SheetMapper.normalize.bind(rt0.context.SheetMapper);
  const tableConflicts = [];
  for (const sheet in aliases) {
    const seen = {};
    for (const field in aliases[sheet]) {
      for (const alias of aliases[sheet][field]) {
        const n = norm(alias);
        if (seen[n] && seen[n] !== field) {
          tableConflicts.push(sheet + '.' + alias + ': ' + seen[n] + ' vs ' + field);
        }
        seen[n] = field;
      }
    }
  }
  eq('별칭 표 자체에 필드 간 충돌 없음', tableConflicts, []);

  // (1) 두 컬럼이 같은 표준 필드로 인식되는 경우
  const dupHeader = ['자산번호', '자산명', 'TAG번호', '태그번호', '이메일', '지급상태'];
  const { rt } = buildWithMaster(dupHeader, [
    ['A001', '노트북', 'Q12345', 'Q99999', 'seho@company.com', 'ASSIGNED'],
  ]);
  rt.resetExecution();
  const conflicts = rt.context.SheetMapper.detectConflicts(
    'ASSET_MASTER',
    rt.context.SheetIO.header('ASSET_MASTER')
  );
  check('두 컬럼 → 같은 필드 충돌 감지', conflicts.length > 0, JSON.stringify(conflicts));
  eq('충돌 유형', conflicts[0].type, 'AMBIGUOUS_FIELD');
  eq('충돌 필드', conflicts[0].field, 'asset_tag');
  eq('충돌 컬럼 목록', conflicts[0].columns, ['TAG번호', '태그번호']);

  const v = rt.call('validateSetup');
  check('validateSetup 이 ERROR 로 보고', v.ok === false);
  check(
    '어느 컬럼이 겹치는지 알려준다',
    v.errors.some((e) => e.indexOf('TAG번호') >= 0 && e.indexOf('태그번호') >= 0),
    JSON.stringify(v.errors)
  );
  check(
    '자동 선택하지 않는다는 안내 포함',
    v.errors.some((e) => e.indexOf('자동으로 정하지 않습니다') >= 0)
  );

  // 충돌 상태에서는 Pilot 을 시작할 수 없어야 한다
  rt.call('createAuditCampaign', ['PILOT', '충돌 테스트', '2026-09-01', '2026-09-30', true]);
  throws(
    '충돌 상태에서 대상 생성 거부',
    () => rt.call('createAuditTargetsFromMaster', ['PILOT', null]),
    '모두 `asset_tag`'
  );

  // (2) 한 컬럼이 두 표준 필드로 인식되는 경우
  const fake = {
    ASSET_MASTER: {
      asset_tag: ['태그'],
      scanned_tag: ['태그'],
    },
  };
  const origin = rt.context.COLUMN_ALIASES.ASSET_MASTER;
  rt.context.COLUMN_ALIASES.ASSET_MASTER = fake.ASSET_MASTER;
  const c2 = rt.context.SheetMapper.detectConflicts('ASSET_MASTER', ['태그']);
  rt.context.COLUMN_ALIASES.ASSET_MASTER = origin;
  check('한 컬럼 → 두 필드 충돌 감지', c2.some((c) => c.type === 'AMBIGUOUS_COLUMN'),
    JSON.stringify(c2));
}

/* ================================================================== */
console.log('\n[2] 이메일 정규화');
/* ================================================================== */
{
  // 자산대장에 대소문자·공백이 뒤섞인 이메일
  const messyRows = [
    ['A001', 'MacBook Air', 'Q12345', '  Seho@Company.com ', '김세호', '경영지원팀', 'ASSIGNED'],
    ['A002', '모니터', 'Q12346', 'SEHO@COMPANY.COM', '김세호', '경영지원팀', 'ASSIGNED'],
    ['A003', 'iPad', 'Q12347', 'seho @company.com', '김세호', '경영지원팀', 'ASSIGNED'],
    ['A004', 'MacBook Pro', 'Q12348', ' Asset.Admin@Company.com', '박자산', '자산관리팀', 'ASSIGNED'],
  ];
  const { rt, ss } = buildWithMaster(STD_HEADER, messyRows);

  const u = rt.context.Util;
  eq('정규화: 앞뒤 공백', u.normalizeEmail('  a@b.com '), 'a@b.com');
  eq('정규화: 대문자', u.normalizeEmail('A@B.COM'), 'a@b.com');
  eq('정규화: 중간 공백', u.normalizeEmail('a @b.com'), 'a@b.com');
  eq('정규화: 줄바꿈', u.normalizeEmail('a@b.com\n'), 'a@b.com');
  eq('정규화: 빈 값', u.normalizeEmail(null), '');

  const repo = rt.context.RepoUtil;
  check('비교: 대소문자 무시', repo.matchEmail('A@B.com', 'a@b.com'));
  check('비교: 공백 무시', repo.matchEmail(' a@b.com ', 'a@b.com'));
  check('빈 값끼리는 일치로 보지 않는다', !repo.matchEmail('', ''));
  check('빈 값과 실제 값은 불일치', !repo.matchEmail('', 'a@b.com'));

  rt.call('createAuditCampaign', ['PILOT', '정규화', '2026-09-01', '2026-09-30', true]);
  const built = rt.call('createAuditTargetsFromMaster', ['PILOT', ['SEHO@company.com ']]);
  eq('대상 필터도 정규화되어 매칭', built.created, 3);

  rt.resetExecution();
  const targets = rt.context.Repository.listTargetsByCampaign('PILOT');
  check(
    'Audit_Target 에는 정규화된 이메일이 기록된다',
    targets.every((t) => t.user_email === 'seho@company.com'),
    JSON.stringify(targets.map((t) => t.user_email))
  );

  // 원본 시트는 그대로여야 한다
  eq(
    'Asset_Master 원본 값은 수정하지 않는다',
    ss.getSheetByName('자산대장').getRange(2, 4).getValues()[0][0],
    '  Seho@Company.com '
  );

  // 로그인 이메일이 대문자로 와도 동일 사용자로 인식
  rt.setActiveEmail('SEHO@Company.com');
  rt.resetExecution();
  rt.context.Auth.signOutMockUser();
  rt.setProperty('ALLOW_MOCK_USER', 'false');
  const view = rt.call('getMyAssets');
  check('대문자 로그인 이메일도 동일 사용자', view.ok === true, JSON.stringify(view));
  eq('자산 3건 조회', view.data.assets.length, 3);
  eq('세션 이메일 정규화', view.data.user.email, 'seho@company.com');

  // 관리자 판정도 정규화된다
  rt.setActiveEmail(' ASSET.ADMIN@company.com ');
  rt.resetExecution();
  const adminView = rt.call('getMyAssets');
  check('관리자 판정도 정규화 적용', adminView.data.user.isAdmin === true);

  // 기록된 로그의 user_email 도 정규화된 값
  rt.setActiveEmail('SEHO@Company.com');
  rt.call('verifyQr', ['Q12345', '']);
  rt.resetExecution();
  const logs = rt.context.Repository.listLogsByCampaign('PILOT');
  eq('Audit_Log 이메일 정규화', logs[0].user_email, 'seho@company.com');

  // validateSetup 이 정리 필요한 이메일을 경고
  const v = rt.call('validateSetup');
  check(
    '공백 섞인 이메일을 경고',
    v.warnings.some((w) => w.indexOf('공백') >= 0),
    JSON.stringify(v.warnings)
  );
}

/* ================================================================== */
console.log('\n[3] Audit_Target Snapshot 보호');
/* ================================================================== */
{
  const { rt, ss } = buildWithMaster(STD_HEADER, STD_ROWS);
  rt.call('createAuditCampaign', ['PILOT', '스냅샷', '2026-09-01', '2026-09-30', true]);
  const first = rt.call('createAuditTargetsFromMaster', ['PILOT', null]);
  eq('최초 생성 4건', first.created, 4);

  const targetSheet = ss.getSheetByName('Audit_Target');
  const rowsAfterFirst = targetSheet.getLastRow();

  // 재실행 거부
  throws(
    '동일 차수 재생성 거부',
    () => rt.call('createAuditTargetsFromMaster', ['PILOT', null]),
    '이미'
  );
  eq('행이 늘어나지 않는다', targetSheet.getLastRow(), rowsAfterFirst);

  // onlyEmails 를 바꿔서 재실행해도 거부
  throws(
    '대상 범위를 바꿔도 재생성 거부',
    () => rt.call('createAuditTargetsFromMaster', ['PILOT', ['seho@company.com']]),
    '이미'
  );
  eq('행 수 여전히 동일', targetSheet.getLastRow(), rowsAfterFirst);

  // 활성 차수 지정 없이 호출해도 거부
  throws('차수 미지정 재실행도 거부', () =>
    rt.call('createAuditTargetsFromMaster', [null, null])
  );

  // 스냅샷 내용 보존 확인
  rt.resetExecution();
  const before = rt.context.Repository.listTargetsByCampaign('PILOT')
    .map((t) => t.asset_id + ':' + t.asset_tag + ':' + t.user_email + ':' + t.asset_name)
    .sort();

  // Asset_Master 를 바꿔본다: 소유자 변경 / 자산명 변경 / Tag 변경 / 신규 자산 / 지급해제
  const master = ss.getSheetByName('자산대장');
  master.getRange(2, 4).setValues([['other@company.com']]);   // A001 소유자 변경
  master.getRange(3, 2).setValues([['모니터(교체)']]);          // A002 자산명 변경
  master.getRange(4, 3).setValues([['Q99999']]);              // A003 Tag 변경
  master.getRange(5, 7).setValues([['IN_STOCK']]);            // A004 지급 해제
  master.getRange(6, 1, 1, STD_HEADER.length).setValues([
    ['A009', '신규 자산', 'Q12399', 'seho@company.com', '김세호', '경영지원팀', 'ASSIGNED'],
  ]);

  rt.resetExecution();
  const after = rt.context.Repository.listTargetsByCampaign('PILOT')
    .map((t) => t.asset_id + ':' + t.asset_tag + ':' + t.user_email + ':' + t.asset_name)
    .sort();
  eq('Master 변경이 기존 Snapshot 에 영향 없음', after, before);

  // 대시보드 분모도 그대로
  rt.setProperty('ALLOW_MOCK_USER', 'true');
  rt.call('devSignInAs', ['asset.admin@company.com']);
  const dash = rt.call('getAdminDashboard', ['PILOT']);
  eq('실사 분모 불변', dash.data.asset.total, 4);

  // 신규 자산은 대상에 포함되지 않는다
  rt.call('devSignInAs', ['seho@company.com']);
  const myView = rt.call('getMyAssets').data;
  check(
    'Master 에 추가된 자산은 이번 차수 대상이 아니다',
    myView.assets.every((a) => a.asset_id !== 'A009'),
    JSON.stringify(myView.assets.map((a) => a.asset_id))
  );
  // 소유자가 바뀐 A001 도 여전히 원래 사용자의 대상
  check(
    'Master 에서 소유자가 바뀌어도 기존 대상은 유지',
    myView.assets.some((a) => a.asset_id === 'A001'),
    JSON.stringify(myView.assets.map((a) => a.asset_id))
  );
}

/* ================================================================== */
console.log('\n[4] Audit_Log 동시성');
/* ================================================================== */
{
  const { rt, ss } = buildWithMaster(STD_HEADER, STD_ROWS);
  rt.call('createAuditCampaign', ['PILOT', '동시성', '2026-09-01', '2026-09-30', true]);
  rt.call('createAuditTargetsFromMaster', ['PILOT', null]);
  rt.call('devSignInAs', ['seho@company.com']);

  // Lock 획득 → flush → Lock 해제 순서
  rt.lockEvents.length = 0;
  rt.call('verifyQr', ['Q12345', '']);
  const seq = rt.lockEvents.join(',');
  check('Lock 획득 → flush → 해제 순서', seq === 'lock,flush,unlock', seq);

  // 읽기 경로에는 Lock 이 걸리지 않아야 한다
  rt.lockEvents.length = 0;
  rt.call('getMyAssets');
  eq('조회에는 Lock 미사용', rt.lockEvents, []);
  rt.lockEvents.length = 0;
  rt.call('devSignInAs', ['asset.admin@company.com']);
  rt.call('getAdminDashboard', ['PILOT']);
  eq('관리자 집계에도 Lock 미사용', rt.lockEvents, []);

  // 세 가지 상태 전이 모두 Lock 을 사용한다
  rt.call('devSignInAs', ['seho@company.com']);
  rt.lockEvents.length = 0;
  rt.call('submitPhoto', ['A002', TINY_PNG, 'image/png']);
  check('PHOTO_SUBMITTED 도 Lock 사용', rt.lockEvents.join(',') === 'lock,flush,unlock',
    rt.lockEvents.join(','));

  rt.lockEvents.length = 0;
  rt.call('submitException', ['A002', 'LOST', '']);
  check('NOT_IN_POSSESSION 도 Lock 사용', rt.lockEvents.join(',') === 'lock,flush,unlock',
    rt.lockEvents.join(','));

  rt.lockEvents.length = 0;
  rt.call('submitUnlistedAsset', ['Q77777', '', '', '']);
  check('Audit_Unlisted 도 Lock 사용', rt.lockEvents.join(',') === 'lock,flush,unlock',
    rt.lockEvents.join(','));

  // 동일 자산에 여러 실행이 몰려도 로그는 1건
  const logSheet = ss.getSheetByName('Audit_Log');
  const before = logSheet.getLastRow();
  for (let i = 0; i < 20; i++) {
    rt.call('verifyQr', ['Q12345', '']);
  }
  eq('20회 반복 스캔에도 행 증가 없음', logSheet.getLastRow(), before);

  rt.resetExecution();
  const logs = rt.context.Repository.listLogsByCampaign('PILOT')
    .filter((l) => l.asset_id === 'A001');
  eq('A001 로그 1건', logs.length, 1);

  // 서로 다른 사용자가 동시에 각자의 자산을 처리해도 서로 덮어쓰지 않는다
  rt.call('devSignInAs', ['jieun@company.com']);
  rt.call('verifyQr', ['Q12347', '']);
  rt.call('devSignInAs', ['asset.admin@company.com']);
  rt.call('verifyQr', ['Q12348', '']);
  rt.resetExecution();
  const all = rt.context.Repository.listLogsByCampaign('PILOT');
  const keys = all.map((l) => l.campaign_id + '|' + l.asset_id + '|' + l.user_email);
  eq('논리 키 중복 없음', keys.length, new Set(keys).size);
  // seho A001(QR) + seho A002(사진→미보유) + jieun A003 + admin A004
  eq('사용자별 로그가 각각 보존', all.length, 4);
  check(
    '각 로그의 소유자가 섞이지 않는다',
    all.every((l) =>
      (l.asset_id === 'A001' || l.asset_id === 'A002')
        ? l.user_email === 'seho@company.com'
        : l.asset_id === 'A003'
          ? l.user_email === 'jieun@company.com'
          : l.user_email === 'asset.admin@company.com'
    ),
    JSON.stringify(all.map((l) => l.asset_id + '=' + l.user_email))
  );

  // Lock 획득 실패 시 사용자 친화적 메시지
  rt.resetExecution();
  const origLock = rt.context.LockService.getScriptLock;
  rt.context.LockService.getScriptLock = () => ({
    tryLock: () => false,
    waitLock: () => false,
    releaseLock: () => {},
  });
  rt.call('devSignInAs', ['seho@company.com']);
  const busy = rt.call('verifyQr', ['Q12346', '']);
  rt.context.LockService.getScriptLock = origLock;
  check('Lock 실패 시 실패 응답', busy.ok === false, JSON.stringify(busy));
  eq('사용자 친화적 메시지', busy.message, '다른 처리가 진행 중입니다. 잠시 후 다시 시도해주세요.');
}

/* ================================================================== */
console.log('\n[5] Drive 사진 권한');
/* ================================================================== */
{
  const { rt } = buildWithMaster(STD_HEADER, STD_ROWS, {
    DRIVE_ROOT_FOLDER_ID: '',
  });
  // 운영 폴더를 지정한 상태를 만든다
  rt.resetExecution();
  const folder = rt.context.DriveApp.createFolder('자산실사 증빙');
  rt.setProperty('DRIVE_ROOT_FOLDER_ID', folder.getId());

  rt.call('createAuditCampaign', ['PILOT', '사진', '2026-09-01', '2026-09-30', true]);
  rt.call('createAuditTargetsFromMaster', ['PILOT', null]);

  rt.call('devSignInAs', ['seho@company.com']);
  const submitted = rt.call('submitPhoto', ['A001', TINY_PNG, 'image/png']);
  check('사진 제출 성공', submitted.ok === true, JSON.stringify(submitted).slice(0, 200));

  rt.resetExecution();
  const log = rt.context.Repository.listLogsByCampaign('PILOT')
    .find((l) => l.asset_id === 'A001');
  const fileId = String(log.photo_file_id);
  check('Drive File ID 기록', fileId.indexOf('file-') === 0, fileId);

  // 지정한 운영 폴더 아래에 저장되었는지 (차수 / 이메일 하위 폴더)
  const campaignFolder = folder.children.find((f) => f.getName() === 'PILOT');
  check('차수 폴더 생성', !!campaignFolder);
  const userFolder = campaignFolder &&
    campaignFolder.children.find((f) => f.getName() === 'seho@company.com');
  check('사용자 폴더 생성', !!userFolder);
  check('파일이 사용자 폴더에 저장', userFolder && userFolder.fileIds.indexOf(fileId) >= 0);
  check(
    '루트에 직접 저장되지 않음',
    folder.fileIds.indexOf(fileId) < 0,
    JSON.stringify(folder.fileIds)
  );

  // 본인은 열람 가능
  const mine = rt.call('getPhotoDataUrl', [fileId]);
  check('본인 증빙 열람 가능', mine.ok === true && typeof mine.data === 'string');

  // 다른 직원은 file id 를 알아도 열람 불가
  rt.call('devSignInAs', ['jieun@company.com']);
  const stolen = rt.call('getPhotoDataUrl', [fileId]);
  check('타인은 File ID 를 알아도 열람 불가', stolen.ok === false, JSON.stringify(stolen));
  eq('권한 메시지', stolen.message, '접근 권한이 없습니다.');

  // 존재하지 않는/추측한 ID 도 거부
  const guessed = rt.call('getPhotoDataUrl', ['file-guessed-id']);
  check('추측한 File ID 거부', guessed.ok === false);

  // 관리자는 열람 가능
  rt.call('devSignInAs', ['asset.admin@company.com']);
  const asAdmin = rt.call('getPhotoDataUrl', [fileId]);
  check('관리자는 열람 가능', asAdmin.ok === true && typeof asAdmin.data === 'string');

  // 클라이언트로 내려가는 데이터에 Drive URL 이 포함되지 않는다
  rt.call('devSignInAs', ['seho@company.com']);
  const myView = JSON.stringify(rt.call('getMyAssets').data);
  check('직원 응답에 Drive URL 없음', myView.indexOf('drive.google.com') < 0);
  check('직원 응답에 photo_url 필드 없음', myView.indexOf('photo_url') < 0);

  rt.call('devSignInAs', ['asset.admin@company.com']);
  const adminList = JSON.stringify(rt.call('getAdminAuditList', [{}]).data);
  check('관리자 목록에도 Drive URL 없음', adminList.indexOf('drive.google.com') < 0);
  const recon = JSON.stringify(rt.call('getAdminReconciliation', [{}]).data);
  check('확인 필요 목록에도 Drive URL 없음', recon.indexOf('drive.google.com') < 0);
}

/* ================================================================== */
console.log('\n[6] validateSetup 분류');
/* ================================================================== */
{
  // 정상 구성 → ok
  const { rt } = buildWithMaster(STD_HEADER, STD_ROWS);
  rt.call('createAuditCampaign', ['PILOT', '정상', '2026-09-01', '2026-09-30', true]);
  rt.call('createAuditTargetsFromMaster', ['PILOT', null]);
  rt.setProperty('MODE', 'GOOGLE_SHEETS');
  rt.setProperty('ALLOW_MOCK_USER', 'false');
  rt.setProperty('ALLOW_DEV_TAG_INPUT', 'false');
  const ok = rt.call('validateSetup');
  check('정상 구성은 오류 0건', ok.ok === true, JSON.stringify(ok.errors));

  // ERROR: 중복 Tag
  const dup = buildWithMaster(STD_HEADER, [
    ['A001', '노트북', 'Q12345', 'a@company.com', '가', '팀', 'ASSIGNED'],
    ['A002', '모니터', 'Q12345', 'b@company.com', '나', '팀', 'ASSIGNED'],
  ]).rt;
  dup.call('createAuditCampaign', ['P', 'x', '2026-09-01', '2026-09-30', true]);
  dup.call('createAuditTargetsFromMaster', ['P', null]);
  const dupV = dup.call('validateSetup');
  check('중복 Tag → ERROR', dupV.ok === false);
  check('중복 Tag 메시지', dupV.errors.some((e) => e.indexOf('asset_tag 가 중복') >= 0));

  // ERROR: 활성 차수 2개
  const two = buildWithMaster(STD_HEADER, STD_ROWS).rt;
  two.call('createAuditCampaign', ['P1', 'x', '2026-09-01', '2026-09-30', true]);
  two.call('createAuditTargetsFromMaster', ['P1', null]);
  two.resetExecution();
  two.context.SheetIO.appendObject('AUDIT_CAMPAIGN', {
    campaign_id: 'P2', campaign_name: 'y', status: 'ACTIVE',
  });
  const twoV = two.call('validateSetup');
  check('활성 차수 2개 → ERROR', twoV.ok === false);
  check('활성 차수 메시지', twoV.errors.some((e) => e.indexOf('ACTIVE 차수가 2개') >= 0),
    JSON.stringify(twoV.errors));

  // ERROR: 활성 차수 없음
  const none = buildWithMaster(STD_HEADER, STD_ROWS).rt;
  const noneV = none.call('validateSetup');
  check('활성 차수 없음 → ERROR', noneV.ok === false);
  check('차수 없음 메시지', noneV.errors.some((e) => e.indexOf('ACTIVE 차수가 없습니다') >= 0));

  // ERROR: 필수 시트 없음
  const missing = buildWithMaster(STD_HEADER, STD_ROWS);
  missing.ss.deleteSheet(missing.ss.getSheetByName('Audit_Log'));
  const missV = missing.rt.call('validateSetup');
  check('필수 시트 없음 → ERROR', missV.ok === false);
  check('시트 없음 메시지', missV.errors.some((e) => e.indexOf('열 수 없습니다') >= 0),
    JSON.stringify(missV.errors));

  // ERROR: Drive 폴더 접근 불가
  const drive = buildWithMaster(STD_HEADER, STD_ROWS, {
    DRIVE_ROOT_FOLDER_ID: 'nonexistent-folder',
  }).rt;
  drive.call('createAuditCampaign', ['P', 'x', '2026-09-01', '2026-09-30', true]);
  drive.call('createAuditTargetsFromMaster', ['P', null]);
  const driveV = drive.call('validateSetup');
  check('Drive 폴더 접근 불가 → ERROR', driveV.ok === false);
  check('Drive 메시지', driveV.errors.some((e) => e.indexOf('DRIVE_ROOT_FOLDER_ID') >= 0));

  // WARNING: 이메일/Tag 없는 지급 자산, 관리자 미설정
  const warn = buildWithMaster(
    STD_HEADER,
    [
      ['A001', '노트북', 'Q12345', 'a@company.com', '가', '팀', 'ASSIGNED'],
      ['A002', '모니터', 'Q12346', '', '나', '팀', 'ASSIGNED'],
      ['A003', '키보드', '', 'c@company.com', '다', '팀', 'ASSIGNED'],
    ],
    { ADMIN_EMAILS: '' }
  ).rt;
  warn.call('createAuditCampaign', ['P', 'x', '2026-09-01', '2026-09-30', true]);
  warn.call('createAuditTargetsFromMaster', ['P', null]);
  const warnV = warn.call('validateSetup');
  check('운영 가능한 항목은 ERROR 가 아니다', warnV.ok === true, JSON.stringify(warnV.errors));
  check('이메일 없는 지급 자산 → WARNING',
    warnV.warnings.some((w) => w.indexOf('이메일이 없는 자산') >= 0));
  check('Tag 없는 지급 자산 → WARNING',
    warnV.warnings.some((w) => w.indexOf('asset_tag 가 없는 자산') >= 0));
  check('관리자 미설정 → WARNING',
    warnV.warnings.some((w) => w.indexOf('관리자가 설정되지 않았습니다') >= 0),
    JSON.stringify(warnV.warnings));
}

console.log('\n----------------------------------------');
console.log('통과 ' + passed + ' / 실패 ' + failed);
if (failures.length) {
  console.log('\n실패 목록:');
  failures.forEach((f) => console.log(' - ' + f));
}
process.exit(failed ? 1 : 0);
