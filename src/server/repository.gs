/**
 * Repository 인터페이스 (Facade).
 *
 * 서비스 계층은 항상 `Repository.*` 만 호출한다.
 * 실제 구현은 CONFIG.MODE 에 따라 MockRepository / SheetRepository 로 분기한다.
 * 두 구현은 완전히 동일한 시그니처를 가진다(§24).
 *
 * 반환 객체의 필드명은 Sheet 컬럼명과 1:1로 일치시킨다.
 */
var Repository = {
  impl: function () {
    return Config.isMock() ? MockRepository : SheetRepository;
  },

  /* ---- 사용자 / 관리자 ---- */
  listUsers: function () { return this.impl().listUsers(); },
  findUserByEmail: function (email) { return this.impl().findUserByEmail(email); },
  listAdmins: function () { return this.impl().listAdmins(); },

  /* ---- 실사 차수 ---- */
  getActiveCampaign: function () { return this.impl().getActiveCampaign(); },
  listCampaigns: function () { return this.impl().listCampaigns(); },
  findCampaign: function (campaignId) { return this.impl().findCampaign(campaignId); },

  /* ---- 자산 기준정보 (관리자 화면 전용) ---- */
  findAssetByTag: function (tag) { return this.impl().findAssetByTag(tag); },
  findAssetById: function (assetId) { return this.impl().findAssetById(assetId); },

  /* ---- 실사 대상 Snapshot ---- */
  listTargetsByUser: function (campaignId, email) {
    return this.impl().listTargetsByUser(campaignId, email);
  },
  listTargetsByCampaign: function (campaignId) {
    return this.impl().listTargetsByCampaign(campaignId);
  },
  findTargetByTag: function (campaignId, tag) {
    return this.impl().findTargetByTag(campaignId, tag);
  },
  findTargetByAsset: function (campaignId, assetId) {
    return this.impl().findTargetByAsset(campaignId, assetId);
  },

  /* ---- 실사 로그 ---- */
  listLogsByUser: function (campaignId, email) {
    return this.impl().listLogsByUser(campaignId, email);
  },
  listLogsByCampaign: function (campaignId) {
    return this.impl().listLogsByCampaign(campaignId);
  },
  findLog: function (campaignId, assetId, email) {
    return this.impl().findLog(campaignId, assetId, email);
  },
  /** 논리 unique key(campaign_id + asset_id + user_email) 기준 upsert */
  upsertLog: function (log) { return this.impl().upsertLog(log); },

  /* ---- 목록에 없는 자산 ---- */
  listUnlistedByUser: function (campaignId, email) {
    return this.impl().listUnlistedByUser(campaignId, email);
  },
  listUnlistedByCampaign: function (campaignId) {
    return this.impl().listUnlistedByCampaign(campaignId);
  },
  /** unique key(campaign_id + user_email + scanned_tag) 기준 upsert */
  upsertUnlisted: function (record) { return this.impl().upsertUnlisted(record); },

  /* ---- 오류 로그 ---- */
  logError: function (record) { return this.impl().logError(record); },

  /* ---- PoC 데모 전용 ---- */
  resetUserAudit: function (campaignId, email) {
    return this.impl().resetUserAudit(campaignId, email);
  }
};

/**
 * 두 구현이 공유하는 순수 함수들.
 * (배열 필터링 로직을 한 곳에 모아 Mock/Sheet 간 동작 차이를 없앤다)
 */
var RepoUtil = {
  matchEmail: function (a, b) {
    return Util.trim(a).toLowerCase() === Util.trim(b).toLowerCase();
  },

  matchTag: function (a, b) {
    return Util.normalizeTag(a) === Util.normalizeTag(b);
  },

  /** 빈 Audit_Log 레코드 (모든 컬럼 존재 보장) */
  emptyLog: function () {
    return {
      campaign_id: '',
      asset_id: '',
      asset_tag: '',
      user_email: '',
      verification_method: '',
      scanned_tag: '',
      photo_file_id: '',
      photo_url: '',
      audit_status: '',
      exception_type: '',
      note: '',
      verified_at: '',
      created_at: '',
      updated_at: '',
      review_state: '',
      review_note: '',
      reviewed_by: '',
      reviewed_at: ''
    };
  },

  emptyUnlisted: function () {
    return {
      campaign_id: '',
      user_email: '',
      scanned_tag: '',
      photo_file_id: '',
      photo_url: '',
      note: '',
      created_at: '',
      status: '',
      review_note: '',
      reviewed_by: '',
      reviewed_at: ''
    };
  },

  /** 기본값 위에 입력값을 덮어써 컬럼 누락을 방지 */
  merge: function (base, patch) {
    var out = {};
    for (var k in base) out[k] = base[k];
    for (var p in patch) {
      if (patch[p] !== undefined) out[p] = patch[p];
    }
    return out;
  }
};
