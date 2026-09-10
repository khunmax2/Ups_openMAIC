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
  const ALLOWED = new Set(['lib/base-path.ts']);
  // `fetch(` or `new EventSource(` followed by a string literal starting with
  // `/`, without apiPath() in between.
  // The backtick is written as an escape so this file never contains a
  // stray one: the pattern is read by tools that lex before they parse.
  const BARE = /(?<![\w$.])(?:fetch|new EventSource)\(\s*['"\x60]\//gu;

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
        for (const match of text.matchAll(BARE)) {
          const line = text.slice(0, match.index).split('\n').length;
          offenders.push(`${rel}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('would notice one that slipped back in', () => {
    // Proves the pattern above matches what it claims to, so an empty result
    // means "none found" rather than "the regex never matched anything".
    const sample = "const res = await fetch('/api/stages', { method: 'GET' });";
    expect([...sample.matchAll(BARE)]).toHaveLength(1);
    expect([..."await fetch(apiPath('/api/stages'))".matchAll(BARE)]).toHaveLength(0);
    expect([..."await prefetch('/api/x')".matchAll(BARE)]).toHaveLength(0);
  });
});
