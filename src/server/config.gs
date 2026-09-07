/**
 * 전역 설정.
 *
 * 값은 코드 기본값 → Script Properties 순으로 덮어쓴다.
 * (Sheet ID / Drive Folder ID 같은 환경값을 코드에 커밋하지 않기 위함)
 *
 * Script Properties 설정 예 (Apps Script 편집기 > 프로젝트 설정 > 스크립트 속성):
 *   MODE                = GOOGLE_SHEETS
 *   SPREADSHEET_ID      = 1AbC...
 *   DRIVE_ROOT_FOLDER_ID= 1XyZ...
 *   ALLOW_MOCK_USER     = false
 *   ALLOW_DEV_TAG_INPUT = false
 *   ADMIN_EMAILS        = admin@company.com,manager@company.com
 *
 * 주의: 이 파일에는 다른 파일의 함수를 최상위에서 호출하는 코드를 두지 않는다.
 * (Apps Script 는 파일 로드 순서를 보장하지 않으므로 참조는 항상 함수 실행 시점에)
 */

var MODE_MOCK = 'MOCK';
var MODE_GOOGLE_SHEETS = 'GOOGLE_SHEETS';

var CONFIG_DEFAULTS = {
  /** MOCK | GOOGLE_SHEETS */
  MODE: 'MOCK',

  /** GOOGLE_SHEETS 모드에서 사용할 스프레드시트 ID (비우면 setup.gs 로 생성) */
  SPREADSHEET_ID: '',

  /** 사진을 저장할 Drive 루트 폴더 ID (비우면 이름으로 생성) */
  DRIVE_ROOT_FOLDER_ID: '',
  DRIVE_ROOT_FOLDER_NAME: 'Asset Audit',

  /** PoC 데모용 계정 전환 허용 여부. 운영 배포에서는 반드시 false */
  ALLOW_MOCK_USER: 'true',

  /** QR 스캐너의 "개발용 Tag 직접 입력" 노출 여부. 운영 배포에서는 false */
  ALLOW_DEV_TAG_INPUT: 'true',

  /** Admin 시트와 별개로 항상 관리자로 취급할 이메일 (쉼표 구분) */
  ADMIN_EMAILS: 'asset.admin@company.com',

  /** 사용자별 실사 대상 캐시 TTL (초) */
  CACHE_TTL_SECONDS: '300',

  /** 관리자 대시보드 집계 캐시 TTL (초) */
  DASHBOARD_CACHE_TTL_SECONDS: '60',

  /** Audit_Log upsert 시 Lock 대기 시간 (ms) */
  LOCK_WAIT_MS: '20000',

  /** 업로드 허용 최대 바이트 (클라이언트에서 리사이즈 후 기준) */
  MAX_PHOTO_BYTES: '6291456',

  /** 서비스 표시 이름 */
  APP_NAME: '자산실사'
};

var SHEET_NAMES = {
  ASSET_MASTER: 'Asset_Master',
  AUDIT_CAMPAIGN: 'Audit_Campaign',
  AUDIT_TARGET: 'Audit_Target',
  AUDIT_LOG: 'Audit_Log',
  AUDIT_UNLISTED: 'Audit_Unlisted',
  ADMIN: 'Admin',
  ERROR_LOG: 'Error_Log'
};

/** 시트별 헤더 정의 (setup.gs 가 이 정의로 시트를 생성한다) */
var SHEET_SCHEMA = {
  Asset_Master: [
    'asset_id', 'asset_tag', 'asset_name', 'model', 'serial_number',
    'user_name', 'user_email', 'department', 'asset_status', 'updated_at'
  ],
  Audit_Campaign: [
    'campaign_id', 'campaign_name', 'start_date', 'end_date', 'status',
    'created_at'
  ],
  Audit_Target: [
    'campaign_id', 'asset_id', 'asset_tag', 'asset_name', 'user_name',
    'user_email', 'department'
  ],
  // review_* 4개 컬럼은 관리자 Reconciliation(§17) 처리 결과 저장을 위한 추가 컬럼
  Audit_Log: [
    'campaign_id', 'asset_id', 'asset_tag', 'user_email',
    'verification_method', 'scanned_tag', 'photo_file_id', 'photo_url',
    'audit_status', 'exception_type', 'note', 'verified_at',
    'created_at', 'updated_at',
    'review_state', 'review_note', 'reviewed_by', 'reviewed_at'
  ],
  // report_type / review_* 은 §17 확인 필요 분류·처리를 위한 추가 컬럼
  // status 컬럼이 관리자 처리 상태(REVIEW_STATE)를 담는다.
  Audit_Unlisted: [
    'campaign_id', 'user_email', 'scanned_tag', 'photo_file_id', 'photo_url',
    'note', 'created_at', 'status', 'report_type', 'review_note',
    'reviewed_by', 'reviewed_at'
  ],
  Admin: ['email', 'name', 'added_at'],
  Error_Log: ['timestamp', 'user_email', 'fn', 'message', 'detail']
};

/** 내부 상태값 (§13) */
var AUDIT_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  QR_VERIFIED: 'QR_VERIFIED',
  PHOTO_SUBMITTED: 'PHOTO_SUBMITTED',
  NOT_IN_POSSESSION: 'NOT_IN_POSSESSION',
  UNLISTED_ASSET: 'UNLISTED_ASSET',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
};

var VERIFICATION_METHOD = {
  QR: 'QR',
  PHOTO: 'PHOTO',
  SELF_REPORT: 'SELF_REPORT'
};

var EXCEPTION_TYPE = {
  ALREADY_RETURNED: 'ALREADY_RETURNED',
  TRANSFERRED: 'TRANSFERRED',
  LOST: 'LOST',
  NOT_REMEMBERED: 'NOT_REMEMBERED',
  OTHER: 'OTHER',
  UNLISTED: 'UNLISTED',
  FOREIGN_ASSET: 'FOREIGN_ASSET',
  TAG_MISMATCH: 'TAG_MISMATCH'
};

var REVIEW_STATE = {
  PENDING: 'PENDING',
  RESOLVED_OK: 'RESOLVED_OK',
  MASTER_UPDATE_REQUIRED: 'MASTER_UPDATE_REQUIRED',
  USER_FOLLOWUP_REQUIRED: 'USER_FOLLOWUP_REQUIRED'
};

var REVIEW_CATEGORY = {
  NOT_IN_POSSESSION: 'NOT_IN_POSSESSION',
  UNLISTED_ASSET: 'UNLISTED_ASSET',
  FOREIGN_SCAN: 'FOREIGN_SCAN',
  TAG_MISMATCH: 'TAG_MISMATCH',
  PHOTO_REVIEW: 'PHOTO_REVIEW'
};

var Config = {
  _cache: null,

  /** 전체 설정 조회 (요청 1회당 1번만 Script Properties 를 읽는다) */
  all: function () {
    if (this._cache) return this._cache;
    var merged = {};
    for (var key in CONFIG_DEFAULTS) {
      merged[key] = CONFIG_DEFAULTS[key];
    }
    try {
      var props = PropertiesService.getScriptProperties().getProperties();
      for (var k in props) {
        if (props[k] !== '' && props[k] != null) merged[k] = props[k];
      }
    } catch (err) {
      // Properties 접근이 불가한 실행 컨텍스트에서는 기본값 사용
    }
    this._cache = merged;
    return merged;
  },

  get: function (key) {
    return this.all()[key];
  },

  bool: function (key) {
    return String(this.all()[key]).toLowerCase() === 'true';
  },

  num: function (key) {
    return Number(this.all()[key]);
  },

  isMock: function () {
    return this.get('MODE') !== MODE_GOOGLE_SHEETS;
  },

  adminEmails: function () {
    return String(this.get('ADMIN_EMAILS') || '')
      .split(',')
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(function (s) { return s.length > 0; });
  },

  /** 테스트에서 설정을 갈아끼울 때 사용 */
  reset: function () {
    this._cache = null;
  }
};
