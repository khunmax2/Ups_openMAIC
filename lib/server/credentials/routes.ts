/**
 * The HTTP surface for server-side credentials (fork). One module, mounted by
 * two thin route files, so the rules live in one place:
 *
 *   GET    /api/studio/credentials                            what I have (masked)
 *   PUT    /api/studio/credentials/{section}/{providerId}     set my own
 *   DELETE /api/studio/credentials/{section}/{providerId}     remove my own
 *   PUT    /api/studio/credentials/default/{section}/{id}     admin: set the default
 *   DELETE /api/studio/credentials/default/{section}/{id}     admin: remove it
 *
 * A key goes in and never comes back out: every read answers a mask. The
 * role comes from the gateway's header, never from the request body.
 */

import { createLogger } from '@/lib/logger';
import { readVerifiedOrAnonymousOwnerId } from '@/lib/server/agent-runtime/owner';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  readStudioRole,
  refuseWithoutStudioIdentity,
  studioGatewayRequired,
} from '@/lib/server/studio-identity';

import { credentialStore, invalidateCredentialCache } from './context';
import {
  deleteCredential,
  isCredentialSection,
  listCredentials,
  maskCredential,
  readCredential,
  upsertCredential,
  type CredentialScope,
  type CredentialSection,
  type CredentialSet,
  type ProviderProfile,
  type StoredCredential,
} from './store';

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_FIELD = 4096;

const log = createLogger('Credentials');

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function jsonError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

/** The identity the gateway set, or -- only without a gateway -- the anonymous cookie. */
function ownerOf(request: Request): string | Response {
  const owner = readVerifiedOrAnonymousOwnerId(request.headers);
  if (owner) return owner;
  if (studioGatewayRequired()) return refuseWithoutStudioIdentity();
  return jsonError(401, 'UNAUTHENTICATED', 'no identity on this request');
}

export interface MaskedCredential {
  masked: string;
  baseUrl: string;
  profile?: ProviderProfile;
  /**
   * Fork. On a default row, answered to an admin only: when it was shared,
   * whether this admin shared it, and which account did.
   */
  sharedAt?: number;
  sharedByYou?: boolean;
  sharedBy?: string;
}

export type MaskedSet = Partial<Record<CredentialSection, Record<string, MaskedCredential>>>;

function maskSet(
  rows: CredentialSet['own'] | CredentialSet['defaults'],
  describe?: (row: StoredCredential) => Partial<MaskedCredential>,
): MaskedSet {
  const out: MaskedSet = {};
  for (const [section, providers] of Object.entries(rows) as Array<
    [CredentialSection, Record<string, StoredCredential>]
  >) {
    out[section] = Object.fromEntries(
      Object.entries(providers).map(([id, row]) => [
        id,
        {
          masked: maskCredential(row.apiKey),
          baseUrl: row.baseUrl,
          ...(row.profile ? { profile: row.profile } : {}),
          ...(describe ? describe(row) : {}),
        },
      ]),
    );
  }
  return out;
}

/** An owner id as an admin can look it up: the account id, without the channel prefix. */
function accountOf(ownerId: string): string {
  return ownerId.replace(/^user:/u, '');
}

export async function handleList(request: Request): Promise<Response> {
  const owner = ownerOf(request);
  if (owner instanceof Response) return owner;
  const role = readStudioRole(request.headers);
  const store = await credentialStore();
  if (!store) {
    // No database: nothing is stored server-side and the browser keeps its
    // own keys, upstream's shape. Say so rather than answering an empty set
    // the client would read as "you have nothing".
    return json(200, { role, storage: 'none', own: {}, defaults: {} });
  }
  const set = await listCredentials(store, owner);
  // Fork. Any admin may share, replace or stop a default, so an admin is told
  // whose key each shared one is and since when. Other accounts are not told
  // who; they only use it.
  const sharer =
    role === 'admin'
      ? (row: StoredCredential): Partial<MaskedCredential> => ({
          sharedByYou: !!row.updatedBy && row.updatedBy === owner,
          ...(row.updatedBy ? { sharedBy: accountOf(row.updatedBy) } : {}),
          ...(row.updatedAt ? { sharedAt: row.updatedAt } : {}),
        })
      : undefined;
  return json(200, {
    role,
    storage: 'server',
    own: maskSet(set.own),
    defaults: maskSet(set.defaults, sharer),
  });
}

/** Whose share a change touched, for the log line. Ids only -- never a key. */
function sharedBy(previous: StoredCredential | null): string {
  return previous?.updatedBy || 'an admin, before sharers were recorded';
}

interface Address {
  scope: CredentialScope;
  section: CredentialSection;
  providerId: string;
}

function parseAddress(segments: string[]): Address | Response {
  const [first, ...rest] = segments;
  const scope: CredentialScope = first === 'default' ? 'default' : 'owner';
  const parts = scope === 'default' ? rest : segments;
  if (parts.length !== 2) {
    return jsonError(404, 'ROUTE_NOT_FOUND', 'expected /{section}/{providerId}');
  }
  const [section, providerId] = parts;
  if (!section || !isCredentialSection(section)) {
    return jsonError(400, 'INVALID_REQUEST', `unknown section: ${section}`);
  }
  if (!providerId || !PROVIDER_ID.test(providerId)) {
    return jsonError(400, 'INVALID_REQUEST', 'invalid provider id');
  }
  return { scope, section, providerId };
}

type Patch = Partial<StoredCredential> & { copyFromOwner?: boolean };

// Fork. A profile describes a provider (see ProviderProfile in ./store) so
// another account's browser can show one it never added. It is not a
// credential and must not become a second place to keep one.
const MAX_PROFILE = 64 * 1024;
const SECRET_FIELD = /^(api_?key|access_?key(_?id|_?secret)?)$|secret|token|password/iu;

function readProfile(value: unknown): ProviderProfile | Response {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return jsonError(400, 'INVALID_REQUEST', 'profile must be an object');
  }
  const profile = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([field]) => !SECRET_FIELD.test(field)),
  );
  if (JSON.stringify(profile).length > MAX_PROFILE) {
    return jsonError(400, 'INVALID_REQUEST', 'profile is too large');
  }
  return profile;
}

async function readPatch(request: Request): Promise<Patch | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'INVALID_REQUEST', 'body must be JSON');
  }
  if (!body || typeof body !== 'object') {
    return jsonError(400, 'INVALID_REQUEST', 'body must be an object');
  }
  const patch: Patch = {};
  // An admin promoting their own key to the shared default has no key to
  // send -- the browser never holds it -- so the copy happens server-side.
  if ((body as Record<string, unknown>).copyFromOwner === true) patch.copyFromOwner = true;
  for (const field of ['apiKey', 'baseUrl'] as const) {
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > MAX_FIELD) {
      return jsonError(400, 'INVALID_REQUEST', `${field} must be a string`);
    }
    patch[field] = value.trim();
  }
  const profile = (body as Record<string, unknown>).profile;
  if (profile !== undefined) {
    const checked = readProfile(profile);
    if (checked instanceof Response) return checked;
    patch.profile = checked;
  }
  if (patch.apiKey === '***') {
    // The sentinel is what the browser sends when it does not hold a key; it
    // must never be stored as one.
    return jsonError(400, 'INVALID_REQUEST', 'apiKey is the sentinel, not a key');
  }
  return patch;
}

export async function handleWrite(request: Request, segments: string[]): Promise<Response> {
  const owner = ownerOf(request);
  if (owner instanceof Response) return owner;
  const address = parseAddress(segments);
  if (address instanceof Response) return address;
  const role = readStudioRole(request.headers);
  if (address.scope === 'default' && role !== 'admin') {
    return jsonError(403, 'FORBIDDEN', 'only an administrator can set the shared default');
  }
  const store = await credentialStore();
  if (!store) {
    return jsonError(503, 'PERSISTENCE_NOT_CONFIGURED', 'server persistence not configured');
  }
  const full = { ...address, ownerId: owner };
  const shared = address.scope === 'default';
  const target = `${address.section}/${address.providerId}`;
  // Fork. Any admin may change what every account falls back to, so each
  // change is logged with who made it and whose share it touched.
  const previous = shared ? await readCredential(store, full) : null;

  if (request.method === 'DELETE') {
    const removed = await deleteCredential(store, full);
    invalidateCredentialCache(shared ? undefined : owner);
    if (shared && removed) {
      log.info(`Stopped sharing ${target}: by ${owner}; it was shared by ${sharedBy(previous)}`);
    }
    return json(200, { removed });
  }
  if (request.method !== 'PUT') {
    return jsonError(405, 'INVALID_REQUEST', 'PUT or DELETE');
  }
  const patch = await readPatch(request);
  if (patch instanceof Response) return patch;
  if (patch.profile && address.scope !== 'default') {
    // Only a shared row reaches a browser that lacks the provider.
    return jsonError(400, 'INVALID_REQUEST', 'a profile belongs to a shared default');
  }
  if (patch.copyFromOwner) {
    if (address.scope !== 'default') {
      return jsonError(400, 'INVALID_REQUEST', 'copyFromOwner applies to the default scope');
    }
    const own = await readCredential(store, { ...address, scope: 'owner', ownerId: owner });
    if (!own) return jsonError(404, 'ASSET_NOT_FOUND', 'you have no key of your own to promote');
    patch.apiKey = own.apiKey;
    patch.baseUrl = own.baseUrl;
  }
  if (patch.baseUrl) {
    // A stored base URL is used without the per-request SSRF check the
    // generate routes run on a client-sent one; check it once, here.
    const ssrfError = await validateUrlForSSRF(patch.baseUrl);
    if (ssrfError) return jsonError(403, 'INVALID_URL', ssrfError);
  }
  const { copyFromOwner: _copy, ...fields } = patch;
  const stored = await upsertCredential(store, full, fields, owner);
  invalidateCredentialCache(shared ? undefined : owner);
  if (shared) {
    if (!stored) {
      log.info(`Cleared the shared ${target}: by ${owner}; it was shared by ${sharedBy(previous)}`);
    } else if (patch.apiKey !== undefined) {
      const replaced = !previous
        ? ''
        : previous.updatedBy === owner
          ? '; replaced their own earlier share'
          : `; replaced the key shared by ${sharedBy(previous)}`;
      log.info(`Shared ${target}: by ${owner}${replaced}`);
    } else {
      log.info(`Updated the shared ${target} (endpoint or description): by ${owner}`);
    }
  }
  return json(200, {
    stored: stored ? { masked: maskCredential(stored.apiKey), baseUrl: stored.baseUrl } : null,
  });
}
