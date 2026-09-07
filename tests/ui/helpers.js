/** UI 검증 공용 헬퍼 */
const { expect } = require('@playwright/test');

/** 테스트 간 격리: 저장소를 시드 상태로 되돌린다 */
async function resetServer(page, baseURL) {
  const res = await page.request.post(`${baseURL}/__reset`);
  expect(res.ok()).toBeTruthy();
}

/** 데모 계정으로 접속 */
async function openAs(page, email) {
  await page.goto(`/?user=${encodeURIComponent(email)}`);
  await page.waitForSelector('[data-testid="greeting"], [data-testid="demo-user"]');
}

/**
 * 가로 overflow 검사.
 * 의도적으로 가로 스크롤을 허용한 컨테이너(.table-scroll) 내부는 제외한다.
 */
async function expectNoHorizontalOverflow(page, label) {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const viewport = doc.clientWidth;
    const problems = [];
    if (doc.scrollWidth > viewport + 1) {
      problems.push({ what: 'document', scrollWidth: doc.scrollWidth, viewport });
    }
    document.querySelectorAll('body *').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      let parent = el.parentElement;
      let insideScroller = false;
      while (parent) {
        const st = getComputedStyle(parent);
        if (st.overflowX === 'auto' || st.overflowX === 'scroll') { insideScroller = true; break; }
        parent = parent.parentElement;
      }
      if (insideScroller) return;
      if (rect.right > viewport + 1 || rect.left < -1) {
        problems.push({
          what: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          viewport,
        });
      }
    });
    return problems;
  });
  expect(report, `${label}: 가로 overflow 발생`).toEqual([]);
}

/**
 * 텍스트 잘림 검사.
 * overflow:hidden 이면서 ellipsis 처리도 없는 요소에서 내용이 잘리면 실패.
 */
async function expectNoTextClipping(page, label) {
  const clipped = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('body *').forEach((el) => {
      if (!el.childNodes.length) return;
      const hasText = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && n.textContent.trim().length > 0
      );
      if (!hasText) return;
      const st = getComputedStyle(el);
      const hiddenX = st.overflowX === 'hidden' || st.overflow === 'hidden';
      const hiddenY = st.overflowY === 'hidden' || st.overflow === 'hidden';
      const ellipsis = st.textOverflow === 'ellipsis';
      if (hiddenX && !ellipsis && el.scrollWidth > el.clientWidth + 1) {
        out.push({ what: el.className || el.tagName, axis: 'x', scroll: el.scrollWidth, client: el.clientWidth });
      }
      if (hiddenY && el.scrollHeight > el.clientHeight + 2) {
        out.push({ what: el.className || el.tagName, axis: 'y', scroll: el.scrollHeight, client: el.clientHeight });
      }
    });
    return out;
  });
  expect(clipped, `${label}: 텍스트 잘림 발생`).toEqual([]);
}

/**
 * 하단 고정 CTA 가 컨텐츠 마지막 요소를 가리지 않는지 검사.
 * (페이지 최하단까지 스크롤한 뒤 비교)
 */
async function expectCtaDoesNotCoverContent(page, label) {
  const result = await page.evaluate(async () => {
    const cta = document.querySelector('.cta');
    if (!cta) return { skipped: true };
    if (getComputedStyle(cta).position !== 'fixed') return { skipped: true };
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 120));
    const ctaRect = cta.getBoundingClientRect();
    const screen = document.querySelector('.screen');
    if (!screen) return { skipped: true };
    // .screen 의 마지막 자식 중 실제로 보이는 요소
    const children = Array.from(screen.children).filter((c) => {
      const r = c.getBoundingClientRect();
      return r.height > 0;
    });
    if (!children.length) return { skipped: true };
    const last = children[children.length - 1].getBoundingClientRect();
    return {
      skipped: false,
      contentBottom: Math.round(last.bottom),
      ctaTop: Math.round(ctaRect.top),
    };
  });
  if (result.skipped) return;
  expect(
    result.contentBottom,
    `${label}: 하단 CTA(${result.ctaTop}px)가 컨텐츠 마지막(${result.contentBottom}px)을 가림`
  ).toBeLessThanOrEqual(result.ctaTop);
}

/**
 * 버튼 겹침 검사.
 *
 * 같은 배치 맥락(둘 다 일반 흐름 / 둘 다 고정)에 있는 버튼끼리만 비교한다.
 * 고정 CTA 아래로 본문이 지나가는 것은 정상 동작이며,
 * "실제로 누를 수 있는가" 는 expectButtonsClickable 에서 따로 검사한다.
 */
async function expectNoButtonOverlap(page, label) {
  const overlaps = await page.evaluate(() => {
    const isFixed = (el) => {
      let node = el;
      while (node && node !== document.body) {
        if (getComputedStyle(node).position === 'fixed') return true;
        node = node.parentElement;
      }
      return false;
    };
    const buttons = Array.from(
      document.querySelectorAll('button, .btn, a[role="button"]')
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    });
    const out = [];
    for (let i = 0; i < buttons.length; i++) {
      for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i];
        const b = buttons[j];
        if (a.contains(b) || b.contains(a)) continue;
        if (isFixed(a) !== isFixed(b)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (overlapX > 2 && overlapY > 2) {
          out.push({
            a: a.textContent.trim().slice(0, 20),
            b: b.textContent.trim().slice(0, 20),
          });
        }
      }
    }
    return out;
  });
  expect(overlaps, `${label}: 버튼 겹침`).toEqual([]);
}

/**
 * 모든 버튼이 실제로 클릭 가능한지 검사.
 * 화면에 보이도록 스크롤한 뒤 중심점을 hit-test 해서 다른 요소에 가려지지 않았는지 본다.
 */
async function expectButtonsClickable(page, label) {
  const blocked = await page.evaluate(async () => {
    const buttons = Array.from(
      document.querySelectorAll('button, .btn, label.btn, a[role="button"]')
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return (
        r.width > 0 && r.height > 0 &&
        st.visibility !== 'hidden' && st.display !== 'none' &&
        !el.disabled
      );
    });
    const out = [];
    for (const el of buttons) {
      el.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 20));
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (y < 0 || y > window.innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      if (hit === el || el.contains(hit) || hit.contains(el)) continue;
      out.push({
        button: el.textContent.trim().slice(0, 24),
        coveredBy: hit.tagName.toLowerCase() +
          (hit.className ? '.' + String(hit.className).split(' ')[0] : ''),
        at: { x: Math.round(x), y: Math.round(y) },
        scrollY: Math.round(window.scrollY),
        docHeight: document.documentElement.scrollHeight,
        connected: el.isConnected,
      });
    }
    window.scrollTo(0, 0);
    return out;
  });
  expect(blocked, `${label}: 가려져서 누를 수 없는 버튼`).toEqual([]);
}

/** 화면 종합 검사 */
async function auditLayout(page, label) {
  await expectNoHorizontalOverflow(page, label);
  await expectNoTextClipping(page, label);
  await expectNoButtonOverlap(page, label);
  await expectButtonsClickable(page, label);
  await expectCtaDoesNotCoverContent(page, label);
}

/** 직원 화면 본문 텍스트 (PoC 데모 바 제외) */
async function appText(page) {
  return page.evaluate(() => {
    const app = document.getElementById('app');
    if (!app) return '';
    const clone = app.cloneNode(true);
    clone.querySelectorAll('.demo-bar').forEach((el) => el.remove());
    return clone.textContent || '';
  });
}

/** 서버 설정을 바꾼다 (운영 배포 상태 재현용) */
async function configure(page, baseURL, body) {
  const res = await page.request.post(`${baseURL}/__config`, { data: body });
  expect(res.ok()).toBeTruthy();
}

/** QR 스캐너의 개발용 Tag 입력으로 스캔 결과를 흉내 낸다 */
async function scanTag(page, tag) {
  await page.fill('[data-testid="dev-tag-input"]', tag);
  await page.click('[data-testid="dev-tag-submit"]');
}

module.exports = {
  resetServer,
  openAs,
  auditLayout,
  appText,
  configure,
  expectNoHorizontalOverflow,
  expectNoTextClipping,
  expectNoButtonOverlap,
  expectButtonsClickable,
  expectCtaDoesNotCoverContent,
  scanTag,
};
