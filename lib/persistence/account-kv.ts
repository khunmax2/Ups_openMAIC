/**
 * Fork. The server side of upstream's account-scoped KV contract.
 *
 * Upstream marks two stores `account`-scoped -- provider settings
 * (`settings-storage`) and the user profile (`user-profile-storage`) -- as the
 * data "a server-backed deployment may sync across devices", and ships the
 * client for it (`HttpKVStore`), but no server. So both lived in one browser's
 * localStorage: a new browser came up with upstream's defaults (deleted
 * models back, added ones gone, toggles off, voice `default`) and a blank
 * profile. Found by the 2026-09-14 audit.
 *
 * This answers `/api/persistence/kv/...` with one row per (owner, key). The
 * owner is the gateway's verified identity, resolved by the persistence route
 * before this runs; nothing on the wire names a principal or a scope, exactly
 * as the contract requires (`packages/@openmaic/storage/test/kv-conformance-server.ts`).
 *
 * Values are stored as JSON text. The settings blob never carries a real API
 * key here: the client masks keys whenever this scope is server-backed
 * (`lib/store/account-kv.ts`); keys live in `studio_credential` only.
 */

import { createHash } from 'node:crypto';

import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';

const log = createLogger('AccountKV');

/**
 * Fork. Which account an answer was served for, as a short one-way tag.
 *
 * A tab keeps its stores in memory; when another tab signs in as someone
 * else, the shared cookie makes this tab's next write land on that other
 * account -- one click in a stale tab wrote one account's whole settings blob
 * as another's (audit F01, reproduced 2026-09-15). Every answer carries the
 * tag; the browser remembers the first one it saw and sends it back on each
 * write (lib/store/account-kv.ts). A write claiming a different account is
 * refused, and the browser reloads as the account now signed in.
 */
export const OWNER_HEADER = 'x-studio-kv-owner';

export function ownerTag(ownerId: string): string {
  return createHash('sha256').update(ownerId).digest('hex').slice(0, 16);
}

export const ACCOUNT_KV_SCHEMA = `
CREATE TABLE IF NOT EXISTS studio_account_kv (
  owner_id   TEXT   NOT NULL,
  key        TEXT   NOT NULL,
  value      TEXT   NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (owner_id, key)
);
`;

/** Room for a settings blob or a profile with an uploaded avatar. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Reads must never be served from a cache: another device may have just written. */
const NO_STORE = { 'cache-control': 'no-store' };

/** Every header spelling that would try to convey a scope; the contract has none. */
const PROHIBITED_SCOPE_HEADERS = ['scope', 'x-scope', 'kv-scope', 'x-kv-scope'];

class KvHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const schemaReady = new WeakMap<Queryable, Promise<void>>();

export function ensureAccountKvSchema(queryable: Queryable): Promise<void> {
  let ready = schemaReady.get(queryable);
  if (!ready) {
    ready = (async () => {
      for (const statement of splitSqlStatements(ACCOUNT_KV_SCHEMA)) {
        await queryable.query(statement);
      }
    })();
    // A failed attempt (database still starting) is retried by the next request.
    ready.catch(() => schemaReady.delete(queryable));
    schemaReady.set(queryable, ready);
  }
  return ready;
}

function pathParts(path: string): string[] {
  const raw = (path.split(/[?#]/u, 1)[0] ?? '').split('/');
  if (raw[0] === '') raw.shift();
  return raw.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw new KvHttpError(400, 'VALIDATION_FAILED', 'request path is not valid percent-encoding');
    }
  });
}

function assertNoScopeChannel(request: Request, url: URL, parts: string[]): void {
  const scoped =
    parts[1] === 'device' ||
    parts[1] === 'account' ||
    url.searchParams.has('scope') ||
    PROHIBITED_SCOPE_HEADERS.some((header) => request.headers.has(header));
  if (scoped) {
    throw new KvHttpError(
      400,
      'VALIDATION_FAILED',
      'kv requests must not carry a scope -- this contract is account-scoped and the ' +
        'principal is derived server-side',
    );
  }
}

async function readWriteBody(request: Request): Promise<{ value: unknown }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new KvHttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new KvHttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new KvHttpError(400, 'VALIDATION_FAILED', 'request body must be a JSON object');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new KvHttpError(400, 'VALIDATION_FAILED', 'request body must be a JSON object');
  }
  if (!('value' in body)) {
    throw new KvHttpError(400, 'VALIDATION_FAILED', 'kv write body must carry "value"');
  }
  if ('scope' in body) {
    throw new KvHttpError(400, 'VALIDATION_FAILED', 'kv write body must not carry a scope');
  }
  return body as { value: unknown };
}

async function route(
  request: Request,
  path: string,
  ownerId: string,
  queryable: Queryable,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = pathParts(path);
  if (parts[0] !== 'kv') throw new KvHttpError(404, 'ROUTE_NOT_FOUND', 'route not found');
  assertNoScopeChannel(request, url, parts);
  const method = request.method.toUpperCase();

  if (method === 'GET' && parts.length === 2 && parts[1] === 'keys') {
    await ensureAccountKvSchema(queryable);
    // A literal prefix: `starts_with`, not LIKE, so `%` and `_` in a prefix
    // are characters rather than wildcards.
    const result = await queryable.query(
      'SELECT key FROM studio_account_kv WHERE owner_id = $1 AND starts_with(key, $2) ORDER BY key',
      [ownerId, url.searchParams.get('prefix') ?? ''],
    );
    const keys = (result.rows as Array<{ key: unknown }>).map((row) => String(row.key));
    return Response.json(keys, { status: 200, headers: NO_STORE });
  }

  if (parts.length === 3 && parts[1] === 'entries') {
    const key = parts[2]!;
    if (method === 'GET') {
      await ensureAccountKvSchema(queryable);
      const result = await queryable.query(
        'SELECT value FROM studio_account_kv WHERE owner_id = $1 AND key = $2',
        [ownerId, key],
      );
      const row = (result.rows as Array<{ value: unknown }>)[0];
      if (!row) throw new KvHttpError(404, 'KEY_NOT_FOUND', `no kv entry ${JSON.stringify(key)}`);
      return Response.json(
        { value: JSON.parse(String(row.value)) as unknown },
        { status: 200, headers: NO_STORE },
      );
    }
    if (method === 'PUT') {
      const { value } = await readWriteBody(request);
      await ensureAccountKvSchema(queryable);
      const text = JSON.stringify(value);
      await queryable.query(
        `INSERT INTO studio_account_kv (owner_id, key, value, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (owner_id, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [ownerId, key, text, Date.now()],
      );
      // Fork: a write trail, so a setting that vanishes can be traced to the
      // write that dropped it. Who, which key, how big, which model -- never
      // the value itself.
      log.info(
        `Wrote ${key} for ${ownerId} (${Buffer.byteLength(text, 'utf8')} bytes${describe(key, value)})`,
      );
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      await ensureAccountKvSchema(queryable);
      await queryable.query('DELETE FROM studio_account_kv WHERE owner_id = $1 AND key = $2', [
        ownerId,
        key,
      ]);
      log.info(`Deleted ${key} for ${ownerId}`);
      return new Response(null, { status: 204 });
    }
  }

  throw new KvHttpError(404, 'ROUTE_NOT_FOUND', 'route not found');
}

/** The settings write's selected model, for the write trail. Ids only. */
function describe(key: string, value: unknown): string {
  if (key !== 'settings-storage') return '';
  const state = (value as { state?: Record<string, unknown> } | null)?.state;
  if (!state || typeof state !== 'object') return '';
  const provider = typeof state.providerId === 'string' ? state.providerId : '?';
  const model = typeof state.modelId === 'string' ? state.modelId : '?';
  const configs = state.providersConfig as Record<string, { models?: unknown }> | undefined;
  const models = configs?.[provider]?.models;
  const count = Array.isArray(models) ? `, ${models.length} ${provider} models` : '';
  return `; llm ${provider}/${model}${count}`;
}

/** A write from a tab that loaded another account never lands. */
function refuseAnotherAccountsWrite(request: Request, path: string, ownerId: string, tag: string) {
  const method = request.method.toUpperCase();
  if (method !== 'PUT' && method !== 'DELETE') return;
  const claimed = request.headers.get(OWNER_HEADER);
  // No tag: a client from before the guard, or a first write. The owner is
  // still the verified identity; only a tab's memory of another one is refused.
  if (!claimed || claimed === tag) return;
  log.warn(`Refused ${method} ${path}: the tab loaded another account (signed in as ${ownerId})`);
  throw new KvHttpError(
    409,
    'OWNER_CHANGED',
    'this tab was loaded for another account; reload to continue as the one signed in',
  );
}

/**
 * Answer one `/kv/...` request for `ownerId`. `path` is the request path
 * relative to the persistence route, still percent-encoded. Never throws.
 */
export async function handleAccountKvRequest(
  request: Request,
  path: string,
  ownerId: string,
  queryable: Queryable,
): Promise<Response> {
  const tag = ownerTag(ownerId);
  let response: Response;
  try {
    refuseAnotherAccountsWrite(request, path, ownerId, tag);
    response = await route(request, path, ownerId, queryable);
  } catch (error) {
    if (error instanceof KvHttpError) {
      response = Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    } else {
      console.error('account kv request failed', error);
      response = Response.json(
        { error: { code: 'INTERNAL_ERROR', message: 'internal server error' } },
        { status: 500 },
      );
    }
  }
  response.headers.set(OWNER_HEADER, tag);
  return response;
}
