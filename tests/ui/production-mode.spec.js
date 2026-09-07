/**
 * 운영 배포 상태 검증.
 *
 * ALLOW_MOCK_USER=false / ALLOW_DEV_TAG_INPUT=false 로 두고
 * Google Workspace 로그인 계정만으로 동작하는지, 그리고 데모용 기능이
 * 완전히 사라지는지 확인한다(§4, §8).
 */
const { test, expect } = require('@playwright/test');
const { resetServer, configure, appText, auditLayout } = require('./helpers');

test.beforeEach(async ({ page, baseURL }) => {
  await resetServer(page, baseURL);
});

test('운영 설정에서는 데모 계정 전환과 개발용 Tag 입력이 사라진다', async ({ page, baseURL }) => {
  await configure(page, baseURL, {
    properties: { ALLOW_MOCK_USER: 'false', ALLOW_DEV_TAG_INPUT: 'false' },
    activeEmail: 'seho@company.com',
    signOutMockUser: true,
  });

  await page.goto('/');
  await page.waitForSelector('[data-testid="greeting"]');

  // Workspace 계정으로 식별된다
  await expect(page.getByTestId('greeting')).toHaveText('김세호님의 보유 자산을 확인해주세요.');
  await expect(page.getByTestId('asset-card')).toHaveCount(3);

  // 데모 기능은 노출되지 않는다
  await expect(page.getByTestId('demo-bar')).toHaveCount(0);

  // 다른 직원 정보가 페이지 어디에도 없어야 한다 (초기 payload 포함)
  const html = await page.content();
  expect(html).not.toContain('jieun@company.com');
  expect(html).not.toContain('이지은');
  expect(html).not.toContain('junho@company.com');

  // 스캐너에 개발용 입력이 없어야 한다
  await page.getByTestId('cta-scan').click();
  await expect(page.getByTestId('dev-tag-input')).toHaveCount(0);
  await expect(page.getByTestId('scan-file')).toHaveCount(1);
  await auditLayout(page, '운영 QR 스캐너');
});

test('로그인 계정을 확인할 수 없으면 안내 화면을 보여준다', async ({ page, baseURL }) => {
  await configure(page, baseURL, {
    properties: { ALLOW_MOCK_USER: 'false' },
    activeEmail: '',
    signOutMockUser: true,
  });

  await page.goto('/');
  await expect(page.locator('.notice-error')).toContainText(
    '로그인 정보를 확인하지 못했습니다'
  );
  await expect(page.locator('.notice-error')).toContainText('회사 Google 계정으로 로그인');
  await expect(page.getByTestId('demo-user')).toHaveCount(0);

  // 내부 진단 정보는 사용자 화면에 노출하지 않는다
  const text = await appText(page);
  expect(text).not.toContain('Session.getActiveUser');
  expect(text).not.toContain('USER_DEPLOYING');
  expect(text).not.toContain('Error');
});

test('데모 모드가 꺼지면 devSignInAs 는 서버에서 거부된다', async ({ page, baseURL }) => {
  await configure(page, baseURL, {
    properties: { ALLOW_MOCK_USER: 'false' },
    activeEmail: 'seho@company.com',
    signOutMockUser: true,
  });

  const res = await page.request.post(`${baseURL}/rpc`, {
    data: { fn: 'devSignInAs', args: ['asset.admin@company.com'] },
  });
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.message).toBe('접근 권한이 없습니다.');

  const reset = await page.request.post(`${baseURL}/rpc`, {
    data: { fn: 'devResetMyAudit', args: [] },
  });
  expect((await reset.json()).ok).toBe(false);
});

test('일반 직원에게는 관리자 진입점이 보이지 않는다', async ({ page, baseURL }) => {
  await configure(page, baseURL, {
    properties: { ALLOW_MOCK_USER: 'false' },
    activeEmail: 'seho@company.com',
    signOutMockUser: true,
  });
  await page.goto('/');
  await page.waitForSelector('[data-testid="greeting"]');
  await expect(page.getByTestId('admin-entry')).toHaveCount(0);

  // 서버도 거부한다
  const res = await page.request.post(`${baseURL}/rpc`, {
    data: { fn: 'getAdminDashboard', args: [''] },
  });
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.message).toBe('접근 권한이 없습니다.');
});
