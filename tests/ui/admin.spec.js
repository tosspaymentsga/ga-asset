/**
 * 관리자 화면 검증 (§15~§17, §26).
 */
const { test, expect } = require('@playwright/test');
const { resetServer, openAs, auditLayout } = require('./helpers');

const ADMIN = 'asset.admin@company.com';

test.beforeEach(async ({ page, baseURL }) => {
  await resetServer(page, baseURL);
});

async function openAdmin(page) {
  await openAs(page, ADMIN);
  await page.getByTestId('admin-entry').click();
  await page.waitForSelector('[data-testid="kpi-assets"]');
}

test('관리자만 관리자 메뉴에 진입할 수 있다', async ({ page }) => {
  await openAs(page, 'seho@company.com');
  await expect(page.getByTestId('admin-entry')).toHaveCount(0);

  await openAs(page, ADMIN);
  await expect(page.getByTestId('admin-entry')).toHaveCount(1);
});

test('Dashboard KPI 가 Audit_Target 기준으로 표시된다', async ({ page, baseURL }) => {
  await openAdmin(page);

  // 화면 값과 서버 계산값이 일치해야 한다
  const res = await page.request.post(`${baseURL}/rpc`, {
    data: { fn: 'getAdminDashboard', args: [''] },
  });
  const dash = (await res.json()).data;

  const kpi = page.getByTestId('kpi-assets');
  await expect(kpi).toContainText(String(dash.asset.total));
  await expect(kpi).toContainText(String(dash.asset.completed));
  await expect(kpi).toContainText(String(dash.asset.not_started));

  await expect(page.locator('body')).toContainText(dash.asset.completion_rate + '%');
  await expect(page.locator('body')).toContainText('전체 대상 사용자');
  await expect(page.locator('body')).toContainText('부서별 실사 현황');

  // 4분류 합이 전체와 같아야 한다
  expect(
    dash.asset.completed + dash.asset.not_started + dash.asset.review_required
  ).toBe(dash.asset.total);

  await auditLayout(page, '관리자 Dashboard');
});

test('실사 현황 목록에서 필터와 검색이 동작한다', async ({ page }) => {
  await openAdmin(page);
  await page.getByTestId('tab-list').click();
  await page.waitForSelector('[data-testid="audit-row"]');

  const allRows = await page.getByTestId('audit-row').count();
  expect(allRows).toBeGreaterThan(0);
  await expect(page.getByTestId('list-total')).toContainText('총 ');
  await auditLayout(page, '실사 현황 목록');

  // 상태 필터
  await page.selectOption('[data-testid="filter-status"]', 'NOT_STARTED');
  await page.waitForTimeout(300);
  const notStarted = page.getByTestId('audit-row');
  const count = await notStarted.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(notStarted.nth(i)).toContainText('미실사');
  }

  // 검색 (Tag)
  await page.selectOption('[data-testid="filter-status"]', '');
  await page.waitForTimeout(300);
  await page.fill('[data-testid="admin-search"]', 'Q12345');
  await page.waitForTimeout(600);
  await expect(page.getByTestId('audit-row')).toHaveCount(1);
  await expect(page.getByTestId('audit-row').first()).toContainText('김세호');

  // 검색 (이메일) — 대상 자산 6건 + 목록에 없는 자산 신고 1건이 함께 보인다
  await page.fill('[data-testid="admin-search"]', 'junho@company.com');
  await page.waitForTimeout(600);
  const junhoRows = page.getByTestId('audit-row');
  await expect(junhoRows).toHaveCount(7);
  await expect(junhoRows.filter({ hasText: '목록에 없는 자산' })).toHaveCount(1);
  await expect(junhoRows.filter({ hasText: 'A009' })).toHaveCount(1);

  await auditLayout(page, '실사 현황 목록 - 검색');
});

test('확인 필요 화면에서 분류별 항목과 처리 액션이 동작한다', async ({ page, baseURL }) => {
  await openAdmin(page);
  await page.getByTestId('tab-recon').click();
  await page.waitForSelector('[data-testid="recon-item"]');

  // 분류 칩이 모두 노출된다
  for (const key of [
    'all',
    'NOT_IN_POSSESSION',
    'UNLISTED_ASSET',
    'FOREIGN_SCAN',
    'TAG_MISMATCH',
    'PHOTO_REVIEW',
  ]) {
    await expect(page.getByTestId('recon-cat-' + key)).toBeVisible();
  }
  await auditLayout(page, '확인 필요');

  const before = await page.request.post(`${baseURL}/rpc`, {
    data: { fn: 'getAdminReconciliation', args: [{}] },
  });
  const openBefore = (await before.json()).data.open_total;
  expect(openBefore).toBeGreaterThan(0);

  // 첫 항목을 "자산정보 수정 필요" 로 처리
  await page.getByTestId('resolve-MASTER_UPDATE_REQUIRED').first().click();
  await expect(page.locator('.toast')).toContainText('처리했습니다.');

  const after = await page.request.post(`${baseURL}/rpc`, {
    data: { fn: 'getAdminReconciliation', args: [{}] },
  });
  const openAfter = (await after.json()).data.open_total;
  expect(openAfter).toBe(openBefore - 1);

  // 분류 필터
  await page.getByTestId('recon-cat-UNLISTED_ASSET').click();
  await page.waitForTimeout(400);
  const items = page.getByTestId('recon-item');
  const n = await items.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    await expect(items.nth(i)).toContainText('목록에 없는 자산');
  }
  await auditLayout(page, '확인 필요 - 분류 필터');
});

test('확인 필요 항목에는 Master 대조 힌트가 함께 보인다', async ({ page }) => {
  await openAdmin(page);
  await page.getByTestId('tab-recon').click();
  await page.getByTestId('recon-cat-UNLISTED_ASSET').click();
  await page.waitForTimeout(400);
  // 신고 메모와 별개로 Master 대조 힌트가 함께 제공된다
  await expect(
    page.locator('.hint-box').filter({ hasText: 'Master' }).first()
  ).toBeVisible();

  // 등록된 적 없는 Tag 는 그렇게 표시된다
  await expect(page.getByTestId('recon-item').first()).toContainText(
    'Master 에 없는 Tag'
  );
});

test('실사 결과가 반영되면 Dashboard 수치가 함께 변한다', async ({ page, baseURL }) => {
  // 김세호가 자산 1건을 QR 확인
  await openAs(page, 'seho@company.com');
  await page.getByTestId('cta-scan').click();
  await page.fill('[data-testid="dev-tag-input"]', 'Q12345');
  await page.click('[data-testid="dev-tag-submit"]');
  await expect(page.getByTestId('scan-ok')).toBeVisible();

  // 관리자로 전환 후 확인
  await openAs(page, ADMIN);
  await page.getByTestId('admin-entry').click();
  await page.waitForSelector('[data-testid="kpi-assets"]');

  const res = await page.request.post(`${baseURL}/rpc`, {
    data: { fn: 'getAdminDashboard', args: [''] },
  });
  const dash = (await res.json()).data;

  // 시드(9 QR) + 방금 1건
  expect(dash.asset.qr_verified).toBe(10);
  await expect(page.getByTestId('kpi-assets')).toContainText(String(dash.asset.total));
});
