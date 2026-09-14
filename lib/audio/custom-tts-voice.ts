/**
 * Fork. A custom TTS provider only knows the voices its definition lists.
 *
 * The store's generic fallback voice is `default`, which a built-in provider
 * maps to its own default but a custom server does not know -- it answers 400
 * "Bad Request". Found 2026-09-14 on a shared custom provider: it was selected
 * before its voice list arrived through the credential sync, the selection
 * stayed `default`, and every narration request failed until the user
 * switched providers away and back (`setTTSProvider` picks the first listed
 * voice; nothing else did).
 *
 * The settings store now keeps the selection inside the list after every write
 * (`correctedCustomTTSVoice`), and narration requests apply the same rule to a
 * course's saved voice binding (`customTTSVoiceFor`).
 */

import { isCustomTTSProvider } from './types';

type VoiceList = ReadonlyArray<{ readonly id: string }> | undefined;

/**
 * The voice to send: the chosen one when the custom provider lists it,
 * otherwise its first listed voice. A built-in provider, or a custom one that
 * lists no voices, keeps the chosen voice.
 */
export function customTTSVoiceFor(providerId: string, voiceId: string, voices: VoiceList): string {
  if (!isCustomTTSProvider(providerId) || !voices?.length) return voiceId;
  return voices.some((voice) => voice.id === voiceId) ? voiceId : voices[0]!.id;
}

/** The `ttsVoice` the settings should hold instead, or undefined when it is fine. */
export function correctedCustomTTSVoice(state: {
  readonly ttsProviderId: string;
  readonly ttsVoice: string;
  readonly ttsProvidersConfig: Readonly<
    Record<string, { readonly customVoices?: VoiceList } | undefined>
  >;
}): string | undefined {
  const voices = state.ttsProvidersConfig[state.ttsProviderId]?.customVoices;
  const voice = customTTSVoiceFor(state.ttsProviderId, state.ttsVoice, voices);
  return voice === state.ttsVoice ? undefined : voice;
}
