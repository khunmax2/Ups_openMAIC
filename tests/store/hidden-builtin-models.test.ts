import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  hiddenAfterBulkEdit,
  hiddenAfterEdit,
  shownBuiltIns,
  withHidden,
} from '@/lib/store/hidden-builtin-models';

/**
 * Fork. A built-in model someone removed from a provider stays removed.
 * Reported 2026-09-15: the two DeepSeek models deleted from OpenRouter came
 * back on every load, because upstream rebuilds each built-in provider's list
 * from the registry whenever the store rehydrates.
 */
describe('hidden built-in models', () => {
  const builtIns = ['m-pro', 'm-flash'];

  it('hides exactly the built-ins missing from the edited list', () => {
    expect(hiddenAfterEdit(builtIns, [{ id: 'm-pro' }, { id: 'custom' }])).toEqual(['m-flash']);
    expect(hiddenAfterEdit(builtIns, [{ id: 'm-flash' }, { id: 'm-pro' }])).toEqual([]);
    expect(hiddenAfterEdit([], [{ id: 'custom' }])).toEqual([]);
  });

  it('drops a provider from the map once nothing of it is hidden', () => {
    const map = withHidden({}, 'openrouter', ['m-flash']);
    expect(map).toEqual({ openrouter: ['m-flash'] });
    expect(withHidden(map, 'openrouter', [])).toEqual({});
  });

  it('recomputes every provider on a bulk replace, custom providers excluded', () => {
    const idsOf = (providerId: string) => (providerId === 'openrouter' ? builtIns : []);
    expect(
      hiddenAfterBulkEdit(idsOf, {
        openrouter: { models: [{ id: 'm-pro' }] },
        'custom-1': { models: [{ id: 'x' }] },
      }),
    ).toEqual({ openrouter: ['m-flash'] });
  });

  it('shows the registry built-ins minus the hidden ones, in registry order', () => {
    const models = [{ id: 'm-pro' }, { id: 'm-flash' }, { id: 'm-new' }];
    expect(shownBuiltIns(models, ['m-flash']).map((m) => m.id)).toEqual(['m-pro', 'm-new']);
    expect(shownBuiltIns(models, undefined).map((m) => m.id)).toEqual([
      'm-pro',
      'm-flash',
      'm-new',
    ]);
  });
});

describe('the settings store keeps a removed built-in removed across loads', () => {
  let useSettingsStore: typeof import('@/lib/store/settings').useSettingsStore;
  let PROVIDERS: typeof import('@/lib/ai/providers').PROVIDERS;

  // The store module evaluates browser globals at import; give it inert ones.
  // The first import compiles the whole store graph, hence the long timeout.
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
    ({ useSettingsStore } = await import('@/lib/store/settings'));
    ({ PROVIDERS } = await import('@/lib/ai/providers'));
  }, 120_000);

  it('a removed built-in stays out after the next load; Reset brings it back', () => {
    const registry = PROVIDERS.openrouter.models;
    const [kept, removed] = registry.map((m) => m.id);
    const custom = { id: 'google/gemini-3.5-flash-lite', name: 'google/gemini-3.5-flash-lite' };

    const store = useSettingsStore;
    const current = store.getState().providersConfig.openrouter.models;
    store.getState().setProviderConfig('openrouter', {
      models: [...current.filter((m) => m.id !== removed), custom],
    });
    expect(store.getState().hiddenBuiltInModels.openrouter).toEqual([removed]);

    // What the next load, or a tab coming back, does with the saved copy.
    const merge = store.persist.getOptions().merge!;
    const reload = () => {
      const saved = JSON.parse(JSON.stringify(store.getState()));
      return merge(saved, store.getState()).providersConfig.openrouter.models.map((m) => m.id);
    };
    const afterLoad = reload();
    expect(afterLoad).toContain(kept);
    expect(afterLoad).toContain(custom.id);
    expect(afterLoad).not.toContain(removed);

    // Reset restores the registry list, and it stays restored.
    store.getState().setProviderConfig('openrouter', { models: [...registry] });
    expect(store.getState().hiddenBuiltInModels.openrouter).toBeUndefined();
    expect(reload()).toEqual(expect.arrayContaining([kept, removed]));
  });
});
