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
  APP_NAME: '자산실사',

  /* 실제 스프레드시트의 시트 이름이 다를 때만 채운다 (비우면 SHEET_NAMES 기본값) */
  SHEET_ASSET_MASTER: '',
  SHEET_AUDIT_CAMPAIGN: '',
  SHEET_AUDIT_TARGET: '',
  SHEET_AUDIT_LOG: '',
  SHEET_AUDIT_UNLISTED: '',
  SHEET_ADMIN: '',
  SHEET_ERROR_LOG: ''
};

/**
 * 시트 키 → 기본 시트 이름.
 * 실제 스프레드시트의 시트 이름이 다르면 코드를 고치지 않고
 * 스크립트 속성(SHEET_ASSET_MASTER 등)으로 덮어쓴다.
 */
var SHEET_NAMES = {
  ASSET_MASTER: 'Asset_Master',
  AUDIT_CAMPAIGN: 'Audit_Campaign',
  AUDIT_TARGET: 'Audit_Target',
  AUDIT_LOG: 'Audit_Log',
  AUDIT_UNLISTED: 'Audit_Unlisted',
  ADMIN: 'Admin',
  ERROR_LOG: 'Error_Log'
};

/** 시트 이름을 덮어쓰는 스크립트 속성 키 */
var SHEET_NAME_PROPERTIES = {
  ASSET_MASTER: 'SHEET_ASSET_MASTER',
  AUDIT_CAMPAIGN: 'SHEET_AUDIT_CAMPAIGN',
  AUDIT_TARGET: 'SHEET_AUDIT_TARGET',
  AUDIT_LOG: 'SHEET_AUDIT_LOG',
  AUDIT_UNLISTED: 'SHEET_AUDIT_UNLISTED',
  ADMIN: 'SHEET_ADMIN',
  ERROR_LOG: 'SHEET_ERROR_LOG'
};

/* ------------------------------------------------------------------ */
/* 컬럼 매핑                                                           */
/* ------------------------------------------------------------------ */

/**
 * ★ 실제 Sheet 연결 시 여기만 고치면 된다.
 *
 * 코드 전체는 왼쪽의 "표준 필드명" 만 사용한다.
 * 오른쪽 배열은 실제 시트 헤더에서 찾아볼 후보(별칭)이며, 앞에 있는 것부터 매칭한다.
 * 비교는 공백/밑줄/하이픈/대소문자를 무시하므로
 * `TAG 번호`, `tag_번호`, `TAG번호` 는 모두 같은 것으로 본다.
 *
 * 회사 자산대장 컬럼명이 다르면 해당 배열에 컬럼명을 추가하기만 하면 된다.
 * (컬럼 순서는 상관없다. 목록에 없는 컬럼은 무시된다.)
 */
var COLUMN_ALIASES = {
  ASSET_MASTER: {
    asset_id:      ['asset_id', '자산번호', '자산ID', '자산코드'],
    asset_tag:     ['asset_tag', 'TAG번호', 'Tag번호', '태그번호', 'QR번호'],
    asset_name:    ['asset_name', '자산명', '품명'],
    model:         ['model', '모델명', '모델'],
    serial_number: ['serial_number', 'Serial', 'S/N', '시리얼', '시리얼번호'],
    user_name:     ['user_name', '성명', '사용자', '사용자명', '이름'],
    user_email:    ['user_email', '이메일', '회사이메일', '메일'],
    department:    ['department', '조직', '부서', '소속'],
    asset_status:  ['asset_status', '지급상태', '자산상태', '상태'],
    updated_at:    ['updated_at', '수정일시', '갱신일시'],
    // 선택 항목 — 현재 로직에서 사용하지 않지만 있으면 그대로 읽어둔다
    employee_no:   ['employee_no', '사번', '사원번호']
  },

  AUDIT_CAMPAIGN: {
    campaign_id:   ['campaign_id', '차수ID', '실사차수'],
    campaign_name: ['campaign_name', '차수명', '실사명'],
    start_date:    ['start_date', '시작일'],
    end_date:      ['end_date', '종료일'],
    status:        ['status', '상태'],
    created_at:    ['created_at', '생성일시']
  },

  AUDIT_TARGET: {
    campaign_id: ['campaign_id', '차수ID'],
    asset_id:    ['asset_id', '자산번호'],
    asset_tag:   ['asset_tag', 'TAG번호', '태그번호'],
    asset_name:  ['asset_name', '자산명'],
    user_name:   ['user_name', '성명', '사용자'],
    user_email:  ['user_email', '이메일'],
    department:  ['department', '조직', '부서']
  },

  AUDIT_LOG: {
    campaign_id:         ['campaign_id', '차수ID'],
    asset_id:            ['asset_id', '자산번호'],
    asset_tag:           ['asset_tag', 'TAG번호'],
    user_email:          ['user_email', '이메일'],
    verification_method: ['verification_method', '확인방법'],
    scanned_tag:         ['scanned_tag', '스캔TAG'],
    photo_file_id:       ['photo_file_id', '사진FileID'],
    photo_url:           ['photo_url', '사진URL'],
    audit_status:        ['audit_status', '실사상태'],
    exception_type:      ['exception_type', '예외사유'],
    note:                ['note', '메모'],
    verified_at:         ['verified_at', '확인일시'],
    created_at:          ['created_at', '생성일시'],
    updated_at:          ['updated_at', '수정일시'],
    review_state:        ['review_state', '처리상태'],
    review_note:         ['review_note', '처리메모'],
    reviewed_by:         ['reviewed_by', '처리자'],
    reviewed_at:         ['reviewed_at', '처리일시']
  },

  AUDIT_UNLISTED: {
    campaign_id:   ['campaign_id', '차수ID'],
    user_email:    ['user_email', '이메일'],
    scanned_tag:   ['scanned_tag', '스캔TAG', 'TAG번호'],
    photo_file_id: ['photo_file_id', '사진FileID'],
    photo_url:     ['photo_url', '사진URL'],
    note:          ['note', '메모'],
    created_at:    ['created_at', '생성일시'],
    status:        ['status', '처리상태'],
    report_type:   ['report_type', '신고유형'],
    review_note:   ['review_note', '처리메모'],
    reviewed_by:   ['reviewed_by', '처리자'],
    reviewed_at:   ['reviewed_at', '처리일시']
  },

  ADMIN: {
    email:    ['email', '이메일'],
    name:     ['name', '성명', '이름'],
    added_at: ['added_at', '등록일']
  },

  ERROR_LOG: {
    timestamp:  ['timestamp', '발생일시'],
    user_email: ['user_email', '이메일'],
    fn:         ['fn', '함수'],
    message:    ['message', '메시지'],
    detail:     ['detail', '상세']
  }
};

/**
 * 없으면 동작이 불가능한 필수 컬럼.
 * validateSetup() 이 이 목록으로 연결 전 점검을 수행한다.
 */
var REQUIRED_COLUMNS = {
  ASSET_MASTER: ['asset_id', 'asset_tag', 'asset_name', 'user_email', 'asset_status'],
  AUDIT_CAMPAIGN: ['campaign_id', 'campaign_name', 'status'],
  AUDIT_TARGET: ['campaign_id', 'asset_id', 'asset_tag', 'user_email'],
  AUDIT_LOG: [
    'campaign_id', 'asset_id', 'user_email', 'audit_status',
    'verification_method', 'verified_at'
  ],
  AUDIT_UNLISTED: ['campaign_id', 'user_email', 'scanned_tag', 'status'],
  ADMIN: ['email'],
  ERROR_LOG: ['timestamp', 'fn', 'message']
};

/**
 * 시트별 표준 헤더 (setup.gs 가 새 시트를 만들 때 사용한다).
 * 이미 존재하는 시트의 헤더는 건드리지 않고 COLUMN_ALIASES 로 해석한다.
 */
var SHEET_SCHEMA = {
  ASSET_MASTER: [
    'asset_id', 'asset_tag', 'asset_name', 'model', 'serial_number',
    'user_name', 'user_email', 'department', 'asset_status', 'updated_at'
  ],
  AUDIT_CAMPAIGN: [
    'campaign_id', 'campaign_name', 'start_date', 'end_date', 'status',
    'created_at'
  ],
  AUDIT_TARGET: [
    'campaign_id', 'asset_id', 'asset_tag', 'asset_name', 'user_name',
    'user_email', 'department'
  ],
  // review_* 4개 컬럼은 관리자 Reconciliation(§17) 처리 결과 저장을 위한 추가 컬럼
  AUDIT_LOG: [
    'campaign_id', 'asset_id', 'asset_tag', 'user_email',
    'verification_method', 'scanned_tag', 'photo_file_id', 'photo_url',
    'audit_status', 'exception_type', 'note', 'verified_at',
    'created_at', 'updated_at',
    'review_state', 'review_note', 'reviewed_by', 'reviewed_at'
  ],
  // report_type / review_* 은 §17 확인 필요 분류·처리를 위한 추가 컬럼
  // status 컬럼이 관리자 처리 상태(REVIEW_STATE)를 담는다.
  AUDIT_UNLISTED: [
    'campaign_id', 'user_email', 'scanned_tag', 'photo_file_id', 'photo_url',
    'note', 'created_at', 'status', 'report_type', 'review_note',
    'reviewed_by', 'reviewed_at'
  ],
  ADMIN: ['email', 'name', 'added_at'],
  ERROR_LOG: ['timestamp', 'user_email', 'fn', 'message', 'detail']
};

/** 실사 결과가 기록되는 시트 (Asset_Master 는 절대 포함하지 않는다) */
var WRITABLE_SHEET_KEYS = ['AUDIT_LOG', 'AUDIT_UNLISTED', 'ERROR_LOG'];

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

  /**
   * 시트 키 → 실제 시트 이름.
   * 스크립트 속성(SHEET_ASSET_MASTER 등)이 있으면 그 값을 쓴다.
   */
  sheetName: function (key) {
    var override = this.get(SHEET_NAME_PROPERTIES[key]);
    override = override === null || override === undefined ? '' : String(override).trim();
    return override || SHEET_NAMES[key];
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
