/**
 * 직원 화면 검증 (§26).
 * mobile-390 / desktop-1440 두 프로젝트에서 모두 실행된다.
 */
const { test, expect } = require('@playwright/test');
const {
  resetServer,
  openAs,
  auditLayout,
  appText,
  configure,
  scanTag,
} = require('./helpers');

const SEHO = 'seho@company.com';

test.beforeEach(async ({ page, baseURL }) => {
  await resetServer(page, baseURL);
});

test('접속하면 본인 자산만 보이고 진행률이 표시된다', async ({ page }) => {
  await openAs(page, SEHO);

  await expect(page.getByTestId('greeting')).toHaveText('김세호님의 보유 자산을 확인해주세요.');
  await expect(page.getByTestId('progress-count')).toHaveText('0 / 3 완료');

  const cards = page.getByTestId('asset-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('MacBook Air 13');
  await expect(cards.nth(0)).toContainText('자산번호 A001');
  await expect(cards.nth(0)).toContainText('Tag Q12345');
  await expect(cards.nth(0)).toContainText('미실사');

  // 다른 직원 정보가 실사 화면에 없어야 한다 (PoC 데모 계정 전환 바 제외)
  const body = await appText(page);
  expect(body).not.toContain('이지은');
  expect(body).not.toContain('jieun@company.com');
  expect(body).not.toContain('박준호');

  await expect(page.getByTestId('cta-scan')).toBeVisible();
  await auditLayout(page, '내 자산 목록');
});

test('정상 QR 스캔 → 실사 완료로 기록된다', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('cta-scan').click();
  await auditLayout(page, 'QR 스캐너');

  await scanTag(page, 'Q12345');

  await expect(page.getByTestId('scan-ok')).toBeVisible();
  await expect(page.locator('.summary')).toContainText('MacBook Air 13');
  await expect(page.locator('.summary')).toContainText('A001');
  await expect(page.locator('.summary')).toContainText('Q12345');
  await expect(page.getByTestId('progress-count')).toHaveText('1 / 3 완료');
  await auditLayout(page, 'QR 성공');

  await page.click('[data-action="goList"]');
  await expect(page.getByTestId('asset-card').nth(0)).toContainText('완료');
  await expect(page.getByTestId('progress-count')).toHaveText('1 / 3 완료');
});

test('동일 QR 을 다시 스캔해도 중복 처리되지 않는다', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('cta-scan').click();
  await scanTag(page, 'Q12345');
  await expect(page.getByTestId('scan-ok')).toBeVisible();

  await page.getByTestId('result-scan-more').click();
  await scanTag(page, 'Q12345');

  await expect(page.getByTestId('scan-ok')).toBeVisible();
  await expect(page.locator('.result-desc')).toContainText('중복으로 기록되지 않았습니다');
  await expect(page.getByTestId('progress-count')).toHaveText('1 / 3 완료');
});

test('본인 자산이 아닌 QR → 소유자 정보 없이 확인 필요로 등록', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('cta-scan').click();
  await scanTag(page, 'Q12348'); // 이지은 자산

  await expect(page.getByTestId('scan-not-mine')).toHaveText('내 자산 목록에 없는 자산입니다');
  await expect(page.getByTestId('not-mine-tag')).toHaveText('Q12348');

  const body = await appText(page);
  expect(body).not.toContain('이지은');
  expect(body).not.toContain('jieun');
  expect(body).not.toContain('MacBook Pro');
  await auditLayout(page, 'QR 불일치');

  await page.getByTestId('register-foreign').click();
  await expect(page.getByTestId('asset-list')).toBeVisible();
  await expect(page.locator('body')).toContainText('내 목록에 없는 QR');
  await auditLayout(page, '등록 후 목록');
});

test('인식할 수 없는 Tag → 확인 필요 안내와 다시 스캔 제공', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('cta-scan').click();
  await scanTag(page, 'Q99999');

  await expect(page.getByTestId('scan-not-mine')).toBeVisible();
  await expect(page.getByTestId('rescan')).toBeVisible();
  await page.getByTestId('rescan').click();
  await expect(page.getByTestId('dev-tag-input')).toBeVisible();
});

test('자산 상세에서 사진으로 확인 → 사진 제출 상태', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('asset-card').nth(1).click();

  await expect(page.getByTestId('detail-name')).toHaveText('모니터 27형');
  await expect(page.getByTestId('detail-scan')).toBeVisible();
  await expect(page.getByTestId('detail-photo')).toBeVisible();
  await expect(page.getByTestId('detail-exception')).toBeVisible();
  await auditLayout(page, '자산 상세');

  await page.getByTestId('detail-photo').click();
  await expect(page.locator('.photo-guide')).toContainText(
    '자산과 자산 Tag가 함께 보이도록 촬영해주세요.'
  );
  await expect(page.getByTestId('submit-photo')).toBeDisabled();
  await auditLayout(page, '사진 실사');

  await page.setInputFiles('[data-testid="photo-input"]', {
    name: 'asset.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    ),
  });
  await expect(page.getByTestId('photo-preview')).toBeVisible();
  await expect(page.getByTestId('submit-photo')).toBeEnabled();

  await page.getByTestId('submit-photo').click();
  await expect(page.locator('.summary')).toContainText('사진 제출');

  await page.click('[data-action="goList"]');
  await expect(page.getByTestId('asset-card').nth(1)).toContainText('사진 제출');
  await expect(page.getByTestId('progress-count')).toHaveText('1 / 3 완료');
});

test('보유하지 않음 신고 → 확인 필요 상태', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('asset-card').nth(2).click();
  await page.getByTestId('detail-exception').click();

  await expect(page.getByTestId('reason-list')).toBeVisible();
  await expect(page.getByTestId('submit-exception')).toBeDisabled();
  await auditLayout(page, '미보유 신고');

  // 기타 선택 시 메모 입력란 노출
  await page.getByTestId('reason-OTHER').check();
  await expect(page.getByTestId('reason-note')).toBeVisible();
  await auditLayout(page, '미보유 신고 - 기타');

  await page.getByTestId('reason-ALREADY_RETURNED').check();
  await expect(page.getByTestId('reason-note')).toBeHidden();
  await page.getByTestId('submit-exception').click();

  await expect(page.locator('.summary')).toContainText('확인 필요');
  await page.click('[data-action="goList"]');
  await expect(page.getByTestId('asset-card').nth(2)).toContainText('확인 필요');
});

test('목록에 없는 자산 등록', async ({ page }) => {
  await openAs(page, SEHO);
  await page.getByTestId('go-unlisted').click();
  await auditLayout(page, '목록에 없는 자산');

  // Tag 없이 제출하면 사용자 친화적 안내
  await page.getByTestId('submit-unlisted').click();
  await expect(page.locator('.toast')).toContainText('Tag 번호를 입력해주세요.');

  await page.fill('[data-testid="unlisted-tag"]', 'Q77777');
  await page.fill('[data-testid="unlisted-note"]', '옆자리에서 받은 모니터');
  await page.getByTestId('submit-unlisted').click();

  await expect(page.getByTestId('asset-list')).toBeVisible();
  await expect(page.locator('body')).toContainText('Tag Q77777');
  await expect(page.locator('body')).toContainText('목록에 없는 자산');
  await auditLayout(page, '등록 후 목록');
});

test('모든 자산에 응답하면 실사 완료 화면이 나온다', async ({ page }) => {
  await openAs(page, SEHO);

  // A001 QR
  await page.getByTestId('cta-scan').click();
  await scanTag(page, 'Q12345');
  await expect(page.getByTestId('scan-ok')).toBeVisible();
  await page.click('[data-action="goList"]');

  // A002 사진
  await page.getByTestId('asset-card').nth(1).click();
  await page.getByTestId('detail-photo').click();
  await page.setInputFiles('[data-testid="photo-input"]', {
    name: 'a.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    ),
  });
  await page.getByTestId('submit-photo').click();
  await expect(page.locator('.summary')).toContainText('사진 제출');
  await page.click('[data-action="goList"]');

  // A003 미보유
  await page.getByTestId('asset-card').nth(2).click();
  await page.getByTestId('detail-exception').click();
  await page.getByTestId('reason-LOST').check();
  await page.getByTestId('submit-exception').click();

  // 마지막 응답이므로 완료 화면으로 이동
  await expect(page.getByTestId('complete-title')).toHaveText('자산실사가 완료되었습니다');
  const summary = page.getByTestId('complete-summary');
  await expect(summary).toContainText('3개');
  await expect(summary).toContainText('QR 확인');
  await auditLayout(page, '실사 완료');

  // 재접속해도 완료 상태 유지
  await page.reload();
  await expect(page.getByTestId('progress-count')).toHaveText('3 / 3 완료');
  await expect(page.getByTestId('done-banner')).toBeVisible();
  await auditLayout(page, '완료 후 목록');
});

test('서버 오류는 사용자 친화적 메시지로 표시된다', async ({ page }) => {
  await openAs(page, SEHO);

  // 서버가 오류를 반환하는 상황 (형식이 잘못된 사진)
  await page.evaluate(() => {
    window.__origPrepare = PhotoUtil.prepare;
    PhotoUtil.prepare = function () {
      return Promise.resolve({ base64: 'AAAA', mimeType: 'text/plain', previewUrl: '' });
    };
  });
  await page.getByTestId('asset-card').nth(0).click();
  await page.getByTestId('detail-photo').click();
  await page.setInputFiles('[data-testid="photo-input"]', {
    name: 'x.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await page.getByTestId('submit-photo').click();
  await expect(page.locator('.toast')).toContainText('이미지 파일만 업로드할 수 있습니다.');

  // 통신 자체가 실패하는 경우
  await page.evaluate(() => {
    window.google.script.run = {
      withSuccessHandler() { return this; },
      withFailureHandler(fn) { this.__fail = fn; return this; },
      getMyAssets() { this.__fail(new Error('boom')); },
      submitPhoto() { this.__fail(new Error('boom')); },
    };
  });
  await page.getByTestId('submit-photo').click();
  await expect(page.locator('.toast')).toContainText('서버와 통신하지 못했습니다');
  const toastText = await page.textContent('.toast');
  expect(toastText).not.toContain('boom');
});

test('QR 스캐너는 카메라를 못 쓰면 대체 수단을 안내한다', async ({ page, context }) => {
  // 카메라 권한 거부 상황을 만든다
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => {
          const err = new Error('denied');
          err.name = 'NotAllowedError';
          return Promise.reject(err);
        },
      },
    });
  });
  await openAs(page, SEHO);
  await page.getByTestId('cta-scan').click();

  await expect(page.locator('.scanner-fallback')).toContainText('카메라 권한이 허용되지 않았습니다');
  await expect(page.locator('.scanner-fallback')).toContainText('QR 촬영해서 확인');
  // 실시간 카메라가 막혀도 기본 확인 방식(촬영 → 디코딩)은 그대로 쓸 수 있어야 한다
  await expect(page.getByTestId('scan-file')).toHaveCount(1);
  const captureBtn = page.locator('label.btn', { hasText: 'QR 촬영해서 확인' });
  await expect(captureBtn).toBeVisible();
  await expect(captureBtn).toHaveClass(/btn-primary/);
  await auditLayout(page, 'QR 카메라 불가');
  void context;
});
