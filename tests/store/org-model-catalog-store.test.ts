import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Fork. The organisation's model catalog inside the real settings store: every
 * account's list for a provider follows the organisation's, a rehydrate keeps
 * it, a new account starts on the organisation's default, and a model the
 * person picks is never overridden (lib/credentials/org-models.ts).
 */
describe("the settings store applies the organisation's model catalog", () => {
  let useSettingsStore: typeof import('@/lib/store/settings').useSettingsStore;
  let applyOrgCatalog: typeof import('@/lib/store/settings').applyOrgCatalog;
  let PROVIDERS: typeof import('@/lib/ai/providers').PROVIDERS;

  beforeAll(async () => {
    const storage = new Map<string, string>();
    const localStorageStub = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    };
    vi.stubGlobal('localStorage', localStorageStub);
    vi.stubGlobal('window', { localStorage: localStorageStub });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    ({ useSettingsStore, applyOrgCatalog } = await import('@/lib/store/settings'));
    ({ PROVIDERS } = await import('@/lib/ai/providers'));
  }, 120_000);

  const gemini = { id: 'google/gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite' };

  it("gives a new account the organisation's list and default, and keeps them across a reload", () => {
    const [pro, flash] = PROVIDERS.openrouter.models.map((m) => m.id);
    const store = useSettingsStore;
    const state = store.getState();
    // The account has OpenRouter's key through the organisation's share.
    store.setState({
      providersConfig: {
        ...state.providersConfig,
        openrouter: { ...state.providersConfig.openrouter, apiKey: '***' },
      },
      orgModelCatalog: {
        models: { openrouter: { hidden: [flash!], extra: [gemini] } },
        defaultModel: { providerId: 'openrouter', modelId: gemini.id },
      },
    });
    store.setState(applyOrgCatalog(store.getState()));
    const ids = () => store.getState().providersConfig.openrouter.models.map((m) => m.id);
    expect(ids()).toEqual([pro, gemini.id]);
    expect(store.getState().providerId).toBe('openrouter');
    expect(store.getState().modelId).toBe(gemini.id);

    // A reload (or a tab coming back) with the saved copy keeps it.
    const merge = store.persist.getOptions().merge!;
    const saved = JSON.parse(JSON.stringify(store.getState()));
    const reloaded = merge(saved, store.getState());
    expect(reloaded.providersConfig.openrouter.models.map((m) => m.id)).toEqual([pro, gemini.id]);

    // What the organisation hides is not this person's to hide: removing
    // another built-in records only that one.
    store.getState().setProviderConfig('openrouter', {
      models: store.getState().providersConfig.openrouter.models.filter((m) => m.id !== pro),
    });
    expect(store.getState().hiddenBuiltInModels.openrouter).toEqual([pro]);
  });

  it('never overrides a model the person picked', () => {
    const store = useSettingsStore;
    store.getState().setModel('google', 'gemini-3.6-flash');
    expect(store.getState().llmModelIsUserSet).toBe(true);
    store.setState(applyOrgCatalog(store.getState()));
    expect(store.getState().providerId).toBe('google');
    expect(store.getState().modelId).toBe('gemini-3.6-flash');
  });
});
