import { describe, expect, it } from 'vitest';

/**
 * Fork. A custom TTS provider only knows the voices its definition lists. The
 * store's generic fallback voice, `default`, is not one of them, and the
 * provider answers it with 400 "Bad Request" -- found 2026-09-14 on a shared
 * custom provider whose selection landed before its voice list did. These
 * helpers keep the choice inside the list.
 */

import { correctedCustomTTSVoice, customTTSVoiceFor } from '@/lib/audio/custom-tts-voice';

const CUSTOM = 'custom-tts-mine';
const VOICES = [{ id: 'ped' }, { id: 'nam' }];

describe('customTTSVoiceFor', () => {
  it('keeps a voice the provider lists', () => {
    expect(customTTSVoiceFor(CUSTOM, 'nam', VOICES)).toBe('nam');
  });

  it("replaces a voice the provider does not list with the provider's first", () => {
    expect(customTTSVoiceFor(CUSTOM, 'default', VOICES)).toBe('ped');
    expect(customTTSVoiceFor(CUSTOM, '', VOICES)).toBe('ped');
  });

  it('leaves the voice alone when the provider lists none, or is built in', () => {
    expect(customTTSVoiceFor(CUSTOM, 'default', [])).toBe('default');
    expect(customTTSVoiceFor(CUSTOM, 'default', undefined)).toBe('default');
    expect(customTTSVoiceFor('openai-tts', 'alloy', VOICES)).toBe('alloy');
  });
});

describe('correctedCustomTTSVoice', () => {
  const state = (ttsProviderId: string, ttsVoice: string) => ({
    ttsProviderId,
    ttsVoice,
    ttsProvidersConfig: { [CUSTOM]: { customVoices: VOICES } },
  });

  it('names the voice the settings should hold when the choice is outside the list', () => {
    expect(correctedCustomTTSVoice(state(CUSTOM, 'default'))).toBe('ped');
  });

  it('answers undefined when nothing needs to change', () => {
    expect(correctedCustomTTSVoice(state(CUSTOM, 'nam'))).toBeUndefined();
    expect(correctedCustomTTSVoice(state('openai-tts', 'default'))).toBeUndefined();
    expect(
      correctedCustomTTSVoice({ ttsProviderId: CUSTOM, ttsVoice: 'x', ttsProvidersConfig: {} }),
    ).toBeUndefined();
  });
});
