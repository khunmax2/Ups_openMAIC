import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiPath, basePath } from '@/lib/base-path';

describe('apiPath', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('changes nothing when the app is served at the root', () => {
    // Upstream's own deployment, which must pay nothing for this.
    expect(apiPath('/api/stages')).toBe('/api/stages');
    expect(basePath()).toBe('');
  });

  it('prefixes an absolute path when a base path is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/course-studio');
    expect(apiPath('/api/stages')).toBe('/course-studio/api/stages');
  });

  it('is idempotent', () => {
    // Load-bearing: a call site prefixes a path and a helper it flows through
    // prefixes it again. Without this, the second application produces
    // /course-studio/course-studio/api/... — a 404 that reads like a routing
    // bug and is in fact a double prefix.
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/course-studio');
    const once = apiPath('/api/stages');
    expect(apiPath(once)).toBe(once);
    expect(apiPath(apiPath(apiPath('/api/stages')))).toBe('/course-studio/api/stages');
  });

  it('does not mistake a longer sibling path for an already-prefixed one', () => {
    // `/course-studio-admin` starts with the base path as a string but is not
    // under it, so it must still be prefixed. Comparing on the string alone
    // would silently send it somewhere else.
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/course-studio');
    expect(apiPath('/course-studio-admin/api/x')).toBe('/course-studio/course-studio-admin/api/x');
  });

  it('leaves a path that is not absolute alone', () => {
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/course-studio');
    expect(apiPath('api/stages')).toBe('api/stages');
    expect(apiPath('https://elsewhere.example/api/stages')).toBe(
      'https://elsewhere.example/api/stages',
    );
  });

  it('tolerates a trailing slash in the configured value', () => {
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/course-studio/');
    expect(apiPath('/api/stages')).toBe('/course-studio/api/stages');
  });
});

/**
 * The guard. 71 call sites were converted at once; without something that
 * fails, they come back one at a time — and a single bare `fetch('/api/...')`
 * on a shared host is a request sent to another team's API, not a 404 anyone
 * would notice in review.
 */
describe('no bare same-origin request paths', () => {
  const ROOTS = ['app', 'lib', 'components', 'hooks'];
  const ALLOWED = new Set([
    'lib/base-path.ts',
    // The pbl/v2 endpoint is a union of path literals typed at the declaration
    // and consumed once, and wrapping each literal would retype the union. They
    // are wrapped at that single call instead -- which no regex can see, so the
    // exemption is paired with the assertion below that the wrap is still there.
    'components/scene-renderers/pbl/v2/chat.tsx',
    'components/scene-renderers/pbl/v2/use-instructor-stream.ts',
  ]);
  // `fetch(` or `new EventSource(` followed by a string literal starting with
  // `/`, without apiPath() in between.
  // The backtick is written as an escape so this file never contains a
  // stray one: the pattern is read by tools that lex before they parse.
  // Three shapes, because `fetch(` was never the whole surface. The first
  // pass matched only that one and reported a clean tree while the
  // persistence layer was still addressing the origin root through a
  // `baseUrl:`.
  //
  // What no static rule can catch is `fetch(someVariable)`. Where a URL
  // travels as a variable it is wrapped at the call rather than at the
  // declaration -- see use-instructor-stream.ts, whose endpoint is a union
  // of literals that wrapping individually would retype.
  const BARE = [
    /(?<![\w$.])(?:fetch|new EventSource)\(\s*['"\x60]\//gu,
    // Narrowed to /api/ deliberately: every route this app serves lives there,
    // while `endpoint: '/v1/audio/speech'` is a path on a provider's base URL
    // and prefixing it would send the request to this origin instead.
    /(?:baseUrl|endpoint|url)\s*:\s*['"\x60]\/api\//gu,
    /create(?:EventSource|Source)\(\s*['"\x60]\//gu,
    // A static file under public/ rendered with a literal src. Next serves
    // public/ under the base path, but does not rewrite a src the app writes,
    // so a bare one asks the origin root -- 126 requests for /logos/*.svg
    // answered 404 on the first run, and a broken image reports nothing.
    /<(?:img|Image|motion\.img)\b[^>]{0,200}?\bsrc=['"]\//gu,
    // The same element with a src that travels as a VARIABLE. The literal
    // pattern above reported a clean tree while `<AvatarImage src={avatar}>`
    // was asking the origin root for /avatars/clown.png (the model picks the
    // path from a list) and `<img src={provider.icon}>` for /logos/*.svg --
    // every avatar and every provider logo in the product, 404. assetPath()
    // is idempotent and leaves a non-absolute value alone, so wrapping is
    // always safe; a bare `src={x}` on these tags is therefore always wrong.
    // AvatarImage prefixes internally now; the primitive it wraps is listed
    // so a raw use of it is caught too. Iframes are not media and are left out.
    /<(?:img|motion\.img|video|source|AvatarPrimitive\.Image)\b[^>]{0,400}?\bsrc=\{(?!\s*(?:assetPath|apiPath)\(|\s*typeof )/gu,
  ];

  /**
   * One recursive directory walk, and no `statSync` per entry.
   *
   * The first version recursed by hand and stat'd everything it found. Reading
   * every source file in four roots is this test's whole job, but doing it that
   * way cost enough — under a full-suite run, beside 680 other files — to push
   * timeout-sensitive tests elsewhere over the edge: the suite failed 81 and 87
   * on two runs of the same tree against a 74-78 baseline, and excluding this
   * one file brought it back to 75. The scan itself was never wrong; it was
   * just expensive enough to be somebody else's problem.
   */
  function sources(dir: string): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir, { recursive: true, encoding: 'utf8' });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => /\.tsx?$/u.test(entry) && !entry.includes('node_modules'))
      .map((entry) => join(dir, entry));
  }

  it('every fetch and EventSource goes through apiPath()', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sources(root)) {
        const rel = file.split(sep).join('/');
        if (ALLOWED.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        for (const pattern of BARE) {
          for (const match of text.matchAll(pattern)) {
            const line = text.slice(0, match.index).split('\n').length;
            offenders.push(`${rel}:${line}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the exempted union wrapped at its single point of use', () => {
    // The exemption above is only safe while this holds. If the wrap is removed
    // the eleven literals it covers go back to addressing the origin root, and
    // nothing else in this file would notice.
    const consumer = readFileSync(
      join('components', 'scene-renderers', 'pbl', 'v2', 'use-instructor-stream.ts'),
      'utf8',
    );
    expect(consumer).toContain('fetch(apiPath(endpoint)');
  });

  it('would notice one that slipped back in', () => {
    // Proves the pattern above matches what it claims to, so an empty result
    // means "none found" rather than "the regex never matched anything".
    const hits = (text: string) => BARE.flatMap((p) => [...text.matchAll(p)]).length;
    expect(hits("const res = await fetch('/api/stages');")).toBe(1);
    expect(hits("new HttpDocumentStore({ baseUrl: '/api/persistence' })")).toBe(1);
    expect(hits("createEventSource('/api/agent/owner-events')")).toBe(1);
    expect(hits("run({ endpoint: '/api/pbl/v2/simulator' })")).toBe(1);
    expect(hits("await fetch(apiPath('/api/stages'))")).toBe(0);
    expect(hits("baseUrl: apiPath('/api/persistence')")).toBe(0);
    expect(hits("await prefetch('/api/x')")).toBe(0);
    expect(hits('<img src="/logo-horizontal.png" alt="" />')).toBe(1);
    // framer-motion's element is a different tag name and slipped the first
    // version of this pattern -- it was the hero logo, the most visible image
    // in the product.
    expect(hits('<motion.img src="/logo-horizontal.png" alt="" />')).toBe(1);
    expect(hits('<img src={assetPath(brand.logoSrc)} alt="" />')).toBe(0);
    expect(hits('<img src={agent.avatar} alt="" />')).toBe(1);
    expect(hits('<video className="x"\n  src={resolvedSrc}\n/>')).toBe(1);
    expect(hits('<AvatarPrimitive.Image src={src} />')).toBe(1);
    expect(
      hits('<AvatarPrimitive.Image src={typeof src === "string" ? assetPath(src) : src} />'),
    ).toBe(0);
    expect(hits('<video src={assetPath(resolvedSrc)} />')).toBe(0);
    expect(hits('<iframe src={entry.src} />')).toBe(0);
  });
});
