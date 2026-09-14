import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fork. Found in the 2026-09-15 review: the edit timeline decides whether a
 * line is voiced by looking in this browser's IndexedDB, so in any other
 * browser every line whose clip is on the server read as "not voiced" and its
 * preview would not play.
 */

vi.mock('@/lib/hooks/use-scene-generator', () => ({ generateAndStoreTTS: vi.fn() }));
vi.mock('@/lib/media/collect-stage-asset-refs', () => ({
  proveExclusiveAssetOwnership: vi.fn(),
}));
vi.mock('@/lib/media/use-asset-url', () => ({
  assetRefExists: vi.fn(async () => false),
  withAssetUrl: async (_ref: string, consume: (url: string | null) => unknown) => consume(null),
}));
vi.mock('@/lib/utils/database', () => ({
  db: {
    audioFiles: {
      get: vi.fn(async () => undefined),
      bulkGet: vi.fn(async (ids: string[]) => ids.map(() => undefined)),
      bulkDelete: vi.fn(),
    },
  },
}));
vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: () => ({}) } }));
vi.mock('@/lib/store/stage', () => ({ useStageStore: { getState: () => ({ stage: null }) } }));

import { audioExists, audioExistsBulk, audioObjectUrl } from '@/lib/audio/regenerate-speech-tts';

const CLIP = '/api/classroom-media/s1/media/tts-def.mp3';

describe('a line voiced on the server', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === CLIP
          ? new Response(new Blob(['mp3'], { type: 'audio/mpeg' }), { status: 200 })
          : new Response('missing', { status: 404 }),
      ),
    );
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:clip'), revokeObjectURL: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('counts as voiced in any browser', async () => {
    await expect(audioExists(CLIP)).resolves.toBe(true);
    await expect(audioExists('tts_s1_a1')).resolves.toBe(false);
    expect([...(await audioExistsBulk([CLIP, 'tts_s1_a1']))]).toEqual([CLIP]);
  });

  it('previews from the server', async () => {
    await expect(audioObjectUrl(CLIP)).resolves.toBe('blob:clip');
  });
});
