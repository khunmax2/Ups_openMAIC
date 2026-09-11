import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Queryable, QueryResult } from '@openmaic/storage/runtime/pg';

/**
 * An in-memory Queryable that understands exactly the SQL the credential
 * store sends. Not a Postgres: it checks that the store asks the right
 * questions and folds the answers correctly, which is where the logic lives.
 * The schema and the real SQL are exercised against PostgreSQL 16 by the
 * storage-contract job that runs owner-materials.pg.test.ts.
 */
type Row = {
  scope: string;
  owner_id: string;
  section: string;
  provider_id: string;
  api_key: string;
  base_url: string;
};

function memoryQueryable(rows: Row[] = []): Queryable & { rows: Row[] } {
  const key = (r: Pick<Row, 'scope' | 'owner_id' | 'section' | 'provider_id'>) =>
    `${r.scope}|${r.owner_id}|${r.section}|${r.provider_id}`;
  return {
    rows,
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
      if (text.startsWith('SELECT')) {
        return {
          rows: rows.filter(
            (r) =>
              r.scope === p[0] &&
              r.owner_id === p[1] &&
              r.section === p[2] &&
              r.provider_id === p[3],
          ) as unknown as T[],
        };
      }
      if (text.startsWith('INSERT')) {
        const next: Row = {
          scope: p[0]!,
          owner_id: p[1]!,
          section: p[2]!,
          provider_id: p[3]!,
          api_key: p[4]!,
          base_url: p[5]!,
        };
        const i = rows.findIndex((r) => key(r) === key(next));
        if (i >= 0) rows[i] = next;
        else rows.push(next);
        return { rows: [] };
      }
      if (
        text.startsWith("DELETE FROM studio_credential WHERE scope = 'owner' AND owner_id = $1")
      ) {
        const gone = rows.filter((r) => r.scope === 'owner' && r.owner_id === p[0]);
        for (const g of gone) rows.splice(rows.indexOf(g), 1);
        return { rows: gone as unknown as T[] };
      }
      if (text.startsWith('DELETE')) {
        const i = rows.findIndex(
          (r) =>
            r.scope === p[0] && r.owner_id === p[1] && r.section === p[2] && r.provider_id === p[3],
        );
        if (i < 0) return { rows: [] };
        const [gone] = rows.splice(i, 1);
        return { rows: [gone] as unknown as T[] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

describe('credential store', () => {
  it("folds the owner rows and the defaults, and nobody else's", async () => {
    const { listCredentials } = await import('@/lib/server/credentials/store');
    const q = memoryQueryable([
      {
        scope: 'owner',
        owner_id: 'user:a',
        section: 'image',
        provider_id: 'custom-image',
        api_key: 'ka',
        base_url: 'https://a',
      },
      {
        scope: 'owner',
        owner_id: 'user:b',
        section: 'image',
        provider_id: 'custom-image',
        api_key: 'kb',
        base_url: 'https://b',
      },
      {
        scope: 'default',
        owner_id: '',
        section: 'tts',
        provider_id: 'openai-tts',
        api_key: 'kd',
        base_url: '',
      },
      {
        scope: 'owner',
        owner_id: 'user:a',
        section: 'nonsense',
        provider_id: 'x',
        api_key: 'k',
        base_url: '',
      },
    ]);
    const set = await listCredentials(q, 'user:a');
    expect(set.own).toEqual({ image: { 'custom-image': { apiKey: 'ka', baseUrl: 'https://a' } } });
    expect(set.defaults).toEqual({ tts: { 'openai-tts': { apiKey: 'kd', baseUrl: '' } } });
  });

  it('keeps the key when only the base URL is patched, and deletes an emptied row', async () => {
    const { upsertCredential, readCredential } = await import('@/lib/server/credentials/store');
    const q = memoryQueryable();
    const addr = {
      scope: 'owner' as const,
      ownerId: 'user:a',
      section: 'image' as const,
      providerId: 'custom-image',
    };
    await upsertCredential(q, addr, { apiKey: 'secret', baseUrl: 'https://one' });
    await upsertCredential(q, addr, { baseUrl: 'https://two' });
    expect(await readCredential(q, addr)).toEqual({ apiKey: 'secret', baseUrl: 'https://two' });
    expect(await upsertCredential(q, addr, { apiKey: '', baseUrl: '' })).toBeNull();
    expect(await readCredential(q, addr)).toBeNull();
  });

  it('stores a default under the empty owner, never under the admin who set it', async () => {
    const { upsertCredential } = await import('@/lib/server/credentials/store');
    const q = memoryQueryable();
    await upsertCredential(
      q,
      { scope: 'default', ownerId: 'user:admin', section: 'image', providerId: 'custom-image' },
      { apiKey: 'shared' },
    );
    expect(q.rows).toEqual([
      {
        scope: 'default',
        owner_id: '',
        section: 'image',
        provider_id: 'custom-image',
        api_key: 'shared',
        base_url: '',
      },
    ]);
  });

  it('masks a key the way DeepWitya does', async () => {
    const { maskCredential } = await import('@/lib/server/credentials/store');
    expect(maskCredential('sk-proj-abcdefghijkl-wxyz')).toBe('sk-pr••••wxyz');
    expect(maskCredential('short')).toBe('sh••••');
    expect(maskCredential('')).toBe('');
  });
});

describe('credential context and the resolver funnel', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.IMAGE_CUSTOM_API_KEY;
    delete process.env.IMAGE_CUSTOM_BASE_URL;
    delete process.env.IMAGE_OPENAI_API_KEY;
  });

  async function arm(rows: Row[]) {
    const q = memoryQueryable(rows);
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool: q }),
    }));
    vi.stubEnv('DATABASE_URL', 'postgres://fake');
    return q;
  }

  it("resolves the owner's stored key over the sentinel the browser sends", async () => {
    await arm([
      {
        scope: 'owner',
        owner_id: 'user:a',
        section: 'image',
        provider_id: 'custom-image',
        api_key: 'own-key',
        base_url: 'https://own',
      },
    ]);
    const { runWithCredentials } = await import('@/lib/server/credentials/context');
    const { resolveImageApiKey, resolveImageBaseUrl } =
      await import('@/lib/server/provider-config');
    await runWithCredentials('user:a', 'user', async () => {
      expect(resolveImageApiKey('custom-image', '***')).toBe('own-key');
      expect(resolveImageBaseUrl('custom-image', 'https://client')).toBe('https://own');
    });
  });

  it('falls back to the admin default when the owner has no row', async () => {
    await arm([
      {
        scope: 'default',
        owner_id: '',
        section: 'image',
        provider_id: 'custom-image',
        api_key: 'default-key',
        base_url: '',
      },
    ]);
    const { runWithCredentials } = await import('@/lib/server/credentials/context');
    const { resolveImageApiKey, getUsableImageProviderIds } =
      await import('@/lib/server/provider-config');
    await runWithCredentials('user:a', 'user', async () => {
      expect(resolveImageApiKey('custom-image', '***')).toBe('default-key');
      expect(getUsableImageProviderIds()).toEqual(['custom-image']);
    });
  });

  it("prefers the owner's own row over the default, and lists own first", async () => {
    await arm([
      {
        scope: 'default',
        owner_id: '',
        section: 'image',
        provider_id: 'openai-image',
        api_key: 'd',
        base_url: '',
      },
      {
        scope: 'owner',
        owner_id: 'user:a',
        section: 'image',
        provider_id: 'custom-image',
        api_key: 'o',
        base_url: '',
      },
      {
        scope: 'default',
        owner_id: '',
        section: 'image',
        provider_id: 'custom-image',
        api_key: 'd2',
        base_url: '',
      },
    ]);
    const { runWithCredentials } = await import('@/lib/server/credentials/context');
    const { resolveImageApiKey, getUsableImageProviderIds } =
      await import('@/lib/server/provider-config');
    await runWithCredentials('user:a', 'user', async () => {
      expect(resolveImageApiKey('custom-image')).toBe('o');
      expect(getUsableImageProviderIds()).toEqual(['custom-image', 'openai-image']);
    });
  });

  it('never treats the sentinel as a key, inside or outside a context', async () => {
    await arm([]);
    const { runWithCredentials } = await import('@/lib/server/credentials/context');
    const { resolveImageApiKey } = await import('@/lib/server/provider-config');
    expect(resolveImageApiKey('custom-image', '***')).toBe('');
    await runWithCredentials('user:a', 'user', async () => {
      expect(resolveImageApiKey('custom-image', '***')).toBe('');
      // A real client key still works for an ungated/legacy caller.
      expect(resolveImageApiKey('custom-image', 'typed')).toBe('typed');
    });
  });

  it('lets an operator-managed entry win over a stored row', async () => {
    await arm([
      {
        scope: 'owner',
        owner_id: 'user:a',
        section: 'image',
        provider_id: 'custom-image',
        api_key: 'own-key',
        base_url: '',
      },
    ]);
    vi.stubEnv('IMAGE_CUSTOM_API_KEY', 'operator-key');
    const { runWithCredentials } = await import('@/lib/server/credentials/context');
    const { resolveImageApiKey } = await import('@/lib/server/provider-config');
    await runWithCredentials('user:a', 'user', async () => {
      expect(resolveImageApiKey('custom-image', '***')).toBe('operator-key');
    });
  });

  it('reads an owner once per TTL, and again after that owner writes', async () => {
    const q = await arm([
      {
        scope: 'owner',
        owner_id: 'user:a',
        section: 'image',
        provider_id: 'custom-image',
        api_key: 'k1',
        base_url: '',
      },
    ]);
    const spy = vi.spyOn(q, 'query');
    const { runWithCredentials, invalidateCredentialCache } =
      await import('@/lib/server/credentials/context');
    const { resolveImageApiKey } = await import('@/lib/server/provider-config');
    const listCalls = () =>
      spy.mock.calls.filter(([sql]) => String(sql).includes("scope = 'default'")).length;

    await runWithCredentials('user:a', 'user', async () => {
      expect(resolveImageApiKey('custom-image')).toBe('k1');
    });
    await runWithCredentials('user:a', 'user', async () => {
      expect(resolveImageApiKey('custom-image')).toBe('k1');
    });
    expect(listCalls()).toBe(1);

    // A write through the store must be visible on the next request.
    q.rows[0]!.api_key = 'k2';
    invalidateCredentialCache('user:a');
    await runWithCredentials('user:a', 'user', async () => {
      expect(resolveImageApiKey('custom-image')).toBe('k2');
    });
    expect(listCalls()).toBe(2);

    // Another owner is another cache entry.
    await runWithCredentials('user:b', 'user', async () => {
      expect(resolveImageApiKey('custom-image')).toBe('');
    });
    expect(listCalls()).toBe(3);
  });

  it('runs the handler as upstream would when there is no database', async () => {
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => {
        throw new Error('should not be called');
      },
    }));
    vi.stubEnv('DATABASE_URL', '');
    const { runWithCredentials, currentCredentialContext } =
      await import('@/lib/server/credentials/context');
    await runWithCredentials('user:a', 'user', async () => {
      expect(currentCredentialContext()?.credentials).toEqual({ own: {}, defaults: {} });
    });
  });
});

describe('credential routes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  async function armRoutes(rows: Row[] = []) {
    const q = memoryQueryable(rows);
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool: q }),
    }));
    vi.stubEnv('DATABASE_URL', 'postgres://fake');
    vi.stubEnv('STUDIO_REQUIRE_GATEWAY', '1');
    // The real guard resolves hostnames; a test must not depend on DNS. What
    // is asserted here is that the route consults it and honours its verdict.
    vi.doMock('@/lib/server/ssrf-guard', () => ({
      validateUrlForSSRF: async (url: string) =>
        url.includes('169.254.169.254') ? 'Cloud metadata endpoints are blocked' : null,
    }));
    const routes = await import('@/lib/server/credentials/routes');
    return { q, ...routes };
  }

  const as = (owner: string, role?: 'admin' | 'user') => ({
    'x-deeptutor-owner': owner,
    ...(role ? { 'x-deeptutor-role': role } : {}),
  });

  it('refuses a request the gateway did not identify', async () => {
    const { handleList } = await armRoutes();
    const res = await handleList(new Request('http://s/api/studio/credentials'));
    expect(res.status).toBe(401);
  });

  it('answers masks, never keys, and says which are defaults', async () => {
    const { handleList } = await armRoutes([
      {
        scope: 'owner',
        owner_id: 'user:a',
        section: 'image',
        provider_id: 'custom-image',
        api_key: 'sk-proj-abcdefghijkl-wxyz',
        base_url: 'https://gpu',
      },
      {
        scope: 'default',
        owner_id: '',
        section: 'tts',
        provider_id: 'openai-tts',
        api_key: 'sk-default-0000000000-zzzz',
        base_url: '',
      },
    ]);
    const res = await handleList(
      new Request('http://s/api/studio/credentials', { headers: as('user:a') }),
    );
    const body = await res.json();
    expect(body.role).toBe('user');
    expect(body.storage).toBe('server');
    expect(body.own).toEqual({
      image: { 'custom-image': { masked: 'sk-pr••••wxyz', baseUrl: 'https://gpu' } },
    });
    expect(body.defaults).toEqual({
      tts: { 'openai-tts': { masked: 'sk-de••••zzzz', baseUrl: '' } },
    });
    expect(JSON.stringify(body)).not.toContain('abcdefghijkl');
  });

  it("stores an owner's key under that owner only", async () => {
    const { handleWrite, q } = await armRoutes();
    const res = await handleWrite(
      new Request('http://s/api/studio/credentials/image/custom-image', {
        method: 'PUT',
        headers: { ...as('user:a'), 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: 'sk-live-1234567890-abcd',
          baseUrl: 'https://gpu.example.net/v1',
        }),
      }),
      ['image', 'custom-image'],
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      stored: { masked: 'sk-li••••abcd', baseUrl: 'https://gpu.example.net/v1' },
    });
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0]).toMatchObject({ scope: 'owner', owner_id: 'user:a' });
  });

  it('refuses the sentinel as a key', async () => {
    const { handleWrite } = await armRoutes();
    const res = await handleWrite(
      new Request('http://s/x', {
        method: 'PUT',
        headers: { ...as('user:a'), 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: '***' }),
      }),
      ['image', 'custom-image'],
    );
    expect(res.status).toBe(400);
  });

  it('lets only an admin set or remove the shared default', async () => {
    const { handleWrite, q } = await armRoutes();
    const put = (role?: 'admin' | 'user') =>
      handleWrite(
        new Request('http://s/x', {
          method: 'PUT',
          headers: { ...as('user:boss', role), 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: 'sk-shared-000000000-abcd' }),
        }),
        ['default', 'image', 'custom-image'],
      );
    expect((await put('user')).status).toBe(403);
    expect((await put()).status).toBe(403);
    expect((await put('admin')).status).toBe(200);
    expect(q.rows[0]).toMatchObject({ scope: 'default', owner_id: '' });

    const del = await handleWrite(
      new Request('http://s/x', { method: 'DELETE', headers: as('user:someone', 'user') }),
      ['default', 'image', 'custom-image'],
    );
    expect(del.status).toBe(403);
    expect(q.rows).toHaveLength(1);
  });

  it('rejects an unknown section and a malformed provider id', async () => {
    const { handleWrite } = await armRoutes();
    const put = (segments: string[]) =>
      handleWrite(
        new Request('http://s/x', {
          method: 'PUT',
          headers: { ...as('user:a'), 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: 'k' }),
        }),
        segments,
      );
    expect((await put(['nope', 'custom-image'])).status).toBe(400);
    expect((await put(['image', '../etc'])).status).toBe(400);
    expect((await put(['image'])).status).toBe(404);
  });

  it('checks a stored base URL against the SSRF guard once, at write time', async () => {
    const { handleWrite } = await armRoutes();
    const res = await handleWrite(
      new Request('http://s/x', {
        method: 'PUT',
        headers: { ...as('user:a'), 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'k', baseUrl: 'http://169.254.169.254/latest' }),
      }),
      ['image', 'custom-image'],
    );
    expect(res.status).toBe(403);
  });
});
