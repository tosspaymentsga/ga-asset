/**
 * 평면 빌드(dist/appsscript-flat) 검증.
 *
 * Apps Script 편집기에 그대로 붙여넣을 파일들이 실제로 동작하는지 확인한다.
 * src/ 와 동일한 코드여야 하고, include 경로만 폴더 없이 바뀌어야 한다.
 *
 * 실행: node tests/flat-build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRuntime } = require('./harness/gas-runtime');
const { build, OUT, SERVER_ORDER } = require('../tools/build-flat');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

console.log('평면 빌드 검증 (Apps Script 편집기 배포용)');

console.log('\n[1] 빌드');
build();
const SRC = path.join(__dirname, '..', 'src');

check('출력 폴더 생성', fs.existsSync(OUT));
check('매니페스트 포함', fs.existsSync(path.join(OUT, 'appsscript.json')));
check('붙여넣기 순서 안내 포함', fs.existsSync(path.join(OUT, 'PASTE_ORDER.md')));
check('하위 폴더 없음',
  fs.readdirSync(OUT, { withFileTypes: true }).every((e) => e.isFile()));

console.log('\n[2] 원본과 내용 일치 (include 경로만 다름)');
SERVER_ORDER.forEach((name) => {
  const original = fs.readFileSync(path.join(SRC, 'server', name), 'utf8');
  const flat = fs.readFileSync(path.join(OUT, name), 'utf8');
  const normalized = original.replace(/createTemplateFromFile\('html\//g, "createTemplateFromFile('");
  check(name + ' 내용 동일', flat === normalized);
});

fs.readdirSync(path.join(SRC, 'html')).forEach((name) => {
  const original = fs.readFileSync(path.join(SRC, 'html', name), 'utf8');
  const flat = fs.readFileSync(path.join(OUT, name), 'utf8');
  const normalized = original.replace(/include\('html\//g, "include('");
  check(name + ' 내용 동일', flat === normalized);
});

console.log('\n[3] 폴더 경로 잔존 여부');
const leftovers = fs.readdirSync(OUT)
  .filter((f) => f.endsWith('.gs') || f.endsWith('.html'))
  .filter((f) => /include\('html\/|createTemplateFromFile\('html\//.test(
    fs.readFileSync(path.join(OUT, f), 'utf8')
  ));
eq('html/ 경로 참조 없음', leftovers, []);

console.log('\n[4] 평면 빌드로 실제 구동');
const rt = createRuntime({
  srcDir: OUT,
  serverDir: '',           // .gs 파일이 루트에 있다
  activeEmail: '',
  properties: { MODE: 'MOCK', ALLOW_MOCK_USER: 'true', ALLOW_DEV_TAG_INPUT: 'true' },
});

const html = rt.call('doGet', [{ parameter: {} }]).getContent();
check('doGet 이 HTML 을 반환', html.indexOf('<!DOCTYPE html>') === 0);
check('스타일 포함', html.indexOf('--ink:') > 0);
check('jsQR 포함', html.indexOf('jsQR') > 0);
check('앱 스크립트 포함', html.indexOf('App.boot') > 0);
check('초기 상태 주입', html.indexOf('__INITIAL_STATE__') > 0);
check('템플릿 스크립틀릿 잔존 없음', html.indexOf('<?') < 0);

console.log('\n[5] 평면 빌드에서 실사 플로우');
let res = rt.call('devSignInAs', ['seho@company.com']);
check('로그인', res.ok === true, JSON.stringify(res).slice(0, 160));

let view = rt.call('getMyAssets').data;
eq('내 자산 3건', view.assets.length, 3);
eq('사용자 이름', view.user.name, '김세호');

res = rt.call('verifyQr', ['Q12345', '']);
eq('QR 확인', res.data.result, 'MATCHED');
eq('진행률', [res.data.progress.responded, res.data.progress.total], [1, 3]);

res = rt.call('verifyQr', ['Q12348', '']);
eq('타인 자산 차단', res.data.result, 'NOT_MINE');

res = rt.call('submitException', ['A003', 'LOST', '']);
eq('미보유 신고', res.data.asset.audit_status, 'NOT_IN_POSSESSION');

rt.call('devSignInAs', ['asset.admin@company.com']);
res = rt.call('getAdminDashboard', ['']);
check('관리자 대시보드', res.ok === true, JSON.stringify(res).slice(0, 160));
eq('전체 대상 22건', res.data.asset.total, 22);

console.log('\n----------------------------------------');
console.log('통과 ' + passed + ' / 실패 ' + failed);
if (failures.length) {
  console.log('\n실패 목록:');
  failures.forEach((f) => console.log(' - ' + f));
}
process.exit(failed ? 1 : 0);
