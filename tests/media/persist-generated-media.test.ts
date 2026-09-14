import { describe, expect, it, vi } from 'vitest';

/**
 * Fork. Browser-generated media follows upstream's byte model: the bytes go to
 * the server's classroom-media directory (`persistClassroomMediaBytes`, the
 * same path the agent runtime writes) and the document carries the returned
 * `/api/classroom-media/...` reference, so a course's images and narration
 * survive a new browser and reach a published course's learners. Best-effort
 * by contract: an upload failure never fails generation; the IndexedDB copy
 * stays the fallback.
 */

import { audioMimeForFormat, uploadGeneratedMedia } from '@/lib/media/persist-generated-media';

const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
const URL_REF = '/api/classroom-media/stage-1/media/generated-abc.png';

describe('uploadGeneratedMedia', () => {
  it("posts the bytes to the owner's course and returns the server reference", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ url: URL_REF }, { status: 201 }));
    await expect(
      uploadGeneratedMedia({
        stageId: 'stage-1',
        blob,
        mime: 'image/png',
        prefix: 'generated',
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
        enabled: true,
      }),
    ).resolves.toBe(URL_REF);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/stages/stage-1/media');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: blob });
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('image/png');
    expect(headers.get('x-media-prefix')).toBe('generated');
  });

  it('returns nothing, and does not throw, when the server refuses or is unreachable', async () => {
    const refused = vi.fn(async () => new Response('', { status: 403 }));
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    for (const fetchImpl of [refused, offline]) {
      await expect(
        uploadGeneratedMedia({
          stageId: 'stage-1',
          blob,
          mime: 'image/png',
          fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
          enabled: true,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('sends nothing when the studio has no server persistence', async () => {
    const fetchImpl = vi.fn();
    await expect(
      uploadGeneratedMedia({
        stageId: 'stage-1',
        blob,
        mime: 'image/png',
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
        enabled: false,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('audioMimeForFormat', () => {
  it.each([
    ['mp3', 'audio/mpeg'],
    ['wav', 'audio/wav'],
    ['ogg', 'audio/ogg'],
  ])('maps %s to %s', (format, mime) => {
    expect(audioMimeForFormat(format)).toBe(mime);
  });

  it('has no server mime for a format the byte route does not store', () => {
    expect(audioMimeForFormat('pcm')).toBeUndefined();
  });
});
