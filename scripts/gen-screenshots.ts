// Captures the screenshots Chrome shows in Android's install sheet (public/screenshots).
// Needs the app running: `npm run worker:dev` (or `npm run preview`), then:
//   node scripts/gen-screenshots.ts [url]
// Set CHROMIUM_PATH to use a preinstalled browser instead of Playwright's own.

import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:8787/';
const out = new URL('../public/screenshots/', import.meta.url).pathname;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  reducedMotion: 'reduce',
});
const page = await ctx.newPage();

await page.goto(url);
await page.waitForSelector('.intro');
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}intro.png` });

await page.getByRole('button', { name: 'Skip' }).click();
await page.waitForSelector('.home');
for (const cup of [1, 1, 2, 1]) {
  await page.locator(`[data-cup="${cup}"]`).click();
  await page.waitForTimeout(120);
}
await page.waitForTimeout(1900);
await page.screenshot({ path: `${out}today.png` });

await page.goto(`${url}#/settings`);
await page.waitForSelector('.settings .card');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}settings.png` });

await browser.close();
console.log('Wrote public/screenshots/{intro,today,settings}.png');
