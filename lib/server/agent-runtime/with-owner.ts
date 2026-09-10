import {
  readStudioOwnerId,
  refuseWithoutStudioIdentity,
  studioGatewayRequired,
} from '@/lib/server/studio-identity';

import { resolveRequestOwnerId } from './owner';

/**
 * Resolve the owner identity and run a handler with its response headers.
 *
 * The Set-Cookie minted by resolveRequestOwnerId must ride every response,
 * including 4xx and 5xx: a client that retries after an error keeps the same
 * owner partition, while a 500 that dropped the cookie would silently make
 * the retry a different anonymous owner.
 *
 * Fork change: the identity the gateway verified is threaded through
 * `authenticatedOwnerId`, which is the seam upstream documents for exactly
 * this. When it is present no anonymous cookie is minted, so a signed-in
 * visitor is never partitioned under a throwaway id. When it is absent and
 * this deployment requires the gateway, the request is refused here rather
 * than served an empty workspace that looks like it worked.
 */
export async function withRequestOwnerId(
  req: Pick<Request, 'headers'>,
  handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
): Promise<Response> {
  const responseHeaders = new Headers();
  const studioOwnerId = readStudioOwnerId(req.headers);
  if (!studioOwnerId && studioGatewayRequired()) {
    return refuseWithoutStudioIdentity(responseHeaders);
  }
  const ownerId = resolveRequestOwnerId(req, responseHeaders, studioOwnerId);
  try {
    return await handler(ownerId, responseHeaders);
  } catch (error) {
    console.error('[agent-runtime] request failed under owner', error);
    return new Response('Internal Server Error', { status: 500, headers: responseHeaders });
  }
}
