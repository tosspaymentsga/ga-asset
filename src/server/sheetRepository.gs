/**
 * Google Sheets 저장소 (MODE=GOOGLE_SHEETS).
 *
 * 성능 원칙(§18):
 *  - 셀 단위 getValue() 금지. 항상 getValues() 로 일괄 조회 후 배열에서 탐색한다.
 *  - 반복문 안에서 getRange() 를 호출하지 않는다.
 *  - 같은 실행 안에서 동일 시트를 두 번 읽지 않는다 (실행 단위 memo).
 *  - QR 스캔 upsert 는 전체 시트를 읽지 않고 키 컬럼 4개만 읽어 행 번호를 찾는다.
 *  - 사용자별 실사 대상은 CacheService 에 캐싱한다 (작은 payload 만 캐싱).
 */

/**
 * 컬럼 매핑기.
 *
 * 실제 시트 헤더( `자산번호`, `TAG번호` … )를 코드가 쓰는 표준 필드명
 * ( `asset_id`, `asset_tag` … )으로 옮긴다. 매핑 규칙은 전부
 * config.gs 의 COLUMN_ALIASES 한 곳에 있다.
 */
var SheetMapper = {
  /** 비교용 정규화: 공백/밑줄/하이픈 제거 + 소문자 */
  normalize: function (value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/[\s_\-./]/g, '')
      .toLowerCase();
  },

  /**
   * 헤더 행 → { field: columnIndex } (0-based).
   * 매칭되지 않은 표준 필드는 키 자체가 없다.
   */
  build: function (sheetKey, headerRow) {
    var aliases = COLUMN_ALIASES[sheetKey] || {};
    var normalizedHeader = [];
    for (var c = 0; c < headerRow.length; c++) {
      normalizedHeader.push(this.normalize(headerRow[c]));
    }

    var map = {};
    for (var field in aliases) {
      var candidates = aliases[field];
      for (var a = 0; a < candidates.length; a++) {
        var idx = normalizedHeader.indexOf(this.normalize(candidates[a]));
        if (idx >= 0) {
          map[field] = idx;
          break;
        }
      }
    }
    return map;
  },

  /** 표준 필드 목록 중 시트에 없는 것 */
  missing: function (map, requiredFields) {
    var out = [];
    for (var i = 0; i < requiredFields.length; i++) {
      if (map[requiredFields[i]] === undefined) out.push(requiredFields[i]);
    }
    return out;
  }
};

var SheetIO = {
  _ss: null,
  _sheets: {},
  _values: {},
  _objects: {},
  _maps: {},

  spreadsheet: function () {
    if (this._ss) return this._ss;
    var id = Util.trim(Config.get('SPREADSHEET_ID'));
    try {
      this._ss = id
        ? SpreadsheetApp.openById(id)
        : SpreadsheetApp.getActiveSpreadsheet();
    } catch (err) {
      throw new AppError('LOAD_FAILED', ERROR_MESSAGES.LOAD_FAILED, String(err));
    }
    if (!this._ss) {
      throw new AppError(
        'LOAD_FAILED',
        ERROR_MESSAGES.LOAD_FAILED,
        'SPREADSHEET_ID 가 설정되지 않았습니다. setup.gs 의 setupSpreadsheet() 를 실행하세요.'
      );
    }
    return this._ss;
  },

  /** @param {string} key SHEET_NAMES 의 키 (예: 'ASSET_MASTER') */
  sheet: function (key) {
    if (this._sheets[key]) return this._sheets[key];
    var name = Config.sheetName(key);
    var sheet = this.spreadsheet().getSheetByName(name);
    if (!sheet) {
      throw new AppError(
        'LOAD_FAILED',
        ERROR_MESSAGES.LOAD_FAILED,
        '시트를 찾을 수 없습니다: ' + name +
          ' (스크립트 속성 ' + SHEET_NAME_PROPERTIES[key] + ' 로 이름을 지정할 수 있습니다)'
      );
    }
    this._sheets[key] = sheet;
    return sheet;
  },

  /** 시트 전체 값 (실행 단위 1회만 읽는다) */
  values: function (key) {
    if (this._values[key]) return this._values[key];
    this._values[key] = this.sheet(key).getDataRange().getValues();
    return this._values[key];
  },

  /** 실제 헤더 행 (시트에 적힌 그대로) */
  header: function (key) {
    var values = this._values[key];
    if (values && values.length) return values[0].map(Util.trim);
    var sheet = this.sheet(key);
    var lastCol = sheet.getLastColumn();
    if (!lastCol) return SHEET_SCHEMA[key] || [];
    return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(Util.trim);
  },

  /** 표준 필드 → 컬럼 인덱스 */
  map: function (key) {
    if (this._maps[key]) return this._maps[key];
    this._maps[key] = SheetMapper.build(key, this.header(key));
    return this._maps[key];
  },

  /** 시트 전체를 표준 필드명 객체 배열로 변환 */
  objects: function (key) {
    if (this._objects[key]) return this._objects[key];
    var values = this.values(key);
    var map = this.map(key);
    var out = [];

    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var obj = {};
      var isEmpty = true;
      for (var field in map) {
        var cell = row[map[field]];
        if (cell instanceof Date) cell = cell.toISOString();
        obj[field] = cell === null || cell === undefined ? '' : cell;
        if (!Util.isBlank(cell)) isEmpty = false;
      }
      if (!isEmpty) {
        obj.__row = r + 1;
        out.push(obj);
      }
    }
    this._objects[key] = out;
    return out;
  },

  invalidate: function (key) {
    delete this._values[key];
    delete this._objects[key];
    // 헤더가 바뀌었을 수 있으므로 컬럼 매핑도 함께 버린다
    delete this._maps[key];
  },

  /** 표준 필드 객체 → 실제 컬럼 위치에 맞춘 행 배열 */
  toRow: function (key, obj, existingRow) {
    var header = this.header(key);
    var map = this.map(key);
    var row = [];
    for (var i = 0; i < header.length; i++) {
      // 매핑되지 않은 컬럼(회사에서 추가한 컬럼 등)은 기존 값을 보존한다
      row.push(existingRow && existingRow[i] !== undefined ? existingRow[i] : '');
    }
    for (var field in map) {
      if (obj[field] === undefined) continue;
      var v = obj[field];
      row[map[field]] = v === null ? '' : v;
    }
    return row;
  },

  appendObject: function (key, obj) {
    this.sheet(key).appendRow(this.toRow(key, obj));
    this.invalidate(key);
  },

  writeObject: function (key, rowNumber, obj) {
    var header = this.header(key);
    var sheet = this.sheet(key);
    var existing = sheet.getRange(rowNumber, 1, 1, header.length).getValues()[0];
    sheet
      .getRange(rowNumber, 1, 1, header.length)
      .setValues([this.toRow(key, obj, existing)]);
    this.invalidate(key);
  },

  readObject: function (key, rowNumber) {
    var header = this.header(key);
    var map = this.map(key);
    var row = this.sheet(key).getRange(rowNumber, 1, 1, header.length).getValues()[0];
    var obj = {};
    for (var field in map) {
      var cell = row[map[field]];
      obj[field] = cell instanceof Date ? cell.toISOString() : cell;
    }
    return obj;
  },

  /**
   * 키 컬럼만 좁게 읽기 위한 범위 정보.
   * 컬럼 순서가 회사 시트마다 달라도 동작하도록 헤더에서 위치를 찾는다(§18).
   * @return {{startCol:number, numCols:number, offsets:Object}|null}
   */
  keyRange: function (key, fields) {
    var map = this.map(key);
    var min = null;
    var max = null;
    for (var i = 0; i < fields.length; i++) {
      var idx = map[fields[i]];
      if (idx === undefined) return null;
      if (min === null || idx < min) min = idx;
      if (max === null || idx > max) max = idx;
    }
    var offsets = {};
    for (var f = 0; f < fields.length; f++) {
      offsets[fields[f]] = map[fields[f]] - min;
    }
    return { startCol: min + 1, numCols: max - min + 1, offsets: offsets };
  }
};

var SheetRepository = {
  /* ---- 사용자 (Asset_Master 에서 파생) ---- */
  listUsers: function () {
    var rows = SheetIO.objects('ASSET_MASTER');
    var seen = {};
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var email = Util.trim(rows[i].user_email).toLowerCase();
      if (!email || seen[email]) continue;
      seen[email] = true;
      out.push({
        email: email,
        name: Util.trim(rows[i].user_name),
        department: Util.trim(rows[i].department)
      });
    }
    return out;
  },

  /**
   * 로그인 사용자 프로필.
   *
   * 모든 요청이 이 함수를 거치므로, Asset_Master 전체를 매번 읽지 않도록
   * (1) 사용자별로 이미 캐시되어 있는 Audit_Target 을 먼저 보고
   * (2) 그래도 없을 때만 Asset_Master 를 조회한 뒤
   * 결과 자체를 CacheService 에 담아둔다(§18).
   */
  findUserByEmail: function (email) {
    var normalized = Util.trim(email).toLowerCase();
    if (!normalized) return null;

    var cacheKey = 'user:' + normalized;
    var cached = Cache.get(cacheKey);
    if (cached) return cached;

    var profile = null;

    var campaign = this.getActiveCampaign();
    if (campaign) {
      var targets = this.listTargetsByUser(campaign.campaign_id, normalized);
      if (targets.length) {
        profile = {
          email: normalized,
          name: Util.trim(targets[0].user_name),
          department: Util.trim(targets[0].department)
        };
      }
    }

    if (!profile) {
      var rows = SheetIO.objects('ASSET_MASTER');
      for (var i = 0; i < rows.length; i++) {
        if (RepoUtil.matchEmail(rows[i].user_email, normalized)) {
          profile = {
            email: normalized,
            name: Util.trim(rows[i].user_name),
            department: Util.trim(rows[i].department)
          };
          break;
        }
      }
    }

    if (profile) Cache.put(cacheKey, profile, Config.num('CACHE_TTL_SECONDS'));
    return profile;
  },

  /** 권한 검사에서 매 요청 호출되므로 캐싱한다 */
  listAdmins: function () {
    var cached = Cache.get('admins');
    if (cached) return cached;
    var list;
    try {
      list = SheetIO.objects('ADMIN');
    } catch (err) {
      // Admin 시트가 없으면 CONFIG.ADMIN_EMAILS 만 사용한다
      list = [];
    }
    Cache.put('admins', list, Config.num('CACHE_TTL_SECONDS'));
    return list;
  },

  /* ---- 차수 ---- */
  listCampaigns: function () {
    return SheetIO.objects('AUDIT_CAMPAIGN').map(function (c) {
      return {
        campaign_id: Util.trim(c.campaign_id),
        campaign_name: Util.trim(c.campaign_name),
        start_date: Util.trim(c.start_date),
        end_date: Util.trim(c.end_date),
        status: Util.trim(c.status).toUpperCase(),
        created_at: Util.toIso(c.created_at)
      };
    });
  },

  getActiveCampaign: function () {
    var list = this.listCampaigns();
    for (var i = 0; i < list.length; i++) {
      if (list[i].status === 'ACTIVE') return list[i];
    }
    return null;
  },

  findCampaign: function (campaignId) {
    var list = this.listCampaigns();
    for (var i = 0; i < list.length; i++) {
      if (list[i].campaign_id === campaignId) return list[i];
    }
    return null;
  },

  /* ---- 자산 Master ---- */
  findAssetByTag: function (tag) {
    var rows = SheetIO.objects('ASSET_MASTER');
    for (var i = 0; i < rows.length; i++) {
      if (RepoUtil.matchTag(rows[i].asset_tag, tag)) return rows[i];
    }
    return null;
  },

  findAssetById: function (assetId) {
    var rows = SheetIO.objects('ASSET_MASTER');
    for (var i = 0; i < rows.length; i++) {
      if (Util.trim(rows[i].asset_id) === Util.trim(assetId)) return rows[i];
    }
    return null;
  },

  /* ---- 대상 ---- */
  listTargetsByCampaign: function (campaignId) {
    return SheetIO.objects('AUDIT_TARGET').filter(function (t) {
      return Util.trim(t.campaign_id) === campaignId;
    });
  },

  /**
   * 사용자별 대상 목록.
   * Asset_Master 전량을 클라이언트로 보내지 않기 위해 서버에서 필터링하며,
   * 결과가 작으므로 CacheService 에 캐싱한다(§18).
   */
  listTargetsByUser: function (campaignId, email) {
    var key = 'targets:' + campaignId + ':' + Util.trim(email).toLowerCase();
    var cached = Cache.get(key);
    if (cached) return cached;

    var list = this.listTargetsByCampaign(campaignId).filter(function (t) {
      return RepoUtil.matchEmail(t.user_email, email);
    });
    Cache.put(key, list, Config.num('CACHE_TTL_SECONDS'));
    return list;
  },

  findTargetByTag: function (campaignId, tag) {
    var list = this.listTargetsByCampaign(campaignId);
    for (var i = 0; i < list.length; i++) {
      if (RepoUtil.matchTag(list[i].asset_tag, tag)) return list[i];
    }
    return null;
  },

  findTargetByAsset: function (campaignId, assetId) {
    var list = this.listTargetsByCampaign(campaignId);
    for (var i = 0; i < list.length; i++) {
      if (Util.trim(list[i].asset_id) === Util.trim(assetId)) return list[i];
    }
    return null;
  },

  /* ---- 로그 ---- */
  listLogsByCampaign: function (campaignId) {
    return SheetIO.objects('AUDIT_LOG').filter(function (l) {
      return Util.trim(l.campaign_id) === campaignId;
    });
  },

  listLogsByUser: function (campaignId, email) {
    return this.listLogsByCampaign(campaignId).filter(function (l) {
      return RepoUtil.matchEmail(l.user_email, email);
    });
  },

  /**
   * 논리 키 컬럼(campaign_id, asset_id, user_email)만 읽어 행을 찾는다.
   * 전체 시트를 읽지 않으므로 QR 스캔 경로가 가볍다(§18).
   * 컬럼 위치는 헤더에서 찾으므로 시트의 컬럼 순서가 달라도 동작한다.
   * @return {number} 시트 행 번호 (없으면 -1)
   */
  _findLogRow: function (campaignId, assetId, email) {
    var sheet = SheetIO.sheet('AUDIT_LOG');
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return -1;

    var range = SheetIO.keyRange('AUDIT_LOG', [
      'campaign_id', 'asset_id', 'user_email'
    ]);
    if (!range) {
      throw new AppError(
        'LOAD_FAILED',
        ERROR_MESSAGES.LOAD_FAILED,
        'Audit_Log 에 campaign_id / asset_id / user_email 컬럼이 필요합니다.'
      );
    }

    var keys = sheet
      .getRange(2, range.startCol, lastRow - 1, range.numCols)
      .getValues();
    for (var i = 0; i < keys.length; i++) {
      if (
        Util.trim(keys[i][range.offsets.campaign_id]) === campaignId &&
        Util.trim(keys[i][range.offsets.asset_id]) === Util.trim(assetId) &&
        RepoUtil.matchEmail(keys[i][range.offsets.user_email], email)
      ) {
        return i + 2;
      }
    }
    return -1;
  },

  findLog: function (campaignId, assetId, email) {
    var row = this._findLogRow(campaignId, assetId, email);
    if (row < 0) return null;
    return SheetIO.readObject('AUDIT_LOG', row);
  },

  /**
   * campaign_id + asset_id + user_email 기준 upsert(§5).
   * 동시 write 충돌을 막기 위해 이 구간만 Lock 으로 감싼다(§19).
   */
  upsertLog: function (log) {
    var lock = LockService.getScriptLock();
    var acquired = false;
    try {
      acquired = lock.tryLock(Config.num('LOCK_WAIT_MS'));
      if (!acquired) {
        throw new AppError('BUSY', ERROR_MESSAGES.BUSY, 'lock timeout');
      }

      var row = this._findLogRow(log.campaign_id, log.asset_id, log.user_email);
      var record;
      if (row > 0) {
        var existing = SheetIO.readObject('AUDIT_LOG', row);
        record = RepoUtil.merge(RepoUtil.merge(RepoUtil.emptyLog(), existing), log);
        SheetIO.writeObject('AUDIT_LOG', row, record);
      } else {
        record = RepoUtil.merge(RepoUtil.emptyLog(), log);
        SheetIO.appendObject('AUDIT_LOG', record);
      }
      Cache.remove('dashboard:' + log.campaign_id);
      return record;
    } finally {
      if (acquired) lock.releaseLock();
    }
  },

  /* ---- 목록에 없는 자산 ---- */
  listUnlistedByCampaign: function (campaignId) {
    return SheetIO.objects('AUDIT_UNLISTED').filter(function (u) {
      return Util.trim(u.campaign_id) === campaignId;
    });
  },

  listUnlistedByUser: function (campaignId, email) {
    return this.listUnlistedByCampaign(campaignId).filter(function (u) {
      return RepoUtil.matchEmail(u.user_email, email);
    });
  },

  _findUnlistedRow: function (campaignId, email, tag) {
    var sheet = SheetIO.sheet('AUDIT_UNLISTED');
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return -1;

    var range = SheetIO.keyRange('AUDIT_UNLISTED', [
      'campaign_id', 'user_email', 'scanned_tag'
    ]);
    if (!range) {
      throw new AppError(
        'LOAD_FAILED',
        ERROR_MESSAGES.LOAD_FAILED,
        'Audit_Unlisted 에 campaign_id / user_email / scanned_tag 컬럼이 필요합니다.'
      );
    }

    var keys = sheet
      .getRange(2, range.startCol, lastRow - 1, range.numCols)
      .getValues();
    for (var i = 0; i < keys.length; i++) {
      if (
        Util.trim(keys[i][range.offsets.campaign_id]) === campaignId &&
        RepoUtil.matchEmail(keys[i][range.offsets.user_email], email) &&
        RepoUtil.matchTag(keys[i][range.offsets.scanned_tag], tag)
      ) {
        return i + 2;
      }
    }
    return -1;
  },

  upsertUnlisted: function (record) {
    var lock = LockService.getScriptLock();
    var acquired = false;
    try {
      acquired = lock.tryLock(Config.num('LOCK_WAIT_MS'));
      if (!acquired) {
        throw new AppError('BUSY', ERROR_MESSAGES.BUSY, 'lock timeout');
      }

      var row = this._findUnlistedRow(
        record.campaign_id,
        record.user_email,
        record.scanned_tag
      );
      var merged;
      if (row > 0) {
        var existing = SheetIO.readObject('AUDIT_UNLISTED', row);
        merged = RepoUtil.merge(
          RepoUtil.merge(RepoUtil.emptyUnlisted(), existing),
          record
        );
        SheetIO.writeObject('AUDIT_UNLISTED', row, merged);
      } else {
        merged = RepoUtil.merge(RepoUtil.emptyUnlisted(), record);
        SheetIO.appendObject('AUDIT_UNLISTED', merged);
      }
      Cache.remove('dashboard:' + record.campaign_id);
      return merged;
    } finally {
      if (acquired) lock.releaseLock();
    }
  },

  /* ---- 오류 로그 ---- */
  logError: function (record) {
    try {
      SheetIO.appendObject('ERROR_LOG', {
        timestamp: Util.nowIso(),
        user_email: record.user_email || '',
        fn: record.fn || '',
        message: record.message || '',
        detail: record.detail || ''
      });
    } catch (err) {
      // Error_Log 기록 실패가 원래 요청을 실패시키지 않도록 한다
      Logger.log('[Error_Log 실패] ' + record.fn + ' / ' + record.message);
    }
  },

  /* ---- 데모 초기화 (운영에서는 사용하지 않는다) ---- */
  resetUserAudit: function () {
    throw new AppError(
      'FORBIDDEN',
      ERROR_MESSAGES.FORBIDDEN,
      'GOOGLE_SHEETS 모드에서는 실사 데이터를 초기화하지 않습니다.'
    );
  }
};
