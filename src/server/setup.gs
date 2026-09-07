/**
 * 초기 구축 / 운영 전환용 스크립트.
 *
 * Apps Script 편집기에서 직접 실행하는 함수들이며, 웹 앱에서는 호출되지 않는다.
 * 모든 쓰기는 setValues() 일괄 처리로만 수행한다(§18).
 *
 * 실행 순서 (GOOGLE_SHEETS 모드로 전환할 때):
 *   1) setupSpreadsheet()        시트/헤더 생성 + SPREADSHEET_ID 저장
 *   2) seedSampleData()          샘플 Asset_Master / Audit_Campaign 기록 (선택)
 *   3) buildAuditTargets()       실사 대상 Snapshot 생성  ← 실사 시작 시 1회
 *   4) Script Properties 에 MODE=GOOGLE_SHEETS 설정
 */

function setupSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var existingId = Util.trim(props.getProperty('SPREADSHEET_ID'));

  var ss;
  if (existingId) {
    ss = SpreadsheetApp.openById(existingId);
  } else {
    ss = SpreadsheetApp.create('자산실사 데이터 (ga-asset)');
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }

  Object.keys(SHEET_SCHEMA).forEach(function (name) {
    var header = SHEET_SCHEMA[name];
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);

    var current = sheet.getLastColumn()
      ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      : [];
    var needsHeader =
      current.length !== header.length ||
      header.some(function (h, i) { return Util.trim(current[i]) !== h; });

    if (needsHeader) {
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
    }
  });

  // 기본 시트(Sheet1)가 남아 있으면 제거
  var blank = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) {
    ss.deleteSheet(blank);
  }

  Logger.log('스프레드시트 준비 완료: ' + ss.getUrl());
  return ss.getUrl();
}

/** 샘플 데이터 기록 (MockData 와 동일한 내용) */
function seedSampleData() {
  var ss = SpreadsheetApp.openById(
    Util.trim(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'))
  );

  writeRows_(ss, SHEET_NAMES.ASSET_MASTER, MockData.assets());
  writeRows_(ss, SHEET_NAMES.AUDIT_CAMPAIGN, MockData.campaigns());
  writeRows_(ss, SHEET_NAMES.ADMIN, MockData.admins());
  Cache.invalidateAll();

  Logger.log('샘플 Asset_Master / Audit_Campaign / Admin 기록 완료');
}

/**
 * 실사 대상 Snapshot 생성 (§5).
 * 실사 차수 시작 시 1회만 실행한다.
 * 이미 해당 차수의 대상이 있으면 중복 생성하지 않는다.
 */
function buildAuditTargets(campaignId) {
  var ss = SpreadsheetApp.openById(
    Util.trim(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'))
  );

  var campaignSheet = ss.getSheetByName(SHEET_NAMES.AUDIT_CAMPAIGN);
  var campaigns = Util.rowsToObjects(campaignSheet.getDataRange().getValues());
  var campaign = null;
  for (var i = 0; i < campaigns.length; i++) {
    if (campaignId
      ? Util.trim(campaigns[i].campaign_id) === campaignId
      : Util.trim(campaigns[i].status).toUpperCase() === 'ACTIVE') {
      campaign = campaigns[i];
      break;
    }
  }
  if (!campaign) throw new Error('대상 차수를 찾을 수 없습니다.');

  var targetSheet = ss.getSheetByName(SHEET_NAMES.AUDIT_TARGET);
  var existing = Util.rowsToObjects(targetSheet.getDataRange().getValues());
  for (var e = 0; e < existing.length; e++) {
    if (Util.trim(existing[e].campaign_id) === Util.trim(campaign.campaign_id)) {
      Logger.log('이미 대상 Snapshot 이 존재합니다: ' + campaign.campaign_id);
      return 0;
    }
  }

  var assets = Util.rowsToObjects(
    ss.getSheetByName(SHEET_NAMES.ASSET_MASTER).getDataRange().getValues()
  );
  var rows = [];
  var header = SHEET_SCHEMA.Audit_Target;
  for (var a = 0; a < assets.length; a++) {
    if (Util.trim(assets[a].asset_status).toUpperCase() !== 'ASSIGNED') continue;
    if (!Util.trim(assets[a].user_email)) continue;
    rows.push(
      Util.objectToRow(
        {
          campaign_id: Util.trim(campaign.campaign_id),
          asset_id: Util.trim(assets[a].asset_id),
          asset_tag: Util.trim(assets[a].asset_tag),
          asset_name: Util.trim(assets[a].asset_name),
          user_name: Util.trim(assets[a].user_name),
          user_email: Util.trim(assets[a].user_email).toLowerCase(),
          department: Util.trim(assets[a].department)
        },
        header
      )
    );
  }

  if (rows.length) {
    targetSheet
      .getRange(targetSheet.getLastRow() + 1, 1, rows.length, header.length)
      .setValues(rows);
  }
  // 기준 데이터가 바뀌었으므로 캐시를 통째로 무효화한다
  Cache.invalidateAll();
  Logger.log('대상 Snapshot 생성: ' + rows.length + '건');
  return rows.length;
}

/**
 * Dashboard 성능 테스트용 대량 데이터 생성(§25).
 * Asset_Master 에 임의 자산을 추가한 뒤 buildAuditTargets() 를 다시 실행한다.
 */
function generateBulkMockData(userCount, assetsPerUser) {
  userCount = userCount || 300;
  assetsPerUser = assetsPerUser || 4;

  var ss = SpreadsheetApp.openById(
    Util.trim(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'))
  );
  var sheet = ss.getSheetByName(SHEET_NAMES.ASSET_MASTER);
  var header = SHEET_SCHEMA.Asset_Master;

  var departments = ['개발1팀', '개발2팀', '플랫폼개발팀', '데이터팀', '디자인팀',
    '영업1팀', '마케팅팀', '재무회계팀', '인사팀', '고객경험팀'];
  var names = ['MacBook Pro 14', 'MacBook Air 13', '모니터 27형', 'iPad',
    '도킹 스테이션', '키보드', '마우스', '헤드셋'];

  var startIndex = sheet.getLastRow(); // 헤더 포함 행 수 → 다음 번호 기준
  var rows = [];
  var seq = startIndex;

  for (var u = 0; u < userCount; u++) {
    var email = 'bulk' + (u + 1) + '@company.com';
    var dept = departments[u % departments.length];
    for (var a = 0; a < assetsPerUser; a++) {
      seq++;
      rows.push(
        Util.objectToRow(
          {
            asset_id: 'B' + String(seq).padStart(5, '0'),
            asset_tag: 'QB' + String(seq).padStart(5, '0'),
            asset_name: names[(u + a) % names.length],
            model: 'BULK-MODEL',
            serial_number: 'BULKSN' + seq,
            user_name: '테스트' + (u + 1),
            user_email: email,
            department: dept,
            asset_status: 'ASSIGNED',
            updated_at: Util.nowIso()
          },
          header
        )
      );
    }
  }

  // 한 번에 기록 (반복 setValues 금지)
  sheet
    .getRange(sheet.getLastRow() + 1, 1, rows.length, header.length)
    .setValues(rows);

  Logger.log('대량 자산 ' + rows.length + '건 생성. buildAuditTargets() 를 실행하세요.');
  return rows.length;
}

/** 개발용: MOCK 저장분 초기화 */
function resetMockStore() {
  MockStore.clear();
  Logger.log('MOCK 저장분을 초기화했습니다.');
}

/* ---------------- 내부 헬퍼 ---------------- */

function writeRows_(ss, sheetName, objects) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('시트 없음: ' + sheetName);
  var header = SHEET_SCHEMA[sheetName];

  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, header.length).clearContent();
  }
  if (!objects.length) return;

  var rows = objects.map(function (obj) {
    return Util.objectToRow(obj, header);
  });
  sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
}
