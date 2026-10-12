// Capture the actual menu UI; no synthetic aircraft or scenery is composited in.
// npm ci && npx playwright install chromium
// node scripts/capture-readme.mjs [http://127.0.0.1:5197/]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const origin = process.argv[2] || 'http://127.0.0.1:5197/';
const directory = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('.st-dashboard').waitFor();
  const capture = async name => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.querySelectorAll('#sim-start img')].map(img => img.decode().catch(() => {})));
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${directory}/${name}.jpg`, type: 'jpeg', quality: 85 });
    console.log(`Captured ${name}`);
  };
  await capture('welcome');
  for (const [step, name] of [['mode', 'flight-modes'], ['vehicle', 'aircraft'], ['brief', 'briefing']]) {
    await page.locator(`.st-steps [data-step="${step}"]`).click();
    await capture(name);
  }
} finally {
  await browser.close();
}
