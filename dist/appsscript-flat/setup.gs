/**
 * 초기 구축 / 운영 전환용 스크립트.
 *
 * Apps Script 편집기에서 직접 실행하는 함수들이며, 웹 앱에서는 호출되지 않는다.
 * 모든 읽기/쓰기는 SheetIO 를 거치므로 실제 시트의 컬럼명이 달라도
 * config.gs 의 COLUMN_ALIASES 만 맞추면 그대로 동작한다.
 *
 * ── 실제 데이터 연결 순서 ──────────────────────────────────────────
 *   1) 스크립트 속성에 SPREADSHEET_ID (+ 필요 시 SHEET_* 이름) 설정
 *   2) validateSetup()                  연결 전 점검 (읽기 전용)
 *   3) createAuditCampaign(...)         실사 차수 생성
 *   4) createAuditTargetsFromMaster(...) 대상 Snapshot 생성 (Master 는 읽기만)
 *   5) 스크립트 속성 MODE=GOOGLE_SHEETS
 *   6) validateSetup() 재실행 → 오류 0 확인
 *
 * Asset_Master 를 수정하는 함수는 이 파일에 없다.
 * (generateBulkMockData 만 예외이며, 명시적 확인 토큰 없이는 실행되지 않는다)
 */

/* ------------------------------------------------------------------ */
/* 1. 시트 준비                                                        */
/* ------------------------------------------------------------------ */

/**
 * 시트와 헤더를 준비한다.
 * 이미 있는 시트의 헤더는 건드리지 않는다. (회사 자산대장 보호)
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

  var created = [];
  var kept = [];

  Object.keys(SHEET_SCHEMA).forEach(function (key) {
    var name = Config.sheetName(key);
    var header = SHEET_SCHEMA[key];
    var sheet = ss.getSheetByName(name);

    if (sheet && sheet.getLastRow() > 0) {
      // 이미 데이터(또는 헤더)가 있는 시트는 그대로 둔다
      kept.push(name);
      return;
    }
    if (!sheet) sheet = ss.insertSheet(name);

    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
    created.push(name);
  });

  // 기본 시트(Sheet1)가 비어 있으면 제거
  var blank = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) {
    ss.deleteSheet(blank);
  }

  Cache.invalidateAll();
  Logger.log(
    '스프레드시트 준비 완료: ' + ss.getUrl() +
    '\n  생성: ' + (created.join(', ') || '(없음)') +
    '\n  유지: ' + (kept.join(', ') || '(없음)')
  );
  return { url: ss.getUrl(), id: ss.getId(), created: created, kept: kept };
}

/**
 * 데모용 샘플 데이터 기록.
 * 실제 자산대장을 덮어쓰지 않도록, Asset_Master 에 데이터가 있으면 거부한다.
 * @param {string} confirmToken 이미 데이터가 있는데도 덮어쓰려면 'OVERWRITE'
 */
function seedSampleData(confirmToken) {
  SheetIO.invalidate('ASSET_MASTER');
  var existing = SheetIO.objects('ASSET_MASTER');
  if (existing.length > 0 && confirmToken !== 'OVERWRITE') {
    throw new Error(
      'Asset_Master 에 이미 ' + existing.length + '건이 있습니다. ' +
      '실제 자산대장이라면 실행하지 마세요. ' +
      "덮어쓰려면 seedSampleData('OVERWRITE') 로 실행하세요."
    );
  }

  writeRows_('ASSET_MASTER', MockData.assets());
  writeRows_('AUDIT_CAMPAIGN', MockData.campaigns());
  writeRows_('ADMIN', MockData.admins());
  Cache.invalidateAll();

  Logger.log('샘플 Asset_Master / Audit_Campaign / Admin 기록 완료');
}

/* ------------------------------------------------------------------ */
/* 2. 실사 차수                                                        */
/* ------------------------------------------------------------------ */

/**
 * 실사 차수 생성 (§Pilot).
 *
 * @param {string} campaignId    예) 'PILOT_2026_09'
 * @param {string} campaignName  예) '2026 하반기 자산실사 파일럿'
 * @param {string} startDate     'YYYY-MM-DD'
 * @param {string} endDate       'YYYY-MM-DD'
 * @param {boolean} activate     true 면 status=ACTIVE (기본 true)
 */
function createAuditCampaign(campaignId, campaignName, startDate, endDate, activate) {
  var id = Util.trim(campaignId);
  if (!id) throw new Error('campaignId 를 입력하세요.');
  var makeActive = activate === undefined ? true : !!activate;

  SheetIO.invalidate('AUDIT_CAMPAIGN');
  var campaigns = SheetIO.objects('AUDIT_CAMPAIGN');

  for (var i = 0; i < campaigns.length; i++) {
    if (Util.trim(campaigns[i].campaign_id) === id) {
      throw new Error('이미 존재하는 차수입니다: ' + id);
    }
  }
  if (makeActive) {
    for (var a = 0; a < campaigns.length; a++) {
      if (Util.trim(campaigns[a].status).toUpperCase() === 'ACTIVE') {
        throw new Error(
          '이미 진행 중인 차수가 있습니다: ' + Util.trim(campaigns[a].campaign_id) +
          " . closeAuditCampaign('" + Util.trim(campaigns[a].campaign_id) +
          "') 로 먼저 종료하세요."
        );
      }
    }
  }

  SheetIO.appendObject('AUDIT_CAMPAIGN', {
    campaign_id: id,
    campaign_name: Util.trim(campaignName) || id,
    start_date: Util.trim(startDate),
    end_date: Util.trim(endDate),
    status: makeActive ? 'ACTIVE' : 'DRAFT',
    created_at: Util.nowIso()
  });
  Cache.invalidateAll();

  Logger.log('차수 생성: ' + id + ' (' + (makeActive ? 'ACTIVE' : 'DRAFT') + ')');
  return id;
}

/** 진행 중인 차수를 종료한다 (status=CLOSED). 실사 데이터는 그대로 남는다. */
function closeAuditCampaign(campaignId) {
  var id = Util.trim(campaignId);
  SheetIO.invalidate('AUDIT_CAMPAIGN');
  var campaigns = SheetIO.objects('AUDIT_CAMPAIGN');

  for (var i = 0; i < campaigns.length; i++) {
    if (Util.trim(campaigns[i].campaign_id) === id) {
      SheetIO.writeObject('AUDIT_CAMPAIGN', campaigns[i].__row, { status: 'CLOSED' });
      Cache.invalidateAll();
      Logger.log('차수 종료: ' + id);
      return true;
    }
  }
  throw new Error('차수를 찾을 수 없습니다: ' + id);
}

/* ------------------------------------------------------------------ */
/* 3. 실사 대상 Snapshot                                               */
/* ------------------------------------------------------------------ */

/**
 * Asset_Master 를 읽어 Audit_Target Snapshot 을 만든다.
 * Asset_Master 는 읽기만 하며 절대 수정하지 않는다.
 *
 * 실사 진행 중 Master 가 바뀌어도 이 Snapshot 이 분모를 고정한다.
 *
 * @param {string} campaignId  비우면 현재 ACTIVE 차수
 * @param {Array<string>} onlyEmails  파일럿용 — 지정하면 이 사용자들만 대상에 넣는다
 */
function createAuditTargetsFromMaster(campaignId, onlyEmails) {
  SheetIO.invalidate('AUDIT_CAMPAIGN');
  SheetIO.invalidate('AUDIT_TARGET');
  SheetIO.invalidate('ASSET_MASTER');

  var campaigns = SheetIO.objects('AUDIT_CAMPAIGN');
  var campaign = null;
  for (var i = 0; i < campaigns.length; i++) {
    var matched = campaignId
      ? Util.trim(campaigns[i].campaign_id) === Util.trim(campaignId)
      : Util.trim(campaigns[i].status).toUpperCase() === 'ACTIVE';
    if (matched) {
      campaign = campaigns[i];
      break;
    }
  }
  if (!campaign) {
    throw new Error(
      campaignId
        ? '차수를 찾을 수 없습니다: ' + campaignId
        : '진행 중(ACTIVE)인 차수가 없습니다. createAuditCampaign() 을 먼저 실행하세요.'
    );
  }
  var cid = Util.trim(campaign.campaign_id);

  // 실사 시작 이후 분모가 바뀌면 안 되므로, 이미 대상이 있으면 거부한다.
  // (조용히 no-op 하면 "다시 만들었다" 고 오해할 수 있어 오류로 알린다)
  var existing = SheetIO.objects('AUDIT_TARGET');
  var existingCount = 0;
  for (var e = 0; e < existing.length; e++) {
    if (Util.trim(existing[e].campaign_id) === cid) existingCount++;
  }
  if (existingCount > 0) {
    throw new Error(
      '차수 ' + cid + ' 의 대상 Snapshot 이 이미 ' + existingCount + '건 존재합니다. ' +
      '실사 분모가 바뀌지 않도록 재생성을 거부합니다. ' +
      '정말 다시 만들려면 Audit_Target 시트에서 해당 차수 행을 먼저 삭제하세요.'
    );
  }

  // 컬럼 매핑이 모호한 상태로는 대상을 만들지 않는다 (잘못된 분모가 고정된다)
  ['ASSET_MASTER', 'AUDIT_TARGET'].forEach(function (key) {
    var conflicts = SheetMapper.detectConflicts(key, SheetIO.header(key));
    if (conflicts.length) {
      throw new Error(
        SheetMapper.describeConflict(Config.sheetName(key), conflicts[0]) +
        ' — validateSetup() 으로 전체 충돌을 확인하세요.'
      );
    }
  });

  var allow = null;
  if (onlyEmails && onlyEmails.length) {
    allow = {};
    for (var m = 0; m < onlyEmails.length; m++) {
      allow[Util.normalizeEmail(onlyEmails[m])] = true;
    }
  }

  var assets = SheetIO.objects('ASSET_MASTER');
  var targetSheet = SheetIO.sheet('AUDIT_TARGET');
  var map = SheetIO.map('AUDIT_TARGET');
  var actualHeader = SheetIO.header('AUDIT_TARGET');

  var rows = [];
  var skipped = { notAssigned: 0, noEmail: 0, noTag: 0, filtered: 0 };

  for (var a = 0; a < assets.length; a++) {
    var asset = assets[a];
    if (Util.trim(asset.asset_status).toUpperCase() !== 'ASSIGNED') {
      skipped.notAssigned++;
      continue;
    }
    var email = Util.normalizeEmail(asset.user_email);
    if (!email) { skipped.noEmail++; continue; }
    if (!Util.trim(asset.asset_tag)) { skipped.noTag++; continue; }
    if (allow && !allow[email]) { skipped.filtered++; continue; }

    var record = {
      campaign_id: cid,
      asset_id: Util.trim(asset.asset_id),
      asset_tag: Util.normalizeTag(asset.asset_tag),
      asset_name: Util.trim(asset.asset_name),
      user_name: Util.trim(asset.user_name),
      user_email: email,
      department: Util.trim(asset.department)
    };

    // 실제 컬럼 위치에 맞춰 행을 만든다 (컬럼 순서가 달라도 안전)
    var row = [];
    for (var c = 0; c < actualHeader.length; c++) row.push('');
    for (var field in map) {
      if (record[field] !== undefined) row[map[field]] = record[field];
    }
    rows.push(row);
  }

  if (rows.length) {
    // 반복 setValues 금지 — 한 번에 기록한다
    targetSheet
      .getRange(targetSheet.getLastRow() + 1, 1, rows.length, actualHeader.length)
      .setValues(rows);
  }
  SheetIO.invalidate('AUDIT_TARGET');
  Cache.invalidateAll();

  var summary = {
    campaign_id: cid,
    created: rows.length,
    skipped: skipped,
    already: false
  };
  Logger.log(
    '대상 Snapshot 생성: ' + rows.length + '건 (차수 ' + cid + ')' +
    '\n  제외 — 미지급 ' + skipped.notAssigned +
    ' / 이메일없음 ' + skipped.noEmail +
    ' / Tag없음 ' + skipped.noTag +
    ' / 파일럿필터 ' + skipped.filtered
  );
  return summary;
}

/** 이전 이름 호환 */
function buildAuditTargets(campaignId) {
  return createAuditTargetsFromMaster(campaignId, null);
}

/* ------------------------------------------------------------------ */
/* 4. 연결 전 점검 (읽기 전용)                                          */
/* ------------------------------------------------------------------ */

/**
 * 실제 데이터 연결 전/후 점검.
 * 아무것도 쓰지 않는다. 결과는 Logger 와 반환값 양쪽으로 확인할 수 있다.
 */
function validateSetup() {
  var errors = [];
  var warnings = [];
  var info = {};

  /* --- 설정 --- */
  info.mode = Config.get('MODE');
  info.spreadsheetId = Util.trim(Config.get('SPREADSHEET_ID'));
  info.driveFolderId = Util.trim(Config.get('DRIVE_ROOT_FOLDER_ID'));
  info.sheetNames = {};
  Object.keys(SHEET_NAMES).forEach(function (key) {
    info.sheetNames[key] = Config.sheetName(key);
  });

  if (!info.spreadsheetId) {
    errors.push('SPREADSHEET_ID 가 설정되지 않았습니다.');
  }
  if (Config.bool('ALLOW_MOCK_USER')) {
    warnings.push('ALLOW_MOCK_USER=true — 운영 배포 전에 false 로 바꾸세요.');
  }
  if (Config.bool('ALLOW_DEV_TAG_INPUT')) {
    warnings.push('ALLOW_DEV_TAG_INPUT=true — 운영 배포 전에 false 로 바꾸세요.');
  }
  if (info.mode !== MODE_GOOGLE_SHEETS) {
    warnings.push('MODE=' + info.mode + ' — 실제 데이터 연결 시 GOOGLE_SHEETS 로 바꾸세요.');
  }

  /* --- 인증 (편집기 실행 기준. 최종 확인은 웹 앱에서) --- */
  try {
    info.activeUser = Session.getActiveUser().getEmail();
  } catch (err) { info.activeUser = '(확인 불가)'; }
  try {
    info.effectiveUser = Session.getEffectiveUser().getEmail();
  } catch (err) { info.effectiveUser = '(확인 불가)'; }
  warnings.push(
    '인증은 편집기가 아니라 배포된 웹 앱에서 서로 다른 계정으로 확인해야 합니다. ' +
    'README 의 "Workspace 인증 검증" 항목을 따르세요.'
  );

  if (errors.length) {
    return report_(errors, warnings, info);
  }

  /* --- 시트 존재 + 컬럼 매핑 --- */
  info.columns = {};
  Object.keys(SHEET_NAMES).forEach(function (key) {
    var name = Config.sheetName(key);
    try {
      SheetIO.invalidate(key);
      var map = SheetIO.map(key);
      var missing = SheetMapper.missing(map, REQUIRED_COLUMNS[key] || []);
      var conflicts = SheetMapper.detectConflicts(key, SheetIO.header(key));
      info.columns[key] = {
        sheet: name,
        matched: Object.keys(map).sort(),
        missing: missing,
        conflicts: conflicts
      };
      if (missing.length) {
        errors.push(
          name + ' 시트에서 다음 컬럼을 찾지 못했습니다: ' + missing.join(', ') +
          ' → config.gs 의 COLUMN_ALIASES.' + key + ' 에 실제 컬럼명을 추가하세요.'
        );
      }
      // 컬럼 충돌은 임의 선택 없이 오류로 보고한다 (파일럿 시작 차단)
      conflicts.forEach(function (conflict) {
        errors.push(SheetMapper.describeConflict(name, conflict));
      });
    } catch (err) {
      errors.push(
        name + ' 시트를 열 수 없습니다. ' +
        '(스크립트 속성 ' + SHEET_NAME_PROPERTIES[key] + ' 로 이름을 지정할 수 있습니다)'
      );
    }
  });

  if (errors.length) {
    return report_(errors, warnings, info);
  }

  /* --- Asset_Master 데이터 품질 --- */
  var assets = SheetIO.objects('ASSET_MASTER');
  var seenId = {};
  var seenTag = {};
  var dupId = [];
  var dupTag = [];
  var noTag = 0;
  var noEmail = 0;
  var badEmail = [];
  var messyEmail = [];
  var assigned = 0;

  for (var i = 0; i < assets.length; i++) {
    var id = Util.trim(assets[i].asset_id);
    var tag = Util.normalizeTag(assets[i].asset_tag);
    var email = Util.normalizeEmail(assets[i].user_email);
    var status = Util.trim(assets[i].asset_status).toUpperCase();

    if (Util.needsEmailCleanup(assets[i].user_email)) {
      messyEmail.push(String(assets[i].user_email));
    }

    if (id) {
      if (seenId[id]) dupId.push(id);
      seenId[id] = true;
    }
    if (tag) {
      if (seenTag[tag]) dupTag.push(tag);
      seenTag[tag] = true;
    } else {
      noTag++;
    }
    if (status === 'ASSIGNED') {
      assigned++;
      if (!email) noEmail++;
      else if (email.indexOf('@') < 0) badEmail.push(email);
    }
  }

  info.assetMaster = {
    rows: assets.length,
    assigned: assigned,
    duplicateAssetIds: dupId.length,
    duplicateTags: dupTag.length,
    missingTag: noTag,
    assignedWithoutEmail: noEmail,
    emailsNeedingCleanup: messyEmail.length
  };

  if (dupTag.length) {
    errors.push(
      'asset_tag 가 중복됩니다 (' + dupTag.length + '건, 예: ' +
      dupTag.slice(0, 5).join(', ') + '). QR 로 자산을 특정할 수 없습니다.'
    );
  }
  if (dupId.length) {
    errors.push('asset_id 가 중복됩니다 (' + dupId.length + '건, 예: ' + dupId.slice(0, 5).join(', ') + ').');
  }
  if (noEmail) {
    warnings.push('지급(ASSIGNED) 상태인데 이메일이 없는 자산 ' + noEmail + '건 — 실사 대상에서 제외됩니다.');
  }
  if (noTag) {
    warnings.push('asset_tag 가 없는 자산 ' + noTag + '건 — 실사 대상에서 제외됩니다.');
  }
  if (messyEmail.length) {
    warnings.push(
      '이메일에 공백·줄바꿈이 섞인 값 ' + messyEmail.length + '건 ' +
      '(예: "' + messyEmail.slice(0, 3).join('", "') + '"). ' +
      '비교 시에는 자동 정리되지만 시트 값도 정리하는 편이 좋습니다.'
    );
  }
  if (badEmail.length) {
    warnings.push('이메일 형식이 이상한 값 ' + badEmail.length + '건 (예: ' + badEmail.slice(0, 3).join(', ') + ').');
  }

  /* --- 차수 --- */
  var campaigns = SheetIO.objects('AUDIT_CAMPAIGN');
  var active = campaigns.filter(function (c) {
    return Util.trim(c.status).toUpperCase() === 'ACTIVE';
  });
  info.campaigns = { total: campaigns.length, active: active.length };
  if (active.length === 0) {
    errors.push('ACTIVE 차수가 없습니다. createAuditCampaign() 을 실행하세요.');
  } else if (active.length > 1) {
    errors.push('ACTIVE 차수가 ' + active.length + '개입니다. 하나만 남기세요.');
  } else {
    info.activeCampaign = Util.trim(active[0].campaign_id);
  }

  /* --- 대상 Snapshot --- */
  var targets = SheetIO.objects('AUDIT_TARGET');
  if (info.activeCampaign) {
    var mine = targets.filter(function (t) {
      return Util.trim(t.campaign_id) === info.activeCampaign;
    });
    var users = {};
    var orphan = 0;
    for (var t = 0; t < mine.length; t++) {
      users[Util.normalizeEmail(mine[t].user_email)] = true;
      if (!seenId[Util.trim(mine[t].asset_id)]) orphan++;
    }
    info.targets = {
      campaign: info.activeCampaign,
      assets: mine.length,
      users: Object.keys(users).length,
      notInMaster: orphan
    };
    if (!mine.length) {
      errors.push(
        '활성 차수의 대상 Snapshot 이 없습니다. createAuditTargetsFromMaster() 를 실행하세요.'
      );
    }
    if (orphan) {
      warnings.push('대상 중 Asset_Master 에 없는 자산 ' + orphan + '건 (Master 가 이후 변경됨 — 정상일 수 있음).');
    }
  }

  /* --- 관리자 --- */
  var adminRows = SheetIO.objects('ADMIN');
  info.admins = {
    fromSheet: adminRows.length,
    fromProperty: Config.adminEmails().length
  };
  if (!adminRows.length && !Config.adminEmails().length) {
    // 직원 실사 자체는 가능하므로 경고로 둔다 (관리자 화면만 사용할 수 없다)
    warnings.push(
      '관리자가 설정되지 않았습니다. Admin 시트에 추가하거나 ADMIN_EMAILS 를 설정하세요. ' +
      '(직원 실사는 가능하지만 관리자 화면을 아무도 볼 수 없습니다)'
    );
  }

  /* --- Drive --- */
  if (info.driveFolderId) {
    try {
      info.driveFolderName = DriveApp.getFolderById(info.driveFolderId).getName();
    } catch (err) {
      errors.push('DRIVE_ROOT_FOLDER_ID 폴더를 열 수 없습니다: ' + info.driveFolderId);
    }
  } else {
    warnings.push(
      'DRIVE_ROOT_FOLDER_ID 가 비어 있습니다. ' +
      "이름이 '" + Config.get('DRIVE_ROOT_FOLDER_NAME') + "' 인 폴더를 찾거나 새로 만듭니다."
    );
  }

  return report_(errors, warnings, info);
}

function report_(errors, warnings, info) {
  var lines = [];
  lines.push('=== 자산실사 연결 점검 ===');
  lines.push('MODE=' + info.mode + ' / SPREADSHEET_ID=' + (info.spreadsheetId || '(없음)'));
  lines.push('');
  lines.push('오류 ' + errors.length + '건');
  errors.forEach(function (e) { lines.push('  [X] ' + e); });
  lines.push('경고 ' + warnings.length + '건');
  warnings.forEach(function (w) { lines.push('  [!] ' + w); });
  lines.push('');
  lines.push(JSON.stringify(info, null, 2));

  var text = lines.join('\n');
  Logger.log(text);
  return { ok: errors.length === 0, errors: errors, warnings: warnings, info: info };
}

/* ------------------------------------------------------------------ */
/* 5. 테스트 전용                                                       */
/* ------------------------------------------------------------------ */

/**
 * Dashboard 성능 테스트용 대량 자산 생성.
 *
 * ⚠ Asset_Master 에 행을 추가한다. 운영 스프레드시트에서는 절대 실행하지 말 것.
 * 실수 방지를 위해 확인 토큰을 요구한다.
 *
 *   generateBulkMockData(300, 4, 'ADD-TEST-DATA')
 */
function generateBulkMockData(userCount, assetsPerUser, confirmToken) {
  if (confirmToken !== 'ADD-TEST-DATA') {
    throw new Error(
      'Asset_Master 에 테스트 데이터를 추가하는 함수입니다. ' +
      "운영 시트가 아님을 확인한 뒤 generateBulkMockData(300, 4, 'ADD-TEST-DATA') 로 실행하세요."
    );
  }
  userCount = userCount || 300;
  assetsPerUser = assetsPerUser || 4;

  var sheet = SheetIO.sheet('ASSET_MASTER');
  var actualHeader = SheetIO.header('ASSET_MASTER');
  var map = SheetIO.map('ASSET_MASTER');

  var departments = ['개발1팀', '개발2팀', '플랫폼개발팀', '데이터팀', '디자인팀',
    '영업1팀', '마케팅팀', '재무회계팀', '인사팀', '고객경험팀'];
  var names = ['MacBook Pro 14', 'MacBook Air 13', '모니터 27형', 'iPad',
    '도킹 스테이션', '키보드', '마우스', '헤드셋'];

  var seq = sheet.getLastRow();
  var rows = [];

  for (var u = 0; u < userCount; u++) {
    var email = 'bulk' + (u + 1) + '@company.com';
    var dept = departments[u % departments.length];
    for (var a = 0; a < assetsPerUser; a++) {
      seq++;
      var record = {
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
      };
      var row = [];
      for (var c = 0; c < actualHeader.length; c++) row.push('');
      for (var field in map) {
        if (record[field] !== undefined) row[map[field]] = record[field];
      }
      rows.push(row);
    }
  }

  // 한 번에 기록 (반복 setValues 금지)
  sheet
    .getRange(sheet.getLastRow() + 1, 1, rows.length, actualHeader.length)
    .setValues(rows);
  SheetIO.invalidate('ASSET_MASTER');
  Cache.invalidateAll();

  Logger.log(
    '대량 자산 ' + rows.length + '건 생성. createAuditTargetsFromMaster() 를 실행하세요.'
  );
  return rows.length;
}

/** 개발용: MOCK 저장분 초기화 */
function resetMockStore() {
  MockStore.clear();
  Logger.log('MOCK 저장분을 초기화했습니다.');
}

/* ---------------- 내부 헬퍼 ---------------- */

function writeRows_(sheetKey, objects) {
  var sheet = SheetIO.sheet(sheetKey);
  var actualHeader = SheetIO.header(sheetKey);
  var map = SheetIO.map(sheetKey);

  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, actualHeader.length).clearContent();
  }
  if (!objects.length) return;

  var rows = objects.map(function (obj) {
    var row = [];
    for (var c = 0; c < actualHeader.length; c++) row.push('');
    for (var field in map) {
      if (obj[field] !== undefined) row[map[field]] = obj[field];
    }
    return row;
  });
  sheet.getRange(2, 1, rows.length, actualHeader.length).setValues(rows);
  SheetIO.invalidate(sheetKey);
}
