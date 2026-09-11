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

import { readAnonymousOwnerId } from '@/lib/server/agent-runtime/owner';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  readStudioOwnerId,
  readStudioRole,
  refuseWithoutStudioIdentity,
  studioGatewayRequired,
} from '@/lib/server/studio-identity';

import { credentialStore } from './context';
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
  type StoredCredential,
} from './store';

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_FIELD = 4096;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function jsonError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

/** The identity the gateway set, or the anonymous cookie without a gateway. */
function ownerOf(request: Request): string | Response {
  const owner = readStudioOwnerId(request.headers) ?? readAnonymousOwnerId(request.headers);
  if (owner) return owner;
  if (studioGatewayRequired()) return refuseWithoutStudioIdentity();
  return jsonError(401, 'UNAUTHENTICATED', 'no identity on this request');
}

export interface MaskedCredential {
  masked: string;
  baseUrl: string;
}

export type MaskedSet = Partial<Record<CredentialSection, Record<string, MaskedCredential>>>;

function maskSet(rows: CredentialSet['own'] | CredentialSet['defaults']): MaskedSet {
  const out: MaskedSet = {};
  for (const [section, providers] of Object.entries(rows) as Array<
    [CredentialSection, Record<string, StoredCredential>]
  >) {
    out[section] = Object.fromEntries(
      Object.entries(providers).map(([id, row]) => [
        id,
        { masked: maskCredential(row.apiKey), baseUrl: row.baseUrl },
      ]),
    );
  }
  return out;
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
  return json(200, {
    role,
    storage: 'server',
    own: maskSet(set.own),
    defaults: maskSet(set.defaults),
  });
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

  if (request.method === 'DELETE') {
    const removed = await deleteCredential(store, full);
    return json(200, { removed });
  }
  if (request.method !== 'PUT') {
    return jsonError(405, 'INVALID_REQUEST', 'PUT or DELETE');
  }
  const patch = await readPatch(request);
  if (patch instanceof Response) return patch;
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
  const stored = await upsertCredential(store, full, fields);
  return json(200, {
    stored: stored ? { masked: maskCredential(stored.apiKey), baseUrl: stored.baseUrl } : null,
  });
}
