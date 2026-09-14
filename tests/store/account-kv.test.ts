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

import { SeededAccountKV, keysStayOutOfPersistedSettings } from '@/lib/store/account-kv';

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
