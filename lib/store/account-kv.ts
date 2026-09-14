/**
 * Fork. The app's KV backend: `account` values on the server, per account,
 * when this deployment persists there.
 *
 * Upstream routes zustand `persist` through `KVStore` precisely so "a
 * server-backed deployment can serve the `account` scope without the stores
 * knowing" (`kv-persist.ts`), and ships the client (`HttpKVStore`) -- but the
 * app only ever built the browser store, so provider settings and the profile
 * stayed in one browser. `lib/persistence/account-kv.ts` is the server; this
 * is the switch.
 *
 * The first load after the switch must not reset anyone. The server has no
 * value yet, and upstream's persist seam deliberately never migrates, so an
 * empty server would hydrate defaults over the user's settings. When the
 * server has nothing for a key, this browser's own copy is adopted and sent
 * up once; after that the server's value is the only one read. Deleting a
 * value deletes the local copy too, so it cannot be adopted back.
 */

import {
  BrowserKVStore,
  HttpKVStore,
  type DeviceSafeKVStore,
  type KVScope,
  type KVStore,
} from '@openmaic/storage';

import { apiPath } from '@/lib/base-path';

/** True when the `account` scope is served by the server rather than this browser. */
export function accountStateLeavesBrowser(): boolean {
  return typeof window !== 'undefined' && process.env.NEXT_PUBLIC_PERSISTENCE === '1';
}

/**
 * Whether the persisted settings must mask API keys. Upstream's shape keeps
 * them in the browser; the fork's credential store takes them over
 * (`credentialStorage === 'server'`), and a blob that itself goes to the
 * server must never carry one -- keys belong in the credential store only.
 */
export function keysStayOutOfPersistedSettings(credentialStorage: string | undefined): boolean {
  return credentialStorage === 'server' || accountStateLeavesBrowser();
}

/** `account` on `remote`, adopting `local`'s copy when `remote` has none; `device` on `local`. */
export class SeededAccountKV implements DeviceSafeKVStore {
  readonly servesDeviceScopeLocally = true as const;

  constructor(
    private readonly remote: KVStore,
    private readonly local: KVStore,
  ) {}

  async get<T>(key: string, scope: KVScope = 'account'): Promise<T | null> {
    if (scope === 'device') return this.local.get<T>(key, 'device');
    // A failed read propagates: an outage is not "nothing stored", and the
    // persist seam refuses writes until a read succeeds.
    const stored = await this.remote.get<T>(key);
    if (stored !== null) return stored;
    const adopted = await this.local.get<T>(key, 'account');
    if (adopted === null) return null;
    try {
      await this.remote.set(key, adopted);
    } catch {
      // The next write carries the value up anyway; until then the next load
      // adopts the same local copy again.
    }
    return adopted;
  }

  async set<T>(key: string, value: T, scope: KVScope = 'account'): Promise<void> {
    if (scope === 'device') return this.local.set(key, value, 'device');
    return this.remote.set(key, value);
  }

  async remove(key: string, scope: KVScope = 'account'): Promise<void> {
    if (scope === 'device') return this.local.remove(key, 'device');
    await this.remote.remove(key);
    await this.local.remove(key, 'account').catch(() => undefined);
  }

  async keys(prefix = '', scope: KVScope = 'account'): Promise<string[]> {
    if (scope === 'device') return this.local.keys(prefix, 'device');
    return this.remote.keys(prefix);
  }
}

/** The backend `kv-persist` uses for the app's persisted stores. */
export function createAppKVStore(): KVStore {
  const local = new BrowserKVStore();
  if (!accountStateLeavesBrowser()) return local;
  return new SeededAccountKV(
    new HttpKVStore({
      baseUrl: apiPath('/api/persistence'),
      deviceStore: local,
      credentials: 'include',
    }),
    local,
  );
}
