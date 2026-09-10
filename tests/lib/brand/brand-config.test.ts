import { describe, expect, it } from 'vitest';

import { DEFAULT_BRAND } from '@/lib/brand/brand-config';

/**
 * This file asserted the upstream identity — `OpenMAIC`, `/openmaic-mark.png`,
 * `#722ed1` — which is exactly what the fork replaces. Left alone it would have
 * been red from the de-branding change onward, guarding nothing while looking
 * like a failure. It asserts what this build actually ships instead.
 *
 * The values come from the environment with defaults, so what is pinned here is
 * the default: an image built without `NEXT_PUBLIC_BRAND_*` still carries the
 * host product's identity rather than falling back to upstream's.
 */
describe('DEFAULT_BRAND (single-brand build)', () => {
  it('ships the host product identity, not the upstream one', () => {
    expect(DEFAULT_BRAND.productName).toBe('DeepWitya');
    expect(DEFAULT_BRAND.shortName).toBe('DeepWitya');
    expect(DEFAULT_BRAND.markSrc).toBe('/brand-mark.png');
    expect(DEFAULT_BRAND.themeColor).toBe('#b0501e');
  });

  it('marks its horizontal logo as already containing the wordmark', () => {
    expect(DEFAULT_BRAND.logoHasWordmark).toBe(true);
    expect(DEFAULT_BRAND.logoSrc).toBe('/brand-wordmark.png');
  });

  it('carries a tagline for the home hero', () => {
    // Upstream renders `home.slogan` from the locale files there, which is the
    // upstream product's own strapline in every language including the ones
    // this fork adds. The brand owns this string now.
    expect(DEFAULT_BRAND.tagline).toBeTruthy();
    expect(DEFAULT_BRAND.tagline).not.toMatch(/OpenMAIC/i);
  });

  it('names nothing after the upstream product', () => {
    // A single assertion that catches a default someone forgets to change --
    // the failure mode the de-branding exists to prevent is a surface that
    // still says the vendor's name, not one that crashes.
    for (const value of Object.values(DEFAULT_BRAND)) {
      if (typeof value === 'string') expect(value).not.toMatch(/openmaic/i);
    }
  });
});
