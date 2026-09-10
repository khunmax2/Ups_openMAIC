import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiPath } from '@/lib/base-path';

/**
 * Media references are written into the scene document and later handed to the
 * browser as a `src`. `lib/server/media-origin.ts` calls them
 * origin-independent, and they are — but a base path is not an origin, and a
 * bare `/api/...` resolves against the root, which on a shared host is another
 * team's API rather than a 404.
 *
 * These pin the decision that the prefix goes on at WRITE time. The renderer
 * lives in `@openmaic/renderer`, published on its own, and teaching it about
 * this app's base path would point the wrong way.
 */
describe('media references carry the base path', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is unchanged when the app is served at the root', () => {
    expect(apiPath('/api/classroom-media/stage-1/media/a.png')).toBe(
      '/api/classroom-media/stage-1/media/a.png',
    );
  });

  it('is prefixed when the app is served under a path', () => {
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/deepwitya/studio');
    expect(apiPath('/api/classroom-media/stage-1/media/a.png')).toBe(
      '/deepwitya/studio/api/classroom-media/stage-1/media/a.png',
    );
  });
});

/**
 * The cost of writing the prefix in: a stored reference now carries the
 * deployment's base path, so the check that decides "did we generate this, or
 * is it the learner's own pick" has to recognise both shapes. Getting that
 * wrong does not 404 — it silently starts treating our own past output as
 * something to preserve, and generation stops replacing it.
 */
describe('recognising our own generated references', () => {
  afterEach(() => vi.unstubAllEnvs());

  // The predicate as generate-video.ts builds it.
  function replaceable(value: string, stageId: string): boolean {
    const suffix = `/api/classroom-media/${stageId}/`;
    const prefixes = [apiPath(suffix), suffix];
    if (prefixes.some((p) => value.startsWith(p))) return true;
    try {
      const { pathname } = new URL(value);
      return prefixes.some((p) => pathname.startsWith(p));
    } catch {
      return false;
    }
  }

  it('recognises a row written before the base path landed', () => {
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/deepwitya/studio');
    expect(replaceable('/api/classroom-media/stage-1/media/old.mp4', 'stage-1')).toBe(true);
  });

  it('recognises a row written after it', () => {
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/deepwitya/studio');
    expect(
      replaceable('/deepwitya/studio/api/classroom-media/stage-1/media/new.mp4', 'stage-1'),
    ).toBe(true);
  });

  it('recognises the absolute form the classic pipeline persists', () => {
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/deepwitya/studio');
    expect(
      replaceable(
        'https://host/deepwitya/studio/api/classroom-media/stage-1/media/x.mp4',
        'stage-1',
      ),
    ).toBe(true);
  });

  it("still leaves another stage's media alone", () => {
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/deepwitya/studio');
    expect(
      replaceable('/deepwitya/studio/api/classroom-media/stage-2/media/x.mp4', 'stage-1'),
    ).toBe(false);
  });

  it("still leaves the learner's own pick alone", () => {
    vi.stubEnv('NEXT_PUBLIC_STUDIO_BASE_PATH', '/deepwitya/studio');
    expect(replaceable('https://cdn.example/video.mp4', 'stage-1')).toBe(false);
  });
});
