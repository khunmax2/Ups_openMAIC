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

  it('keeps the newer catalog when a tab comes back, whichever tab saved the settings', () => {
    const store = useSettingsStore;
    const merge = store.persist.getOptions().merge!;
    const grok = { id: 'x-ai/grok-4-fast', name: 'Grok 4 Fast' };
    const catalog = (servedAt: number, extra: Array<{ id: string; name: string }>) => ({
      models: { openrouter: { hidden: [], extra } },
      servedAt,
    });
    const ids = (state: ReturnType<typeof store.getState>) =>
      state.providersConfig.openrouter.models.map((m) => m.id);

    // This tab heard from the server after an admin added Grok...
    store.setState({ orgModelCatalog: catalog(2000, [gemini, grok]) });
    store.setState(applyOrgCatalog(store.getState()));
    expect(ids(store.getState())).toContain(grok.id);

    // ...then a tab opened before that saved the account's settings.
    const stale = JSON.parse(JSON.stringify(store.getState()));
    stale.orgModelCatalog = catalog(1000, [gemini]);
    stale.providersConfig.openrouter.models = stale.providersConfig.openrouter.models.filter(
      (m: { id: string }) => m.id !== grok.id,
    );
    const back = merge(stale, store.getState());
    expect(back.orgModelCatalog?.servedAt).toBe(2000);
    expect(ids(back)).toContain(grok.id);

    // A copy saved by a tab that heard a later answer wins over this tab's.
    const newer = JSON.parse(JSON.stringify(store.getState()));
    newer.orgModelCatalog = catalog(3000, [gemini]);
    const later = merge(newer, store.getState());
    expect(later.orgModelCatalog?.servedAt).toBe(3000);
    expect(ids(later)).not.toContain(grok.id);
  });
});
