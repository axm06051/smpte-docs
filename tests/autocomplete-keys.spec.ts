import { expect, test } from '@playwright/test';

test('autocomplete: arrows move the active option, Enter picks it, Escape closes', async ({
  page,
}) => {
  await page.goto('/');
  const q = page.locator('#q');
  await q.fill('2110');
  const items = page.locator('#acList .ac-item');
  await expect(items.first()).toBeVisible();

  await q.press('ArrowDown');
  await expect(items.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(q).toHaveAttribute('aria-activedescendant', 'ac-i-0');

  await q.press('ArrowDown');
  await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(items.nth(0)).toHaveAttribute('aria-selected', 'false');

  await q.press('ArrowUp');
  await q.press('ArrowUp'); // past the first option -> back to "nothing active"
  await expect(q).not.toHaveAttribute('aria-activedescendant', /.+/);

  await q.press('ArrowDown');
  const slug = await items.nth(0).getAttribute('data-slug');
  await q.press('Enter');
  await expect(q).toHaveValue(slug!);
  await expect(page.locator('#ac')).not.toHaveClass(/open/);

  await q.fill('mxf');
  await expect(page.locator('#ac')).toHaveClass(/open/);
  await q.press('Escape');
  await expect(page.locator('#ac')).not.toHaveClass(/open/);
  await q.press('ArrowDown'); // reopens
  await expect(page.locator('#ac')).toHaveClass(/open/);
});
