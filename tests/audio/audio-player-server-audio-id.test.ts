import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fork. Narration generated in the browser is now stored through upstream's
 * classroom-media byte path, and its `audioId` IS the served reference
 * (`/api/classroom-media/...`), exactly as the agent runtime's scene TTS
 * stamps it. The generating browser still has the bytes locally; any other
 * browser -- a learner on a published course -- has none, and must play the
 * reference itself. A legacy id with no bytes and no URL stays silent.
 */

const mocks = vi.hoisted(() => ({
  resolveAudioBlob: vi.fn(async (..._args: unknown[]) => null),
  createObjectURL: vi.fn(() => 'blob:played'),
  revokeObjectURL: vi.fn(),
}));

vi.mock('@/lib/media/resolve-audio-bytes', () => ({
  resolveAudioBlob: (...args: unknown[]) => mocks.resolveAudioBlob(...args),
}));

function stubBrowser(fetchImpl: typeof globalThis.fetch) {
  class URLStub extends URL {}
  Object.assign(URLStub, {
    createObjectURL: mocks.createObjectURL,
    revokeObjectURL: mocks.revokeObjectURL,
  });
  vi.stubGlobal('URL', URLStub);
  class AudioStub {
    play = () => Promise.resolve();
    addEventListener = vi.fn();
    pause = vi.fn();
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    src = '';
    currentTime = 0;
  }
  vi.stubGlobal('Audio', AudioStub);
  vi.stubGlobal('fetch', fetchImpl);
}

describe('AudioPlayer plays a server-stored narration reference', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('fetches the classroom-media reference when this browser has no bytes', async () => {
    const ref = '/api/classroom-media/stage-1/media/tts-a1-0123.mp3';
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
        }) as unknown as Response,
    );
    stubBrowser(fetchImpl as unknown as typeof globalThis.fetch);
    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    await expect(new AudioPlayer().play(ref)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(ref);
  });

  it('stays silent for a legacy id with no bytes and no URL', async () => {
    const fetchImpl = vi.fn();
    stubBrowser(fetchImpl as unknown as typeof globalThis.fetch);
    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    await expect(new AudioPlayer().play('tts_s0_a1')).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
