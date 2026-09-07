/**
 * 화면 캡처 (검토용).
 * 실행: node tests/screenshots.js   (하네스가 8110 포트에서 떠 있어야 함)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');

const OUT = path.join(__dirname, '..', 'screenshots');
const BASE = process.env.BASE_URL || 'http://localhost:8110';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function shot(page, name) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  console.log('  · ' + name);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME });

  /* ---------------- 모바일 390px ---------------- */
  console.log('모바일 390px');
  let ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  let page = await ctx.newPage();
  await page.request.post(BASE + '/__reset');

  await page.goto(BASE + '/?signout=1');
  await page.waitForSelector('[data-testid="demo-user"]');
  await shot(page, 'm01-로그인');

  await page.goto(BASE + '/?user=seho@company.com');
  await page.waitForSelector('[data-testid="greeting"]');
  await shot(page, 'm02-내자산');

  await page.click('[data-testid="asset-card"]');
  await shot(page, 'm03-자산상세');

  await page.click('[data-testid="detail-scan"]');
  await page.waitForTimeout(500);
  await shot(page, 'm04-QR스캐너');

  await page.fill('[data-testid="dev-tag-input"]', 'Q12345');
  await page.click('[data-testid="dev-tag-submit"]');
  await page.waitForSelector('[data-testid="scan-ok"]');
  await shot(page, 'm05-QR성공');

  await page.click('[data-action="goScan"]');
  await page.waitForSelector('[data-testid="dev-tag-input"]');
  await page.fill('[data-testid="dev-tag-input"]', 'Q12348');
  await page.click('[data-testid="dev-tag-submit"]');
  await page.waitForSelector('[data-testid="scan-not-mine"]');
  await shot(page, 'm06-QR불일치');

  await page.click('[data-action="goList"]');
  await page.click('[data-testid="asset-card"] >> nth=1');
  await page.click('[data-testid="detail-photo"]');
  await shot(page, 'm07-사진실사');

  await page.setInputFiles('[data-testid="photo-input"]', {
    name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1x1, 'base64'),
  });
  await page.waitForSelector('[data-testid="photo-preview"]');
  await page.click('[data-testid="submit-photo"]');
  await page.waitForTimeout(400);

  await page.click('[data-action="goList"]');
  await page.click('[data-testid="asset-card"] >> nth=2');
  await page.click('[data-testid="detail-exception"]');
  await page.check('[data-testid="reason-OTHER"]');
  await shot(page, 'm08-미보유신고');

  await page.check('[data-testid="reason-ALREADY_RETURNED"]');
  await page.click('[data-testid="submit-exception"]');
  await page.waitForSelector('[data-testid="complete-title"]');
  await shot(page, 'm09-실사완료');

  await page.click('[data-action="goList"]');
  await page.click('[data-testid="go-unlisted"]');
  await page.fill('[data-testid="unlisted-tag"]', 'Q77777');
  await page.fill('[data-testid="unlisted-note"]', '옆자리에서 넘겨받은 모니터입니다.');
  await shot(page, 'm10-목록외자산');

  await page.click('[data-testid="submit-unlisted"]');
  await page.waitForSelector('[data-testid="asset-list"]');
  await shot(page, 'm11-내자산-완료상태');

  await ctx.close();

  /* ---------------- 데스크톱 1440px ---------------- */
  console.log('데스크톱 1440px');
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();

  await page.goto(BASE + '/?user=seho@company.com');
  await page.waitForSelector('[data-testid="greeting"]');
  await shot(page, 'd01-직원화면');

  await page.goto(BASE + '/?user=asset.admin@company.com');
  await page.waitForSelector('[data-testid="admin-entry"]');
  await page.click('[data-testid="admin-entry"]');
  await page.waitForSelector('[data-testid="kpi-assets"]');
  await shot(page, 'd02-관리자-Dashboard');

  await page.click('[data-testid="tab-list"]');
  await page.waitForSelector('[data-testid="audit-row"]');
  await shot(page, 'd03-관리자-실사현황');

  await page.click('[data-testid="tab-recon"]');
  await page.waitForSelector('[data-testid="recon-item"]');
  await shot(page, 'd04-관리자-확인필요');

  await ctx.close();

  /* ---------------- 관리자 화면 모바일 ---------------- */
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page = await ctx.newPage();
  await page.goto(BASE + '/?user=asset.admin@company.com');
  await page.waitForSelector('[data-testid="admin-entry"]');
  await page.click('[data-testid="admin-entry"]');
  await page.waitForSelector('[data-testid="kpi-assets"]');
  await shot(page, 'm12-관리자-Dashboard');
  await ctx.close();

  await browser.close();
  console.log('완료 → ' + OUT);
})();
