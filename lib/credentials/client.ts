/**
 * Browser half of server-side credentials (fork).
 *
 * The settings store keeps an `apiKey` per provider in every section, and
 * the persisted copy lives in the browser. Behind the gateway the server
 * keeps the key instead and the browser holds the sentinel `***`; requests
 * still send `x-api-key`, the server sees the sentinel and uses what it has
 * for this owner. Nothing about how a page reads or writes the store changes:
 *
 * - on boot, the server's masked list replaces every stored key with the
 *   sentinel, and a real key still sitting in storage from before is sent to
 *   the server once and replaced -- the migration path for an existing user;
 * - afterwards, a real key typed into the store is sent (debounced) and
 *   replaced with the sentinel as soon as the server confirms it;
 * - a base URL edit is sent the same way, since a self-hosted endpoint's key
 *   is not usable without it.
 *
 * With no database behind the studio (`storage: 'none'`) none of this runs
 * and the browser keeps its keys, which is upstream's shape.
 */

import { apiPath } from '@/lib/base-path';
import { useSettingsStore, type SettingsState } from '@/lib/store/settings';

export const CREDENTIAL_SENTINEL = '***';

export type CredentialSection =
  | 'providers'
  | 'tts'
  | 'asr'
  | 'pdf'
  | 'image'
  | 'video'
  | 'webSearch';

export const CREDENTIAL_SECTIONS: readonly CredentialSection[] = [
  'providers',
  'tts',
  'asr',
  'pdf',
  'image',
  'video',
  'webSearch',
];

const STORE_KEY: Record<CredentialSection, keyof SettingsState> = {
  providers: 'providersConfig',
  tts: 'ttsProvidersConfig',
  asr: 'asrProvidersConfig',
  pdf: 'pdfProvidersConfig',
  image: 'imageProvidersConfig',
  video: 'videoProvidersConfig',
  webSearch: 'webSearchProvidersConfig',
};

export interface StoredCredentialMeta {
  masked: string;
  baseUrl: string;
  source: 'own' | 'default';
}

export type CredentialMeta = Record<string, StoredCredentialMeta>;

export function metaKey(section: CredentialSection, providerId: string): string {
  return `${section}:${providerId}`;
}

type Entry = { apiKey?: string; baseUrl?: string; enabled?: boolean };

/** What PUT accepts: the fields, or an admin's request to copy their own row. */
export type CredentialPatch = Entry & { copyFromOwner?: boolean };

function isRealKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.trim() !== CREDENTIAL_SENTINEL;
}

function sectionEntries(state: SettingsState, section: CredentialSection): Record<string, Entry> {
  return (state[STORE_KEY[section]] ?? {}) as Record<string, Entry>;
}

interface ListResponse {
  role: 'admin' | 'user';
  storage: 'server' | 'none';
  own: Partial<Record<CredentialSection, Record<string, { masked: string; baseUrl: string }>>>;
  defaults: Partial<Record<CredentialSection, Record<string, { masked: string; baseUrl: string }>>>;
}

async function listFromServer(): Promise<ListResponse | undefined> {
  try {
    const res = await fetch(apiPath('/api/studio/credentials'), { credentials: 'include' });
    if (!res.ok) return undefined;
    return (await res.json()) as ListResponse;
  } catch {
    return undefined;
  }
}

export async function putCredential(
  section: CredentialSection,
  providerId: string,
  patch: CredentialPatch,
  scope: 'owner' | 'default' = 'owner',
): Promise<{ masked: string; baseUrl: string } | null | undefined> {
  const path =
    scope === 'default' ? `/default/${section}/${providerId}` : `/${section}/${providerId}`;
  try {
    const res = await fetch(apiPath(`/api/studio/credentials${path}`), {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { stored: { masked: string; baseUrl: string } | null }).stored;
  } catch {
    return undefined;
  }
}

export async function removeCredential(
  section: CredentialSection,
  providerId: string,
  scope: 'owner' | 'default' = 'owner',
): Promise<boolean> {
  const path =
    scope === 'default' ? `/default/${section}/${providerId}` : `/${section}/${providerId}`;
  try {
    const res = await fetch(apiPath(`/api/studio/credentials${path}`), {
      method: 'DELETE',
      credentials: 'include',
    });
    return res.ok;
  } catch {
    return false;
  }
}

function metaFrom(list: ListResponse): CredentialMeta {
  const meta: CredentialMeta = {};
  for (const section of CREDENTIAL_SECTIONS) {
    for (const [id, row] of Object.entries(list.defaults[section] ?? {})) {
      meta[metaKey(section, id)] = { ...row, source: 'default' };
    }
    for (const [id, row] of Object.entries(list.own[section] ?? {})) {
      meta[metaKey(section, id)] = { ...row, source: 'own' };
    }
  }
  return meta;
}

/** Rewrite one section's entries to reflect what the server holds. */
function reconcileSection(
  entries: Record<string, Entry>,
  section: CredentialSection,
  meta: CredentialMeta,
  previousMeta: CredentialMeta,
): Record<string, Entry> {
  const next: Record<string, Entry> = {};
  for (const [id, entry] of Object.entries(entries)) {
    const key = metaKey(section, id);
    const stored = meta[key];
    if (stored) {
      // A provider this browser is seeing a credential for the FIRST time --
      // typically an admin default for an account that never configured it --
      // is switched on, the way typing a key switches it on. Only the first
      // time: a person who turned it off afterwards has said so, and their
      // answer survives every later boot.
      const firstSeen = !previousMeta[key];
      next[id] = {
        ...entry,
        apiKey: CREDENTIAL_SENTINEL,
        // The server's base URL is what the key is used with; an empty one
        // means the provider's default, which the page already knows.
        ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
        ...(firstSeen && entry.enabled === false ? { enabled: true } : {}),
      };
    } else if (entry.apiKey === CREDENTIAL_SENTINEL) {
      // Removed elsewhere (another browser, an admin): nothing stands behind
      // the sentinel any more.
      next[id] = { ...entry, apiKey: '' };
    } else {
      next[id] = entry;
    }
  }
  return next;
}

function applyMeta(meta: CredentialMeta, role: 'admin' | 'user') {
  useSettingsStore.setState((state) => {
    const patch: Partial<SettingsState> = {
      credentialStorage: 'server',
      credentialRole: role,
      credentialMeta: meta,
    };
    for (const section of CREDENTIAL_SECTIONS) {
      (patch as Record<string, unknown>)[STORE_KEY[section]] = reconcileSection(
        sectionEntries(state, section),
        section,
        meta,
        state.credentialMeta ?? {},
      );
    }
    return patch;
  });
}

/**
 * Migration for a browser that stored keys before this existed: every real
 * key in the store that the server has no own row for is sent once. Returns
 * the meta with the migrated rows added.
 */
async function migrateStoredKeys(meta: CredentialMeta): Promise<CredentialMeta> {
  const state = useSettingsStore.getState();
  const next = { ...meta };
  for (const section of CREDENTIAL_SECTIONS) {
    for (const [id, entry] of Object.entries(sectionEntries(state, section))) {
      if (!isRealKey(entry.apiKey)) continue;
      if (next[metaKey(section, id)]?.source === 'own') continue;
      const stored = await putCredential(section, id, {
        apiKey: entry.apiKey.trim(),
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      });
      if (stored) next[metaKey(section, id)] = { ...stored, source: 'own' };
    }
  }
  return next;
}

let syncStarted = false;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * After boot: a real key or a base URL that changes in the store is sent to
 * the server, debounced per provider, and the key is replaced with the
 * sentinel once the server confirms.
 */
function watchStore() {
  let previous = useSettingsStore.getState();
  useSettingsStore.subscribe((state) => {
    if (state.credentialStorage !== 'server') {
      previous = state;
      return;
    }
    for (const section of CREDENTIAL_SECTIONS) {
      const now = sectionEntries(state, section);
      const before = sectionEntries(previous, section);
      for (const [id, entry] of Object.entries(now)) {
        const was = before[id];
        const keyChanged = isRealKey(entry.apiKey) && entry.apiKey !== was?.apiKey;
        const urlChanged =
          typeof entry.baseUrl === 'string' &&
          entry.baseUrl !== (was?.baseUrl ?? '') &&
          (entry.apiKey === CREDENTIAL_SENTINEL || isRealKey(entry.apiKey));
        if (!keyChanged && !urlChanged) continue;
        const key = metaKey(section, id);
        clearTimeout(pending.get(key));
        pending.set(
          key,
          setTimeout(async () => {
            pending.delete(key);
            const latest = sectionEntries(useSettingsStore.getState(), section)[id];
            if (!latest) return;
            const patch: Entry = {};
            if (isRealKey(latest.apiKey)) patch.apiKey = latest.apiKey.trim();
            if (typeof latest.baseUrl === 'string') patch.baseUrl = latest.baseUrl;
            if (patch.apiKey === undefined && patch.baseUrl === undefined) return;
            const stored = await putCredential(section, id, patch);
            if (stored === undefined) return; // network/server error: keep what we have
            useSettingsStore.setState((s) => {
              const entries = { ...sectionEntries(s, section) };
              const current = entries[id];
              if (!current) return {};
              const meta = { ...s.credentialMeta };
              if (stored) meta[key] = { ...stored, source: 'own' };
              else delete meta[key];
              entries[id] = {
                ...current,
                // Only replace the key that was sent; a keystroke that landed
                // after the request left is still a real key to be sent next.
                ...(patch.apiKey !== undefined && current.apiKey === patch.apiKey
                  ? { apiKey: stored ? CREDENTIAL_SENTINEL : '' }
                  : {}),
              };
              return {
                credentialMeta: meta,
                [STORE_KEY[section]]: entries,
              } as Partial<SettingsState>;
            });
          }, 800),
        );
      }
    }
    previous = state;
  });
}

/** Boot: ask the server what it holds, migrate what the browser holds, watch. */
export async function startCredentialSync(): Promise<void> {
  if (syncStarted || typeof window === 'undefined') return;
  syncStarted = true;
  const list = await listFromServer();
  if (!list || list.storage !== 'server') {
    useSettingsStore.setState({ credentialStorage: 'none' });
    return;
  }
  const meta = await migrateStoredKeys(metaFrom(list));
  applyMeta(meta, list.role);
  watchStore();
}

/** Re-read the server after an explicit change (remove, set default). */
export async function refreshCredentials(): Promise<void> {
  const list = await listFromServer();
  if (!list || list.storage !== 'server') return;
  applyMeta(metaFrom(list), list.role);
}

/** Test seam. */
export function resetCredentialSyncForTests(): void {
  syncStarted = false;
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
