/**
 * Fork. The settings store keeps a custom TTS provider's selected voice inside
 * that provider's voice list, whichever write put it outside: a shared custom
 * provider arriving through the credential sync after it was selected, a
 * restored blob, a direct `setState`. Found 2026-09-14: `ttsVoice` stayed
 * `default` on a shared custom provider and every narration request came back
 * 400 until the user switched providers away and back.
 */
import { describe, it, expect, vi } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => void storage.clear(),
  key: () => null,
  length: 0,
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

const persistKv = new BrowserKVStore({ storage: localStorageStub as unknown as Storage });

const CUSTOM = 'custom-tts-mine';
const customConfig = (customVoices: Array<{ id: string; name: string }>) => ({
  apiKey: '',
  baseUrl: 'http://tts.internal/v1',
  enabled: true,
  modelId: 'tts-1',
  customName: 'MyTTS',
  customDefaultBaseUrl: 'http://tts.internal/v1',
  customVoices,
  isBuiltIn: false,
  requiresApiKey: false,
});

async function freshStore(persistedState?: Record<string, unknown>) {
  vi.resetModules();
  storage.clear();
  if (persistedState) {
    await persistKv.set('settings-storage', { state: persistedState, version: 4 }, 'account');
  }
  const { useSettingsStore } = await import('@/lib/store/settings');
  await useSettingsStore.persist.rehydrate();
  return useSettingsStore;
}

describe('a custom TTS provider keeps its selected voice inside its voice list', () => {
  it('when its voices arrive after it was selected', async () => {
    const store = await freshStore();
    store.setState((s) => ({
      ttsProvidersConfig: { ...s.ttsProvidersConfig, [CUSTOM]: customConfig([]) },
      ttsProviderId: CUSTOM as never,
      ttsVoice: 'default',
    }));
    // No voices listed yet: nothing to choose from, nothing changes.
    expect(store.getState().ttsVoice).toBe('default');

    store.setState((s) => ({
      ttsProvidersConfig: {
        ...s.ttsProvidersConfig,
        [CUSTOM]: customConfig([
          { id: 'ped', name: 'Ped' },
          { id: 'nam', name: 'Nam' },
        ]),
      },
    }));
    expect(store.getState().ttsVoice).toBe('ped');
  });

  it('keeps a voice the provider lists', async () => {
    const store = await freshStore();
    store.setState((s) => ({
      ttsProvidersConfig: {
        ...s.ttsProvidersConfig,
        [CUSTOM]: customConfig([
          { id: 'ped', name: 'Ped' },
          { id: 'nam', name: 'Nam' },
        ]),
      },
      ttsProviderId: CUSTOM as never,
      ttsVoice: 'nam',
    }));
    expect(store.getState().ttsVoice).toBe('nam');
  });

  it('when a restored blob holds a voice the provider does not list', async () => {
    const store = await freshStore({
      ttsProviderId: CUSTOM,
      ttsVoice: 'default',
      ttsProvidersConfig: { [CUSTOM]: customConfig([{ id: 'ped', name: 'Ped' }]) },
    });
    expect(store.getState().ttsProviderId).toBe(CUSTOM);
    expect(store.getState().ttsVoice).toBe('ped');
  });
});
