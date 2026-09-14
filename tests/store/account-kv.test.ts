import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KVStore } from '@openmaic/storage';

/**
 * Fork. With server persistence on, the `account` scope (settings, profile)
 * lives on the server, per account. The first load after that switch must not
 * reset anyone: when the server has no value yet, this browser's own copy is
 * adopted and sent up, once. A deleted value must not come back from that
 * local copy. And the settings blob never carries a real API key off the
 * machine -- keys live in the credential store only.
 */

import {
  SeededAccountKV,
  keysStayOutOfPersistedSettings,
  rehydrateWhenVisible,
} from '@/lib/store/account-kv';

function memoryKv(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const kv = {
    data,
    get: vi.fn(async (key: string) => (data.has(key) ? data.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => void data.set(key, value)),
    remove: vi.fn(async (key: string) => void data.delete(key)),
    keys: vi.fn(async (prefix = '') => [...data.keys()].filter((k) => k.startsWith(prefix))),
  };
  return kv;
}

const asKv = (kv: ReturnType<typeof memoryKv>) => kv as unknown as KVStore;

// Found in the 2026-09-15 review. Settings used to belong to the browser, so
// two accounts that shared one browser shared one copy; adopting it for every
// account carried that mix-up into each account for good.
describe('SeededAccountKV — one browser, several accounts', () => {
  it("hands this browser's copy to the first account that opens the studio here, and no other", async () => {
    const local = memoryKv({ 'settings-storage': { state: { modelId: 'm1' } } });
    const accountA = memoryKv();
    const accountB = memoryKv();

    await expect(
      new SeededAccountKV(asKv(accountA), asKv(local)).get('settings-storage'),
    ).resolves.toEqual({ state: { modelId: 'm1' } });
    await expect(
      new SeededAccountKV(asKv(accountB), asKv(local)).get('settings-storage'),
    ).resolves.toBeNull();
    expect(accountB.set).not.toHaveBeenCalled();
  });
});

// Found in the same review: the adopted copy went up exactly as the browser
// held it, bypassing the settings store's own key masking.
describe('SeededAccountKV — keys never reach the server', () => {
  const withKey = {
    state: {
      providersConfig: {
        openai: { apiKey: 'sk-real', baseUrl: '' },
        shared: { apiKey: '***' },
        empty: { apiKey: '' },
      },
    },
  };
  const masked = {
    state: {
      providersConfig: {
        openai: { apiKey: '***', baseUrl: '' },
        shared: { apiKey: '***' },
        empty: { apiKey: '' },
      },
    },
  };

  it('masks an adopted copy on the way up, but hands the store the key so the credential sync can move it', async () => {
    const remote = memoryKv();
    const local = memoryKv({ s: withKey });
    await expect(new SeededAccountKV(asKv(remote), asKv(local)).get('s')).resolves.toEqual(withKey);
    expect(remote.data.get('s')).toEqual(masked);
  });

  it('masks every write', async () => {
    const remote = memoryKv();
    await new SeededAccountKV(asKv(remote), asKv(memoryKv())).set('s', withKey);
    expect(remote.data.get('s')).toEqual(masked);
  });
});

// Found in the same review: settings are one blob, and a tab left open holds an
// old copy in memory -- the next change there wrote it over what another
// browser had saved since. Reading the server again on return narrows that.
describe('rehydrateWhenVisible', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function fakeDocument() {
    const listeners: Array<() => void> = [];
    const doc = {
      visibilityState: 'visible',
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'visibilitychange') listeners.push(listener);
      }),
    };
    const show = (state: 'visible' | 'hidden') => {
      doc.visibilityState = state;
      for (const listener of listeners) listener();
    };
    return { doc, show };
  }

  it('reads a server-backed store again when its tab comes back', () => {
    vi.stubGlobal('window', {});
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    const { doc, show } = fakeDocument();
    vi.stubGlobal('document', doc);
    const rehydrate = vi.fn();

    rehydrateWhenVisible(rehydrate);
    show('hidden');
    expect(rehydrate).not.toHaveBeenCalled();
    show('visible');
    expect(rehydrate).toHaveBeenCalledOnce();
  });

  it('leaves a browser-only store alone', () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '');
    const { doc } = fakeDocument();
    vi.stubGlobal('document', doc);
    rehydrateWhenVisible(vi.fn());
    expect(doc.addEventListener).not.toHaveBeenCalled();
  });
});

describe('SeededAccountKV', () => {
  it("serves the server's value and leaves the local copy alone", async () => {
    const remote = memoryKv({ s: { v: 'server' } });
    const local = memoryKv({ s: { v: 'local' } });
    const kv = new SeededAccountKV(asKv(remote), asKv(local));
    await expect(kv.get('s')).resolves.toEqual({ v: 'server' });
    expect(local.get).not.toHaveBeenCalled();
  });

  it("adopts this browser's copy when the server has none, and sends it up once", async () => {
    const remote = memoryKv();
    const local = memoryKv({ s: { v: 'local' } });
    const kv = new SeededAccountKV(asKv(remote), asKv(local));
    await expect(kv.get('s')).resolves.toEqual({ v: 'local' });
    expect(remote.data.get('s')).toEqual({ v: 'local' });
    await expect(kv.get('s')).resolves.toEqual({ v: 'local' });
    expect(remote.set).toHaveBeenCalledTimes(1);
  });

  it('answers null when neither side has a value', async () => {
    const kv = new SeededAccountKV(asKv(memoryKv()), asKv(memoryKv()));
    await expect(kv.get('s')).resolves.toBeNull();
  });

  it('does not treat a server outage as absence', async () => {
    const remote = memoryKv();
    remote.get.mockRejectedValueOnce(new Error('502'));
    const local = memoryKv({ s: 1 });
    const kv = new SeededAccountKV(asKv(remote), asKv(local));
    await expect(kv.get('s')).rejects.toThrow('502');
    expect(remote.set).not.toHaveBeenCalled();
  });

  it('writes and lists on the server', async () => {
    const remote = memoryKv();
    const local = memoryKv();
    const kv = new SeededAccountKV(asKv(remote), asKv(local));
    await kv.set('s', 2);
    expect(remote.data.get('s')).toBe(2);
    expect(local.set).not.toHaveBeenCalled();
    await expect(kv.keys('')).resolves.toEqual(['s']);
  });

  it('removes the local copy too, so a deleted value is not adopted again', async () => {
    const remote = memoryKv({ s: 1 });
    const local = memoryKv({ s: 1 });
    const kv = new SeededAccountKV(asKv(remote), asKv(local));
    await kv.remove('s');
    await expect(kv.get('s')).resolves.toBeNull();
  });

  it('keeps the device scope on the device', async () => {
    const remote = memoryKv();
    const local = memoryKv();
    const kv = new SeededAccountKV(asKv(remote), asKv(local));
    await kv.set('cursor', 3, 'device');
    await expect(kv.get('cursor', 'device')).resolves.toBe(3);
    expect(remote.set).not.toHaveBeenCalled();
    expect(remote.get).not.toHaveBeenCalled();
  });
});

describe('keysStayOutOfPersistedSettings', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('masks keys once the server holds them', () => {
    expect(keysStayOutOfPersistedSettings('server')).toBe(true);
  });

  it('masks keys whenever the settings blob itself goes to the server', () => {
    vi.stubGlobal('window', {});
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    expect(keysStayOutOfPersistedSettings('none')).toBe(true);
  });

  it("keeps upstream's browser-only behaviour otherwise", () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '');
    expect(keysStayOutOfPersistedSettings('none')).toBe(false);
  });
});
