import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('drops directly into a running local arena', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Dropzone Arena');
  await expect(page.getByRole('heading', { name: 'Drop Zone' })).toBeVisible();
  await expect(page.getByText(/No lobby between you and the yard/)).toBeVisible();
  await expect(page.getByRole('img', { name: /Top-down arena view/ })).toBeVisible();

  await page.getByRole('button', { name: 'Drop in' }).click();
  await expect(page.getByRole('region', { name: 'Run status' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.getByLabel('01:30 remaining')).toBeVisible();
  await expect(page.getByLabel('01:29 remaining')).toBeVisible({ timeout: 3_000 });
});

test('supports keyboard pause and a stable resume', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Drop in' }).click();

  await page.keyboard.down('w');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  await page.keyboard.up('w');
  await page.keyboard.press('p');

  await expect(page.getByRole('heading', { name: 'Run paused' })).toBeVisible();
  const pausedTime = await page
    .getByText(/^\d{2}:\d{2}$/)
    .first()
    .textContent();
  await page.getByRole('button', { name: 'Resume run' }).click();
  await expect(page.getByRole('heading', { name: 'Run paused' })).toBeHidden();
  await expect
    .poll(() =>
      page
        .getByText(/^\d{2}:\d{2}$/)
        .first()
        .textContent(),
    )
    .not.toBe(pausedTime);
});

test('keeps responsive controls and content inside the viewport', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Drop in' }).click();

  const isMobile = testInfo.project.name === 'mobile-chromium';
  const moveStick = page.getByRole('button', { name: 'Move stick' });
  if (isMobile) {
    await expect(moveStick).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Aim and fire stick' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dash' })).toBeVisible();
    await page.getByRole('button', { name: 'Dash' }).tap();
  } else {
    await expect(moveStick).toBeHidden();
  }

  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: globalThis.innerWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
});

test('honors reduced motion and has no serious accessibility findings', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.arena-app')).toHaveClass(/is-reduced-motion/);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const seriousFindings = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(seriousFindings).toEqual([]);
});

test('recovers control when the WebGL context is lost', async ({ page }) => {
  await page.goto('/');
  const canvas = page.getByRole('img', { name: /Top-down arena view/ });
  await expect(canvas).toBeVisible();

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
    page.getByRole('heading', { name: 'Renderer unavailable' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry renderer' }).click();
  await expect(page.getByRole('button', { name: 'Drop in' })).toBeVisible();
});
