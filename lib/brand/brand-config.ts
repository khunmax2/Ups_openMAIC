/**
 * Brand configuration.
 *
 * One source of truth for the product name and logo, read by every surface that
 * shows either: the home hero, the classroom sidebar, the workspace rail and
 * home, the slide editor rail, the access-code gate and the page title.
 *
 * The shape is upstream's, which resolves a brand per vendor from a desktop
 * shell's User-Agent token. This deployment has no vendor shell, so the values
 * are static — but they are read from the environment first, so the product can
 * be re-branded without touching source. That is also what keeps this fork's
 * diff to a set of defaults rather than a substitution across every surface,
 * which is the shape upstream could take back.
 *
 * `NEXT_PUBLIC_*` is inlined by Next at build time, so changing one of these
 * needs a rebuild, not a restart.
 */

export interface BrandConfig {
  /** Full product name (page titles, logo alt text). */
  productName: string;
  /** Short name for space-constrained spots. */
  shortName: string;
  /** Horizontal logo asset under `public/`. */
  logoSrc: string;
  /** Whether `logoSrc` already carries the product wordmark. */
  logoHasWordmark: boolean;
  /** Square brand mark under `public/` (favicon, workspace header). */
  markSrc: string;
  /** Browser theme color (`<meta name="theme-color">` / PWA). */
  themeColor: string;
  /** One-line descriptor under the home logo, and the page description. */
  tagline: string;
}

const name = process.env.NEXT_PUBLIC_BRAND_NAME?.trim() || 'DeepWitya';

/** The default brand: the host product, with no vendor overrides. */
export const DEFAULT_BRAND: BrandConfig = {
  productName: name,
  shortName: process.env.NEXT_PUBLIC_BRAND_SHORT_NAME?.trim() || name,
  logoSrc: process.env.NEXT_PUBLIC_BRAND_LOGO?.trim() || '/brand-wordmark.png',
  logoHasWordmark: true,
  markSrc: process.env.NEXT_PUBLIC_BRAND_MARK?.trim() || '/brand-mark.png',
  themeColor: process.env.NEXT_PUBLIC_BRAND_THEME_COLOR?.trim() || '#b0501e',
  tagline: process.env.NEXT_PUBLIC_BRAND_TAGLINE?.trim() || 'Agent-Native Learning',
};
