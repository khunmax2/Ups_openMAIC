/**
 * The owner's credentials, made visible to code that does not know who is
 * asking (fork).
 *
 * `resolveSectionApiKey()` in provider-config.ts is the one funnel every
 * capability's key passes through, and it is synchronous; the 23 routes and
 * two job runners that reach it never pass an owner. Loading the owner's rows
 * once, at the edge of the request or job, into AsyncLocalStorage lets that
 * funnel consult them without changing its signature or its callers.
 *
 * Precedence, decided 2026-09-11: an operator-managed entry (env/YAML) still
 * wins, because it is the deployment saying "this one is ours"; then the
 * owner's own row; then the admin default; then whatever the client sent,
 * which is upstream's behaviour and the only path an ungated studio has.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { readAnonymousOwnerId } from '@/lib/server/agent-runtime/owner';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readStudioOwnerId, readStudioRole, type StudioRole } from '@/lib/server/studio-identity';

import {
  ensureCredentialSchema,
  listCredentials,
  type CredentialSection,
  type CredentialSet,
  type StoredCredential,
} from './store';

export interface CredentialContext {
  ownerId: string;
  role: StudioRole;
  credentials: CredentialSet;
}

const storage = new AsyncLocalStorage<CredentialContext>();

/**
 * What the browser sends in place of a key it no longer holds. The server
 * treats it as "use what you have for me", never as a key. Kept short and
 * impossible as a real key; DeepWitya uses the same three characters.
 */
export const CREDENTIAL_SENTINEL = '***';

export function isCredentialSentinel(value: string | undefined | null): boolean {
  return value?.trim() === CREDENTIAL_SENTINEL;
}

export function currentCredentialContext(): CredentialContext | undefined {
  return storage.getStore();
}

/** The owner's own row, else the default; undefined when neither exists. */
export function currentCredential(
  section: CredentialSection,
  providerId: string,
): (StoredCredential & { source: 'own' | 'default' }) | undefined {
  const ctx = storage.getStore();
  if (!ctx) return undefined;
  const own = ctx.credentials.own[section]?.[providerId];
  if (own) return { ...own, source: 'own' };
  const fallback = ctx.credentials.defaults[section]?.[providerId];
  if (fallback) return { ...fallback, source: 'default' };
  return undefined;
}

/** Provider ids the context can supply a credential for, own rows first. */
export function currentCredentialProviderIds(section: CredentialSection): string[] {
  const ctx = storage.getStore();
  if (!ctx) return [];
  const own = Object.keys(ctx.credentials.own[section] ?? {});
  const defaults = Object.keys(ctx.credentials.defaults[section] ?? {}).filter(
    (id) => !own.includes(id),
  );
  return [...own, ...defaults];
}

let schemaEnsured: Promise<void> | undefined;

async function credentialQueryable() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return undefined;
  const provider = await getServerPersistenceProvider(connectionString);
  const queryable = provider.pool;
  schemaEnsured ??= ensureCredentialSchema(queryable).catch((error) => {
    schemaEnsured = undefined;
    throw error;
  });
  await schemaEnsured;
  return queryable;
}

/** The queryable for the credential routes; undefined without a database. */
export async function credentialStore() {
  return credentialQueryable();
}

/**
 * Load the owner's credentials and run `fn` with them visible. Without a
 * database there is nothing to load and `fn` runs as before -- upstream's
 * shape, where the client's key is the only key.
 */
export async function runWithCredentials<T>(
  ownerId: string,
  role: StudioRole,
  fn: () => Promise<T>,
): Promise<T> {
  const queryable = await credentialQueryable().catch((error) => {
    console.error('[credentials] store unavailable; running without stored credentials', error);
    return undefined;
  });
  const credentials: CredentialSet = queryable
    ? await listCredentials(queryable, ownerId).catch((error) => {
        console.error('[credentials] load failed; running without stored credentials', error);
        return { own: {}, defaults: {} };
      })
    : { own: {}, defaults: {} };
  return storage.run({ ownerId, role, credentials }, fn);
}

/**
 * Route wrapper. Reads the identity the gateway set (or the anonymous cookie
 * when no gateway is in front) and runs the handler inside the owner's
 * credential context. A request with no identity at all runs the handler as
 * upstream would: nothing loaded, client key only.
 */
export function withOwnerCredentials<Req extends Request, Res extends Response, Args extends unknown[]>(
  handler: (request: Req, ...rest: Args) => Promise<Res>,
): (request: Req, ...rest: Args) => Promise<Res> {
  return async (request, ...rest) => {
    const ownerId = readStudioOwnerId(request.headers) ?? readAnonymousOwnerId(request.headers);
    if (!ownerId) return handler(request, ...rest);
    return runWithCredentials(ownerId, readStudioRole(request.headers), () =>
      handler(request, ...rest),
    );
  };
}
