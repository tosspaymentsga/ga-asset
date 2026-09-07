/**
 * 로컬 검증 서버 (테스트 전용).
 *
 * 실제 Apps Script 웹앱과 동일한 코드를 구동한다.
 *   GET  /            → doGet(e) 결과 HTML + google.script.run shim 주입
 *   POST /rpc         → { fn, args } 를 서버 함수로 그대로 호출
 *   POST /__reset     → 저장소 초기화 (테스트 간 격리)
 *   GET  /__health    → 상태 확인
 *
 * 사용:  node tests/harness/server.js [--port 8110] [--mode MOCK|GOOGLE_SHEETS]
 */
'use strict';

const http = require('http');
const { createRuntime } = require('./gas-runtime');

const RPC_FUNCTIONS = [
  'getMyAssets',
  'getMyAuditStatus',
  'verifyQr',
  'registerForeignScan',
  'submitPhoto',
  'submitException',
  'submitUnlistedAsset',
  'getPhotoDataUrl',
  'getAdminDashboard',
  'getAdminAuditList',
  'getAdminReconciliation',
  'resolveReviewItem',
  'devSignInAs',
  'devResetMyAudit',
];

function parseArgs(argv) {
  const out = { port: 8110, mode: 'MOCK' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    if (argv[i] === '--mode') out.mode = argv[++i];
  }
  return out;
}

function buildRuntime(mode) {
  const runtime = createRuntime({
    activeEmail: '',
    properties: {
      MODE: mode,
      ALLOW_MOCK_USER: 'true',
      ALLOW_DEV_TAG_INPUT: 'true',
    },
  });

  if (mode === 'GOOGLE_SHEETS') {
    // 실제 운영 전환과 동일한 순서로 시트를 구성한다
    runtime.call('setupSpreadsheet');
    runtime.call('seedSampleData');
    runtime.call('buildAuditTargets');
    // Audit_Log 시드 (MockData 와 동일한 상태를 시트에 기록)
    runtime.context.MockData.seedLogs().forEach((log) => {
      runtime.resetExecution();
      runtime.context.SheetRepository.upsertLog(log);
    });
    runtime.context.MockData.seedUnlisted().forEach((rec) => {
      runtime.resetExecution();
      runtime.context.SheetRepository.upsertUnlisted(rec);
    });
  }
  return runtime;
}

function shim() {
  return `
<script>
/* 로컬 검증용 google.script.run shim (실제 Apps Script 에서는 플랫폼이 제공) */
(function () {
  var NAMES = ${JSON.stringify(RPC_FUNCTIONS)};
  function makeRunner(success, failure) {
    var runner = {
      withSuccessHandler: function (fn) { return makeRunner(fn, failure); },
      withFailureHandler: function (fn) { return makeRunner(success, fn); },
      withUserObject: function () { return runner; }
    };
    NAMES.forEach(function (name) {
      runner[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        fetch('/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fn: name, args: args })
        })
          .then(function (r) { return r.json(); })
          .then(function (res) { if (success) success(res); })
          .catch(function (e) { if (failure) failure(e); });
      };
    });
    return runner;
  }
  window.google = { script: { run: makeRunner(null, null), host: {} } };
})();
</script>
`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 40 * 1024 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function start(options) {
  let runtime = buildRuntime(options.mode);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    try {
      if (req.method === 'GET' && url.pathname === '/__health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: options.mode }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/__reset') {
        runtime = buildRuntime(options.mode);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // 운영 배포 상태(ALLOW_MOCK_USER=false 등)를 재현하기 위한 테스트 훅
      if (req.method === 'POST' && url.pathname === '/__config') {
        const body = JSON.parse((await readBody(req)) || '{}');
        Object.keys(body.properties || {}).forEach((k) => {
          runtime.setProperty(k, body.properties[k]);
        });
        if (typeof body.activeEmail === 'string') {
          runtime.setActiveEmail(body.activeEmail);
        }
        if (body.signOutMockUser) {
          runtime.resetExecution();
          runtime.context.Auth.signOutMockUser();
        }
        runtime.resetExecution();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        // 테스트 편의: ?user= 로 데모 계정을 미리 선택
        const user = url.searchParams.get('user');
        if (user) runtime.call('devSignInAs', [user]);
        if (url.searchParams.get('signout') === '1') {
          runtime.resetExecution();
          runtime.context.Auth.signOutMockUser();
        }

        const output = runtime.call('doGet', [{ parameter: {} }]);
        const html = output.getContent().replace('<body>', '<body>' + shim());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/rpc') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (RPC_FUNCTIONS.indexOf(body.fn) < 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: 'unknown function' }));
          return;
        }
        const result = runtime.call(body.fn, body.args || []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      console.error('[harness]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: String(err && err.message) }));
    }
  });

  return new Promise((resolve) => {
    server.listen(options.port, () => {
      console.log(
        `[harness] http://localhost:${options.port}  (MODE=${options.mode})`
      );
      resolve(server);
    });
  });
}

if (require.main === module) {
  start(parseArgs(process.argv));
}

module.exports = { start, RPC_FUNCTIONS, buildRuntime };
