import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

type Call = { url: string; method: string; body?: unknown };

/** A fake credential server: answers the list, records writes, echoes masks. */
function fakeServer(list: {
  storage?: 'server' | 'none';
  role?: 'admin' | 'user';
  own?: Record<string, Record<string, { masked: string; baseUrl: string }>>;
  defaults?: Record<string, Record<string, { masked: string; baseUrl: string }>>;
}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: input, method, body });
    if (method === 'GET') {
      return Response.json({
        storage: list.storage ?? 'server',
        role: list.role ?? 'user',
        own: list.own ?? {},
        defaults: list.defaults ?? {},
      });
    }
    if (method === 'PUT') {
      const key = String(body?.apiKey ?? '');
      return Response.json({
        stored: { masked: `${key.slice(0, 2)}••••`, baseUrl: body?.baseUrl ?? '' },
      });
    }
    return Response.json({ removed: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

describe('server-side credentials, browser half', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replaces every stored key with the sentinel and keeps the mask beside it', async () => {
    fakeServer({
      own: { image: { 'custom-image': { masked: 'sk-pr••••wxyz', baseUrl: 'https://gpu/v1' } } },
      defaults: { tts: { 'openai-tts': { masked: 'sk-de••••zzzz', baseUrl: '' } } },
    });
    const { useSettingsStore } = await import('@/lib/store/settings');
    const { startCredentialSync, resetCredentialSyncForTests } =
      await import('@/lib/credentials/client');
    resetCredentialSyncForTests();
    await startCredentialSync();

    const s = useSettingsStore.getState();
    expect(s.credentialStorage).toBe('server');
    expect(s.imageProvidersConfig['custom-image']).toMatchObject({
      apiKey: '***',
      baseUrl: 'https://gpu/v1',
    });
    expect(s.ttsProvidersConfig['openai-tts']).toMatchObject({ apiKey: '***' });
    expect(s.credentialMeta['image:custom-image']).toEqual({
      masked: 'sk-pr••••wxyz',
      baseUrl: 'https://gpu/v1',
      source: 'own',
    });
    expect(s.credentialMeta['tts:openai-tts']?.source).toBe('default');
  });

  it('migrates a key the browser already held, once, and then holds the sentinel', async () => {
    const { calls } = fakeServer({});
    const { useSettingsStore } = await import('@/lib/store/settings');
    useSettingsStore.getState().setVideoProviderConfig('seedance', {
      apiKey: 'old-browser-key-000000',
      baseUrl: '',
    });
    const { startCredentialSync, resetCredentialSyncForTests } =
      await import('@/lib/credentials/client');
    resetCredentialSyncForTests();
    await startCredentialSync();

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toContain('/api/studio/credentials/video/seedance');
    expect(puts[0]?.body).toEqual({ apiKey: 'old-browser-key-000000' });
    expect(useSettingsStore.getState().videoProvidersConfig.seedance?.apiKey).toBe('***');
    expect(useSettingsStore.getState().credentialMeta['video:seedance']?.source).toBe('own');
  });

  it('sends a key typed after boot and swaps in the sentinel when the server confirms', async () => {
    vi.useFakeTimers();
    const { calls } = fakeServer({});
    const { useSettingsStore } = await import('@/lib/store/settings');
    const { startCredentialSync, resetCredentialSyncForTests } =
      await import('@/lib/credentials/client');
    resetCredentialSyncForTests();
    await startCredentialSync();

    useSettingsStore.getState().setImageProviderConfig('custom-image', { apiKey: 'typed-key-1' });
    useSettingsStore.getState().setImageProviderConfig('custom-image', { apiKey: 'typed-key-12' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(900);

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1); // debounced: one write for two keystrokes
    expect(puts[0]?.body).toMatchObject({ apiKey: 'typed-key-12' });
    expect(useSettingsStore.getState().imageProvidersConfig['custom-image']?.apiKey).toBe('***');
  });

  it('never sends the sentinel, and treats a change to the sentinel as no change', async () => {
    vi.useFakeTimers();
    const { calls } = fakeServer({
      own: { image: { 'custom-image': { masked: 'sk••••', baseUrl: '' } } },
    });
    const { useSettingsStore } = await import('@/lib/store/settings');
    const { startCredentialSync, resetCredentialSyncForTests } =
      await import('@/lib/credentials/client');
    resetCredentialSyncForTests();
    await startCredentialSync();

    // "Change" clears the field; "Keep current" puts the sentinel back.
    useSettingsStore.getState().setImageProviderConfig('custom-image', { apiKey: '' });
    useSettingsStore.getState().setImageProviderConfig('custom-image', { apiKey: '***' });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('leaves the browser holding its keys when there is no server store', async () => {
    const { calls } = fakeServer({ storage: 'none' });
    const { useSettingsStore } = await import('@/lib/store/settings');
    useSettingsStore.getState().setImageProviderConfig('custom-image', { apiKey: 'local-key' });
    const { startCredentialSync, resetCredentialSyncForTests } =
      await import('@/lib/credentials/client');
    resetCredentialSyncForTests();
    await startCredentialSync();
    expect(useSettingsStore.getState().credentialStorage).toBe('none');
    expect(useSettingsStore.getState().imageProvidersConfig['custom-image']?.apiKey).toBe(
      'local-key',
    );
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('switches a provider on the first time a credential appears for it, and only then', async () => {
    const { useSettingsStore } = await import('@/lib/store/settings');
    // An account that never configured image generation: the provider row
    // exists with upstream's default, enabled: false.
    expect(useSettingsStore.getState().imageProvidersConfig['custom-image']?.enabled).toBe(false);

    fakeServer({
      defaults: {
        image: { 'custom-image': { masked: 'sk-ad••••min1', baseUrl: 'https://gpu/v1' } },
      },
    });
    const mod = await import('@/lib/credentials/client');
    mod.resetCredentialSyncForTests();
    await mod.startCredentialSync();
    const first = useSettingsStore.getState().imageProvidersConfig['custom-image'];
    expect(first).toMatchObject({ apiKey: '***', enabled: true, baseUrl: 'https://gpu/v1' });

    // The person turns it off. A later boot sees the same default -- not for
    // the first time -- and leaves their answer alone.
    useSettingsStore.getState().setImageProviderConfig('custom-image', { enabled: false });
    mod.resetCredentialSyncForTests();
    await mod.startCredentialSync();
    expect(useSettingsStore.getState().imageProvidersConfig['custom-image']?.enabled).toBe(false);
  });

  it('never persists a real key once the server holds them', async () => {
    fakeServer({});
    const { useSettingsStore } = await import('@/lib/store/settings');
    const { startCredentialSync, resetCredentialSyncForTests } =
      await import('@/lib/credentials/client');
    resetCredentialSyncForTests();
    await startCredentialSync();
    // In memory for the moment between keystroke and confirmation...
    useSettingsStore.setState((s) => ({
      imageProvidersConfig: {
        ...s.imageProvidersConfig,
        'custom-image': { ...s.imageProvidersConfig['custom-image'], apiKey: 'in-flight-key' },
      },
    }));
    const persisted = useSettingsStore.persist
      .getOptions()
      .partialize?.(useSettingsStore.getState());
    expect(persisted?.imageProvidersConfig?.['custom-image']?.apiKey).toBe('***');
    expect(JSON.stringify(persisted)).not.toContain('in-flight-key');
  });
});
