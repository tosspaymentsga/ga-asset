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

var SheetIO = {
  _ss: null,
  _sheets: {},
  _values: {},
  _objects: {},

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

  sheet: function (name) {
    if (this._sheets[name]) return this._sheets[name];
    var sheet = this.spreadsheet().getSheetByName(name);
    if (!sheet) {
      throw new AppError(
        'LOAD_FAILED',
        ERROR_MESSAGES.LOAD_FAILED,
        '시트를 찾을 수 없습니다: ' + name
      );
    }
    this._sheets[name] = sheet;
    return sheet;
  },

  /** 시트 전체 값 (실행 단위 1회만 읽는다) */
  values: function (name) {
    if (this._values[name]) return this._values[name];
    this._values[name] = this.sheet(name).getDataRange().getValues();
    return this._values[name];
  },

  objects: function (name) {
    if (this._objects[name]) return this._objects[name];
    this._objects[name] = Util.rowsToObjects(this.values(name));
    return this._objects[name];
  },

  header: function (name) {
    var values = this._values[name];
    if (values && values.length) return values[0].map(Util.trim);
    var sheet = this.sheet(name);
    var lastCol = sheet.getLastColumn();
    if (!lastCol) return SHEET_SCHEMA[name] || [];
    return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(Util.trim);
  },

  invalidate: function (name) {
    delete this._values[name];
    delete this._objects[name];
  },

  appendObject: function (name, obj) {
    var header = this.header(name);
    this.sheet(name).appendRow(Util.objectToRow(obj, header));
    this.invalidate(name);
  },

  writeObject: function (name, rowNumber, obj) {
    var header = this.header(name);
    this.sheet(name)
      .getRange(rowNumber, 1, 1, header.length)
      .setValues([Util.objectToRow(obj, header)]);
    this.invalidate(name);
  },

  readObject: function (name, rowNumber) {
    var header = this.header(name);
    var row = this.sheet(name).getRange(rowNumber, 1, 1, header.length).getValues()[0];
    var obj = {};
    for (var i = 0; i < header.length; i++) {
      var cell = row[i];
      obj[header[i]] = cell instanceof Date ? cell.toISOString() : cell;
    }
    return obj;
  }
};

var SheetRepository = {
  /* ---- 사용자 (Asset_Master 에서 파생) ---- */
  listUsers: function () {
    var rows = SheetIO.objects(SHEET_NAMES.ASSET_MASTER);
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
      var rows = SheetIO.objects(SHEET_NAMES.ASSET_MASTER);
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
      list = SheetIO.objects(SHEET_NAMES.ADMIN);
    } catch (err) {
      // Admin 시트가 없으면 CONFIG.ADMIN_EMAILS 만 사용한다
      list = [];
    }
    Cache.put('admins', list, Config.num('CACHE_TTL_SECONDS'));
    return list;
  },

  /* ---- 차수 ---- */
  listCampaigns: function () {
    return SheetIO.objects(SHEET_NAMES.AUDIT_CAMPAIGN).map(function (c) {
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
    var rows = SheetIO.objects(SHEET_NAMES.ASSET_MASTER);
    for (var i = 0; i < rows.length; i++) {
      if (RepoUtil.matchTag(rows[i].asset_tag, tag)) return rows[i];
    }
    return null;
  },

  findAssetById: function (assetId) {
    var rows = SheetIO.objects(SHEET_NAMES.ASSET_MASTER);
    for (var i = 0; i < rows.length; i++) {
      if (Util.trim(rows[i].asset_id) === Util.trim(assetId)) return rows[i];
    }
    return null;
  },

  /* ---- 대상 ---- */
  listTargetsByCampaign: function (campaignId) {
    return SheetIO.objects(SHEET_NAMES.AUDIT_TARGET).filter(function (t) {
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
    return SheetIO.objects(SHEET_NAMES.AUDIT_LOG).filter(function (l) {
      return Util.trim(l.campaign_id) === campaignId;
    });
  },

  listLogsByUser: function (campaignId, email) {
    return this.listLogsByCampaign(campaignId).filter(function (l) {
      return RepoUtil.matchEmail(l.user_email, email);
    });
  },

  /**
   * 키 컬럼(campaign_id, asset_id, asset_tag, user_email)만 읽어 행을 찾는다.
   * 전체 시트를 읽지 않으므로 QR 스캔 경로가 가벼워진다.
   * @return {number} 시트 행 번호 (없으면 -1)
   */
  _findLogRow: function (campaignId, assetId, email) {
    var sheet = SheetIO.sheet(SHEET_NAMES.AUDIT_LOG);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return -1;
    var keys = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (
        Util.trim(keys[i][0]) === campaignId &&
        Util.trim(keys[i][1]) === Util.trim(assetId) &&
        RepoUtil.matchEmail(keys[i][3], email)
      ) {
        return i + 2;
      }
    }
    return -1;
  },

  findLog: function (campaignId, assetId, email) {
    var row = this._findLogRow(campaignId, assetId, email);
    if (row < 0) return null;
    return SheetIO.readObject(SHEET_NAMES.AUDIT_LOG, row);
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
        var existing = SheetIO.readObject(SHEET_NAMES.AUDIT_LOG, row);
        record = RepoUtil.merge(RepoUtil.merge(RepoUtil.emptyLog(), existing), log);
        SheetIO.writeObject(SHEET_NAMES.AUDIT_LOG, row, record);
      } else {
        record = RepoUtil.merge(RepoUtil.emptyLog(), log);
        SheetIO.appendObject(SHEET_NAMES.AUDIT_LOG, record);
      }
      Cache.remove('dashboard:' + log.campaign_id);
      return record;
    } finally {
      if (acquired) lock.releaseLock();
    }
  },

  /* ---- 목록에 없는 자산 ---- */
  listUnlistedByCampaign: function (campaignId) {
    return SheetIO.objects(SHEET_NAMES.AUDIT_UNLISTED).filter(function (u) {
      return Util.trim(u.campaign_id) === campaignId;
    });
  },

  listUnlistedByUser: function (campaignId, email) {
    return this.listUnlistedByCampaign(campaignId).filter(function (u) {
      return RepoUtil.matchEmail(u.user_email, email);
    });
  },

  _findUnlistedRow: function (campaignId, email, tag) {
    var sheet = SheetIO.sheet(SHEET_NAMES.AUDIT_UNLISTED);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return -1;
    var keys = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (
        Util.trim(keys[i][0]) === campaignId &&
        RepoUtil.matchEmail(keys[i][1], email) &&
        RepoUtil.matchTag(keys[i][2], tag)
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
        var existing = SheetIO.readObject(SHEET_NAMES.AUDIT_UNLISTED, row);
        merged = RepoUtil.merge(
          RepoUtil.merge(RepoUtil.emptyUnlisted(), existing),
          record
        );
        SheetIO.writeObject(SHEET_NAMES.AUDIT_UNLISTED, row, merged);
      } else {
        merged = RepoUtil.merge(RepoUtil.emptyUnlisted(), record);
        SheetIO.appendObject(SHEET_NAMES.AUDIT_UNLISTED, merged);
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
      SheetIO.appendObject(SHEET_NAMES.ERROR_LOG, {
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
