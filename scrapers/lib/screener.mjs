// Shared Screener.in browser plumbing: headless Chromium with a desktop UA,
// cookie-based login, and a patient "navigate + wait for selector" helper with
// retries. Used by both the universe scraper and the per-company crawler.

import { chromium } from 'playwright';

export const LOGIN_URL = 'https://www.screener.in/login/';
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fill the login form, submit, and verify a /logout/ link is present.
export async function login(page, email, password) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"]', email);
  await page.fill('input[name="password"]', password);

  const submit = page.locator('button[type="submit"]');
  if (await submit.count()) await submit.first().click();
  else await page.press('input[name="password"]', 'Enter');

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const html = await page.content();
  if (!html.includes('/logout/')) {
    throw new Error(
      'Screener login failed: no /logout/ link found after submitting credentials. ' +
        'Double-check SCREENER_EMAIL / SCREENER_PASSWORD.'
    );
  }
}

// Launch headless Chromium with the desktop UA, log in, and return the handles.
export async function launchLoggedIn(email, password) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: DESKTOP_UA });
  const page = await context.newPage();
  await login(page, email, password);
  return { browser, context, page };
}

// Navigate to `url` and wait for `waitFor` to appear. Retries a few times so a
// transient render failure isn't mistaken for a real condition (e.g. the end of
// a screen, or a company page that "has no ratios"). Returns the page HTML, or
// null if `waitFor` never appeared.
export async function gotoWithRetry(
  page,
  url,
  { waitFor, isFirst = false, firstTimeout = 20000, timeout = 12000, attempts = 3 } = {}
) {
  const limit = isFirst ? firstTimeout : timeout;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector(waitFor, { timeout: limit });
      return await page.content();
    } catch {
      if (attempt < attempts) {
        console.warn(`  retry  : '${waitFor}' not found on attempt ${attempt}/${attempts} for ${url}`);
        await sleep(1000 * attempt);
      }
    }
  }
  return null;
}
