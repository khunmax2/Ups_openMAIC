/**
 * Who the request belongs to, according to the gateway in front of this app.
 *
 * This module is fork-private. Upstream OpenMAIC resolves identity from an
 * anonymous cookie it mints itself (`lib/server/agent-runtime/owner.ts`) and
 * documents `authenticatedOwnerId` as the seam "a future auth integration must
 * thread". This is that integration: DeepWitya verifies its own session and
 * states the result in one request header, which every ownership decision here
 * then reads.
 *
 * **The header is trusted only because nothing can reach this app without going
 * through the gateway that sets it.** The studio container publishes no host
 * port, sits on its own compose network, and the gateway strips any copy a
 * client sent before adding its own. That is a network property, and network
 * properties are changed by people in a hurry, which is why
 * STUDIO_REQUIRE_GATEWAY exists below: it turns "the header is missing" from a
 * quiet fall-back into a refusal.
 */

/**
 * Both sides must use one name. A rename on one side alone fails silently —
 * the app keeps working while every reader stops seeing their own work — so the
 * deploy-time contract check asserts this default against the gateway source
 * and the pin file.
 */
const DEFAULT_IDENTITY_HEADER = 'x-deeptutor-owner';

/**
 * Read per call, not captured at import, for the same reason
 * `studioGatewayRequired()` is: a module-level constant makes the value depend
 * on when this module was first imported, which is not something a test — or a
 * reader — should have to reason about.
 */
export function identityHeaderName(): string {
  return (process.env.STUDIO_IDENTITY_HEADER || DEFAULT_IDENTITY_HEADER).toLowerCase();
}

/**
 * `user:` distinguishes a verified principal from the `anon:` identities
 * upstream mints for cookie-only visitors. The prefix is upstream's own
 * convention, established in its tests; keeping it means an authenticated
 * owner id can never collide with an anonymous one whatever the uid is.
 */
const IDENTITY_PREFIX = 'user:';

/**
 * DeepWitya's own bound on the value it puts after the prefix
 * (`AuthStatusResponse.user_id`, `min_length=1, max_length=64`). Matching it
 * rather than inventing a looser rule means a uid this app rejects is a uid
 * DeepWitya could not have issued.
 */
const MAX_UID_LENGTH = 64;

/** Anything the header spec would let through but a uid can never contain. */
const FORBIDDEN_IN_UID = /[\s\u0000-\u001f\u007f]/;

/**
 * Whether a request with no identity must be refused rather than served as a
 * fresh anonymous visitor.
 *
 * Off, a direct hit that bypassed the gateway is answered with an empty
 * workspace and looks like it worked — which is exactly what makes the bypass
 * hard to notice. On, it is a 401.
 *
 * Read on every call rather than captured at module load: a test that sets the
 * variable must not depend on import order, and reading an environment variable
 * is not a cost worth caching.
 */
export function studioGatewayRequired(): boolean {
  const value = process.env.STUDIO_REQUIRE_GATEWAY;
  return value === '1' || value === 'true';
}

/**
 * The verified owner id for this request, or undefined when the gateway said
 * nothing about who is asking.
 *
 * Returns the full `user:<uid>` form, because that — not the bare uid — is what
 * every ownership column stores.
 */
export function readStudioOwnerId(headers: Headers): string | undefined {
  return studioOwnerIdFrom(headers.get(identityHeaderName()));
}

/**
 * The same rule applied to a raw header value.
 *
 * Node's `IncomingMessage.headers` is a plain object, and building a `Headers`
 * from it to reuse the function above would throw on a value the WHATWG parser
 * rejects — turning a request that should be refused into a 500. Validating the
 * string directly keeps every malformed identity on the same path: refused.
 */
export function studioOwnerIdFrom(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;

  const value = raw.trim();
  if (!value.startsWith(IDENTITY_PREFIX)) return undefined;

  const uid = value.slice(IDENTITY_PREFIX.length);
  if (!uid || uid.length > MAX_UID_LENGTH) return undefined;
  if (FORBIDDEN_IN_UID.test(uid)) return undefined;

  return `${IDENTITY_PREFIX}${uid}`;
}

/**
 * The response a request gets when it arrived without an identity and this
 * deployment requires one.
 *
 * Deliberately says nothing about the gateway, the header name, or how to
 * satisfy it: whoever reached this app without going through the front door
 * does not need instructions for the next attempt. The reason is in the server
 * log instead, where an operator debugging a misconfigured gateway will look.
 */
export function refuseWithoutStudioIdentity(responseHeaders?: Headers): Response {
  console.error(
    '[studio-identity] refused a request with no identity header. Either the ' +
      'gateway did not set it, or something reached this app without passing ' +
      'through the gateway.',
  );
  const headers = new Headers(responseHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401, headers });
}
