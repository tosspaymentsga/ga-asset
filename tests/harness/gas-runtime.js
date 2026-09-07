/**
 * Apps Script 런타임 에뮬레이터 (테스트 전용).
 *
 * 배포물(src/)에는 Node 의존성이 전혀 없다. 이 파일은 clasp 로 push 되지 않으며,
 * `src/server/*.gs` 와 `src/html/*.html` 을 "있는 그대로" 로컬에서 구동해
 * §26 검증 시나리오를 실제로 실행하기 위한 도구다.
 *
 * 에뮬레이션 대상:
 *   PropertiesService / CacheService / LockService / Session /
 *   Utilities / Logger / SpreadsheetApp / DriveApp / HtmlService
 *
 * 실제 Apps Script 는 요청마다 실행 컨텍스트가 초기화되므로,
 * RPC 호출 전에 실행 단위 메모를 비워 같은 조건을 만든다(resetExecution).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', '..', 'src');

/** filePushOrder 와 동일한 순서 */
const SERVER_FILES = [
  'config.gs',
  'util.gs',
  'auth.gs',
  'repository.gs',
  'mockRepository.gs',
  'sheetRepository.gs',
  'mockStorage.gs',
  'driveService.gs',
  'assetService.gs',
  'auditService.gs',
  'adminService.gs',
  'setup.gs',
  'main.gs',
];

/* ------------------------------------------------------------------ */
/* 서비스 에뮬레이션                                                   */
/* ------------------------------------------------------------------ */

function createProperties() {
  const store = new Map();
  return {
    _store: store,
    getProperty: (k) => (store.has(k) ? store.get(k) : null),
    setProperty(k, v) { store.set(k, String(v)); return this; },
    deleteProperty(k) { store.delete(k); return this; },
    getProperties: () => Object.fromEntries(store),
    setProperties(obj, deleteAll) {
      if (deleteAll) store.clear();
      Object.keys(obj).forEach((k) => store.set(k, String(obj[k])));
      return this;
    },
    deleteAllProperties() { store.clear(); return this; },
  };
}

function createCache() {
  const store = new Map(); // key -> {value, expires}
  const now = () => Date.now();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expires < now()) { store.delete(key); return null; }
      return hit.value;
    },
    put(key, value, ttl) {
      store.set(key, { value: String(value), expires: now() + (ttl || 600) * 1000 });
    },
    remove(key) { store.delete(key); },
    removeAll(keys) { (keys || []).forEach((k) => store.delete(k)); },
    _clear() { store.clear(); },
  };
}

/* ---------------- Spreadsheet 에뮬레이터 ---------------- */

/**
 * Sheets 호출 통계 (§18 성능 규칙 검증용).
 * getValue(단일 셀) 호출은 애초에 구현하지 않아, 사용하면 즉시 에러가 난다.
 */
const sheetStats = {
  getValuesCalls: 0,
  setValuesCalls: 0,
  appendRowCalls: 0,
  cellsRead: 0,
  /** 시트별 전체 범위 조회 횟수 — 같은 시트를 두 번 읽으면 여기서 드러난다 */
  fullScans: {},
  reset() {
    this.getValuesCalls = 0;
    this.setValuesCalls = 0;
    this.appendRowCalls = 0;
    this.cellsRead = 0;
    this.fullScans = {};
  },
  maxFullScans() {
    return Object.values(this.fullScans).reduce((a, b) => Math.max(a, b), 0);
  },
};

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  getValues() {
    sheetStats.getValuesCalls++;
    sheetStats.cellsRead += this.numRows * this.numCols;
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        row.push(this.sheet._cell(this.row + r, this.col + c));
      }
      out.push(row);
    }
    return out;
  }
  setValues(values) {
    sheetStats.setValuesCalls++;
    values.forEach((row, r) => {
      row.forEach((value, c) => {
        this.sheet._setCell(this.row + r, this.col + c, value);
      });
    });
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        this.sheet._setCell(this.row + r, this.col + c, '');
      }
    }
    return this;
  }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = []; // 2차원 배열 (0-based)
  }
  getName() { return this.name; }
  _cell(row, col) {
    const r = this.rows[row - 1];
    if (!r) return '';
    const v = r[col - 1];
    return v === undefined || v === null ? '' : v;
  }
  _setCell(row, col, value) {
    while (this.rows.length < row) this.rows.push([]);
    const r = this.rows[row - 1];
    while (r.length < col) r.push('');
    r[col - 1] = value === undefined || value === null ? '' : value;
  }
  getLastRow() {
    let last = 0;
    this.rows.forEach((row, i) => {
      if (row.some((c) => c !== '' && c !== null && c !== undefined)) last = i + 1;
    });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.rows.forEach((row) => {
      for (let c = row.length; c > 0; c--) {
        if (row[c - 1] !== '' && row[c - 1] !== null && row[c - 1] !== undefined) {
          if (c > last) last = c;
          break;
        }
      }
    });
    return last;
  }
  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows || 1, numCols || 1);
  }
  getDataRange() {
    sheetStats.fullScans[this.name] = (sheetStats.fullScans[this.name] || 0) + 1;
    const rows = Math.max(1, this.getLastRow());
    const cols = Math.max(1, this.getLastColumn());
    return new FakeRange(this, 1, 1, rows, cols);
  }
  appendRow(values) {
    sheetStats.appendRowCalls++;
    const row = this.getLastRow() + 1;
    values.forEach((v, i) => this._setCell(row, i + 1, v));
    return this;
  }
  setFrozenRows() { return this; }
}

class FakeSpreadsheet {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = [];
  }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(name) {
    return this.sheets.find((s) => s.getName() === name) || null;
  }
  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(sheet) {
    this.sheets = this.sheets.filter((s) => s !== sheet);
  }
}

function createSpreadsheetApp(registry) {
  return {
    openById(id) {
      if (!registry.has(id)) throw new Error('Spreadsheet not found: ' + id);
      return registry.get(id);
    },
    getActiveSpreadsheet() {
      return registry.values().next().value || null;
    },
    create(name) {
      const id = 'ss-' + crypto.randomUUID().slice(0, 8);
      const ss = new FakeSpreadsheet(id, name);
      registry.set(id, ss);
      return ss;
    },
  };
}

/* ---------------- Drive 에뮬레이터 ---------------- */

function createDriveApp(files, folders) {
  class FakeFile {
    constructor(id, name, blob) {
      this.id = id; this.name = name; this.blob = blob;
    }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return 'https://drive.google.com/file/d/' + this.id + '/view'; }
    getBlob() { return this.blob; }
  }
  class FakeFolder {
    constructor(id, name) {
      this.id = id; this.name = name; this.children = []; this.fileIds = [];
    }
    getId() { return this.id; }
    getName() { return this.name; }
    createFolder(name) {
      const f = new FakeFolder('fld-' + crypto.randomUUID().slice(0, 8), name);
      this.children.push(f);
      folders.set(f.id, f);
      return f;
    }
    getFoldersByName(name) {
      const list = this.children.filter((f) => f.getName() === name);
      let i = 0;
      return { hasNext: () => i < list.length, next: () => list[i++] };
    }
    createFile(blob) {
      const file = new FakeFile('file-' + crypto.randomUUID().slice(0, 8), blob.getName(), blob);
      files.set(file.id, file);
      this.fileIds.push(file.id);
      return file;
    }
  }
  const root = new FakeFolder('root', 'My Drive');
  folders.set('root', root);

  return {
    getFolderById(id) {
      if (!folders.has(id)) throw new Error('Folder not found');
      return folders.get(id);
    },
    getFoldersByName(name) { return root.getFoldersByName(name); },
    createFolder(name) { return root.createFolder(name); },
    getFileById(id) {
      if (!files.has(id)) throw new Error('File not found');
      return files.get(id);
    },
  };
}

/* ---------------- HtmlService 에뮬레이터 ---------------- */

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readHtmlFile(name) {
  // Apps Script 파일명은 확장자를 제외하고 지정한다 ('html/index')
  const file = path.join(SRC, name.endsWith('.html') ? name : name + '.html');
  return fs.readFileSync(file, 'utf8');
}

/** Apps Script 템플릿 문법(<? ?>, <?= ?>, <?!= ?>) 평가 */
function evaluateTemplate(content, templateObject, context) {
  const parts = [];
  let cursor = 0;
  const re = /<\?(=|!=)?([\s\S]*?)\?>/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    parts.push({ type: 'text', value: content.slice(cursor, match.index) });
    parts.push({ type: match[1] || 'code', value: match[2] });
    cursor = match.index + match[0].length;
  }
  parts.push({ type: 'text', value: content.slice(cursor) });

  // Apps Script 는 <?= expr; ?> 처럼 세미콜론이 붙어도 허용하므로 동일하게 처리한다
  const expr = (value) => value.trim().replace(/;+\s*$/, '');

  let body = 'var __out = [];\n';
  parts.forEach((part) => {
    if (part.type === 'text') {
      body += '__out.push(' + JSON.stringify(part.value) + ');\n';
    } else if (part.type === '=') {
      body += '__out.push(__esc(' + expr(part.value) + '));\n';
    } else if (part.type === '!=') {
      body += '__out.push(' + expr(part.value) + ');\n';
    } else {
      body += part.value + '\n';
    }
  });
  body += 'return __out.join("");';

  const fn = vm.runInContext(
    '(function(__data, __esc){ with (__data) { ' + body + ' } })',
    context
  );
  return fn(templateObject, htmlEscape);
}

function createHtmlService(context) {
  class HtmlOutput {
    constructor(content) { this.content = content; }
    getContent() { return this.content; }
    setTitle(t) { this.title = t; return this; }
    addMetaTag(name, value) {
      this.content = this.content.replace(
        '</head>',
        '  <meta name="' + name + '" content="' + value + '">\n</head>'
      );
      return this;
    }
    setXFrameOptionsMode() { return this; }
  }

  class HtmlTemplate {
    constructor(content) { this.__content = content; }
    evaluate() {
      const data = {};
      Object.keys(this).forEach((k) => {
        if (k !== '__content') data[k] = this[k];
      });
      return new HtmlOutput(evaluateTemplate(this.__content, data, context));
    }
  }

  return {
    createTemplateFromFile: (name) => new HtmlTemplate(readHtmlFile(name)),
    createHtmlOutputFromFile: (name) => new HtmlOutput(readHtmlFile(name)),
    createHtmlOutput: (html) => new HtmlOutput(html),
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
  };
}

/* ------------------------------------------------------------------ */
/* 런타임 생성                                                         */
/* ------------------------------------------------------------------ */

function createRuntime(options = {}) {
  const scriptProps = createProperties();
  const userProps = createProperties();
  const cache = createCache();
  const spreadsheets = new Map();
  const driveFiles = new Map();
  const driveFolders = new Map();

  const session = {
    activeEmail: options.activeEmail || '',
    effectiveEmail: options.effectiveEmail || 'deployer@company.com',
  };

  const logs = [];

  const context = {
    console,
    Promise,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,

    PropertiesService: {
      getScriptProperties: () => scriptProps,
      getUserProperties: () => userProps,
      getDocumentProperties: () => scriptProps,
    },
    CacheService: {
      getScriptCache: () => cache,
      getUserCache: () => cache,
    },
    LockService: {
      // Node 는 단일 스레드이므로 실제 경합은 발생하지 않는다.
      // 코드 경로(획득/해제)가 정상 동작하는지만 확인한다.
      getScriptLock: () => ({
        tryLock: () => true,
        waitLock: () => true,
        releaseLock: () => {},
      }),
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => session.activeEmail }),
      getEffectiveUser: () => ({ getEmail: () => session.effectiveEmail }),
      getScriptTimeZone: () => 'Asia/Seoul',
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
      base64Decode: (str) => Array.from(Buffer.from(str, 'base64')),
      newBlob: (bytes, contentType, name) => ({
        getBytes: () => bytes,
        getContentType: () => contentType,
        getName: () => name,
      }),
      formatDate: (date, tz, format) => {
        const pad = (n) => String(n).padStart(2, '0');
        return format
          .replace('yyyy', date.getFullYear())
          .replace('MM', pad(date.getMonth() + 1))
          .replace('dd', pad(date.getDate()))
          .replace('HH', pad(date.getHours()))
          .replace('mm', pad(date.getMinutes()))
          .replace('ss', pad(date.getSeconds()));
      },
      sleep: () => {},
    },
    Logger: {
      log: (msg) => { logs.push(String(msg)); },
    },
    SpreadsheetApp: createSpreadsheetApp(spreadsheets),
    DriveApp: createDriveApp(driveFiles, driveFolders),
  };

  context.globalThis = context;
  vm.createContext(context);
  context.HtmlService = createHtmlService(context);

  // 서버 코드 로드
  SERVER_FILES.forEach((file) => {
    const code = fs.readFileSync(path.join(SRC, 'server', file), 'utf8');
    vm.runInContext(code, context, { filename: 'src/server/' + file });
  });

  // 초기 설정 주입
  if (options.properties) {
    Object.keys(options.properties).forEach((k) => {
      scriptProps.setProperty(k, options.properties[k]);
    });
  }

  /** 실제 Apps Script 처럼 요청마다 실행 단위 상태를 초기화한다 */
  function resetExecution() {
    vm.runInContext(
      [
        'Config.reset();',
        'Auth.reset();',
        'Cache._version = null;',
        'MockStore._memo = {};',
        'SheetIO._ss = null; SheetIO._sheets = {}; SheetIO._values = {}; SheetIO._objects = {};',
      ].join('\n'),
      context
    );
  }

  function call(fnName, args = []) {
    resetExecution();
    const fn = context[fnName];
    if (typeof fn !== 'function') throw new Error('Unknown function: ' + fnName);
    return fn.apply(context, args);
  }

  return {
    context,
    call,
    resetExecution,
    sheetStats,
    logs,
    session,
    scriptProps,
    userProps,
    cache,
    spreadsheets,
    driveFiles,
    setActiveEmail(email) { session.activeEmail = email; },
    setProperty(key, value) { scriptProps.setProperty(key, value); },
    /** 데모 계정 세션을 직접 설정 (UI 없이 시나리오를 돌릴 때) */
    signInAs(email) {
      resetExecution();
      return context.devSignInAs(email);
    },
    reset() {
      scriptProps.deleteAllProperties();
      userProps.deleteAllProperties();
      cache._clear();
      if (options.properties) {
        Object.keys(options.properties).forEach((k) => {
          scriptProps.setProperty(k, options.properties[k]);
        });
      }
      resetExecution();
    },
  };
}

module.exports = { createRuntime, SERVER_FILES };
