// 배포물이 아닌 검증 도구 설정 (§26 UI 검증)
const fs = require('fs');
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.HARNESS_PORT || 8110);

/** 환경에 미리 설치된 Chromium 사용 (버전이 다르면 executablePath 로 지정) */
function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

const executablePath = chromiumPath();
const launchOptions = executablePath ? { executablePath } : {};

module.exports = defineConfig({
  testDir: './ui',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    screenshot: 'off',
    launchOptions,
  },
  projects: [
    {
      name: 'mobile-390',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: false,
        hasTouch: true,
        launchOptions,
      },
    },
    {
      name: 'desktop-1440',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions,
      },
    },
  ],
  webServer: {
    command: `node harness/server.js --port ${PORT}`,
    url: `http://localhost:${PORT}/__health`,
    reuseExistingServer: true,
    timeout: 20000,
    cwd: __dirname,
  },
});
