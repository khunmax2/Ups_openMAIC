import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetManifestEntry } from '@openmaic/dsl';

/**
 * Fork. Found in the 2026-09-15 review: once a course's media lives on the
 * server, every reader that looked only in this browser's IndexedDB came up
 * empty in any other browser -- the home thumbnail, and the ZIP/PPTX/video
 * exports. These are the shared pieces those readers now use: a served copy is
 * fetched only when this browser holds no bytes of its own, and only where the
 * caller asks for it (playback and the editor's status checks do not download
 * clips).
 */

const mocks = vi.hoisted(() => ({
  audioRows: new Map<string, unknown>(),
  mediaRows: new Map<string, unknown>(),
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    audioFiles: { get: vi.fn(async (id: string) => mocks.audioRows.get(id)) },
    mediaFiles: { get: vi.fn(async (key: string) => mocks.mediaRows.get(key)) },
  },
}));

vi.mock('@/lib/media/use-asset-url', () => ({
  withAssetUrl: async (_ref: string, consume: (url: string | null) => unknown) => consume(null),
  assetRefExists: async () => false,
}));

import {
  applyServedImageSources,
  fetchServedBytes,
  isServedMediaReference,
} from '@/lib/media/stage-media-assets';
import { resolveAudioBlob } from '@/lib/media/resolve-audio-bytes';
import { resolveStoredBytes } from '@/lib/media/resolve-stored-bytes';
import { collectAudioFiles, collectMediaFiles } from '@/lib/export/classroom-zip-utils';
import { useMediaGenerationStore } from '@/lib/store/media-generation';

const IMAGE = '/api/classroom-media/s1/media/generated-abc.png';
const CLIP = '/api/classroom-media/s1/media/tts-def.wav';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.audioRows.clear();
  mocks.mediaRows.clear();
  useMediaGenerationStore.setState({ tasks: {} });
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === IMAGE) {
      return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });
    }
    if (String(input) === CLIP) {
      return new Response(new Blob(['wav'], { type: 'audio/wav' }), { status: 200 });
    }
    return new Response('missing', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('served-copy helpers', () => {
  it('recognises a served reference', () => {
    expect(isServedMediaReference(IMAGE)).toBe(true);
    expect(isServedMediaReference('https://cdn.example/x.png')).toBe(true);
    expect(isServedMediaReference('gen_img_1')).toBe(false);
    expect(isServedMediaReference('tts_s1_a1')).toBe(false);
    expect(isServedMediaReference(undefined)).toBe(false);
  });

  it('fetches the bytes behind one, and answers null when there are none', async () => {
    expect((await fetchServedBytes(IMAGE))?.type).toBe('image/png');
    await expect(fetchServedBytes('/api/classroom-media/s1/media/gone.png')).resolves.toBeNull();
  });

  it('points recorded image placeholders at their served copies', () => {
    const slide = {
      elements: [
        { type: 'image', src: 'gen_img_1' },
        { type: 'image', src: 'gen_img_2' },
        { type: 'text', content: 'hi' },
      ],
    };
    applyServedImageSources(slide, { gen_img_1: IMAGE });
    expect(slide.elements[0]).toMatchObject({ src: IMAGE });
    expect(slide.elements[1]).toMatchObject({ src: 'gen_img_2' });
  });
});

describe('narration from the server', () => {
  it('is not downloaded unless the caller asks for it', async () => {
    await expect(resolveAudioBlob(CLIP)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is fetched for a caller that asks, when this browser holds no copy', async () => {
    expect((await resolveAudioBlob(CLIP, { fetchServed: true }))?.type).toBe('audio/wav');
  });

  it("prefers this browser's own copy", async () => {
    mocks.audioRows.set(CLIP, { id: CLIP, blob: new Blob(['local'], { type: 'audio/wav' }) });
    const blob = await resolveAudioBlob(CLIP, { fetchServed: true });
    expect(await blob?.text()).toBe('local');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reaches the classroom ZIP, named after the served file', async () => {
    const collected = await collectAudioFiles([{ ref: CLIP, kind: 'audio' } as AssetManifestEntry]);
    expect(collected).toHaveLength(1);
    expect(collected[0]!.zipPath).toMatch(/\.wav$/u);
  });
});

describe('images from the server', () => {
  const options = {
    stageId: 's1',
    loadCompatRow: true,
    fetchPolicy: { requireOk: true, requireNonEmpty: true },
  } as const;

  it("resolve through the course's served copy when this browser has none", async () => {
    const blob = await resolveStoredBytes('gen_img_1', {
      ...options,
      servedCopies: { gen_img_1: IMAGE },
    });
    expect(blob?.type).toBe('image/png');
  });

  it('resolve to nothing without the map, as before', async () => {
    await expect(resolveStoredBytes('gen_img_1', options)).resolves.toBeNull();
  });

  it('reach the classroom ZIP', async () => {
    const collected = await collectMediaFiles(
      's1',
      [{ ref: 'gen_img_1', kind: 'image' } as AssetManifestEntry],
      { gen_img_1: IMAGE },
    );
    expect(collected).toHaveLength(1);
    expect(collected[0]!.record.blob.size).toBeGreaterThan(0);
  });
});
