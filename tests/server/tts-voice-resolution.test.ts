import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A self-hosted TTS engine usually serves one voice, under its own name, and it
 * is never the built-in default the client's picker sends. Pointing a provider
 * at your own base URL therefore worked right up until synthesis, which failed
 * on a voice the engine never had — a well-formed, authorised request refused
 * for a reason nothing in the UI could explain.
 *
 * So the server has the last word on the voice, the way it already does on the
 * model and the base URL.
 */
describe('resolveTTSVoice', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  async function resolver() {
    const mod = await import('@/lib/server/provider-config');
    return mod.resolveTTSVoice;
  }

  it("passes the client's choice through when the server declares nothing", async () => {
    // Upstream's behaviour, and the right one for a hosted provider whose voice
    // list we do not own.
    const resolve = await resolver();
    expect(resolve('openai-tts', 'alloy')).toBe('alloy');
  });

  it('honours the client when it asks for a voice the server declares', async () => {
    vi.stubEnv('TTS_OPENAI_API_KEY', 'k');
    vi.stubEnv('TTS_OPENAI_VOICES', 'nova,onyx');
    const resolve = await resolver();
    expect(resolve('openai-tts', 'onyx')).toBe('onyx');
  });

  it('substitutes the first declared voice when the client asks for another', async () => {
    vi.stubEnv('TTS_OPENAI_API_KEY', 'k');
    vi.stubEnv('TTS_OPENAI_VOICES', 'nova,onyx');
    const resolve = await resolver();
    // 'alloy' is the picker's default and the engine has never heard of it.
    expect(resolve('openai-tts', 'alloy')).toBe('nova');
  });

  it('supplies a voice when the client sent none', async () => {
    vi.stubEnv('TTS_OPENAI_API_KEY', 'k');
    vi.stubEnv('TTS_OPENAI_VOICES', 'nova');
    const resolve = await resolver();
    expect(resolve('openai-tts', undefined)).toBe('nova');
  });

  it('ignores blank entries in the declaration', async () => {
    vi.stubEnv('TTS_OPENAI_API_KEY', 'k');
    vi.stubEnv('TTS_OPENAI_VOICES', ' , nova , ');
    const resolve = await resolver();
    expect(resolve('openai-tts', 'alloy')).toBe('nova');
  });

  it('leaves a provider it was not told about alone', async () => {
    vi.stubEnv('TTS_OPENAI_API_KEY', 'k');
    vi.stubEnv('TTS_OPENAI_VOICES', 'nova');
    const resolve = await resolver();
    expect(resolve('minimax-tts', 'speech-02-hd')).toBe('speech-02-hd');
  });
});
