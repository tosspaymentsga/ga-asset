/**
 * 공통 유틸리티.
 *
 * - AppError: 사용자에게 보여줘도 되는 메시지를 가진 오류
 * - Util: 날짜/문자열/배열 헬퍼
 * - Cache: CacheService 래퍼 (키 prefix + JSON 직렬화 + 실패 무시)
 */

/**
 * 사용자 노출용 오류.
 * Apps Script 내부 오류 메시지는 절대 그대로 노출하지 않는다(§21).
 */
function AppError(code, userMessage, detail) {
  this.name = 'AppError';
  this.code = code || 'UNKNOWN';
  this.message = userMessage || '처리 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.';
  this.detail = detail || '';
  this.isAppError = true;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

var ERROR_MESSAGES = {
  NOT_SIGNED_IN: '로그인 정보를 확인하지 못했습니다. 회사 계정으로 다시 접속해주세요.',
  FORBIDDEN: '접근 권한이 없습니다.',
  LOAD_FAILED: '자산 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.',
  QR_FAILED: 'QR 정보를 확인하지 못했습니다.',
  PHOTO_FAILED: '사진 업로드에 실패했습니다. 잠시 후 다시 시도해주세요.',
  SAVE_FAILED: '저장하지 못했습니다. 잠시 후 다시 시도해주세요.',
  NO_CAMPAIGN: '진행 중인 자산실사가 없습니다.',
  BUSY: '다른 처리가 진행 중입니다. 잠시 후 다시 시도해주세요.'
};

var Util = {
  /** ISO 8601 문자열 */
  nowIso: function () {
    return new Date().toISOString();
  },

  /** 값이 Date 든 문자열이든 ISO 문자열로 정규화 */
  toIso: function (value) {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString();
    var d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : d.toISOString();
  },

  /** 2026.09.08 14:32 (Asia/Seoul 기준 표기는 클라이언트에서 처리) */
  isBlank: function (value) {
    return value === null || value === undefined || String(value).trim() === '';
  },

  trim: function (value) {
    return value === null || value === undefined ? '' : String(value).trim();
  },

  /** Tag 정규화: 공백 제거 + 대문자 */
  normalizeTag: function (value) {
    return Util.trim(value).toUpperCase();
  },

  /**
   * QR 페이로드에서 Tag ID 추출.
   * QR 에는 고유 Tag ID 만 담는 것이 원칙이지만,
   * URL(`https://.../t/Q12345`) 또는 `TAG:Q12345` 형태로 인쇄된 경우도 허용한다.
   */
  extractTag: function (payload) {
    var raw = Util.trim(payload);
    if (!raw) return '';

    if (/^https?:\/\//i.test(raw)) {
      var queryMatch = raw.match(/[?&]tag=([^&#]+)/i);
      if (queryMatch) return Util.normalizeTag(decodeURIComponent(queryMatch[1]));
      var withoutQuery = raw.split('?')[0].split('#')[0];
      var parts = withoutQuery.split('/').filter(function (p) { return p; });
      var last = parts.length ? parts[parts.length - 1] : '';
      return Util.normalizeTag(last);
    }

    var prefixed = raw.match(/^tag[:=]\s*(.+)$/i);
    if (prefixed) return Util.normalizeTag(prefixed[1]);

    return Util.normalizeTag(raw);
  },

  /** 헤더 배열 → { 컬럼명: 인덱스 } */
  headerIndex: function (headerRow) {
    var index = {};
    for (var i = 0; i < headerRow.length; i++) {
      var key = Util.trim(headerRow[i]);
      if (key) index[key] = i;
    }
    return index;
  },

  /**
   * getValues() 결과(헤더 포함)를 객체 배열로 변환.
   * 시트 전체를 한 번만 읽고 배열에서 처리하기 위한 기본 도구(§18).
   */
  rowsToObjects: function (values) {
    if (!values || values.length < 2) return [];
    var header = values[0];
    var keys = [];
    for (var c = 0; c < header.length; c++) keys.push(Util.trim(header[c]));

    var out = [];
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var isEmpty = true;
      var obj = {};
      for (var i = 0; i < keys.length; i++) {
        if (!keys[i]) continue;
        var cell = row[i];
        if (cell instanceof Date) cell = cell.toISOString();
        obj[keys[i]] = cell === null || cell === undefined ? '' : cell;
        if (!Util.isBlank(cell)) isEmpty = false;
      }
      if (!isEmpty) {
        obj.__row = r + 1; // 시트상의 실제 행 번호 (1-based)
        out.push(obj);
      }
    }
    return out;
  },

  /** 객체를 헤더 순서에 맞춘 배열로 변환 */
  objectToRow: function (obj, header) {
    var row = [];
    for (var i = 0; i < header.length; i++) {
      var v = obj[header[i]];
      row.push(v === null || v === undefined ? '' : v);
    }
    return row;
  },

  uuid: function () {
    return Utilities.getUuid();
  },

  /** 안전한 파일명 */
  safeFileName: function (value) {
    return Util.trim(value).replace(/[^A-Za-z0-9._@-]+/g, '_');
  },

  /** 배열을 key 기준 Map 으로 */
  indexBy: function (list, keyFn) {
    var map = {};
    for (var i = 0; i < list.length; i++) {
      map[keyFn(list[i])] = list[i];
    }
    return map;
  },

  /** 소수점 1자리 백분율 */
  percent: function (numerator, denominator) {
    if (!denominator) return 0;
    return Math.round((numerator / denominator) * 1000) / 10;
  }
};

var CACHE_VERSION_PROPERTY = 'GA_CACHE_VERSION';

var Cache = {
  _version: null,

  /**
   * 캐시 키 접두사.
   * 버전을 올리면 기존 키가 통째로 무효화된다.
   * (Audit_Target 을 새로 만든 뒤 invalidateAll() 로 사용한다)
   */
  prefix: function () {
    if (this._version === null) {
      try {
        this._version =
          PropertiesService.getScriptProperties().getProperty(CACHE_VERSION_PROPERTY) || '1';
      } catch (err) {
        this._version = '1';
      }
    }
    return 'ga_audit_v' + this._version + ':';
  },

  _store: function () {
    try {
      return CacheService.getScriptCache();
    } catch (err) {
      return null;
    }
  },

  get: function (key) {
    var store = this._store();
    if (!store) return null;
    try {
      var raw = store.get(this.prefix() + key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  },

  put: function (key, value, ttlSeconds) {
    var store = this._store();
    if (!store) return;
    try {
      store.put(this.prefix() + key, JSON.stringify(value), ttlSeconds || 300);
    } catch (err) {
      // 캐시는 실패해도 기능에 영향을 주지 않는다
    }
  },

  remove: function (key) {
    var store = this._store();
    if (!store) return;
    try {
      store.remove(this.prefix() + key);
    } catch (err) {
      // noop
    }
  },

  removeAll: function (keys) {
    var store = this._store();
    if (!store || !keys.length) return;
    try {
      var p = this.prefix();
      store.removeAll(keys.map(function (k) { return p + k; }));
    } catch (err) {
      // noop
    }
  },

  /** 전체 캐시 무효화 (기준 데이터를 바꾼 뒤 호출) */
  invalidateAll: function () {
    try {
      var props = PropertiesService.getScriptProperties();
      var next = String(Number(props.getProperty(CACHE_VERSION_PROPERTY) || '1') + 1);
      props.setProperty(CACHE_VERSION_PROPERTY, next);
      this._version = next;
    } catch (err) {
      // noop
    }
  }
};
