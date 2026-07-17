import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

const BASE_URL = 'http://localhost:4301';
const AUTHORITY_URL = 'http://localhost:4302';
const ONLINE_RUNTIME_CHUNK = /\/online-arena-runtime-[^/]+\.js(?:\?|$)/;

interface OnlineIdentity {
  readonly callsign: string;
  readonly deaths: string;
  readonly kills: string;
  readonly marker: string;
}

interface OnlinePlayer {
  readonly context: BrowserContext;
  readonly page: Page;
}

test(
  'keeps initial and local entry isolated from the online authority and runtime',
  { tag: '@desktop' },
  async ({ page }) => {
    const authorityRequests: string[] = [];
    const onlineRuntimeRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(AUTHORITY_URL)) {
        authorityRequests.push(request.url());
      }
      if (ONLINE_RUNTIME_CHUNK.test(request.url())) {
        onlineRuntimeRequests.push(request.url());
      }
    });

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Drop in' })).toBeVisible();
    expect(authorityRequests).toEqual([]);
    expect(onlineRuntimeRequests).toEqual([]);

    await page.getByRole('button', { name: 'Drop in' }).click();
    await expect(page.getByRole('region', { name: 'Run status' })).toBeVisible();
    await expect(page.getByLabel('01:29 remaining')).toBeVisible({ timeout: 3_000 });

    expect(authorityRequests).toEqual([]);
    expect(onlineRuntimeRequests).toEqual([]);
  },
);

test(
  'joins two anonymous players to one continuous field and updates the live menu roster',
  { tag: '@desktop' },
  async ({ browser, page }) => {
    test.setTimeout(120_000);
    await enterOnline(page);
    let second: OnlinePlayer | undefined;

    try {
      const initialIdentity = await readOnlineIdentity(page);
      const fieldMenuHeading = page.getByRole('heading', { name: 'Field menu' });
      await page.keyboard.press('p');
      await expect(fieldMenuHeading).toBeVisible();
      await expect(
        page.getByText(/shared arena remains live.*online play is not paused/i),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(fieldMenuHeading).toBeHidden();
      await openFieldMenu(page);

      second = await openOnlinePlayer(browser);
      await expectPopulation(page, 2);
      await expectPopulation(second.page, 2);

      const firstIdentity = await readOnlineIdentity(page);
      const secondIdentity = await readOnlineIdentity(second.page);
      expect(firstIdentity).toEqual(initialIdentity);
      expect(firstIdentity.callsign).not.toBe(secondIdentity.callsign);
      expect(firstIdentity.kills).toBe('0');
      expect(firstIdentity.deaths).toBe('0');
      expect(secondIdentity.kills).toBe('0');
      expect(secondIdentity.deaths).toBe('0');

      for (const playerPage of [page, second.page]) {
        const table = rosterTable(playerPage);
        await expect(table).toContainText(firstIdentity.callsign);
        await expect(table).toContainText(secondIdentity.callsign);
        await expect(table.getByRole('rowheader', { name: / You$/ })).toHaveCount(1);
        const markers = await table
          .getByRole('cell', { name: /^#\d+$/ })
          .allTextContents();
        expect(markers).toHaveLength(2);
        expect(new Set(markers).size).toBe(2);
        await expect(
          publicArenaStatus(playerPage).getByText('Continuous free-for-all', {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          publicArenaStatus(playerPage).getByText('No rounds / no winner', {
            exact: true,
          }),
        ).toBeVisible();
      }

      await leaveArena(second.page);
      await expectPopulation(page, 1);
      await expect(rosterTable(page)).not.toContainText(secondIdentity.callsign);
      await expect(fieldMenuHeading).toBeVisible();

      await page.bringToFront();
      await page.getByRole('button', { name: 'Return' }).click();
      await expect(fieldMenuHeading).toBeHidden();
      await page.keyboard.down('w');
      await expectConnected(page);
      await page.keyboard.press('Space');
      await page.keyboard.up('w');

      expect(await readOnlineIdentity(page)).toEqual(firstIdentity);
      await leaveArena(page);
    } finally {
      if (second) await closeOnlinePlayer(second);
      await leaveArena(page).catch(() => undefined);
    }
  },
);

test(
  'reconnects within grace with the same identity and a fresh shared state',
  { tag: '@desktop' },
  async ({ browser }) => {
    test.slow();
    const returning = await openOnlinePlayer(browser);
    const observer = await openOnlinePlayer(browser);

    try {
      await expectPopulation(returning.page, 2);
      await expectPopulation(observer.page, 2);
      const retainedIdentity = await readOnlineIdentity(returning.page);
      const observerIdentity = await readOnlineIdentity(observer.page);
      const resumedAdmissionRequests: string[] = [];
      returning.page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          request.url() === `${AUTHORITY_URL}/api/quickplay`
        ) {
          resumedAdmissionRequests.push(request.url());
        }
      });

      await openFieldMenu(observer.page);
      await returning.page.reload();
      await expect(
        returning.page.getByRole('button', { name: 'Public quickplay' }),
      ).toBeVisible();

      await returning.page.getByRole('button', { name: 'Public quickplay' }).click();
      await expectConnected(returning.page);
      await expectPopulation(returning.page, 2);
      expect(await readOnlineIdentity(returning.page)).toEqual(retainedIdentity);
      expect(resumedAdmissionRequests).toEqual([]);

      await observer.page.bringToFront();
      await observer.page.getByRole('button', { name: 'Leave arena' }).click();
      await returning.page.bringToFront();
      await expect(
        observer.page.getByRole('button', { name: 'Drop in' }),
      ).toBeVisible();
      await expectPopulation(returning.page, 1);
      await expect(rosterTable(returning.page)).not.toContainText(
        observerIdentity.callsign,
      );

      await leaveArena(returning.page);
    } finally {
      await closeOnlinePlayer(observer);
      await closeOnlinePlayer(returning);
    }
  },
);

test(
  'expires disconnected identity before offering fresh quickplay and local play',
  { tag: '@desktop' },
  async ({ browser }) => {
    test.slow();
    const expiring = await openOnlinePlayer(browser);
    const observer = await openOnlinePlayer(browser);

    try {
      await expectPopulation(expiring.page, 2);
      await expectPopulation(observer.page, 2);
      const expiredIdentity = await readOnlineIdentity(expiring.page);
      const observerIdentity = await readOnlineIdentity(observer.page);

      await expiring.page.reload();
      await expect(
        expiring.page.getByRole('button', { name: 'Drop in' }),
      ).toBeVisible();
      await expect(rosterTable(observer.page)).toContainText(expiredIdentity.callsign);
      await expectPopulation(observer.page, 1, 15_000);
      await expect(rosterTable(observer.page)).not.toContainText(
        expiredIdentity.callsign,
      );

      await expiring.page.getByRole('button', { name: 'Public quickplay' }).click();
      await expect(
        expiring.page.getByRole('heading', { name: 'Arena session expired' }),
      ).toBeVisible();
      await expect(
        expiring.page.getByText(/former callsign and session statistics are gone/i),
      ).toBeVisible();

      await expiring.page.getByRole('button', { name: 'Fresh quickplay' }).click();
      await expectConnected(expiring.page);
      await expectPopulation(expiring.page, 2);
      const freshIdentity = await readOnlineIdentity(expiring.page);
      expect(freshIdentity.callsign).not.toBe(observerIdentity.callsign);
      expect(freshIdentity.kills).toBe('0');
      expect(freshIdentity.deaths).toBe('0');

      await expiring.page.getByRole('button', { name: 'Field menu' }).click();
      await expiring.page.getByRole('button', { name: 'Play local' }).click();
      await expect(
        expiring.page.getByRole('region', { name: 'Run status' }),
      ).toBeVisible();
      await expect(expiring.page.getByLabel('01:30 remaining')).toBeVisible();
      await expectPopulation(observer.page, 1);

      await leaveArena(observer.page);
    } finally {
      await closeOnlinePlayer(observer);
      await closeOnlinePlayer(expiring);
    }
  },
);

test(
  'falls back to a fresh local run after aborted authority traffic and stops retrying',
  { tag: '@desktop' },
  async ({ page }) => {
    const authorityRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(AUTHORITY_URL)) {
        authorityRequests.push(request.url());
      }
    });
    await page.route(`${AUTHORITY_URL}/**`, (route) => route.abort('failed'));

    await page.goto('/');
    await page.getByRole('button', { name: 'Public quickplay' }).click();
    await expect(
      page.getByRole('heading', { name: 'Online service unavailable' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry online' })).toBeVisible();
    expect(authorityRequests.length).toBeGreaterThan(0);
    const requestsBeforeFallback = authorityRequests.length;

    await page.getByRole('button', { name: 'Play local' }).click();
    await expect(page.getByRole('region', { name: 'Run status' })).toBeVisible();
    await expect(page.getByLabel('01:29 remaining')).toBeVisible({ timeout: 3_000 });
    expect(authorityRequests).toHaveLength(requestsBeforeFallback);
  },
);

test(
  'recovers an online WebGL context loss from current authority within grace',
  { tag: '@desktop' },
  async ({ browser }) => {
    test.slow();
    const affected = await openOnlinePlayer(browser);
    const observer = await openOnlinePlayer(browser);

    try {
      await expectPopulation(affected.page, 2);
      const retainedIdentity = await readOnlineIdentity(affected.page);
      const canvas = affected.page.getByRole('img', { name: /Top-down arena view/ });
      const contextLossSupported = await canvas.evaluate((element) => {
        const canvasElement = element as HTMLCanvasElement;
        const context =
          canvasElement.getContext('webgl2') ?? canvasElement.getContext('webgl');
        const extension = context?.getExtension('WEBGL_lose_context');
        extension?.loseContext();
        return Boolean(extension);
      });
      expect(contextLossSupported).toBe(true);

      await expect(
        affected.page.getByRole('heading', { name: 'Online renderer unavailable' }),
      ).toBeVisible();
      await expect(
        affected.page.getByText(/shared arena remains live.*could not pause/i),
      ).toBeVisible();
      await expectPopulation(observer.page, 2);
      await expect(rosterTable(observer.page)).toContainText(retainedIdentity.callsign);

      await leaveArena(observer.page);
      await affected.page.getByRole('button', { name: 'Retry renderer' }).click();
      await expectConnected(affected.page);
      await expectPopulation(affected.page, 1);
      expect(await readOnlineIdentity(affected.page)).toEqual(retainedIdentity);
      await leaveArena(affected.page);
    } finally {
      await closeOnlinePlayer(observer);
      await closeOnlinePlayer(affected);
    }
  },
);

test(
  'honors reduced motion and passes ready, connected, and field-menu axe checks',
  { tag: '@desktop' },
  async ({ page }) => {
    test.slow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('.arena-app')).toHaveClass(/is-reduced-motion/);
    await expectNoSeriousAxeFindings(page);

    await page.getByRole('button', { name: 'Public quickplay' }).click();
    await expectConnected(page);
    await expect(page.locator('.arena-app')).toHaveClass(/is-reduced-motion/);
    await expectNoSeriousAxeFindings(page);

    await page.getByRole('button', { name: 'Field menu' }).click();
    await expect(page.getByRole('heading', { name: 'Field menu' })).toBeVisible();
    await expectNoSeriousAxeFindings(page);
    await leaveArena(page);
  },
);

test(
  'supports online touch controls and accessible disclosure at 320 CSS pixels',
  { tag: '@mobile' },
  async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Public quickplay' }).click();
    await expectConnected(page);

    const move = page.getByRole('button', { name: 'Move stick' });
    const aim = page.getByRole('button', { name: 'Aim and fire stick' });
    const dash = page.getByRole('button', { name: 'Dash' });
    const fieldMenu = page.getByRole('button', { name: 'Field menu' });
    const rosterGroup = publicArenaStatus(page)
      .getByRole('group')
      .filter({ hasText: 'Field roster' });
    const disclosure = rosterGroup
      .getByText('Field roster', { exact: true })
      .locator('..');
    await expect(rosterGroup).toBeVisible();
    expect(
      await disclosure.evaluate((element) => ({
        tagName: element.tagName,
        tabIndex: (element as HTMLElement).tabIndex,
      })),
    ).toEqual({ tagName: 'SUMMARY', tabIndex: 0 });
    for (const action of [move, aim, dash, fieldMenu, disclosure]) {
      await expectEssentialActionBounds(action, 320, 640);
    }

    await move.tap({ position: { x: 80, y: 52 } });
    await aim.tap({ position: { x: 24, y: 52 } });
    await dash.tap();
    await expectConnected(page);

    await disclosure.click();
    await expect(rosterTable(page)).toBeHidden();
    await disclosure.press('Enter');
    await expect(rosterTable(page)).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      scrollX: globalThis.scrollX,
      viewportWidth: globalThis.innerWidth,
    }));
    expect(dimensions.viewportWidth).toBe(320);
    expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(dimensions.scrollX).toBe(0);

    await fieldMenu.click();
    await expect(page.getByRole('heading', { name: 'Field menu' })).toBeVisible();
    await page.getByRole('button', { name: 'Leave arena' }).click();
    await expect(page.getByRole('button', { name: 'Drop in' })).toBeVisible();
  },
);

async function openOnlinePlayer(browser: Browser): Promise<OnlinePlayer> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  await enterOnline(page);
  return { context, page };
}

async function enterOnline(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Public quickplay' }).click();
  await expectConnected(page);
}

async function closeOnlinePlayer(player: OnlinePlayer): Promise<void> {
  if (!player.page.isClosed()) await leaveArena(player.page).catch(() => undefined);
  await player.context.close().catch(() => undefined);
}

async function leaveArena(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.bringToFront();
  const menuHeading = page.getByRole('heading', { name: 'Field menu' });
  const leave = page.getByRole('button', { name: 'Leave arena' });
  if (!(await leave.isVisible().catch(() => false))) {
    const menu = page.getByRole('button', { name: 'Field menu' });
    if (!(await menu.isVisible().catch(() => false))) return;
    await openFieldMenu(page);
  }
  await expect(menuHeading).toBeVisible({ timeout: 5_000 });
  await leave.click({ noWaitAfter: true, timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Drop in' })).toBeVisible();
}

async function openFieldMenu(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Field menu' });
  const button = page.getByRole('button', { name: 'Field menu' });
  if (await heading.isVisible()) return;
  await expect(button).toBeVisible();
  await button.click();
  await expect(heading).toBeVisible();
}

function publicArenaStatus(page: Page): Locator {
  return page.getByRole('region', { name: 'Public arena status' });
}

function rosterTable(page: Page): Locator {
  return page.getByRole('table', { name: 'Public free-for-all roster' });
}

async function expectConnected(page: Page): Promise<void> {
  const status = publicArenaStatus(page);
  await expect(status).toBeVisible({ timeout: 10_000 });
  await expect(status.getByText('Stable', { exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

async function expectPopulation(
  page: Page,
  population: number,
  timeout = 10_000,
): Promise<void> {
  await expect(
    publicArenaStatus(page).getByText(`${population} / 8`, { exact: true }),
  ).toBeVisible({ timeout });
}

async function readOnlineIdentity(page: Page): Promise<OnlineIdentity> {
  const status = publicArenaStatus(page);
  const callsign = await status
    .getByText('Generated callsign', { exact: true })
    .locator('..')
    .locator('strong')
    .textContent();
  const statistics = await status
    .getByLabel('Session statistics')
    .getByRole('definition')
    .allTextContents();
  const marker = await status.getByLabel(/^Player marker \d+$/).textContent();
  expect(callsign).not.toBe('');
  expect(statistics).toHaveLength(2);
  return {
    callsign: callsign?.trim() ?? '',
    deaths: statistics[1]?.trim() ?? '',
    kills: statistics[0]?.trim() ?? '',
    marker: marker?.trim() ?? '',
  };
}

async function expectNoSeriousAxeFindings(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const seriousFindings = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(seriousFindings).toEqual([]);
}

async function expectEssentialActionBounds(
  action: Locator,
  viewportWidth: number,
  viewportHeight: number,
): Promise<void> {
  await expect(action).toBeVisible();
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewportWidth);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewportHeight);
}
