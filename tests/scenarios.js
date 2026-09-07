/**
 * 서버 로직 검증 (§26 시나리오).
 *
 * 실제 `src/server/*.gs` 를 Apps Script 에뮬레이터로 구동해 확인한다.
 * MOCK / GOOGLE_SHEETS 두 모드에서 동일하게 통과해야 한다.
 *
 * 실행: node tests/scenarios.js
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

/** 1x1 투명 PNG (base64) */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function buildRuntime(mode) {
  const runtime = createRuntime({
    activeEmail: '',
    properties: { MODE: mode, ALLOW_MOCK_USER: 'true', ALLOW_DEV_TAG_INPUT: 'true' },
  });

  if (mode === 'GOOGLE_SHEETS') {
    runtime.call('setupSpreadsheet');
    runtime.call('seedSampleData');
    runtime.call('buildAuditTargets');
    runtime.context.MockData.seedLogs().forEach((log) => {
      runtime.resetExecution();
      runtime.context.SheetRepository.upsertLog(log);
    });
    runtime.context.MockData.seedUnlisted().forEach((rec) => {
      runtime.resetExecution();
      runtime.context.SheetRepository.upsertUnlisted(rec);
    });
  }
  return runtime;
}

/** 저장소에 남아 있는 전체 Audit_Log 를 직접 확인 (UI 를 거치지 않는 검증) */
function readLogs(rt, campaignId) {
  rt.resetExecution();
  return rt.context.Repository.listLogsByCampaign(campaignId);
}

function readUnlisted(rt, campaignId) {
  rt.resetExecution();
  return rt.context.Repository.listUnlistedByCampaign(campaignId);
}

function run(mode) {
  console.log('\n=== MODE=' + mode + ' ===');
  const rt = buildRuntime(mode);
  const CAMPAIGN = 'AUDIT_2026_H2';

  /* -------- Scenario 1: 접속 → 본인 자산만 -------- */
  console.log('\n[1] 접속 → 현재 사용자 확인 → 본인 자산만 표시');
  let res = rt.call('devSignInAs', ['seho@company.com']);
  check('로그인 성공', res.ok === true, JSON.stringify(res).slice(0, 200));
  let view = rt.call('getMyAssets').data;
  eq('사용자 이름', view.user.name, '김세호');
  eq('본인 자산 3건', view.assets.length, 3);
  eq(
    '자산번호 A001~A003',
    view.assets.map((a) => a.asset_id),
    ['A001', 'A002', 'A003']
  );
  check(
    '다른 사용자 자산 미포함',
    view.assets.every((a) => ['A001', 'A002', 'A003'].indexOf(a.asset_id) >= 0)
  );
  const payload = JSON.stringify(view);
  check('응답에 타인 이메일 없음', payload.indexOf('jieun@company.com') < 0);
  check('응답에 타인 이름 없음', payload.indexOf('이지은') < 0);
  check('응답에 serial_number 없음', payload.indexOf('serial') < 0);
  eq('초기 진행률 0/3', [view.progress.responded, view.progress.total], [0, 3]);

  /* -------- Scenario 2: 정상 QR -------- */
  console.log('\n[2] 정상 QR → QR_VERIFIED');
  res = rt.call('verifyQr', ['Q12345', '']);
  check('QR 호출 성공', res.ok === true, JSON.stringify(res).slice(0, 200));
  eq('결과 MATCHED', res.data.result, 'MATCHED');
  eq('자산명', res.data.asset.asset_name, 'MacBook Air 13');
  eq('내부 상태 QR_VERIFIED', res.data.asset.audit_status, 'QR_VERIFIED');
  eq('표시 라벨', res.data.asset.status_label, '완료');
  eq('진행률 1/3', [res.data.progress.responded, res.data.progress.total], [1, 3]);
  check('verified_at 기록', !!res.data.asset.verified_at);

  const logsAfterFirst = readLogs(rt, CAMPAIGN).filter(
    (l) => l.user_email === 'seho@company.com'
  );
  eq('seho 로그 1건', logsAfterFirst.length, 1);
  const firstVerifiedAt = logsAfterFirst[0].verified_at;

  /* -------- Scenario 3: 타 자산 QR -------- */
  console.log('\n[3] 타 자산 QR → 정보 노출 없이 확인 필요');
  res = rt.call('verifyQr', ['Q12348', '']); // A004 = 이지은 자산
  eq('결과 NOT_MINE', res.data.result, 'NOT_MINE');
  eq('스캔 Tag 반환', res.data.scanned_tag, 'Q12348');
  const notMine = JSON.stringify(res.data);
  check('소유자 이메일 미노출', notMine.indexOf('jieun') < 0, notMine);
  check('소유자 이름 미노출', notMine.indexOf('이지은') < 0, notMine);
  check('자산명 미노출', notMine.indexOf('MacBook Pro') < 0, notMine);

  res = rt.call('verifyQr', ['Q99999', '']); // Master 에도 없는 Tag
  eq('미등록 Tag 도 NOT_MINE', res.data.result, 'NOT_MINE');

  // 확인 필요로 등록
  res = rt.call('registerForeignScan', ['Q12348', '']);
  check('확인 필요 등록 성공', res.ok === true);
  eq('중복 아님', res.data.already, false);
  res = rt.call('registerForeignScan', ['Q12348', '']);
  eq('재등록은 already=true', res.data.already, true);
  const foreign = readUnlisted(rt, CAMPAIGN).filter(
    (u) => u.user_email === 'seho@company.com'
  );
  eq('Audit_Unlisted 1건만 생성', foreign.length, 1);
  eq('report_type=FOREIGN_ASSET', foreign[0].report_type, 'FOREIGN_ASSET');

  /* -------- Scenario 4: 동일 QR 재스캔 -------- */
  console.log('\n[4] 동일 QR 재스캔 → 중복 Audit_Log 생성 금지');
  res = rt.call('verifyQr', ['Q12345', '']);
  eq('두 번째도 MATCHED', res.data.result, 'MATCHED');
  eq('already_verified=true', res.data.already_verified, true);
  res = rt.call('verifyQr', ['q12345', '']); // 소문자/공백도 동일 취급
  eq('대소문자 무관 동일 처리', res.data.already_verified, true);
  res = rt.call('verifyQr', ['https://asset.company.com/t/Q12345', '']);
  eq('URL 형태 QR 도 동일 Tag', res.data.already_verified, true);

  const logsAfterRepeat = readLogs(rt, CAMPAIGN).filter(
    (l) => l.user_email === 'seho@company.com'
  );
  eq('여전히 로그 1건', logsAfterRepeat.length, 1);
  eq('최초 확인 시각 보존', logsAfterRepeat[0].verified_at, firstVerifiedAt);
  eq('진행률 여전히 1/3', rt.call('getMyAuditStatus').data.responded, 1);

  /* -------- Scenario 5: 사진 제출 -------- */
  console.log('\n[5] 사진 제출 → PHOTO_SUBMITTED');
  res = rt.call('submitPhoto', ['A002', TINY_PNG, 'image/png']);
  check('사진 제출 성공', res.ok === true, JSON.stringify(res).slice(0, 200));
  eq('상태 PHOTO_SUBMITTED', res.data.asset.audit_status, 'PHOTO_SUBMITTED');
  eq('표시 라벨', res.data.asset.status_label, '사진 제출');
  const photoLog = readLogs(rt, CAMPAIGN).find(
    (l) => l.asset_id === 'A002' && l.user_email === 'seho@company.com'
  );
  check('photo_file_id 저장', !!photoLog.photo_file_id, JSON.stringify(photoLog));
  check('photo_url 저장', !!photoLog.photo_url);
  eq('관리자 검토 대상', photoLog.review_state, 'PENDING');
  check(
    '시트에 이미지 바이너리 미저장',
    String(photoLog.photo_file_id).length < 200 &&
      JSON.stringify(photoLog).indexOf(TINY_PNG.slice(0, 40)) < 0
  );

  // 본인 사진은 열람 가능
  res = rt.call('getPhotoDataUrl', [photoLog.photo_file_id]);
  check('본인 증빙 열람 가능', res.ok === true && typeof res.data === 'string');

  /* -------- Scenario 6: 미보유 신고 -------- */
  console.log('\n[6] 미보유 신고 → NOT_IN_POSSESSION');
  res = rt.call('submitException', ['A003', 'OTHER', '']);
  check('기타 사유 메모 없으면 거부', res.ok === false);
  eq('사용자 친화적 메시지', res.message, '기타 사유는 내용을 입력해주세요.');

  res = rt.call('submitException', ['A003', 'ALREADY_RETURNED', '']);
  check('미보유 신고 성공', res.ok === true);
  eq('상태 NOT_IN_POSSESSION', res.data.asset.audit_status, 'NOT_IN_POSSESSION');
  eq('표시 라벨', res.data.asset.status_label, '확인 필요');
  const nipLog = readLogs(rt, CAMPAIGN).find(
    (l) => l.asset_id === 'A003' && l.user_email === 'seho@company.com'
  );
  eq('사유 저장', nipLog.exception_type, 'ALREADY_RETURNED');
  eq('검토 대상', nipLog.review_state, 'PENDING');

  /* -------- Scenario 7: 목록 외 자산 -------- */
  console.log('\n[7] 목록에 없는 자산 → Audit_Unlisted');
  res = rt.call('submitUnlistedAsset', ['Q77777', '옆자리에서 받은 모니터', '', '']);
  check('등록 성공', res.ok === true);
  eq('중복 아님', res.data.already, false);
  res = rt.call('submitUnlistedAsset', ['q77777 ', '메모 수정', '', '']);
  eq('동일 Tag 재등록은 upsert', res.data.already, true);
  const myUnlisted = readUnlisted(rt, CAMPAIGN).filter(
    (u) => u.user_email === 'seho@company.com'
  );
  eq('내 Unlisted 2건 (타인QR 1 + 미등록 1)', myUnlisted.length, 2);
  const unlistedRow = myUnlisted.find((u) => u.scanned_tag === 'Q77777');
  eq('report_type=UNLISTED', unlistedRow.report_type, 'UNLISTED');
  eq('메모 갱신', unlistedRow.note, '메모 수정');

  /* -------- Scenario 8: 전 자산 응답 → 완료 -------- */
  console.log('\n[8] 전 자산 응답 → 사용자 실사 완료');
  view = rt.call('getMyAssets').data;
  eq('진행률 3/3', [view.progress.responded, view.progress.total], [3, 3]);
  eq('완료 플래그', view.progress.completed, true);
  eq('QR 확인 1', view.progress.qr_verified, 1);
  eq('사진 제출 1', view.progress.photo_submitted, 1);
  eq('확인 필요 1', view.progress.not_in_possession, 1);
  check('완료 시각 존재', !!view.progress.completed_at);

  // 재접속해도 상태 유지
  view = rt.call('getMyAssets').data;
  eq('재조회 시 상태 유지', view.progress.completed, true);

  /* -------- Scenario 9: Dashboard 수치 일치 -------- */
  console.log('\n[9] Dashboard 수치 = Audit_Target 기준 수치와 일치');
  res = rt.call('getAdminDashboard', ['']);
  check('일반 직원은 관리자 API 거부', res.ok === false, JSON.stringify(res));
  eq('권한 메시지', res.message, '접근 권한이 없습니다.');

  rt.call('devSignInAs', ['asset.admin@company.com']);
  res = rt.call('getAdminDashboard', ['']);
  check('관리자는 조회 가능', res.ok === true, JSON.stringify(res).slice(0, 200));
  const dash = res.data;

  // 저장소에서 직접 재계산해 대조
  rt.resetExecution();
  const targets = rt.context.Repository.listTargetsByCampaign(CAMPAIGN);
  const logs = readLogs(rt, CAMPAIGN);
  const logByAsset = {};
  logs.forEach((l) => { if (l.asset_id) logByAsset[l.asset_id] = l; });

  let expectCompleted = 0;
  let expectNotStarted = 0;
  let expectReview = 0;
  let expectQr = 0;
  let expectPhoto = 0;
  const userMap = {};
  targets.forEach((t) => {
    const status = (logByAsset[t.asset_id] || {}).audit_status || 'NOT_STARTED';
    if (status === 'QR_VERIFIED') expectQr++;
    if (status === 'PHOTO_SUBMITTED') expectPhoto++;
    if (status === 'QR_VERIFIED' || status === 'PHOTO_SUBMITTED') expectCompleted++;
    else if (status === 'NOT_IN_POSSESSION') expectReview++;
    else expectNotStarted++;

    const email = String(t.user_email).toLowerCase();
    if (!userMap[email]) userMap[email] = { total: 0, responded: 0 };
    userMap[email].total++;
    if (['QR_VERIFIED', 'PHOTO_SUBMITTED', 'NOT_IN_POSSESSION'].indexOf(status) >= 0) {
      userMap[email].responded++;
    }
  });
  const expectUsers = Object.keys(userMap).length;
  const expectUsersDone = Object.keys(userMap).filter(
    (k) => userMap[k].total === userMap[k].responded
  ).length;

  eq('전체 대상 자산', dash.asset.total, targets.length);
  eq('실사 완료', dash.asset.completed, expectCompleted);
  eq('미실사', dash.asset.not_started, expectNotStarted);
  eq('확인 필요', dash.asset.review_required, expectReview);
  eq('QR 확인', dash.asset.qr_verified, expectQr);
  eq('사진 제출', dash.asset.photo_submitted, expectPhoto);
  eq(
    '실사율',
    dash.asset.completion_rate,
    Math.round((expectCompleted / targets.length) * 1000) / 10
  );
  eq('전체 대상 사용자', dash.user.total, expectUsers);
  eq('완료 사용자', dash.user.completed, expectUsersDone);
  eq('미완료 사용자', dash.user.incomplete, expectUsers - expectUsersDone);
  eq(
    '자산 4분류 합 = 전체',
    dash.asset.completed + dash.asset.not_started + dash.asset.review_required,
    dash.asset.total
  );

  // 상세 목록 합계도 동일해야 한다
  const listRes = rt.call('getAdminAuditList', [{ pageSize: 200 }]).data;
  const targetRows = listRes.rows.filter((r) => !r.is_extra);
  eq('목록의 대상 행 수 = 전체 대상', targetRows.length, targets.length);
  eq(
    '목록 상태 집계 = KPI',
    targetRows.filter((r) => r.audit_status === 'NOT_STARTED').length,
    dash.asset.not_started
  );

  // 확인 필요 목록
  const recon = rt.call('getAdminReconciliation', [{}]).data;
  eq('미해결 합계 일치', recon.open_total, dash.review.open_total);
  const sumCounts = Object.keys(recon.counts).reduce((a, k) => a + recon.counts[k], 0);
  eq('카테고리 합 = 미해결 합계', sumCounts, recon.open_total);
  check(
    '확인 필요에 미보유/목록외/타인QR/사진 모두 포함',
    recon.counts.NOT_IN_POSSESSION > 0 &&
      recon.counts.UNLISTED_ASSET > 0 &&
      recon.counts.FOREIGN_SCAN > 0 &&
      recon.counts.PHOTO_REVIEW > 0,
    JSON.stringify(recon.counts)
  );

  // 관리자 처리
  const pending = recon.items.find((i) => i.review_state === 'PENDING');
  res = rt.call('resolveReviewItem', [pending.key, 'MASTER_UPDATE_REQUIRED', '']);
  check('확인 필요 처리 성공', res.ok === true, JSON.stringify(res));
  const recon2 = rt.call('getAdminReconciliation', [{}]).data;
  eq('미해결 1건 감소', recon2.open_total, recon.open_total - 1);
  const resolved = recon2.items.find((i) => i.key === pending.key);
  eq('처리 상태 반영', resolved.review_state, 'MASTER_UPDATE_REQUIRED');
  check('처리자 기록', resolved.reviewed_by === 'asset.admin@company.com');

  // Asset_Master 는 자동 수정되지 않는다
  rt.resetExecution();
  const masterAfter = rt.context.Repository.findAssetById('A003');
  eq('Master 사용자 유지', String(masterAfter.user_email).toLowerCase(), 'seho@company.com');
  eq('Master 상태 유지', masterAfter.asset_status, 'ASSIGNED');

  /* -------- 보안: 타인 증빙 접근 차단 -------- */
  console.log('\n[보안] 권한 검사');
  rt.call('devSignInAs', ['junho@company.com']);
  res = rt.call('getPhotoDataUrl', [photoLog.photo_file_id]);
  check('타인 증빙 열람 차단', res.ok === false, JSON.stringify(res));
  eq('권한 메시지', res.message, '접근 권한이 없습니다.');

  res = rt.call('submitPhoto', ['A001', TINY_PNG, 'image/png']); // A001 은 seho 자산
  check('타인 자산 사진 제출 차단', res.ok === false);
  res = rt.call('submitException', ['A001', 'LOST', '']);
  check('타인 자산 예외 신고 차단', res.ok === false);
  res = rt.call('getAdminAuditList', [{}]);
  check('비관리자 목록 조회 차단', res.ok === false);

  // 다른 사용자의 자산은 여전히 3건이 아니라 본인 것만
  const junho = rt.call('getMyAssets').data;
  eq('박준호 자산 6건', junho.assets.length, 6);
  check(
    '박준호 응답에 타인 자산 없음',
    junho.assets.every((a) => a.asset_id >= 'A009' && a.asset_id <= 'A014')
  );

  /* -------- 오류 처리 (§21) -------- */
  console.log('\n[오류] 사용자 친화적 메시지');
  rt.resetExecution();
  rt.context.Auth.signOutMockUser();
  rt.session.activeEmail = '';
  res = rt.call('getMyAssets');
  check('미로그인 시 실패 응답', res.ok === false);
  eq(
    '안내 메시지',
    res.message,
    '로그인 정보를 확인하지 못했습니다. 회사 계정으로 다시 접속해주세요.'
  );
  check('내부 스택 미노출', !JSON.stringify(res).match(/at .*\.gs/));

  rt.call('devSignInAs', ['seho@company.com']);
  res = rt.call('verifyQr', ['   ', '']);
  check('빈 QR 실패', res.ok === false);
  eq('QR 메시지', res.message, 'QR 정보를 확인하지 못했습니다.');
  res = rt.call('submitPhoto', ['A001', TINY_PNG, 'text/plain']);
  check('허용되지 않는 형식 거부', res.ok === false);
  eq('형식 메시지', res.message, '이미지 파일만 업로드할 수 있습니다.');

  /* -------- 동시 write -------- */
  console.log('\n[동시성] 같은 자산 반복 upsert');
  rt.call('devSignInAs', ['minseo@company.com']);
  for (let i = 0; i < 12; i++) {
    rt.call('verifyQr', ['Q12359', '']); // A015
  }
  const minseoLogs = readLogs(rt, CAMPAIGN).filter(
    (l) => l.user_email === 'minseo@company.com' && l.asset_id === 'A015'
  );
  eq('반복 스캔에도 로그 1건', minseoLogs.length, 1);

  return { passed, failed };
}

console.log('자산실사 서버 로직 검증');
run('MOCK');
run('GOOGLE_SHEETS');

console.log('\n----------------------------------------');
console.log('통과 ' + passed + ' / 실패 ' + failed);
if (failures.length) {
  console.log('\n실패 목록:');
  failures.forEach((f) => console.log(' - ' + f));
}
process.exit(failed ? 1 : 0);
