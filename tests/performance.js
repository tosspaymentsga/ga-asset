/**
 * Apps Script 성능 규칙 검증 (§18, §19).
 *
 * GOOGLE_SHEETS 모드에서 실제 `sheetRepository.gs` 를 구동하며
 * Sheets API 호출 횟수와 읽는 셀 수를 센다.
 *
 * 실행: node tests/performance.js
 */
'use strict';

const { createRuntime } = require('./harness/gas-runtime');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    failed++;
    console.log('  ✗ ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

function build() {
  const rt = createRuntime({
    activeEmail: '',
    properties: {
      MODE: 'GOOGLE_SHEETS',
      ALLOW_MOCK_USER: 'true',
      ALLOW_DEV_TAG_INPUT: 'true',
    },
  });
  rt.call('setupSpreadsheet');
  rt.call('seedSampleData');
  rt.call('buildAuditTargets');
  rt.context.MockData.seedLogs().forEach((log) => {
    rt.resetExecution();
    rt.context.SheetRepository.upsertLog(log);
  });
  rt.context.MockData.seedUnlisted().forEach((rec) => {
    rt.resetExecution();
    rt.context.SheetRepository.upsertUnlisted(rec);
  });
  return rt;
}

/** 대량 데이터 생성 후 대상 스냅샷 재생성 */
function scaleUp(rt, users, perUser) {
  rt.call('generateBulkMockData', [users, perUser]);
  // 기존 스냅샷을 지우고 다시 만든다
  rt.resetExecution();
  const ss = rt.context.SpreadsheetApp.openById(
    rt.scriptProps.getProperty('SPREADSHEET_ID')
  );
  const target = ss.getSheetByName('Audit_Target');
  target.rows = target.rows.slice(0, 1);
  rt.call('buildAuditTargets');
}

console.log('Apps Script 성능 규칙 검증 (MODE=GOOGLE_SHEETS)');

const rt = build();
const stats = rt.sheetStats;

console.log('\n[1] 자산 규모 확대 (사용자 300명 × 4대 = 1,200대 추가)');
scaleUp(rt, 300, 4);
rt.resetExecution();
const targetCount = rt.context.Repository.listTargetsByCampaign('AUDIT_2026_H2').length;
check('실사 대상 규모', targetCount > 1200, targetCount + '건');

rt.call('devSignInAs', ['seho@company.com']);

console.log('\n[2] 내 자산 조회 (getMyAssets)');
// 캐시가 빈 상태(cold)
rt.resetExecution();
rt.context.Cache.invalidateAll();
stats.reset();
rt.call('getMyAssets');
const cold = { calls: stats.getValuesCalls, cells: stats.cellsRead };
check(
  'cold: 시트를 일괄 getValues 로만 읽는다',
  cold.calls > 0 && cold.calls <= 8,
  'getValues ' + cold.calls + '회 / ' + cold.cells + '셀'
);
check(
  'cold: 한 요청에서 같은 시트를 두 번 읽지 않는다',
  stats.maxFullScans() <= 1,
  JSON.stringify(stats.fullScans)
);

// 캐시가 따뜻한 상태(warm)
stats.reset();
rt.call('getMyAssets');
const warm = { calls: stats.getValuesCalls, cells: stats.cellsRead };
check(
  'warm: 대상 스냅샷 재조회 없이 처리된다',
  warm.cells < cold.cells / 4,
  cold.cells + '셀 → ' + warm.cells + '셀'
);
check(
  'warm: 읽는 양이 대상 규모에 비례하지 않는다',
  warm.cells < targetCount,
  warm.cells + '셀 (대상 ' + targetCount + '건)'
);

console.log('\n[3] QR 스캔 (verifyQr)');
stats.reset();
rt.call('verifyQr', ['Q12345', '']);
const scan = {
  calls: stats.getValuesCalls,
  cells: stats.cellsRead,
  writes: stats.setValuesCalls + stats.appendRowCalls,
};
check(
  'QR 스캔이 전체 Audit_Log 를 읽지 않는다',
  scan.cells < targetCount * 2,
  '읽은 셀 ' + scan.cells + '개 (대상 ' + targetCount + '건)'
);
check('쓰기는 1회', scan.writes === 1, scan.writes + '회');

stats.reset();
rt.call('verifyQr', ['Q12345', '']);
check(
  '재스캔도 같은 비용 (로그 증가 없음)',
  stats.setValuesCalls + stats.appendRowCalls === 1,
  '쓰기 ' + (stats.setValuesCalls + stats.appendRowCalls) + '회'
);

console.log('\n[4] 관리자 Dashboard');
rt.call('devSignInAs', ['asset.admin@company.com']);
stats.reset();
const t0 = Date.now();
const dash = rt.call('getAdminDashboard', ['']);
const elapsed = Date.now() - t0;
check('집계 성공', dash.ok === true);
check(
  '시트별 1회씩만 일괄 조회',
  stats.maxFullScans() <= 1,
  JSON.stringify(stats.fullScans) + ' / ' + stats.cellsRead + '셀'
);
check('집계 시간', elapsed < 3000, elapsed + 'ms');

stats.reset();
rt.call('getAdminDashboard', ['']);
check(
  '두 번째 호출은 집계 캐시에서 반환 (차수 조회만 남는다)',
  stats.cellsRead < 100,
  'getValues ' + stats.getValuesCalls + '회 / ' + stats.cellsRead + '셀'
);

console.log('\n[5] 사용자 화면에 Asset_Master 전량이 내려가지 않는다');
rt.call('devSignInAs', ['seho@company.com']);
const view = rt.call('getMyAssets').data;
check('내 자산만 반환', view.assets.length === 3, view.assets.length + '건');
const payloadSize = JSON.stringify(view).length;
check('응답 크기가 작다', payloadSize < 4000, payloadSize + 'bytes');
check(
  '응답에 다른 사용자 데이터 없음',
  JSON.stringify(view).indexOf('bulk1@company.com') < 0
);

console.log('\n----------------------------------------');
console.log('통과 ' + passed + ' / 실패 ' + failed);
process.exit(failed ? 1 : 0);
