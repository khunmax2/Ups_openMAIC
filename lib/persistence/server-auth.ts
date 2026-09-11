/**
 * Authentication for the embedded persistence route, derived from the identity
 * the gateway verified.
 *
 * Upstream ships a development authenticator here: a bearer token whose public
 * half (`NEXT_PUBLIC_PERSISTENCE_TOKEN`) is compiled into the browser bundle,
 * with the learner key taken from a client-supplied `x-learner-key`. Its own
 * docstring says what that costs — "anyone who can load the page can read and
 * write EVERY learner partition and all documents" — and asks production to
 * "replace this module with real session verification and derive learner
 * identity from server-controlled claims". This is that replacement.
 *
 * Two consequences worth stating, because they are the whole point:
 *
 * - **Nothing here reads a client-supplied value.** The only input is the
 *   header the gateway sets after verifying a DeepWitya session, and the
 *   gateway strips any copy the client sent before setting its own.
 * - **Assets are partitioned per owner.** Upstream filed every asset under one
 *   `'shared'` principal, deliberately, because with no ownership on documents
 *   a per-header partition only made a shared document's images unreadable.
 *   Documents here carry a real owner, so assets follow the same owner —
 *   otherwise the isolation the rest of this change buys would stop at the
 *   first image.
 */
import type { IncomingMessage } from 'node:http';

import type { AssetPrincipal } from '@openmaic/storage';
import type { RuntimeHttpPrincipal } from '@openmaic/storage/server';

import {
  readAnonymousOwnerId,
  readVerifiedOrAnonymousOwnerId,
} from '@/lib/server/agent-runtime/owner';
import {
  identityHeaderName,
  studioGatewayRequired,
  studioOwnerIdFrom,
} from '@/lib/server/studio-identity';

type PersistencePrincipal = RuntimeHttpPrincipal & Partial<Pick<AssetPrincipal, 'key'>>;

/**
 * One owner id fills both slots.
 *
 * `key` partitions stored assets; `learnerKey` partitions runtime sessions.
 * They answer the same question here — which person is this — so deriving both
 * from one server-controlled claim is what keeps them from ever disagreeing.
 */
function principalFor(ownerId: string): PersistencePrincipal {
  return { key: ownerId, learnerKey: ownerId };
}

/**
 * The learner key the browser must use for this owner -- the same value the
 * principal above carries, exported so the `whoami` answer and the policy
 * check can never disagree. The browser cannot derive it: it does not see the
 * gateway header, and its own device key (`anon:<uuid>`) is what every
 * learner-scoped path carried before this existed -- every one of them 403.
 */
export function learnerKeyForOwner(ownerId: string): string {
  return principalFor(ownerId).learnerKey ?? ownerId;
}

/**
 * The anonymous fallback exists so this fork stays runnable the way upstream
 * runs: with no gateway in front, identity is the anonymous cookie upstream
 * already mints, and assets partition by it exactly as documents do. It is
 * never reached in our deployment — STUDIO_REQUIRE_GATEWAY refuses those
 * requests before they get here, and the compose contract check asserts that
 * variable is set — and keeping it costs one line while removing it would
 * fork every persistence test away from upstream's.
 *
 * It mints nothing: a request with neither header nor cookie is unauthenticated.
 */
function ownerFor(headers: Headers): string | undefined {
  return readVerifiedOrAnonymousOwnerId(headers);
}

export function authenticatePersistenceHeaders(headers: Headers): PersistencePrincipal | undefined {
  const ownerId = ownerFor(headers);
  return ownerId ? principalFor(ownerId) : undefined;
}

export async function authenticatePersistenceRequest(
  req: IncomingMessage,
): Promise<PersistencePrincipal | undefined> {
  // `IncomingMessage.headers` is a plain object with lower-cased names, and a
  // repeated header arrives as an array. Only the first value is considered: a
  // request carrying two identity headers is a request something tampered
  // with, and joining them would invent an owner id belonging to nobody.
  const raw = req.headers[identityHeaderName()];
  const ownerId = studioOwnerIdFrom(Array.isArray(raw) ? raw[0] : raw);
  if (ownerId) return principalFor(ownerId);

  // Same rule as ownerFor: where the gateway is required, the cookie is not
  // an identity. This is the WebSocket upgrade's path, which the Fetch-header
  // variant above never sees.
  if (studioGatewayRequired()) return undefined;
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  const anonymous = readAnonymousOwnerId(new Headers({ cookie }));
  return anonymous ? principalFor(anonymous) : undefined;
}
