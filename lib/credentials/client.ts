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
 *   is not usable without it;
 * - a custom TTS/ASR provider's endpoint is the URL entered when it was added
 *   (`customDefaultBaseUrl`) until someone types into its Base URL field, and
 *   it travels with the key all the same: the server pairs a stored key only
 *   with the stored URL (audit F2), so a row without one is a key with
 *   nowhere to go. Rows stored before this carried no URL; boot fills them
 *   in, once;
 * - a custom provider exists only in the browser that added it, so a shared
 *   key carries the provider's definition (`profile`: name, endpoint, voices,
 *   models -- never a key). Another account's browser builds the provider
 *   from it, fills an empty model list from it, and drops what it built when
 *   the share goes. A share made before profiles travelled is filled in by
 *   the sharing admin's own browser, once.
 *
 * With no database behind the studio (`storage: 'none'`) none of this runs
 * and the browser keeps its keys, which is upstream's shape.
 */

import { apiPath } from '@/lib/base-path';
import { applyOrgCatalog, useSettingsStore, type SettingsState } from '@/lib/store/settings';

import { newerCatalog, type OrgCatalogAnswer } from './org-models';

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

/** What travels with a shared key so another browser can show the provider. Never a key. */
export type ProviderProfile = Record<string, unknown>;

// The fields of an entry that describe the provider rather than configure it
// for one person: a custom provider's whole definition, or the model list an
// admin added to a built-in image/video provider.
const PROFILE_FIELDS: Record<CredentialSection, readonly string[]> = {
  providers: [
    'name',
    'type',
    'defaultBaseUrl',
    'icon',
    'requiresApiKey',
    'models',
    'modelsUrl',
    'isBuiltIn',
  ],
  tts: [
    'customName',
    'customDefaultBaseUrl',
    'requiresApiKey',
    'modelId',
    'customVoices',
    'customModels',
    'isBuiltIn',
  ],
  asr: [
    'customName',
    'customDefaultBaseUrl',
    'requiresApiKey',
    'modelId',
    'customModels',
    'isBuiltIn',
  ],
  pdf: [],
  image: ['customModels', 'replaceBuiltInModels'],
  video: ['customModels', 'replaceBuiltInModels'],
  webSearch: [],
};

// The sections whose providers can be user-defined -- and so can be missing
// from a browser that never added them -- with the store field naming the one
// in use.
const SELECTED_KEY: Partial<Record<CredentialSection, keyof SettingsState>> = {
  providers: 'providerId',
  tts: 'ttsProviderId',
  asr: 'asrProviderId',
};

/** Stay under the server's limit; a share without its profile still shares the key. */
const PROFILE_LIMIT = 60_000;

export interface StoredCredentialMeta {
  masked: string;
  baseUrl: string;
  source: 'own' | 'default';
}

export type CredentialMeta = Record<string, StoredCredentialMeta>;

export function metaKey(section: CredentialSection, providerId: string): string {
  return `${section}:${providerId}`;
}

type Fields = { apiKey?: string; baseUrl?: string; enabled?: boolean };
type Entry = Fields & { customDefaultBaseUrl?: string; fromShare?: boolean };

/** What PUT accepts: the fields, an admin's request to copy their own row, a profile. */
export type CredentialPatch = Fields & { copyFromOwner?: boolean; profile?: ProviderProfile };

type SharedRow = {
  masked: string;
  baseUrl: string;
  profile?: ProviderProfile;
  // Fork: who shared it and when -- answered to admins only (lib/credentials/share-audit.ts).
  sharedAt?: number;
  sharedByYou?: boolean;
  sharedBy?: string;
};

/**
 * The endpoint this entry's key is used with -- the same URL the page sends
 * with a request: the Base URL field, else a custom provider's own URL.
 */
function endpointOf(entry: Entry): string {
  return entry.baseUrl?.trim() || entry.customDefaultBaseUrl?.trim() || '';
}

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
  defaults: Partial<Record<CredentialSection, Record<string, SharedRow>>>;
  /** Fork: the organisation's model catalog (lib/credentials/org-models.ts). */
  org?: OrgCatalogAnswer;
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

/** The describing fields of an entry or a received profile, and nothing else. */
function pickFields(section: CredentialSection, source: Record<string, unknown>): ProviderProfile {
  const picked: ProviderProfile = {};
  for (const field of PROFILE_FIELDS[section]) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked;
}

/**
 * The profile an entry would share, if it has one: a custom provider's
 * definition, or a built-in image/video provider's added models. A built-in
 * provider otherwise has nothing another browser lacks.
 */
function pickProfile(
  section: CredentialSection,
  entry: Record<string, unknown> | undefined,
): ProviderProfile | undefined {
  if (!entry) return undefined;
  if (SELECTED_KEY[section] && entry.isBuiltIn !== false) return undefined;
  const profile = pickFields(section, entry);
  if (section === 'image' || section === 'video') {
    const models = profile.customModels;
    if (!Array.isArray(models) || models.length === 0) return undefined;
  }
  return Object.keys(profile).length > 0 ? profile : undefined;
}

/** The profile this browser would share for a provider, if it has one to share. */
export function profileFor(
  section: CredentialSection,
  providerId: string,
): ProviderProfile | undefined {
  const entry = sectionEntries(useSettingsStore.getState(), section)[providerId];
  const profile = pickProfile(section, entry as Record<string, unknown> | undefined);
  if (!profile || JSON.stringify(profile).length > PROFILE_LIMIT) return undefined;
  return profile;
}

/** An admin shares their own key with every account, and the provider's definition with it. */
export async function shareCredential(
  section: CredentialSection,
  providerId: string,
): Promise<{ masked: string; baseUrl: string } | null | undefined> {
  const profile = profileFor(section, providerId);
  return putCredential(
    section,
    providerId,
    { copyFromOwner: true, ...(profile ? { profile } : {}) },
    'default',
  );
}

function metaFrom(list: ListResponse): CredentialMeta {
  const meta: CredentialMeta = {};
  for (const section of CREDENTIAL_SECTIONS) {
    for (const [id, row] of Object.entries(list.defaults[section] ?? {})) {
      meta[metaKey(section, id)] = { masked: row.masked, baseUrl: row.baseUrl, source: 'default' };
    }
    for (const [id, row] of Object.entries(list.own[section] ?? {})) {
      meta[metaKey(section, id)] = { masked: row.masked, baseUrl: row.baseUrl, source: 'own' };
    }
  }
  return meta;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** What a shared profile adds to an entry the browser has: only what the entry leaves empty. */
function fillFrom(
  section: CredentialSection,
  entry: Record<string, unknown>,
  profile: ProviderProfile | undefined,
): Record<string, unknown> {
  if (!profile) return {};
  const out: Record<string, unknown> = {};
  for (const field of PROFILE_FIELDS[section]) {
    if (profile[field] !== undefined && isEmpty(entry[field])) out[field] = profile[field];
  }
  return out;
}

/** A provider this browser never added, built from the profile an admin shared with its key. */
function materialize(section: CredentialSection, row: SharedRow): Entry | undefined {
  // A provider missing from this browser is a custom one by definition; the
  // profile need not say so, only describe it.
  if (!row.profile) return undefined;
  const profile = pickFields(section, row.profile);
  const common = { apiKey: CREDENTIAL_SENTINEL, baseUrl: row.baseUrl, fromShare: true };
  if (section === 'providers') {
    if (
      typeof profile.name !== 'string' ||
      typeof profile.type !== 'string' ||
      !Array.isArray(profile.models)
    ) {
      return undefined;
    }
    return { requiresApiKey: false, ...profile, isBuiltIn: false, ...common } as Entry;
  }
  if (section === 'tts') {
    return {
      enabled: true,
      modelId: '',
      customVoices: [],
      requiresApiKey: false,
      ...profile,
      isBuiltIn: false,
      ...common,
    } as Entry;
  }
  if (section === 'asr') {
    return {
      enabled: true,
      modelId: '',
      customModels: [],
      requiresApiKey: false,
      ...profile,
      isBuiltIn: false,
      ...common,
    } as Entry;
  }
  return undefined;
}

/** Rewrite one section's entries to reflect what the server holds. */
function reconcileSection(
  entries: Record<string, Entry>,
  section: CredentialSection,
  meta: CredentialMeta,
  previousMeta: CredentialMeta,
  defaults: SettingsState['credentialDefaults'],
  selectedId: string | undefined,
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
        ...fillFrom(section, entry as Record<string, unknown>, defaults[key]?.profile),
        apiKey: CREDENTIAL_SENTINEL,
        // The server's base URL is what the key is used with; an empty one
        // means the provider's default, which the page already knows.
        ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
        ...(firstSeen && entry.enabled === false ? { enabled: true } : {}),
      };
    } else if (entry.apiKey === CREDENTIAL_SENTINEL) {
      // The row behind the sentinel is gone -- removed here, in another
      // browser, or by an admin. The key and the base URL lived on that row
      // together, so both go: a base URL left behind would sit in the field
      // as though it were the person's own setting, and for a provider with
      // a real default (api.openai.com) hide that default's placeholder.
      // A provider this browser only had because it was shared goes with
      // the share -- unless it is the one in use, which keeps its place.
      if (entry.fromShare && id !== selectedId) continue;
      next[id] = { ...entry, apiKey: '', baseUrl: '' };
    } else {
      next[id] = entry;
    }
  }
  // Shared providers this browser has never seen, built from their profile.
  const prefix = `${section}:`;
  for (const [key, row] of Object.entries(defaults)) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (!id || id in next) continue;
    const built = materialize(section, row);
    if (built) next[id] = built;
  }
  return next;
}

function defaultsFrom(list: ListResponse): SettingsState['credentialDefaults'] {
  const out: SettingsState['credentialDefaults'] = {};
  for (const section of CREDENTIAL_SECTIONS) {
    for (const [id, row] of Object.entries(list.defaults[section] ?? {})) {
      out[metaKey(section, id)] = row;
    }
  }
  return out;
}

// While the store is being rewritten from what the server said, the watcher
// must not read the rewrite as the person typing: a base URL copied in from a
// shared row would otherwise be written back as an own row of its own, and an
// own row -- even a URL-only one -- shadows the shared key.
let applying = false;

function applyMeta(
  meta: CredentialMeta,
  role: 'admin' | 'user',
  defaults: SettingsState['credentialDefaults'],
  org: OrgCatalogAnswer | undefined,
) {
  applying = true;
  try {
    useSettingsStore.setState((state) => {
      const patch: Partial<SettingsState> = {
        credentialStorage: 'server',
        credentialRole: role,
        credentialMeta: meta,
        credentialDefaults: defaults,
      };
      for (const section of CREDENTIAL_SECTIONS) {
        const selectedKey = SELECTED_KEY[section];
        (patch as Record<string, unknown>)[STORE_KEY[section]] = reconcileSection(
          sectionEntries(state, section),
          section,
          meta,
          state.credentialMeta ?? {},
          defaults,
          selectedKey ? String(state[selectedKey] ?? '') : undefined,
        );
      }
      // Fork: the organisation's model catalog, applied over the lists the
      // credentials just shaped (lib/credentials/org-models.ts). An answer the
      // server could not read (no `servedAt`) keeps the copy this tab holds.
      patch.orgModelCatalog = newerCatalog(state.orgModelCatalog, org);
      Object.assign(patch, applyOrgCatalog({ ...state, ...patch } as SettingsState));
      return patch;
    });
  } finally {
    applying = false;
  }
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
      const url = endpointOf(entry);
      const stored = await putCredential(section, id, {
        apiKey: entry.apiKey.trim(),
        ...(url ? { baseUrl: url } : {}),
      });
      if (stored) next[metaKey(section, id)] = { ...stored, source: 'own' };
    }
  }
  return next;
}

/**
 * A custom provider's own row stored before its URL travelled with the key
 * holds the key alone, and the server will not pair it with the URL a request
 * sends. Fill the URL in from the one the provider was added with -- own rows
 * only (an admin's shared row is theirs to edit), once, because the filled row
 * no longer has an empty URL.
 */
async function backfillEndpoints(meta: CredentialMeta): Promise<CredentialMeta> {
  const state = useSettingsStore.getState();
  const next = { ...meta };
  for (const section of CREDENTIAL_SECTIONS) {
    for (const [id, entry] of Object.entries(sectionEntries(state, section))) {
      const key = metaKey(section, id);
      const row = next[key];
      if (row?.source !== 'own' || row.baseUrl) continue;
      const url = entry.customDefaultBaseUrl?.trim();
      if (!url) continue;
      const stored = await putCredential(section, id, { baseUrl: url });
      if (stored) next[key] = { ...stored, source: 'own' };
    }
  }
  return next;
}

/**
 * A share made before profiles travelled holds a key and a URL for a provider
 * only the sharer's browser can describe. That browser -- an admin's, whose
 * own row is the shared one -- sends the description, once: the filled row
 * then has a profile and is skipped.
 */
async function backfillSharedProfiles(list: ListResponse): Promise<void> {
  if (list.role !== 'admin') return;
  for (const section of CREDENTIAL_SECTIONS) {
    for (const [id, shared] of Object.entries(list.defaults[section] ?? {})) {
      if (shared.profile) continue;
      const own = list.own[section]?.[id];
      if (!own || own.masked !== shared.masked || own.baseUrl !== shared.baseUrl) continue;
      const profile = profileFor(section, id);
      if (!profile) continue;
      const stored = await putCredential(section, id, { profile }, 'default');
      if (stored !== undefined) shared.profile = profile;
    }
  }
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
    if (state.credentialStorage !== 'server' || applying) {
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
            const patch: Fields = {};
            if (isRealKey(latest.apiKey)) patch.apiKey = latest.apiKey.trim();
            // The URL goes with the key even when the field is empty and the
            // endpoint is a custom provider's own.
            const url = endpointOf(latest);
            if (typeof latest.baseUrl === 'string' || url) patch.baseUrl = url;
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
  const meta = await backfillEndpoints(await migrateStoredKeys(metaFrom(list)));
  await backfillSharedProfiles(list);
  applyMeta(meta, list.role, defaultsFrom(list), list.org);
  watchStore();
}

/** Re-read the server after an explicit change (remove, set default). */
export async function refreshCredentials(): Promise<void> {
  const list = await listFromServer();
  if (!list || list.storage !== 'server') return;
  applyMeta(metaFrom(list), list.role, defaultsFrom(list), list.org);
}

/** Test seam. */
export function resetCredentialSyncForTests(): void {
  syncStarted = false;
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
