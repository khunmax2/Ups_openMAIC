import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateTTS } from '@/lib/audio/tts-providers';
import type { TTSProviderId } from '@/lib/audio/types';

/**
 * Fork. A custom TTS provider is OpenAI-compatible but not OpenAI: it has no
 * built-in endpoint, so without a base URL it must refuse rather than fall
 * back to OpenAI's. Found 2026-09-12: a custom provider's key stored without
 * its URL (the server pairs a stored key only with the stored URL, audit F2)
 * reached api.openai.com and came back as "Incorrect API key provided".
 */
const CUSTOM = 'custom-tts-mine' as TTSProviderId;

describe('a custom TTS provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('without a base URL refuses before any request leaves', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      generateTTS(
        { providerId: CUSTOM, modelId: 'tts-1', voice: 'ped', apiKey: 'theia-key', baseUrl: '' },
        'hello',
      ),
    ).rejects.toThrow(/requires a base URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with a base URL sends to that endpoint, and only there', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await generateTTS(
      {
        providerId: CUSTOM,
        modelId: 'tts-1',
        voice: 'ped',
        apiKey: 'theia-key',
        baseUrl: 'http://tts.internal/v1',
      },
      'hello',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      'http://tts.internal/v1/audio/speech',
    );
  });
});
