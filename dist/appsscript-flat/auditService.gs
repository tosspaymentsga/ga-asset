/**
 * 실사 처리 서비스 (QR / 사진 / 예외 / 목록에 없는 자산).
 *
 * 보안 원칙(§7): 클라이언트는 "무엇을 스캔했는지"만 보낸다.
 * "그것이 내 자산인지" 는 항상 서버가 Audit_Target 으로 판정한다.
 * 다른 직원의 이름·이메일·부서는 어떤 응답에도 포함하지 않는다.
 */

var AuditService = {
  /** 사용자의 대상 목록에서 tag 로 자산 찾기 (본인 대상만 조회하므로 정보 유출 없음) */
  _findMyTargetByTag: function (campaignId, email, tag) {
    var targets = Repository.listTargetsByUser(campaignId, email);
    for (var i = 0; i < targets.length; i++) {
      if (RepoUtil.matchTag(targets[i].asset_tag, tag)) return targets[i];
    }
    return null;
  },

  _findMyTargetByAsset: function (campaignId, email, assetId) {
    var targets = Repository.listTargetsByUser(campaignId, email);
    for (var i = 0; i < targets.length; i++) {
      if (Util.trim(targets[i].asset_id) === Util.trim(assetId)) return targets[i];
    }
    return null;
  },

  /**
   * QR 실사(§7).
   * @param {string} scannedTag QR 에서 읽은 원본 문자열
   * @param {string} expectedAssetId 자산 상세에서 스캔한 경우 해당 asset_id
   */
  verifyQr: function (user, scannedTag, expectedAssetId) {
    var campaign = AssetService.getActiveCampaign();
    var tag = Util.extractTag(scannedTag);
    if (!tag) {
      throw new AppError('QR_FAILED', ERROR_MESSAGES.QR_FAILED, 'empty tag');
    }

    var target = this._findMyTargetByTag(campaign.campaign_id, user.email, tag);

    // 본인 대상 목록에 없음 → 소유자 정보 없이 안내만 (§7)
    if (!target) {
      return { result: 'NOT_MINE', scanned_tag: tag };
    }

    // 자산 상세에서 스캔했는데 내 "다른" 자산의 Tag 였던 경우
    if (expectedAssetId && Util.trim(expectedAssetId) !== Util.trim(target.asset_id)) {
      var expected = this._findMyTargetByAsset(
        campaign.campaign_id,
        user.email,
        expectedAssetId
      );
      if (expected) {
        var existingLog = Repository.findLog(
          campaign.campaign_id,
          target.asset_id,
          user.email
        );
        return {
          result: 'OTHER_OWN_ASSET',
          scanned_tag: tag,
          asset: AssetService.toAssetCard(target, existingLog),
          expected_asset_name: Util.trim(expected.asset_name)
        };
      }
    }

    var existing = Repository.findLog(
      campaign.campaign_id,
      target.asset_id,
      user.email
    );
    var alreadyVerified =
      !!existing && Util.trim(existing.audit_status) === AUDIT_STATUS.QR_VERIFIED;

    var now = Util.nowIso();
    // 동일 자산은 (campaign_id + asset_id + user_email) 로 upsert 되므로
    // 몇 번을 스캔해도 Audit_Log 행은 1건만 유지된다.
    var saved = Repository.upsertLog({
      campaign_id: campaign.campaign_id,
      asset_id: target.asset_id,
      asset_tag: target.asset_tag,
      user_email: user.email,
      verification_method: VERIFICATION_METHOD.QR,
      scanned_tag: tag,
      audit_status: AUDIT_STATUS.QR_VERIFIED,
      exception_type: '',
      // QR 로 확인되면 이전 예외 신고에 대한 검토 대상에서 제외한다
      review_state: '',
      review_note: '',
      // 이미 확인된 자산이면 최초 확인 시각을 보존한다
      verified_at: alreadyVerified ? Util.toIso(existing.verified_at) : now,
      created_at: existing ? Util.toIso(existing.created_at) || now : now,
      updated_at: now
    });

    return {
      result: 'MATCHED',
      already_verified: alreadyVerified,
      asset: AssetService.toAssetCard(target, saved),
      progress: this._progress(user, campaign)
    };
  },

  /**
   * 내 목록에 없는 QR 을 "확인 필요" 로 등록(§7).
   * Audit_Unlisted 에 report_type 과 함께 기록한다.
   */
  registerForeignScan: function (user, scannedTag, expectedAssetId) {
    var campaign = AssetService.getActiveCampaign();
    var tag = Util.extractTag(scannedTag);
    if (!tag) {
      throw new AppError('QR_FAILED', ERROR_MESSAGES.QR_FAILED, 'empty tag');
    }

    var reportType = expectedAssetId
      ? EXCEPTION_TYPE.TAG_MISMATCH
      : EXCEPTION_TYPE.FOREIGN_ASSET;

    var existing = this._findUnlisted(campaign.campaign_id, user.email, tag);
    var now = Util.nowIso();

    Repository.upsertUnlisted({
      campaign_id: campaign.campaign_id,
      user_email: user.email,
      scanned_tag: tag,
      note: expectedAssetId ? '자산 ' + Util.trim(expectedAssetId) + ' 확인 중 스캔됨' : '',
      created_at: existing ? Util.toIso(existing.created_at) || now : now,
      status: REVIEW_STATE.PENDING,
      report_type: reportType
    });

    return { scanned_tag: tag, already: !!existing };
  },

  /** 사진 실사(§10) */
  submitPhoto: function (user, assetId, base64, mimeType) {
    var campaign = AssetService.getActiveCampaign();
    var target = this._findMyTargetByAsset(
      campaign.campaign_id,
      user.email,
      assetId
    );
    if (!target) {
      // 본인 대상이 아니면 존재 여부조차 알려주지 않는다
      throw new AppError('FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, 'target not found');
    }
    this._validatePhoto(base64, mimeType);

    var stored = PhotoStorage.savePhoto({
      campaignId: campaign.campaign_id,
      userEmail: user.email,
      assetId: target.asset_id,
      base64: base64,
      mimeType: mimeType
    });

    var existing = Repository.findLog(
      campaign.campaign_id,
      target.asset_id,
      user.email
    );
    // QR 로 이미 확인된 자산이면 더 강한 증빙을 유지하고 사진만 첨부한다
    var keepQr =
      !!existing && Util.trim(existing.audit_status) === AUDIT_STATUS.QR_VERIFIED;
    var now = Util.nowIso();

    var saved = Repository.upsertLog({
      campaign_id: campaign.campaign_id,
      asset_id: target.asset_id,
      asset_tag: target.asset_tag,
      user_email: user.email,
      verification_method: keepQr ? VERIFICATION_METHOD.QR : VERIFICATION_METHOD.PHOTO,
      photo_file_id: stored.file_id,
      photo_url: stored.url,
      audit_status: keepQr ? AUDIT_STATUS.QR_VERIFIED : AUDIT_STATUS.PHOTO_SUBMITTED,
      exception_type: '',
      // 사진 제출은 QR 확인과 동일하게 취급하지 않고 관리자 검토 대상으로 남긴다
      review_state: keepQr ? '' : REVIEW_STATE.PENDING,
      verified_at: keepQr ? Util.toIso(existing.verified_at) : now,
      created_at: existing ? Util.toIso(existing.created_at) || now : now,
      updated_at: now
    });

    return {
      asset: AssetService.toAssetCard(target, saved),
      progress: this._progress(user, campaign)
    };
  },

  /** 미보유 신고(§11) */
  submitException: function (user, assetId, exceptionType, note) {
    var campaign = AssetService.getActiveCampaign();
    var target = this._findMyTargetByAsset(
      campaign.campaign_id,
      user.email,
      assetId
    );
    if (!target) {
      throw new AppError('FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, 'target not found');
    }

    var allowed = [
      EXCEPTION_TYPE.ALREADY_RETURNED,
      EXCEPTION_TYPE.TRANSFERRED,
      EXCEPTION_TYPE.LOST,
      EXCEPTION_TYPE.NOT_REMEMBERED,
      EXCEPTION_TYPE.OTHER
    ];
    if (allowed.indexOf(exceptionType) < 0) {
      throw new AppError('SAVE_FAILED', '사유를 선택해주세요.', exceptionType);
    }

    var trimmedNote = Util.trim(note).substring(0, 300);
    if (exceptionType === EXCEPTION_TYPE.OTHER && !trimmedNote) {
      throw new AppError('SAVE_FAILED', '기타 사유는 내용을 입력해주세요.', '');
    }

    var existing = Repository.findLog(
      campaign.campaign_id,
      target.asset_id,
      user.email
    );
    var now = Util.nowIso();

    var saved = Repository.upsertLog({
      campaign_id: campaign.campaign_id,
      asset_id: target.asset_id,
      asset_tag: target.asset_tag,
      user_email: user.email,
      verification_method: VERIFICATION_METHOD.SELF_REPORT,
      scanned_tag: '',
      audit_status: AUDIT_STATUS.NOT_IN_POSSESSION,
      exception_type: exceptionType,
      note: trimmedNote,
      review_state: REVIEW_STATE.PENDING,
      verified_at: now,
      created_at: existing ? Util.toIso(existing.created_at) || now : now,
      updated_at: now
    });

    return {
      asset: AssetService.toAssetCard(target, saved),
      progress: this._progress(user, campaign)
    };
  },

  /** 목록에 없는 자산 등록(§12) */
  submitUnlistedAsset: function (user, tagInput, note, base64, mimeType) {
    var campaign = AssetService.getActiveCampaign();
    var tag = Util.extractTag(tagInput);
    if (!tag) {
      throw new AppError('SAVE_FAILED', 'Tag 번호를 입력해주세요.', '');
    }

    var photo = { file_id: '', url: '' };
    if (base64) {
      this._validatePhoto(base64, mimeType);
      photo = PhotoStorage.savePhoto({
        campaignId: campaign.campaign_id,
        userEmail: user.email,
        assetId: 'unlisted_' + tag,
        base64: base64,
        mimeType: mimeType
      });
    }

    var existing = this._findUnlisted(campaign.campaign_id, user.email, tag);
    var now = Util.nowIso();

    Repository.upsertUnlisted({
      campaign_id: campaign.campaign_id,
      user_email: user.email,
      scanned_tag: tag,
      photo_file_id: photo.file_id,
      photo_url: photo.url,
      note: Util.trim(note).substring(0, 300),
      created_at: existing ? Util.toIso(existing.created_at) || now : now,
      status: REVIEW_STATE.PENDING,
      report_type: EXCEPTION_TYPE.UNLISTED
    });

    return { scanned_tag: tag, already: !!existing };
  },

  /**
   * 사진 미리보기.
   * 본인 증빙이거나 관리자인 경우에만 반환한다(§10 권한).
   */
  getPhotoDataUrl: function (user, fileId) {
    var id = Util.trim(fileId);
    if (!id) return null;

    var allowed = user.isAdmin;
    if (!allowed) {
      var campaign = AssetService.getActiveCampaign();
      var logs = Repository.listLogsByUser(campaign.campaign_id, user.email);
      for (var i = 0; i < logs.length && !allowed; i++) {
        if (Util.trim(logs[i].photo_file_id) === id) allowed = true;
      }
      if (!allowed) {
        var unlisted = Repository.listUnlistedByUser(
          campaign.campaign_id,
          user.email
        );
        for (var j = 0; j < unlisted.length && !allowed; j++) {
          if (Util.trim(unlisted[j].photo_file_id) === id) allowed = true;
        }
      }
    }
    if (!allowed) {
      throw new AppError('FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, 'photo access');
    }
    return PhotoStorage.getPhotoDataUrl(id);
  },

  /* ---------------- 내부 ---------------- */

  _findUnlisted: function (campaignId, email, tag) {
    var list = Repository.listUnlistedByUser(campaignId, email);
    for (var i = 0; i < list.length; i++) {
      if (RepoUtil.matchTag(list[i].scanned_tag, tag)) return list[i];
    }
    return null;
  },

  _validatePhoto: function (base64, mimeType) {
    if (!base64) {
      throw new AppError('PHOTO_FAILED', '사진을 선택해주세요.', '');
    }
    var allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.indexOf(Util.trim(mimeType).toLowerCase()) < 0) {
      throw new AppError('PHOTO_FAILED', '이미지 파일만 업로드할 수 있습니다.', mimeType);
    }
    // base64 길이 → 대략적인 바이트 수
    var bytes = Math.floor((base64.length * 3) / 4);
    if (bytes > Config.num('MAX_PHOTO_BYTES')) {
      throw new AppError('PHOTO_FAILED', '사진 용량이 너무 큽니다.', String(bytes));
    }
  },

  _progress: function (user, campaign) {
    var targets = Repository.listTargetsByUser(campaign.campaign_id, user.email);
    var logs = Repository.listLogsByUser(campaign.campaign_id, user.email);
    var byAsset = {};
    for (var i = 0; i < logs.length; i++) {
      byAsset[Util.trim(logs[i].asset_id)] = logs[i];
    }
    var cards = targets.map(function (t) {
      return AssetService.toAssetCard(t, byAsset[Util.trim(t.asset_id)]);
    });
    return AssetService.progressOf(cards);
  }
};
