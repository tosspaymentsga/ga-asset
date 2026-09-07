/**
 * 실제 QR 이미지 디코딩 검증.
 *
 * 테스트용 QR 인코더로 진짜 QR PNG 를 만들고,
 * 앱이 실제로 사용하는 경로(벤더링한 jsQR → 서버 검증)로 통과시킨다.
 * 카메라 프레임 대신 정지 이미지를 쓰지만, 디코딩 코드 경로는 동일하다.
 */
const { test, expect } = require('@playwright/test');
const { resetServer, openAs, auditLayout } = require('./helpers');
const { encodeQr, matrixToPng } = require('../harness/qrgen');

const SEHO = 'seho@company.com';

function qrPng(text) {
  return matrixToPng(encodeQr(text), 8, 4);
}

test.beforeEach(async ({ page, baseURL }) => {
  await resetServer(page, baseURL);
});

test('벤더링한 jsQR 이 브라우저에서 QR 을 디코딩한다', async ({ page }) => {
  await openAs(page, SEHO);
  const decoded = await page.evaluate(() => typeof window.jsQR);
  expect(decoded).toBe('function');
});

test('실제 QR 이미지 → 본인 자산 확인 완료', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('cta-scan').click();

  await page.setInputFiles('[data-testid="scan-file"]', {
    name: 'qr.png',
    mimeType: 'image/png',
    buffer: qrPng('Q12345'),
  });

  await expect(page.getByTestId('scan-ok')).toBeVisible();
  await expect(page.locator('.summary')).toContainText('MacBook Air 13');
  await expect(page.locator('.summary')).toContainText('Q12345');
  await expect(page.getByTestId('progress-count')).toHaveText('1 / 3 완료');
  await auditLayout(page, '사진 QR 인식 성공');
});

test('QR 안에 URL 이 들어 있어도 Tag 로 인식한다', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('cta-scan').click();

  await page.setInputFiles('[data-testid="scan-file"]', {
    name: 'qr.png',
    mimeType: 'image/png',
    buffer: qrPng('https://asset.company.com/t/Q12347'),
  });

  await expect(page.getByTestId('scan-ok')).toBeVisible();
  await expect(page.locator('.summary')).toContainText('iPad');
  await expect(page.locator('.summary')).toContainText('Q12347');
});

test('실제 QR 이 본인 자산이 아니면 소유자 정보 없이 안내한다', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('cta-scan').click();

  await page.setInputFiles('[data-testid="scan-file"]', {
    name: 'qr.png',
    mimeType: 'image/png',
    buffer: qrPng('Q12348'),
  });

  await expect(page.getByTestId('scan-not-mine')).toBeVisible();
  await expect(page.getByTestId('not-mine-tag')).toHaveText('Q12348');
});

test('QR 이 없는 사진은 인식 실패로 안내한다', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('cta-scan').click();

  // QR 이 없는 단색 이미지
  const blank = matrixToPng(
    Array.from({ length: 21 }, () => new Array(21).fill(false)),
    8,
    4
  );
  await page.setInputFiles('[data-testid="scan-file"]', {
    name: 'blank.png',
    mimeType: 'image/png',
    buffer: blank,
  });

  await expect(page.getByTestId('scan-failed')).toHaveText('QR 을 인식하지 못했습니다');
  await expect(page.locator('.result-desc')).toContainText('사진에서 QR 을 찾지 못했습니다');
  await auditLayout(page, 'QR 인식 실패');
});

test('같은 QR 이미지를 두 번 올려도 중복 기록되지 않는다', async ({ page, baseURL }) => {
  await openAs(page, SEHO);
  const png = qrPng('Q12345');

  await page.getByTestId('cta-scan').click();
  await page.setInputFiles('[data-testid="scan-file"]', {
    name: 'qr.png', mimeType: 'image/png', buffer: png,
  });
  await expect(page.getByTestId('scan-ok')).toBeVisible();

  await page.getByTestId('result-scan-more').click();
  await page.setInputFiles('[data-testid="scan-file"]', {
    name: 'qr.png', mimeType: 'image/png', buffer: png,
  });
  await expect(page.locator('.result-desc')).toContainText('중복으로 기록되지 않았습니다');

  // 서버에도 로그가 1건만 있어야 한다
  const res = await page.request.post(`${baseURL}/rpc`, {
    data: { fn: 'getMyAssets', args: [] },
  });
  const data = (await res.json()).data;
  expect(data.progress.qr_verified).toBe(1);
  expect(data.progress.responded).toBe(1);
});
