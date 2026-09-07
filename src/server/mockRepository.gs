/**
 * MOCK 데이터 저장소 (MODE=MOCK).
 *
 * SheetRepository 와 완전히 동일한 인터페이스를 제공한다.
 * 기준 데이터(사용자/자산/차수/대상)는 코드에서 결정론적으로 생성하고,
 * 변경분(Audit_Log, Audit_Unlisted)만 PropertiesService 에 저장한다.
 *
 * Apps Script 는 요청마다 실행 컨텍스트가 초기화되므로
 * 메모리 변수만으로는 상태가 유지되지 않는다. 따라서 변경분은 반드시 영속화한다.
 * (값 9KB 제한을 넘지 않도록 청크로 분할 저장)
 */

var MOCK_PROP_PREFIX = 'GA_AUDIT_MOCK_';
var MOCK_CHUNK_SIZE = 7000;

var MockStore = {
  _memo: {},

  _props: function () {
    return PropertiesService.getScriptProperties();
  },

  read: function (key, fallback) {
    if (this._memo[key] !== undefined) return this._memo[key];
    var props = this._props();
    var count = Number(props.getProperty(MOCK_PROP_PREFIX + key + '__n') || 0);
    if (!count) {
      this._memo[key] = fallback;
      return fallback;
    }
    var raw = '';
    for (var i = 0; i < count; i++) {
      raw += props.getProperty(MOCK_PROP_PREFIX + key + '__' + i) || '';
    }
    try {
      this._memo[key] = JSON.parse(raw);
    } catch (err) {
      this._memo[key] = fallback;
    }
    return this._memo[key];
  },

  write: function (key, value) {
    var raw = JSON.stringify(value);
    var props = this._props();
    var prevCount = Number(props.getProperty(MOCK_PROP_PREFIX + key + '__n') || 0);

    var chunks = [];
    for (var i = 0; i < raw.length; i += MOCK_CHUNK_SIZE) {
      chunks.push(raw.substring(i, i + MOCK_CHUNK_SIZE));
    }
    var batch = {};
    for (var c = 0; c < chunks.length; c++) {
      batch[MOCK_PROP_PREFIX + key + '__' + c] = chunks[c];
    }
    batch[MOCK_PROP_PREFIX + key + '__n'] = String(chunks.length);
    props.setProperties(batch, false);

    // 남은 이전 청크 제거
    for (var d = chunks.length; d < prevCount; d++) {
      props.deleteProperty(MOCK_PROP_PREFIX + key + '__' + d);
    }
    this._memo[key] = value;
  },

  clear: function () {
    var props = this._props();
    var all = props.getProperties();
    for (var k in all) {
      if (k.indexOf(MOCK_PROP_PREFIX) === 0) props.deleteProperty(k);
    }
    this._memo = {};
  }
};

/* ------------------------------------------------------------------ */
/* 기준 데이터 (결정론적)                                              */
/* ------------------------------------------------------------------ */

var MockData = {
  campaigns: function () {
    return [
      {
        campaign_id: 'AUDIT_2026_H2',
        campaign_name: '2026 하반기 자산실사',
        start_date: '2026-09-01',
        end_date: '2026-09-30',
        status: 'ACTIVE',
        created_at: '2026-08-28T09:00:00.000Z'
      },
      {
        campaign_id: 'AUDIT_2026_H1',
        campaign_name: '2026 상반기 자산실사',
        start_date: '2026-03-02',
        end_date: '2026-03-31',
        status: 'CLOSED',
        created_at: '2026-02-25T09:00:00.000Z'
      }
    ];
  },

  users: function () {
    return [
      { email: 'seho@company.com', name: '김세호', department: '경영지원팀' },
      { email: 'jieun@company.com', name: '이지은', department: '프로덕트디자인팀' },
      { email: 'junho@company.com', name: '박준호', department: '개발1팀' },
      { email: 'minseo@company.com', name: '최민서', department: '영업1팀' },
      { email: 'asset.admin@company.com', name: '박자산', department: '자산관리팀' }
    ];
  },

  admins: function () {
    return [{ email: 'asset.admin@company.com', name: '박자산', added_at: '2026-08-28' }];
  },

  /**
   * Asset_Master.
   * A001~A003 은 기획서 예시와 동일하게 김세호에게 배정한다.
   */
  assets: function () {
    var users = MockData.users();
    var byEmail = {};
    for (var i = 0; i < users.length; i++) byEmail[users[i].email] = users[i];

    var rows = [
      ['A001', 'MacBook Air 13', 'Apple M3 16GB', 'seho@company.com'],
      ['A002', '모니터 27형', 'LG 27UP850N-W', 'seho@company.com'],
      ['A003', 'iPad', 'iPad Air 11 M2', 'seho@company.com'],

      ['A004', 'MacBook Pro 14', 'Apple M3 Pro 18GB', 'jieun@company.com'],
      ['A005', '모니터 27형', 'Dell U2723QE', 'jieun@company.com'],
      ['A006', '키보드', 'Apple Magic Keyboard', 'jieun@company.com'],
      ['A007', '마우스', 'Logitech MX Master 3S', 'jieun@company.com'],
      ['A008', '아이패드', 'iPad Pro 11 M4', 'jieun@company.com'],

      ['A009', 'MacBook Pro 16', 'Apple M3 Max 36GB', 'junho@company.com'],
      ['A010', '모니터 32형', 'LG 32UN880', 'junho@company.com'],
      ['A011', '도킹 스테이션', 'CalDigit TS4', 'junho@company.com'],
      ['A012', '키보드', 'HHKB Professional', 'junho@company.com'],
      ['A013', '헤드셋', 'Jabra Evolve2 65', 'junho@company.com'],
      ['A014', '외장 SSD', 'Samsung T7 1TB', 'junho@company.com'],

      ['A015', 'MacBook Air 15', 'Apple M3 16GB', 'minseo@company.com'],
      ['A016', 'iPhone', 'iPhone 15 128GB', 'minseo@company.com'],
      ['A017', '모니터 27형', 'LG 27UP850N-W', 'minseo@company.com'],
      ['A018', '노트북 거치대', 'Rain mStand', 'minseo@company.com'],
      ['A019', '웹캠', 'Logitech C920', 'minseo@company.com'],

      ['A020', 'MacBook Pro 14', 'Apple M3 Pro 18GB', 'asset.admin@company.com'],
      ['A021', '모니터 27형', 'Dell U2723QE', 'asset.admin@company.com'],
      ['A022', '마우스', 'Logitech MX Master 3S', 'asset.admin@company.com'],

      // 미지급 재고 (실사 대상 아님 — 타인/미지급 자산 QR 테스트용)
      ['A023', '모니터 27형', 'LG 27UP850N-W', ''],
      ['A024', 'MacBook Air 13', 'Apple M3 16GB', '']
    ];

    return rows.map(function (row, index) {
      var owner = byEmail[row[3]];
      return {
        asset_id: row[0],
        asset_tag: 'Q' + (12345 + index),
        asset_name: row[1],
        model: row[2],
        serial_number: 'SN' + (100000 + index * 37),
        user_name: owner ? owner.name : '',
        user_email: owner ? owner.email : '',
        department: owner ? owner.department : '',
        asset_status: owner ? 'ASSIGNED' : 'IN_STOCK',
        updated_at: '2026-08-20T00:00:00.000Z'
      };
    });
  },

  /** Audit_Target — 활성 차수 시작 시점의 Snapshot */
  targets: function () {
    return MockData.assets()
      .filter(function (a) { return a.asset_status === 'ASSIGNED'; })
      .map(function (a) {
        return {
          campaign_id: 'AUDIT_2026_H2',
          asset_id: a.asset_id,
          asset_tag: a.asset_tag,
          asset_name: a.asset_name,
          user_name: a.user_name,
          user_email: a.user_email,
          department: a.department
        };
      });
  },

  /**
   * 시드 Audit_Log.
   * 김세호(A001~A003)는 데모 시나리오를 위해 항상 미실사 상태로 둔다.
   */
  seedLogs: function () {
    var targets = MockData.targets();
    var byAsset = {};
    for (var i = 0; i < targets.length; i++) byAsset[targets[i].asset_id] = targets[i];

    var plan = [
      ['A004', AUDIT_STATUS.QR_VERIFIED, '', ''],
      ['A005', AUDIT_STATUS.QR_VERIFIED, '', ''],
      ['A006', AUDIT_STATUS.PHOTO_SUBMITTED, '', ''],
      ['A009', AUDIT_STATUS.QR_VERIFIED, '', ''],
      ['A010', AUDIT_STATUS.QR_VERIFIED, '', ''],
      ['A011', AUDIT_STATUS.NOT_IN_POSSESSION, EXCEPTION_TYPE.LOST, ''],
      ['A012', AUDIT_STATUS.QR_VERIFIED, '', ''],
      ['A015', AUDIT_STATUS.QR_VERIFIED, '', ''],
      ['A016', AUDIT_STATUS.QR_VERIFIED, '', ''],
      ['A017', AUDIT_STATUS.PHOTO_SUBMITTED, '', ''],
      ['A018', AUDIT_STATUS.QR_VERIFIED, '', ''],
      ['A019', AUDIT_STATUS.NOT_IN_POSSESSION, EXCEPTION_TYPE.ALREADY_RETURNED, '작년 말에 반납했습니다.'],
      ['A020', AUDIT_STATUS.QR_VERIFIED, '', '']
    ];

    var base = new Date('2026-09-05T01:00:00.000Z').getTime();
    return plan.map(function (item, index) {
      var target = byAsset[item[0]];
      var at = new Date(base + index * 37 * 60000).toISOString();
      var isPhoto = item[1] === AUDIT_STATUS.PHOTO_SUBMITTED;
      var isNip = item[1] === AUDIT_STATUS.NOT_IN_POSSESSION;
      var needsReview = isPhoto || isNip;

      return RepoUtil.merge(RepoUtil.emptyLog(), {
        campaign_id: 'AUDIT_2026_H2',
        asset_id: target.asset_id,
        asset_tag: target.asset_tag,
        user_email: target.user_email,
        verification_method: isNip
          ? VERIFICATION_METHOD.SELF_REPORT
          : isPhoto ? VERIFICATION_METHOD.PHOTO : VERIFICATION_METHOD.QR,
        scanned_tag: isNip || isPhoto ? '' : target.asset_tag,
        photo_file_id: isPhoto ? 'mock-photo-' + target.asset_id : '',
        photo_url: isPhoto ? 'mock://photo/' + target.asset_id : '',
        audit_status: item[1],
        exception_type: item[2],
        note: item[3],
        verified_at: at,
        created_at: at,
        updated_at: at,
        review_state: needsReview ? REVIEW_STATE.PENDING : ''
      });
    });
  },

  seedUnlisted: function () {
    return [
      RepoUtil.merge(RepoUtil.emptyUnlisted(), {
        campaign_id: 'AUDIT_2026_H2',
        user_email: 'junho@company.com',
        scanned_tag: 'Q45001',
        note: '옆자리에서 넘겨받은 모니터인데 목록에 없습니다.',
        created_at: '2026-09-04T05:12:00.000Z',
        status: REVIEW_STATE.PENDING,
        report_type: EXCEPTION_TYPE.UNLISTED
      }),
      RepoUtil.merge(RepoUtil.emptyUnlisted(), {
        campaign_id: 'AUDIT_2026_H2',
        user_email: 'jieun@company.com',
        scanned_tag: 'Q12366',
        note: '',
        created_at: '2026-09-05T02:30:00.000Z',
        status: REVIEW_STATE.PENDING,
        report_type: EXCEPTION_TYPE.FOREIGN_ASSET
      })
    ];
  }
};

/* ------------------------------------------------------------------ */
/* MockRepository                                                      */
/* ------------------------------------------------------------------ */

var MockRepository = {
  _logs: function () {
    return MockStore.read('LOGS', null) || this._initLogs();
  },

  _initLogs: function () {
    var seed = MockData.seedLogs();
    MockStore.write('LOGS', seed);
    return seed;
  },

  _unlisted: function () {
    return MockStore.read('UNLISTED', null) || this._initUnlisted();
  },

  _initUnlisted: function () {
    var seed = MockData.seedUnlisted();
    MockStore.write('UNLISTED', seed);
    return seed;
  },

  /* ---- 사용자 ---- */
  listUsers: function () {
    return MockData.users();
  },

  findUserByEmail: function (email) {
    var users = MockData.users();
    for (var i = 0; i < users.length; i++) {
      if (RepoUtil.matchEmail(users[i].email, email)) return users[i];
    }
    return null;
  },

  listAdmins: function () {
    return MockData.admins();
  },

  /* ---- 차수 ---- */
  getActiveCampaign: function () {
    var list = MockData.campaigns();
    for (var i = 0; i < list.length; i++) {
      if (list[i].status === 'ACTIVE') return list[i];
    }
    return null;
  },

  listCampaigns: function () {
    return MockData.campaigns();
  },

  findCampaign: function (campaignId) {
    var list = MockData.campaigns();
    for (var i = 0; i < list.length; i++) {
      if (list[i].campaign_id === campaignId) return list[i];
    }
    return null;
  },

  /* ---- 자산 Master ---- */
  findAssetByTag: function (tag) {
    var list = MockData.assets();
    for (var i = 0; i < list.length; i++) {
      if (RepoUtil.matchTag(list[i].asset_tag, tag)) return list[i];
    }
    return null;
  },

  findAssetById: function (assetId) {
    var list = MockData.assets();
    for (var i = 0; i < list.length; i++) {
      if (list[i].asset_id === assetId) return list[i];
    }
    return null;
  },

  /* ---- 대상 ---- */
  listTargetsByCampaign: function (campaignId) {
    return MockData.targets().filter(function (t) {
      return t.campaign_id === campaignId;
    });
  },

  listTargetsByUser: function (campaignId, email) {
    return MockData.targets().filter(function (t) {
      return t.campaign_id === campaignId && RepoUtil.matchEmail(t.user_email, email);
    });
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
      if (list[i].asset_id === assetId) return list[i];
    }
    return null;
  },

  /* ---- 로그 ---- */
  listLogsByCampaign: function (campaignId) {
    return this._logs().filter(function (l) {
      return l.campaign_id === campaignId;
    });
  },

  listLogsByUser: function (campaignId, email) {
    return this._logs().filter(function (l) {
      return l.campaign_id === campaignId && RepoUtil.matchEmail(l.user_email, email);
    });
  },

  findLog: function (campaignId, assetId, email) {
    var list = this._logs();
    for (var i = 0; i < list.length; i++) {
      if (
        list[i].campaign_id === campaignId &&
        list[i].asset_id === assetId &&
        RepoUtil.matchEmail(list[i].user_email, email)
      ) {
        return list[i];
      }
    }
    return null;
  },

  upsertLog: function (log) {
    var list = this._logs();
    var found = -1;
    for (var i = 0; i < list.length; i++) {
      if (
        list[i].campaign_id === log.campaign_id &&
        list[i].asset_id === log.asset_id &&
        RepoUtil.matchEmail(list[i].user_email, log.user_email)
      ) {
        found = i;
        break;
      }
    }
    var record =
      found >= 0
        ? RepoUtil.merge(list[found], log)
        : RepoUtil.merge(RepoUtil.emptyLog(), log);
    if (found >= 0) list[found] = record;
    else list.push(record);
    MockStore.write('LOGS', list);
    Cache.remove('dashboard:' + log.campaign_id);
    return record;
  },

  /* ---- 목록에 없는 자산 ---- */
  listUnlistedByCampaign: function (campaignId) {
    return this._unlisted().filter(function (u) {
      return u.campaign_id === campaignId;
    });
  },

  listUnlistedByUser: function (campaignId, email) {
    return this._unlisted().filter(function (u) {
      return u.campaign_id === campaignId && RepoUtil.matchEmail(u.user_email, email);
    });
  },

  upsertUnlisted: function (record) {
    var list = this._unlisted();
    var found = -1;
    for (var i = 0; i < list.length; i++) {
      if (
        list[i].campaign_id === record.campaign_id &&
        RepoUtil.matchEmail(list[i].user_email, record.user_email) &&
        RepoUtil.matchTag(list[i].scanned_tag, record.scanned_tag)
      ) {
        found = i;
        break;
      }
    }
    var merged = RepoUtil.merge(RepoUtil.emptyUnlisted(), record);
    if (found >= 0) {
      // 기존 값 유지 후 새 값으로 덮어쓰기 (created_at 보존)
      merged = RepoUtil.merge(list[found], record);
      list[found] = merged;
    } else {
      list.push(merged);
    }
    MockStore.write('UNLISTED', list);
    Cache.remove('dashboard:' + record.campaign_id);
    return merged;
  },

  /* ---- 오류 로그 ---- */
  logError: function (record) {
    Logger.log(
      '[Error_Log] ' + record.fn + ' / ' + record.message + ' / ' + record.detail
    );
  },

  /* ---- 데모 초기화 ---- */
  resetUserAudit: function (campaignId, email) {
    var logs = this._logs().filter(function (l) {
      return !(l.campaign_id === campaignId && RepoUtil.matchEmail(l.user_email, email));
    });
    MockStore.write('LOGS', logs);

    var unlisted = this._unlisted().filter(function (u) {
      return !(u.campaign_id === campaignId && RepoUtil.matchEmail(u.user_email, email));
    });
    MockStore.write('UNLISTED', unlisted);
  }
};
