/**
 * 내 자산 조회 서비스.
 *
 * 직원 화면에 내려보내는 필드는 자산 식별에 필요한 최소한으로 제한한다.
 * (serial_number, 다른 사용자 정보, Asset_Master 전량 등은 절대 내려보내지 않는다 §18)
 */

/** 내부 상태값 → 직원 화면 표기 (§13) */
var DISPLAY_STATUS = {
  NOT_STARTED: { label: '미실사', tone: 'idle' },
  QR_VERIFIED: { label: '완료', tone: 'done' },
  PHOTO_SUBMITTED: { label: '사진 제출', tone: 'photo' },
  NOT_IN_POSSESSION: { label: '확인 필요', tone: 'warn' },
  UNLISTED_ASSET: { label: '확인 필요', tone: 'warn' },
  REVIEW_REQUIRED: { label: '확인 필요', tone: 'warn' }
};

var EXCEPTION_LABELS = {
  ALREADY_RETURNED: '이미 반납함',
  TRANSFERRED: '다른 사람에게 전달함',
  LOST: '분실',
  NOT_REMEMBERED: '기억나지 않음',
  OTHER: '기타',
  UNLISTED: '목록에 없는 자산',
  FOREIGN_ASSET: '내 목록에 없는 QR',
  TAG_MISMATCH: 'Tag 불일치'
};

var AssetService = {
  /** 진행 중인 실사 차수 */
  getActiveCampaign: function () {
    var campaign = Repository.getActiveCampaign();
    if (!campaign) {
      throw new AppError('NO_CAMPAIGN', ERROR_MESSAGES.NO_CAMPAIGN, '');
    }
    return campaign;
  },

  /** 응답이 기록된 상태인지 (§14 완료 판정 기준) */
  isResponded: function (status) {
    return (
      status === AUDIT_STATUS.QR_VERIFIED ||
      status === AUDIT_STATUS.PHOTO_SUBMITTED ||
      status === AUDIT_STATUS.NOT_IN_POSSESSION
    );
  },

  /** 관리자 KPI 상 "실사 완료" (QR 확인 + 사진 제출) */
  isCompleted: function (status) {
    return (
      status === AUDIT_STATUS.QR_VERIFIED ||
      status === AUDIT_STATUS.PHOTO_SUBMITTED
    );
  },

  display: function (status) {
    return DISPLAY_STATUS[status] || DISPLAY_STATUS.NOT_STARTED;
  },

  exceptionLabel: function (type) {
    return EXCEPTION_LABELS[type] || '';
  },

  /** Audit_Target + Audit_Log 를 합쳐 화면용 자산 카드 데이터를 만든다 */
  toAssetCard: function (target, log) {
    var status = (log && Util.trim(log.audit_status)) || AUDIT_STATUS.NOT_STARTED;
    var display = this.display(status);
    return {
      asset_id: Util.trim(target.asset_id),
      asset_tag: Util.trim(target.asset_tag),
      asset_name: Util.trim(target.asset_name),
      audit_status: status,
      status_label: display.label,
      status_tone: display.tone,
      verification_method: (log && Util.trim(log.verification_method)) || '',
      exception_type: (log && Util.trim(log.exception_type)) || '',
      exception_label: this.exceptionLabel((log && Util.trim(log.exception_type)) || ''),
      note: (log && Util.trim(log.note)) || '',
      photo_file_id: (log && Util.trim(log.photo_file_id)) || '',
      verified_at: (log && Util.toIso(log.verified_at)) || ''
    };
  },

  progressOf: function (cards) {
    var counts = {
      total: cards.length,
      responded: 0,
      qr_verified: 0,
      photo_submitted: 0,
      not_in_possession: 0,
      not_started: 0
    };
    var lastAt = '';
    for (var i = 0; i < cards.length; i++) {
      var status = cards[i].audit_status;
      if (status === AUDIT_STATUS.QR_VERIFIED) counts.qr_verified++;
      else if (status === AUDIT_STATUS.PHOTO_SUBMITTED) counts.photo_submitted++;
      else if (status === AUDIT_STATUS.NOT_IN_POSSESSION) counts.not_in_possession++;
      else counts.not_started++;

      if (AssetService.isResponded(status)) {
        counts.responded++;
        if (cards[i].verified_at > lastAt) lastAt = cards[i].verified_at;
      }
    }
    counts.completed = counts.total > 0 && counts.responded === counts.total;
    counts.completed_at = counts.completed ? lastAt : '';
    return counts;
  },

  /**
   * 내 자산 화면 전체 데이터.
   * 서버에서 로그인 사용자에 해당하는 행만 필터링해 반환한다.
   */
  getMyAuditView: function (user) {
    var campaign = this.getActiveCampaign();
    var targets = Repository.listTargetsByUser(campaign.campaign_id, user.email);
    var logs = Repository.listLogsByUser(campaign.campaign_id, user.email);

    var logByAsset = {};
    for (var i = 0; i < logs.length; i++) {
      logByAsset[Util.trim(logs[i].asset_id)] = logs[i];
    }

    var self = this;
    var cards = targets
      .map(function (t) {
        return self.toAssetCard(t, logByAsset[Util.trim(t.asset_id)]);
      })
      .sort(function (a, b) {
        return a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0;
      });

    var unlisted = Repository.listUnlistedByUser(
      campaign.campaign_id,
      user.email
    ).map(function (u) {
      return {
        scanned_tag: Util.trim(u.scanned_tag),
        note: Util.trim(u.note),
        created_at: Util.toIso(u.created_at),
        report_type: Util.trim(u.report_type) || EXCEPTION_TYPE.UNLISTED,
        report_label: self.exceptionLabel(
          Util.trim(u.report_type) || EXCEPTION_TYPE.UNLISTED
        ),
        photo_file_id: Util.trim(u.photo_file_id)
      };
    });

    return {
      user: {
        name: user.name,
        email: user.email,
        department: user.department,
        isAdmin: user.isAdmin,
        isMockSession: !!user.isMockSession
      },
      campaign: {
        campaign_id: campaign.campaign_id,
        campaign_name: campaign.campaign_name,
        start_date: campaign.start_date,
        end_date: campaign.end_date
      },
      assets: cards,
      unlisted: unlisted,
      progress: this.progressOf(cards),
      options: {
        allowDevTagInput: Config.bool('ALLOW_DEV_TAG_INPUT'),
        allowMockUser: Config.bool('ALLOW_MOCK_USER'),
        exceptionReasons: [
          { value: EXCEPTION_TYPE.ALREADY_RETURNED, label: '이미 반납함' },
          { value: EXCEPTION_TYPE.TRANSFERRED, label: '다른 사람에게 전달함' },
          { value: EXCEPTION_TYPE.LOST, label: '분실' },
          { value: EXCEPTION_TYPE.NOT_REMEMBERED, label: '기억나지 않음' },
          { value: EXCEPTION_TYPE.OTHER, label: '기타' }
        ]
      }
    };
  }
};
