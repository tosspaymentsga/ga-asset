/**
 * 관리자 서비스 (Dashboard / 목록 / Reconciliation).
 *
 * 모든 수치는 Audit_Target 을 분모로 매 요청 계산한다(§15).
 * Asset_Master 가 실사 도중 바뀌어도 실사율의 분모는 흔들리지 않는다.
 */

var AdminService = {
  /** 캠페인 확정 (미지정 시 활성 차수) */
  _resolveCampaign: function (campaignId) {
    var campaign = campaignId
      ? Repository.findCampaign(campaignId)
      : Repository.getActiveCampaign();
    if (!campaign) {
      throw new AppError('NO_CAMPAIGN', ERROR_MESSAGES.NO_CAMPAIGN, campaignId || '');
    }
    return campaign;
  },

  /** 확인 필요 분류 (§17) */
  _categoryOfLog: function (log) {
    var status = Util.trim(log.audit_status);
    if (status === AUDIT_STATUS.NOT_IN_POSSESSION) {
      return REVIEW_CATEGORY.NOT_IN_POSSESSION;
    }
    if (status === AUDIT_STATUS.PHOTO_SUBMITTED) {
      return REVIEW_CATEGORY.PHOTO_REVIEW;
    }
    return null;
  },

  _categoryOfUnlisted: function (record) {
    var type = Util.trim(record.report_type) || EXCEPTION_TYPE.UNLISTED;
    if (type === EXCEPTION_TYPE.TAG_MISMATCH) return REVIEW_CATEGORY.TAG_MISMATCH;
    if (type === EXCEPTION_TYPE.FOREIGN_ASSET) return REVIEW_CATEGORY.FOREIGN_SCAN;
    return REVIEW_CATEGORY.UNLISTED_ASSET;
  },

  _emptyCategoryCounts: function () {
    return {
      NOT_IN_POSSESSION: 0,
      UNLISTED_ASSET: 0,
      FOREIGN_SCAN: 0,
      TAG_MISMATCH: 0,
      PHOTO_REVIEW: 0
    };
  },

  /* ---------------------------------------------------------------- */
  /* Dashboard                                                         */
  /* ---------------------------------------------------------------- */

  getDashboard: function (campaignId) {
    var campaign = this._resolveCampaign(campaignId);
    var cacheKey = 'dashboard:' + campaign.campaign_id;
    var cached = Cache.get(cacheKey);
    if (cached) return cached;

    var targets = Repository.listTargetsByCampaign(campaign.campaign_id);
    var logs = Repository.listLogsByCampaign(campaign.campaign_id);
    var unlisted = Repository.listUnlistedByCampaign(campaign.campaign_id);

    var logByAsset = {};
    for (var i = 0; i < logs.length; i++) {
      logByAsset[Util.trim(logs[i].asset_id)] = logs[i];
    }

    var asset = {
      total: targets.length,
      completed: 0,
      not_started: 0,
      review_required: 0,
      qr_verified: 0,
      photo_submitted: 0
    };
    var deptMap = {};
    var userMap = {};

    for (var t = 0; t < targets.length; t++) {
      var target = targets[t];
      var log = logByAsset[Util.trim(target.asset_id)];
      var status = (log && Util.trim(log.audit_status)) || AUDIT_STATUS.NOT_STARTED;

      if (status === AUDIT_STATUS.QR_VERIFIED) asset.qr_verified++;
      if (status === AUDIT_STATUS.PHOTO_SUBMITTED) asset.photo_submitted++;
      if (AssetService.isCompleted(status)) asset.completed++;
      else if (status === AUDIT_STATUS.NOT_IN_POSSESSION) asset.review_required++;
      else asset.not_started++;

      var dept = Util.trim(target.department) || '미지정';
      if (!deptMap[dept]) {
        deptMap[dept] = { department: dept, total: 0, completed: 0, not_started: 0, review_required: 0 };
      }
      deptMap[dept].total++;
      if (AssetService.isCompleted(status)) deptMap[dept].completed++;
      else if (status === AUDIT_STATUS.NOT_IN_POSSESSION) deptMap[dept].review_required++;
      else deptMap[dept].not_started++;

      var email = Util.normalizeEmail(target.user_email);
      if (!userMap[email]) userMap[email] = { total: 0, responded: 0 };
      userMap[email].total++;
      if (AssetService.isResponded(status)) userMap[email].responded++;
    }

    var userTotal = 0;
    var userCompleted = 0;
    for (var key in userMap) {
      userTotal++;
      if (userMap[key].total > 0 && userMap[key].responded === userMap[key].total) {
        userCompleted++;
      }
    }

    var counts = this._emptyCategoryCounts();
    var openTotal = 0;
    for (var l = 0; l < logs.length; l++) {
      if (Util.trim(logs[l].review_state) !== REVIEW_STATE.PENDING) continue;
      var cat = this._categoryOfLog(logs[l]);
      if (!cat) continue;
      counts[cat]++;
      openTotal++;
    }
    for (var u = 0; u < unlisted.length; u++) {
      var state = Util.trim(unlisted[u].status) || REVIEW_STATE.PENDING;
      if (state !== REVIEW_STATE.PENDING) continue;
      counts[this._categoryOfUnlisted(unlisted[u])]++;
      openTotal++;
    }

    var deptList = [];
    for (var d in deptMap) {
      deptMap[d].completion_rate = Util.percent(deptMap[d].completed, deptMap[d].total);
      deptList.push(deptMap[d]);
    }
    deptList.sort(function (a, b) { return b.total - a.total; });

    var result = {
      campaign: campaign,
      campaigns: Repository.listCampaigns().map(function (c) {
        return { campaign_id: c.campaign_id, campaign_name: c.campaign_name, status: c.status };
      }),
      asset: {
        total: asset.total,
        completed: asset.completed,
        not_started: asset.not_started,
        review_required: asset.review_required,
        qr_verified: asset.qr_verified,
        photo_submitted: asset.photo_submitted,
        completion_rate: Util.percent(asset.completed, asset.total)
      },
      user: {
        total: userTotal,
        completed: userCompleted,
        incomplete: userTotal - userCompleted,
        completion_rate: Util.percent(userCompleted, userTotal)
      },
      review: { open_total: openTotal, by_category: counts },
      by_department: deptList
    };

    Cache.put(cacheKey, result, Config.num('DASHBOARD_CACHE_TTL_SECONDS'));
    return result;
  },

  /* ---------------------------------------------------------------- */
  /* 실사 현황 목록 (§16)                                              */
  /* ---------------------------------------------------------------- */

  getAuditList: function (filters) {
    filters = filters || {};
    var campaign = this._resolveCampaign(filters.campaignId);
    var targets = Repository.listTargetsByCampaign(campaign.campaign_id);
    var logs = Repository.listLogsByCampaign(campaign.campaign_id);
    var unlisted = Repository.listUnlistedByCampaign(campaign.campaign_id);

    var logByAsset = {};
    for (var i = 0; i < logs.length; i++) {
      logByAsset[Util.trim(logs[i].asset_id)] = logs[i];
    }

    var nameByEmail = {};
    var deptByEmail = {};
    for (var t = 0; t < targets.length; t++) {
      var em = Util.normalizeEmail(targets[t].user_email);
      if (!nameByEmail[em]) {
        nameByEmail[em] = Util.trim(targets[t].user_name);
        deptByEmail[em] = Util.trim(targets[t].department);
      }
    }

    var rows = [];
    for (var r = 0; r < targets.length; r++) {
      var target = targets[r];
      var log = logByAsset[Util.trim(target.asset_id)];
      var status = (log && Util.trim(log.audit_status)) || AUDIT_STATUS.NOT_STARTED;
      rows.push({
        key: 'log|' + campaign.campaign_id + '|' + target.asset_id + '|' + Util.normalizeEmail(target.user_email),
        user_name: Util.trim(target.user_name),
        user_email: Util.trim(target.user_email),
        department: Util.trim(target.department),
        asset_name: Util.trim(target.asset_name),
        asset_id: Util.trim(target.asset_id),
        asset_tag: Util.trim(target.asset_tag),
        audit_status: status,
        status_label: AssetService.display(status).label,
        status_tone: AssetService.display(status).tone,
        verification_method: (log && Util.trim(log.verification_method)) || '',
        verified_at: (log && Util.toIso(log.verified_at)) || '',
        photo_file_id: (log && Util.trim(log.photo_file_id)) || '',
        exception_type: (log && Util.trim(log.exception_type)) || '',
        exception_label: AssetService.exceptionLabel((log && Util.trim(log.exception_type)) || ''),
        note: (log && Util.trim(log.note)) || '',
        review_state: (log && Util.trim(log.review_state)) || '',
        is_extra: false
      });
    }

    for (var u = 0; u < unlisted.length; u++) {
      var rec = unlisted[u];
      var email = Util.normalizeEmail(rec.user_email);
      var type = Util.trim(rec.report_type) || EXCEPTION_TYPE.UNLISTED;
      rows.push({
        key: 'unl|' + campaign.campaign_id + '|' + email + '|' + Util.normalizeTag(rec.scanned_tag),
        user_name: nameByEmail[email] || email,
        user_email: Util.trim(rec.user_email),
        department: deptByEmail[email] || '-',
        asset_name: type === EXCEPTION_TYPE.UNLISTED ? '목록에 없는 자산' : '내 목록에 없는 QR',
        asset_id: '-',
        asset_tag: Util.normalizeTag(rec.scanned_tag),
        audit_status: type === EXCEPTION_TYPE.UNLISTED
          ? AUDIT_STATUS.UNLISTED_ASSET
          : AUDIT_STATUS.REVIEW_REQUIRED,
        status_label: '확인 필요',
        status_tone: 'warn',
        verification_method: type === EXCEPTION_TYPE.UNLISTED
          ? VERIFICATION_METHOD.SELF_REPORT
          : VERIFICATION_METHOD.QR,
        verified_at: Util.toIso(rec.created_at),
        photo_file_id: Util.trim(rec.photo_file_id),
        exception_type: type,
        exception_label: AssetService.exceptionLabel(type),
        note: Util.trim(rec.note),
        review_state: Util.trim(rec.status) || REVIEW_STATE.PENDING,
        is_extra: true
      });
    }

    var query = Util.trim(filters.query).toLowerCase();
    var filtered = rows.filter(function (row) {
      if (filters.department && row.department !== filters.department) return false;
      if (filters.status && row.audit_status !== filters.status) return false;
      if (filters.method && row.verification_method !== filters.method) return false;
      if (query) {
        var hay = [row.user_name, row.user_email, row.asset_id, row.asset_tag, row.asset_name]
          .join(' ')
          .toLowerCase();
        if (hay.indexOf(query) < 0) return false;
      }
      return true;
    });

    filtered.sort(function (a, b) {
      if (a.user_name !== b.user_name) return a.user_name < b.user_name ? -1 : 1;
      return a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0;
    });

    var page = Math.max(1, Number(filters.page) || 1);
    var pageSize = Math.min(200, Math.max(10, Number(filters.pageSize) || 50));
    var start = (page - 1) * pageSize;

    var departments = [];
    var seenDept = {};
    for (var dd = 0; dd < targets.length; dd++) {
      var dn = Util.trim(targets[dd].department);
      if (dn && !seenDept[dn]) {
        seenDept[dn] = true;
        departments.push(dn);
      }
    }
    departments.sort();

    return {
      rows: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page: page,
      page_size: pageSize,
      campaign: campaign,
      facets: {
        departments: departments,
        campaigns: Repository.listCampaigns().map(function (c) {
          return { campaign_id: c.campaign_id, campaign_name: c.campaign_name };
        })
      }
    };
  },

  /* ---------------------------------------------------------------- */
  /* Reconciliation (§17)                                              */
  /* ---------------------------------------------------------------- */

  getReconciliation: function (filters) {
    filters = filters || {};
    var campaign = this._resolveCampaign(filters.campaignId);
    var targets = Repository.listTargetsByCampaign(campaign.campaign_id);
    var logs = Repository.listLogsByCampaign(campaign.campaign_id);
    var unlisted = Repository.listUnlistedByCampaign(campaign.campaign_id);

    var targetByAsset = {};
    var nameByEmail = {};
    var deptByEmail = {};
    for (var t = 0; t < targets.length; t++) {
      targetByAsset[Util.trim(targets[t].asset_id)] = targets[t];
      var em = Util.normalizeEmail(targets[t].user_email);
      if (!nameByEmail[em]) {
        nameByEmail[em] = Util.trim(targets[t].user_name);
        deptByEmail[em] = Util.trim(targets[t].department);
      }
    }

    var counts = this._emptyCategoryCounts();
    var openTotal = 0;
    var items = [];

    for (var i = 0; i < logs.length; i++) {
      var log = logs[i];
      var state = Util.trim(log.review_state);
      if (!state) continue;
      var category = this._categoryOfLog(log);
      if (!category) continue;
      if (state === REVIEW_STATE.PENDING) {
        counts[category]++;
        openTotal++;
      }
      var target = targetByAsset[Util.trim(log.asset_id)] || {};
      var email = Util.normalizeEmail(log.user_email);
      items.push({
        key: 'log|' + campaign.campaign_id + '|' + Util.trim(log.asset_id) + '|' + email,
        category: category,
        category_label: RECON_CATEGORY_LABELS[category],
        user_name: Util.trim(target.user_name) || nameByEmail[email] || email,
        user_email: Util.trim(log.user_email),
        department: Util.trim(target.department) || deptByEmail[email] || '-',
        asset_id: Util.trim(log.asset_id),
        asset_name: Util.trim(target.asset_name) || '-',
        asset_tag: Util.trim(log.asset_tag),
        exception_type: Util.trim(log.exception_type),
        exception_label: AssetService.exceptionLabel(Util.trim(log.exception_type)),
        note: Util.trim(log.note),
        photo_file_id: Util.trim(log.photo_file_id),
        created_at: Util.toIso(log.verified_at || log.created_at),
        review_state: state,
        review_note: Util.trim(log.review_note),
        reviewed_by: Util.trim(log.reviewed_by),
        reviewed_at: Util.toIso(log.reviewed_at),
        master_hint: ''
      });
    }

    for (var u = 0; u < unlisted.length; u++) {
      var rec = unlisted[u];
      var ucat = this._categoryOfUnlisted(rec);
      var ustate = Util.trim(rec.status) || REVIEW_STATE.PENDING;
      if (ustate === REVIEW_STATE.PENDING) {
        counts[ucat]++;
        openTotal++;
      }
      var uemail = Util.normalizeEmail(rec.user_email);
      // 관리자에게만 노출되는 Master 대조 힌트
      var master = Repository.findAssetByTag(rec.scanned_tag);
      var hint = master
        ? 'Master: ' + Util.trim(master.asset_id) + ' · ' + Util.trim(master.asset_name) +
          ' · ' + Util.trim(master.asset_status) +
          (Util.trim(master.user_email) ? ' · ' + Util.trim(master.user_email) : ' · 미지급')
        : 'Master 에 없는 Tag';

      items.push({
        key: 'unl|' + campaign.campaign_id + '|' + uemail + '|' + Util.normalizeTag(rec.scanned_tag),
        category: ucat,
        category_label: RECON_CATEGORY_LABELS[ucat],
        user_name: nameByEmail[uemail] || uemail,
        user_email: Util.trim(rec.user_email),
        department: deptByEmail[uemail] || '-',
        asset_id: '-',
        asset_name: ucat === REVIEW_CATEGORY.UNLISTED_ASSET ? '목록에 없는 자산' : '내 목록에 없는 QR',
        asset_tag: Util.normalizeTag(rec.scanned_tag),
        exception_type: Util.trim(rec.report_type) || EXCEPTION_TYPE.UNLISTED,
        exception_label: AssetService.exceptionLabel(
          Util.trim(rec.report_type) || EXCEPTION_TYPE.UNLISTED
        ),
        note: Util.trim(rec.note),
        photo_file_id: Util.trim(rec.photo_file_id),
        created_at: Util.toIso(rec.created_at),
        review_state: ustate,
        review_note: Util.trim(rec.review_note),
        reviewed_by: Util.trim(rec.reviewed_by),
        reviewed_at: Util.toIso(rec.reviewed_at),
        master_hint: hint
      });
    }

    var query = Util.trim(filters.query).toLowerCase();
    var filtered = items.filter(function (item) {
      if (filters.category && item.category !== filters.category) return false;
      if (filters.state && item.review_state !== filters.state) return false;
      if (query) {
        var hay = [item.user_name, item.user_email, item.asset_id, item.asset_tag]
          .join(' ')
          .toLowerCase();
        if (hay.indexOf(query) < 0) return false;
      }
      return true;
    });

    filtered.sort(function (a, b) {
      var ap = a.review_state === REVIEW_STATE.PENDING ? 0 : 1;
      var bp = b.review_state === REVIEW_STATE.PENDING ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.created_at < b.created_at ? 1 : -1;
    });

    return {
      items: filtered,
      total: filtered.length,
      counts: counts,
      open_total: openTotal,
      campaign: campaign
    };
  },

  /**
   * 확인 필요 항목 처리.
   * PoC 단계에서는 Asset_Master 를 자동 수정하지 않는다(§17).
   * "자산정보 수정 필요" 는 분류 표시일 뿐이며 기준정보는 그대로 둔다.
   */
  resolveReviewItem: function (admin, key, state, note) {
    var allowed = [
      REVIEW_STATE.PENDING,
      REVIEW_STATE.RESOLVED_OK,
      REVIEW_STATE.MASTER_UPDATE_REQUIRED,
      REVIEW_STATE.USER_FOLLOWUP_REQUIRED
    ];
    if (allowed.indexOf(state) < 0) {
      throw new AppError('SAVE_FAILED', ERROR_MESSAGES.SAVE_FAILED, 'invalid state');
    }

    var parts = Util.trim(key).split('|');
    var now = Util.nowIso();
    var trimmedNote = Util.trim(note).substring(0, 300);

    if (parts[0] === 'log' && parts.length === 4) {
      Repository.upsertLog({
        campaign_id: parts[1],
        asset_id: parts[2],
        user_email: parts[3],
        review_state: state,
        review_note: trimmedNote,
        reviewed_by: admin.email,
        reviewed_at: now,
        updated_at: now
      });
      return { key: key, review_state: state };
    }

    if (parts[0] === 'unl' && parts.length === 4) {
      Repository.upsertUnlisted({
        campaign_id: parts[1],
        user_email: parts[2],
        scanned_tag: parts[3],
        status: state,
        review_note: trimmedNote,
        reviewed_by: admin.email,
        reviewed_at: now
      });
      return { key: key, review_state: state };
    }

    throw new AppError('SAVE_FAILED', ERROR_MESSAGES.SAVE_FAILED, 'invalid key');
  }
};

var RECON_CATEGORY_LABELS = {
  NOT_IN_POSSESSION: '보유하지 않음',
  UNLISTED_ASSET: '목록에 없는 자산',
  FOREIGN_SCAN: '내 목록에 없는 QR',
  TAG_MISMATCH: 'Tag 불일치',
  PHOTO_REVIEW: '사진 검토'
};

var REVIEW_STATE_LABELS = {
  PENDING: '미처리',
  RESOLVED_OK: '정상 처리',
  MASTER_UPDATE_REQUIRED: '자산정보 수정 필요',
  USER_FOLLOWUP_REQUIRED: '사용자 확인 필요'
};
