import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  readStudioOwnerId,
  refuseWithoutStudioIdentity,
  studioGatewayRequired,
  studioOwnerIdFrom,
} from '@/lib/server/studio-identity';

function req(headers: Record<string, string> = {}): Pick<Request, 'headers'> {
  return { headers: new Headers(headers) };
}

const ok = async (ownerId: string, responseHeaders: Headers) =>
  new Response(ownerId, { status: 200, headers: responseHeaders });

describe('reading the gateway identity', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the full user: form, not the bare uid', () => {
    // Every ownership column stores the prefixed value, so handing back a bare
    // uid would partition the same person twice depending on the code path.
    expect(readStudioOwnerId(new Headers({ 'x-deeptutor-owner': 'user:alice' }))).toBe(
      'user:alice',
    );
  });

  it('is case-insensitive about the header name', () => {
    expect(readStudioOwnerId(new Headers({ 'X-DeepTutor-Owner': 'user:alice' }))).toBe(
      'user:alice',
    );
  });

  it('rejects everything that is not a verified user', () => {
    for (const value of ['', 'alice', 'user:', 'anon:0195c8c2', 'admin', ':alice']) {
      expect(readStudioOwnerId(new Headers({ 'x-deeptutor-owner': value }))).toBeUndefined();
    }
  });

  it('rejects a uid carrying whitespace or control characters', () => {
    // Not because a header could smuggle a newline — the runtime rejects that
    // long before here — but because a uid with a space is not a uid, and
    // accepting it would make `user:a b` and `user:a  b` two different people
    // who look like typos of each other.
    for (const uid of ['a b', 'a\tb', 'a\u007fb']) {
      expect(
        readStudioOwnerId(new Headers({ 'x-deeptutor-owner': `user:${uid}` })),
      ).toBeUndefined();
    }
    // A NUL cannot be put into a `Headers` at all, so the raw entry point
    // is the only way to reach that guard, and the only way such a value
    // could arrive: from `IncomingMessage.headers`.
    expect(studioOwnerIdFrom('user:a\u0000b')).toBeUndefined();
  });

  it('trims the surrounding whitespace a proxy may add', () => {
    expect(readStudioOwnerId(new Headers({ 'x-deeptutor-owner': '  user:alice  ' }))).toBe(
      'user:alice',
    );
  });
});

describe('the fail-closed switch', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('is off unless the deployment turns it on', () => {
    expect(studioGatewayRequired()).toBe(false);
    for (const value of ['', '0', 'no', 'false']) {
      vi.stubEnv('STUDIO_REQUIRE_GATEWAY', value);
      expect(studioGatewayRequired()).toBe(false);
    }
    for (const value of ['1', 'true']) {
      vi.stubEnv('STUDIO_REQUIRE_GATEWAY', value);
      expect(studioGatewayRequired()).toBe(true);
    }
  });

  it('says nothing useful to whoever tripped it', async () => {
    // Whoever reached this app without passing the gateway does not get told
    // what to send next time. The reason goes to the server log instead.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = refuseWithoutStudioIdentity();
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain('x-deeptutor-owner');
    expect(body).not.toContain('gateway');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('threading the identity through the request wrapper', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs the handler under the verified owner', async () => {
    const response = await withRequestOwnerId(req({ 'x-deeptutor-owner': 'user:alice' }), ok);
    expect(await response.text()).toBe('user:alice');
  });

  it('mints no anonymous cookie for a verified owner', async () => {
    // The cookie is how upstream partitions a visitor it does not know. Minting
    // one for someone it does know would leave a second identity lying around
    // for the same person.
    const response = await withRequestOwnerId(req({ 'x-deeptutor-owner': 'user:alice' }), ok);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('falls back to the anonymous cookie when the gateway is not required', async () => {
    const response = await withRequestOwnerId(req(), ok);
    expect(await response.text()).toMatch(/^anon:/);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=');
  });

  it('refuses instead of inventing an owner when the gateway is required', async () => {
    // Without this a request that bypassed the gateway is answered with a fresh
    // empty workspace, which looks exactly like the app working correctly.
    vi.stubEnv('STUDIO_REQUIRE_GATEWAY', '1');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(ok);
    const response = await withRequestOwnerId(req(), handler);
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('refuses a malformed identity as if none had arrived', async () => {
    vi.stubEnv('STUDIO_REQUIRE_GATEWAY', '1');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(ok);
    const response = await withRequestOwnerId(req({ 'x-deeptutor-owner': 'anon:x' }), handler);
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('keeps two accounts on separate partitions', async () => {
    const alice = await withRequestOwnerId(req({ 'x-deeptutor-owner': 'user:alice' }), ok);
    const bob = await withRequestOwnerId(req({ 'x-deeptutor-owner': 'user:bob' }), ok);
    expect(await alice.text()).not.toBe(await bob.text());
  });
});
