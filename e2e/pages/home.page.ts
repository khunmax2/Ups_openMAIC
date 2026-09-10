import type { Page, Locator } from '@playwright/test';

import { DEFAULT_BRAND } from '@/lib/brand/brand-config';

export class HomePage {
  readonly page: Page;
  readonly logo: Locator;
  readonly textarea: Locator;
  readonly enterButton: Locator;

  constructor(page: Page) {
    this.page = page;
    // The brand, not a literal. This pinned `alt="OpenMAIC"` and went red the
    // moment the fork changed the product name -- the same failure the unit
    // test for DEFAULT_BRAND had, in a place nobody thinks to look when
    // de-branding. Reading the config means the assertion follows a rebrand
    // instead of being a second place to remember.
    this.logo = page.locator(`img[alt="${DEFAULT_BRAND.productName}"]`);
    this.textarea = page.locator('textarea');
    this.enterButton = page
      .getByRole('button', { name: /enter/i })
      .or(page.locator('button:has-text("进入课堂")'));
  }

  async goto() {
    await this.page.goto('/');
  }

  async fillRequirement(text: string) {
    await this.textarea.fill(text);
  }

  async submit() {
    await this.enterButton.click();
  }
}
