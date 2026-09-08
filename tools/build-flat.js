/**
 * Apps Script 편집기에 직접 붙여넣기 위한 "평면(flat) 빌드" 생성기.
 *
 * clasp 를 쓰면 src/ 를 그대로 push 하면 되지만(파일명에 `/` 가 들어간 형태),
 * 편집기에서 파일을 하나씩 만들어 붙여넣는 경우에는 폴더 없는 이름이 편하다.
 *
 * 이 스크립트는 src/ 를 읽어 dist/appsscript-flat/ 에 다음을 만든다.
 *   - server/*.gs  → 루트로 이동 (내용 동일)
 *   - html/*.html  → 루트로 이동
 *   - include('html/xxx') → include('xxx')
 *   - createTemplateFromFile('html/index') → 'index'
 *
 * 원본은 언제나 src/ 이며, dist/ 는 생성물이므로 직접 수정하지 않는다.
 *
 * 실행: node tools/build-flat.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist', 'appsscript-flat');

/** 편집기에서 만들 때 권장하는 순서 (clasp filePushOrder 와 동일) */
const SERVER_ORDER = [
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

function flatten(content) {
  return content
    .replace(/include\((['"])html\/([^'"]+)\1\)/g, "include($1$2$1)")
    .replace(
      /createTemplateFromFile\((['"])html\/([^'"]+)\1\)/g,
      'createTemplateFromFile($1$2$1)'
    );
}

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const files = [];

  // 매니페스트
  fs.copyFileSync(path.join(SRC, 'appsscript.json'), path.join(OUT, 'appsscript.json'));
  files.push('appsscript.json');

  // 서버 코드
  SERVER_ORDER.forEach((name) => {
    const from = path.join(SRC, 'server', name);
    if (!fs.existsSync(from)) throw new Error('누락된 서버 파일: ' + name);
    fs.writeFileSync(path.join(OUT, name), flatten(fs.readFileSync(from, 'utf8')));
    files.push(name);
  });

  const serverOnDisk = fs.readdirSync(path.join(SRC, 'server')).filter((f) => f.endsWith('.gs'));
  const missed = serverOnDisk.filter((f) => SERVER_ORDER.indexOf(f) < 0);
  if (missed.length) {
    throw new Error('SERVER_ORDER 에 없는 파일: ' + missed.join(', '));
  }

  // HTML
  fs.readdirSync(path.join(SRC, 'html'))
    .filter((f) => f.endsWith('.html'))
    .sort()
    .forEach((name) => {
      const from = path.join(SRC, 'html', name);
      fs.writeFileSync(path.join(OUT, name), flatten(fs.readFileSync(from, 'utf8')));
      files.push(name);
    });

  // 붙여넣기 순서 안내
  const guide = [
    '# Apps Script 편집기에 붙여넣는 순서',
    '',
    '파일명은 아래와 **똑같이** 만들어야 합니다 (확장자 제외한 이름이 일치해야 include 가 동작).',
    '',
    '## 스크립트 파일 (.gs)',
    '',
    ...SERVER_ORDER.map((n, i) => `${i + 1}. \`${n.replace(/\.gs$/, '')}\``),
    '',
    '## HTML 파일',
    '',
    ...files
      .filter((f) => f.endsWith('.html'))
      .map((n) => `- \`${n.replace(/\.html$/, '')}\``),
    '',
    '## 매니페스트',
    '',
    '`appsscript.json` 은 편집기 좌측 하단 **프로젝트 설정 → "appsscript.json" 매니페스트 파일 표시**를',
    '켠 뒤 내용을 교체합니다.',
    '',
    `생성 시각: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'PASTE_ORDER.md'), guide);

  console.log('평면 빌드 생성: ' + path.relative(ROOT, OUT));
  files.forEach((f) => {
    const size = fs.statSync(path.join(OUT, f)).size;
    console.log('  · ' + f + '  (' + size.toLocaleString('ko-KR') + ' bytes)');
  });
  return files;
}

if (require.main === module) build();
module.exports = { build, OUT, SERVER_ORDER };
