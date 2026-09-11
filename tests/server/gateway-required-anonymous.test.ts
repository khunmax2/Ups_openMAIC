import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Queryable, QueryResult } from '@openmaic/storage/runtime/pg';

/**
 * Fork. Where the gateway is required, an anonymous cookie is not an identity.
 *
 * The 2026-09-11 audit (F4) sent a request with no identity header and a
 * well-formed `anonymous_id` cookie straight at the studio with
 * STUDIO_REQUIRE_GATEWAY=1, and the credentials listing answered 200 -- the
 * route read `verified ?? anonymous` and only then asked whether a gateway
 * was required. Four readers had that order; `withRequestOwnerId` had the
 * right one. These tests send the audit's exact request at each of them.
 *
 * The no-gateway shape stays: with the variable unset, the same cookie is an
 * owner, the way upstream runs.
 */

const ANON = 'anonymous_id=6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const SHARED_KEY = 'shared-admin-key';

type Row = {
  scope: string;
  owner_id: string;
  section: string;
  provider_id: string;
  api_key: string;
  base_url: string;
};

function memoryQueryable(rows: Row[]): Queryable {
  return {
    async query<T extends Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<T>> {
      const p = params as string[];
      if (text.startsWith('CREATE')) return { rows: [] };
      if (text.includes("WHERE (scope = 'owner' AND owner_id = $1) OR scope = 'default'")) {
        return {
          rows: rows.filter(
            (r) => (r.scope === 'owner' && r.owner_id === p[0]) || r.scope === 'default',
          ) as unknown as T[],
        };
      }
      return { rows: [] };
    },
  } as Queryable;
}

const sharedImageKey: Row = {
  scope: 'default',
  owner_id: '',
  section: 'image',
  provider_id: 'custom-image',
  api_key: SHARED_KEY,
  base_url: 'https://gpu.example/v1',
};

describe('gateway required: an anonymous cookie is not an identity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', 'postgres://fake');
    vi.stubEnv('STUDIO_REQUIRE_GATEWAY', '1');
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool: memoryQueryable([sharedImageKey]) }),
    }));
  });

  it('the helper answers undefined for the cookie alone, the verified id when set', async () => {
    const { readVerifiedOrAnonymousOwnerId } = await import('@/lib/server/agent-runtime/owner');
    expect(readVerifiedOrAnonymousOwnerId(new Headers({ cookie: ANON }))).toBeUndefined();
    expect(
      readVerifiedOrAnonymousOwnerId(
        new Headers({ cookie: ANON, 'x-deeptutor-owner': 'user:alice' }),
      ),
    ).toBe('user:alice');
  });

  it('credentials listing: 401, not the masked shared rows (the audit request)', async () => {
    const { handleList } = await import('@/lib/server/credentials/routes');
    const res = await handleList(
      new Request('http://s/api/studio/credentials', { headers: { cookie: ANON } }),
    );
    expect(res.status).toBe(401);
  });

  it('credential context: nothing is loaded for the cookie -- the shared key stays out of reach', async () => {
    const { withOwnerCredentials } = await import('@/lib/server/credentials/context');
    const { resolveImageApiKey } = await import('@/lib/server/provider-config');
    const handler = withOwnerCredentials(async () => {
      return Response.json({ key: resolveImageApiKey('custom-image', '***') });
    });
    const res = await handler(new Request('http://s/api/x', { headers: { cookie: ANON } }));
    expect(await res.json()).toEqual({ key: '' });
  });

  it('persistence auth: no principal from Fetch headers nor from the raw upgrade path', async () => {
    const { authenticatePersistenceHeaders, authenticatePersistenceRequest } =
      await import('@/lib/persistence/server-auth');
    expect(authenticatePersistenceHeaders(new Headers({ cookie: ANON }))).toBeUndefined();
    const raw = { headers: { cookie: ANON } } as unknown as import('node:http').IncomingMessage;
    expect(await authenticatePersistenceRequest(raw)).toBeUndefined();
  });
});

describe('no gateway required: the anonymous cookie is an owner, as upstream runs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', 'postgres://fake');
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool: memoryQueryable([sharedImageKey]) }),
    }));
  });

  it('the helper returns the anonymous owner', async () => {
    const { readVerifiedOrAnonymousOwnerId } = await import('@/lib/server/agent-runtime/owner');
    expect(readVerifiedOrAnonymousOwnerId(new Headers({ cookie: ANON }))).toBe(
      'anon:6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    );
  });

  it('persistence auth still yields a principal for the cookie', async () => {
    const { authenticatePersistenceHeaders } = await import('@/lib/persistence/server-auth');
    expect(authenticatePersistenceHeaders(new Headers({ cookie: ANON }))?.key).toBe(
      'anon:6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    );
  });
});
