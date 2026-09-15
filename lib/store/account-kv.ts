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
 *
 * Settings used to belong to the browser, so accounts that shared one browser
 * shared one copy: it goes to the first account that opens the studio here,
 * and any other starts from defaults rather than inheriting it. No API key
 * goes up in any value, adopted or written (keys live in the credential
 * store). A tab left open re-reads its store when it comes back, so an old
 * in-memory copy is not written over one saved elsewhere.
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

const KEY_SENTINEL = '***';

/**
 * A copy of `value` with every non-empty `apiKey` string replaced by the
 * credential store's sentinel. The settings store already masks what it
 * persists; this is the floor under it, and the only masking an adopted copy
 * written before that masking existed would get.
 */
export function maskApiKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => maskApiKeys(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const masked: Record<string, unknown> = {};
  for (const [field, inner] of Object.entries(value as Record<string, unknown>)) {
    masked[field] =
      field === 'apiKey' && typeof inner === 'string' && inner !== '' && inner !== KEY_SENTINEL
        ? KEY_SENTINEL
        : maskApiKeys(inner);
  }
  return masked as T;
}

/**
 * The JSON form of `value` -- exactly what upstream's browser store kept, since
 * it stored `JSON.stringify(value)`. zustand's `persist` hands its storage the
 * whole state, the store's actions and undefined fields included; the browser
 * store dropped them without a word, while `HttpKVStore` refuses anything that
 * is not exact JSON. So every settings write failed in the browser after the
 * switch (deploy-2026-09-15b: "your changes were not saved") while reads, of an
 * adopted copy that was already plain JSON, went on working.
 */
export function toJsonValue<T>(value: T): T {
  const text = JSON.stringify(value);
  return text === undefined ? (undefined as T) : (JSON.parse(text) as T);
}

/** Device-scope marker: this browser's copy of `key` already went to an account. */
const adoptedMarker = (key: string) => `account-kv-adopted:${key}`;

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
    // This browser's copy goes to the first account that opens the studio here.
    if ((await this.local.get<boolean>(adoptedMarker(key), 'device')) === true) return null;
    const adopted = await this.local.get<T>(key, 'account');
    if (adopted === null) return null;
    try {
      // Masked on the way up; the store still gets the key, so the credential
      // sync can move it to where keys belong.
      await this.remote.set(key, maskApiKeys(toJsonValue(adopted)));
      await this.local.set(adoptedMarker(key), true, 'device');
    } catch {
      // Not recorded: the next write carries the value up anyway, and until
      // then the next load offers the same copy again.
    }
    return adopted;
  }

  async set<T>(key: string, value: T, scope: KVScope = 'account'): Promise<void> {
    if (scope === 'device') return this.local.set(key, value, 'device');
    return this.remote.set(key, maskApiKeys(toJsonValue(value)));
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

/**
 * Read a server-backed store again whenever its tab becomes visible. The store
 * is one blob and a tab left open holds an old copy; without this, its next
 * change wrote that copy over what another browser had saved since. Reads are
 * queued behind this tab's own pending writes, so nothing of its own is lost.
 */
export function rehydrateWhenVisible(rehydrate: () => unknown): void {
  if (!accountStateLeavesBrowser() || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    try {
      void Promise.resolve(rehydrate()).catch(() => undefined);
    } catch {
      // A failed re-read leaves the store as it was; the persist seam reports it.
    }
  });
}

/** The response header naming the account an answer was served for (lib/persistence/account-kv.ts). */
export const OWNER_HEADER = 'x-studio-kv-owner';

export interface OwnerGuard {
  /** For `HttpKVStore`: every response is checked for the account it came from. */
  readonly fetch: typeof globalThis.fetch;
  /** For `HttpKVStore`: every write names the account this page was loaded for. */
  readonly headers: (context: { method: string }) => Record<string, string>;
  /** The account tag this page's stores were loaded for, once known. */
  readonly owner: () => string | null;
}

/**
 * Fork. Keeps one page's stores on the account they were loaded for (audit
 * F01). A tab holds settings in memory; when another tab signs in as someone
 * else, the shared cookie made this tab's next write land on that account --
 * reproduced 2026-09-15, one click wrote one account's whole settings blob as
 * another's. The first answer fixes this page's account; every write sends it
 * back and the server refuses one that no longer matches; and the moment an
 * answer comes from a different account the page reloads, as the account now
 * signed in. Once per page: a reload is the whole remedy.
 */
export function createOwnerGuard(
  options: { fetch?: typeof globalThis.fetch; onOwnerChanged?: () => void } = {},
): OwnerGuard {
  let pageOwner: string | null = null;
  let handled = false;
  const changed = () => {
    if (handled) return;
    handled = true;
    (options.onOwnerChanged ?? reloadPage)();
  };
  const base: typeof globalThis.fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    owner: () => pageOwner,
    headers: ({ method }) => {
      const headers: Record<string, string> = {};
      if (method !== 'GET' && pageOwner !== null) headers[OWNER_HEADER] = pageOwner;
      return headers;
    },
    fetch: async (input, init) => {
      const response = await base(input, init);
      const seen = response.headers.get(OWNER_HEADER);
      if (seen) {
        if (pageOwner === null) pageOwner = seen;
        else if (seen !== pageOwner) changed();
      }
      if (response.status === 409) {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as { error?: { code?: unknown } } | null;
        if (body?.error?.code === 'OWNER_CHANGED') changed();
      }
      return response;
    },
  };
}

function reloadPage(): void {
  if (typeof window !== 'undefined') window.location.reload();
}

/** The backend `kv-persist` uses for the app's persisted stores. */
export function createAppKVStore(): KVStore {
  const local = new BrowserKVStore();
  if (!accountStateLeavesBrowser()) return local;
  const guard = createOwnerGuard();
  return new SeededAccountKV(
    new HttpKVStore({
      baseUrl: apiPath('/api/persistence'),
      deviceStore: local,
      credentials: 'include',
      fetch: guard.fetch,
      headers: guard.headers,
    }),
    local,
  );
}
