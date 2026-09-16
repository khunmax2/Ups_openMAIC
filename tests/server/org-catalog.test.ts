import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Queryable, QueryResult } from '@openmaic/storage/runtime/pg';

/**
 * Fork. The organisation's model catalog, server side: an admin sets which
 * models a provider offers every account and the model an account starts
 * with; every account is told the catalog with its credentials, and only an
 * admin is told who set it. Any admin may write (decided 2026-09-15), so each
 * change is recorded and logged.
 */

type Row = { key: string; value: string; updated_by: string; updated_at: number };
type CredRow = {
  scope: string;
  owner_id: string;
  section: string;
  provider_id: string;
  api_key: string;
  base_url: string;
  profile?: string;
  updated_by?: string;
  updated_at?: number;
};

function orgQueryable(rows = new Map<string, Row>(), creds: CredRow[] = []) {
  const credKey = (r: Pick<CredRow, 'scope' | 'owner_id' | 'section' | 'provider_id'>) =>
    `${r.scope}|${r.owner_id}|${r.section}|${r.provider_id}`;
  const queryable = {
    rows,
    creds,
    async query<T extends Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<T>> {
      const sql = text.replace(/\s+/gu, ' ').trim();
      const p = params as string[];
      if (/^(CREATE|ALTER)/iu.test(sql)) return { rows: [] };
      // The credential table, enough for a share and its removal.
      if (sql.startsWith('SELECT scope, owner_id, section, provider_id, api_key')) {
        return {
          rows: creds.filter(
            (r) =>
              r.scope === p[0] &&
              r.owner_id === p[1] &&
              r.section === p[2] &&
              r.provider_id === p[3],
          ) as unknown as T[],
        };
      }
      if (sql.startsWith('INSERT INTO studio_credential')) {
        const next: CredRow = {
          scope: p[0]!,
          owner_id: p[1]!,
          section: p[2]!,
          provider_id: p[3]!,
          api_key: p[4]!,
          base_url: p[5]!,
          ...(p[6] ? { profile: p[6] } : {}),
          ...(p[8] ? { updated_by: p[8], updated_at: Number(p[7]) } : {}),
        };
        const i = creds.findIndex((r) => credKey(r) === credKey(next));
        if (i >= 0) creds[i] = next;
        else creds.push(next);
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM studio_credential WHERE scope = $1')) {
        const i = creds.findIndex(
          (r) =>
            r.scope === p[0] && r.owner_id === p[1] && r.section === p[2] && r.provider_id === p[3],
        );
        if (i < 0) return { rows: [] };
        const [gone] = creds.splice(i, 1);
        return { rows: [gone] as unknown as T[] };
      }
      if (sql.startsWith('SELECT key, value, updated_by, updated_at FROM studio_org_setting')) {
        const [exact, prefix] = params as string[];
        return {
          rows: [...rows.values()].filter(
            (r) => r.key === exact || r.key.startsWith(prefix!),
          ) as unknown as T[],
        };
      }
      if (sql.startsWith('INSERT INTO studio_org_setting')) {
        const [key, value, by, at] = params as [string, string, string, number];
        rows.set(key, { key, value, updated_by: by, updated_at: at });
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM studio_org_setting')) {
        const [key] = params as string[];
        return { rows: (rows.delete(key!) ? [{ key }] : []) as unknown as T[] };
      }
      // The credentials list the same answer carries.
      if (sql.includes("WHERE (scope = 'owner' AND owner_id = $1) OR scope = 'default'")) {
        return {
          rows: creds.filter(
            (r) => (r.scope === 'owner' && r.owner_id === p[0]) || r.scope === 'default',
          ) as unknown as T[],
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return queryable as typeof queryable & Queryable;
}

const logged = vi.hoisted(() => ({ info: [] as string[] }));

describe('organisation model catalog routes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    logged.info.length = 0;
  });

  async function arm() {
    const q = orgQueryable();
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool: q }),
    }));
    vi.doMock('@/lib/logger', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/logger')>();
      return {
        ...actual,
        createLogger: (tag: string) => {
          const real = actual.createLogger(tag);
          return tag === 'OrgCatalog' || tag === 'Credentials'
            ? { ...real, info: (line: string) => logged.info.push(line) }
            : real;
        },
      };
    });
    vi.stubEnv('DATABASE_URL', 'postgres://fake');
    vi.stubEnv('STUDIO_REQUIRE_GATEWAY', '1');
    const org = await import('@/lib/server/org/routes');
    const credentials = await import('@/lib/server/credentials/routes');
    return { q, ...org, ...credentials };
  }

  const as = (owner: string, role?: 'admin' | 'user') => ({
    'x-deeptutor-owner': owner,
    ...(role ? { 'x-deeptutor-role': role } : {}),
  });

  const put = (
    handleOrgWrite: (r: Request, s: string[]) => Promise<Response>,
    headers: Record<string, string>,
    segments: string[],
    body: unknown,
  ) =>
    handleOrgWrite(
      new Request('http://s/x', {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      segments,
    );

  const models = {
    hidden: ['deepseek/deepseek-v4-flash'],
    extra: [{ id: 'google/gemini-3.5-flash-lite', name: 'Gemini' }],
  };

  it("lets only an admin change the organisation's models", async () => {
    const { handleOrgWrite, q } = await arm();
    const path = ['llm-models', 'openrouter'];
    expect((await put(handleOrgWrite, as('user:u1', 'user'), path, models)).status).toBe(403);
    expect((await put(handleOrgWrite, as('user:u1'), path, models)).status).toBe(403);
    expect((await put(handleOrgWrite, as('user:boss', 'admin'), path, models)).status).toBe(200);
    expect(q.rows.get('llm-models:openrouter')).toMatchObject({ updated_by: 'user:boss' });
  });

  it('keeps only what describes a model, and refuses what is not a model list', async () => {
    const { handleOrgWrite, q } = await arm();
    const admin = as('user:boss', 'admin');
    const res = await put(handleOrgWrite, admin, ['llm-models', 'openrouter'], {
      hidden: ['x', 'x'],
      extra: [
        { id: 'm1', name: 'M1', apiKey: 'smuggled', capabilities: { tools: true, sneaky: 1 } },
      ],
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(q.rows.get('llm-models:openrouter')!.value)).toEqual({
      hidden: ['x'],
      extra: [{ id: 'm1', name: 'M1', capabilities: { tools: true } }],
    });
    const bad = (segments: string[], body: unknown) => put(handleOrgWrite, admin, segments, body);
    expect((await bad(['llm-models', 'openrouter'], { hidden: 'x', extra: [] })).status).toBe(400);
    expect(
      (await bad(['llm-models', 'openrouter'], { hidden: [], extra: [{ name: 'no id' }] })).status,
    ).toBe(400);
    expect((await bad(['llm-models', '../etc'], models)).status).toBe(400);
    expect((await bad(['llm-default'], { providerId: 'openrouter' })).status).toBe(400);
    expect((await bad(['nope'], models)).status).toBe(404);
  });

  it('tells every account the catalog, and admins alone who set it', async () => {
    const { handleOrgWrite, handleList } = await arm();
    const admin = as('user:boss', 'admin');
    await put(handleOrgWrite, admin, ['llm-models', 'openrouter'], models);
    await put(handleOrgWrite, admin, ['llm-default'], {
      providerId: 'openrouter',
      modelId: 'google/gemini-3.5-flash-lite',
    });
    const listAs = async (owner: string, role: 'admin' | 'user') =>
      (
        await (
          await handleList(
            new Request('http://s/api/studio/credentials', { headers: as(owner, role) }),
          )
        ).json()
      ).org;

    const forUser = await listAs('user:pupil', 'user');
    expect(forUser.models.openrouter).toEqual({ ...models, updatedAt: expect.any(Number) });
    expect(forUser.defaultModel).toEqual({
      providerId: 'openrouter',
      modelId: 'google/gemini-3.5-flash-lite',
      updatedAt: expect.any(Number),
    });
    const forBoss = await listAs('user:boss', 'admin');
    expect(forBoss.models.openrouter).toMatchObject({ updatedByYou: true, updatedBy: 'boss' });
    const forOther = await listAs('user:demo', 'admin');
    expect(forOther.defaultModel).toMatchObject({ updatedByYou: false, updatedBy: 'boss' });
  });

  it("goes back to each account's own list when removed, and logs each change", async () => {
    const { handleOrgWrite, handleList } = await arm();
    const admin = as('user:boss', 'admin');
    await put(handleOrgWrite, admin, ['llm-models', 'openrouter'], models);
    const removed = await handleOrgWrite(
      new Request('http://s/x', { method: 'DELETE', headers: admin }),
      ['llm-models', 'openrouter'],
    );
    await expect(removed.json()).resolves.toEqual({ removed: true });
    const list = await (
      await handleList(new Request('http://s/api/studio/credentials', { headers: admin }))
    ).json();
    expect(list.org).toEqual({ models: {}, servedAt: expect.any(Number) });
    expect(logged.info).toEqual([
      "Set the organisation's openrouter models: by user:boss (hides 1, adds 1)",
      "Removed the organisation's openrouter models: by user:boss",
    ]);
  });

  it("clears the organisation's default when its model leaves the provider's list", async () => {
    const { handleOrgWrite, handleList } = await arm();
    const admin = as('user:boss', 'admin');
    const defaultOf = async () =>
      (
        await (
          await handleList(new Request('http://s/api/studio/credentials', { headers: admin }))
        ).json()
      ).org.defaultModel;
    const setDefault = (modelId: string) =>
      put(handleOrgWrite, admin, ['llm-default'], { providerId: 'openrouter', modelId });
    const setModels = (body: unknown) =>
      put(handleOrgWrite, admin, ['llm-models', 'openrouter'], body);

    // An organisation addition that is then dropped.
    await setModels(models);
    await setDefault('google/gemini-3.5-flash-lite');
    await setModels({ hidden: [], extra: [] });
    expect(await defaultOf()).toBeUndefined();

    // A built-in that is then hidden.
    await setDefault('deepseek/deepseek-v4-pro');
    await setModels({ hidden: ['deepseek/deepseek-v4-flash'], extra: [] });
    expect(await defaultOf()).toMatchObject({ modelId: 'deepseek/deepseek-v4-pro' });
    await setModels({ hidden: ['deepseek/deepseek-v4-pro'], extra: [] });
    expect(await defaultOf()).toBeUndefined();

    // The provider's list removed altogether; another provider's default is untouched.
    await setModels(models);
    await setDefault('google/gemini-3.5-flash-lite');
    await put(handleOrgWrite, admin, ['llm-models', 'google'], { hidden: [], extra: [] });
    expect(await defaultOf()).toMatchObject({ modelId: 'google/gemini-3.5-flash-lite' });
    await handleOrgWrite(new Request('http://s/x', { method: 'DELETE', headers: admin }), [
      'llm-models',
      'openrouter',
    ]);
    expect(await defaultOf()).toBeUndefined();
    expect(logged.info.filter((l) => l.includes('default model'))).toContainEqual(
      "Cleared the organisation's default model: openrouter/google/gemini-3.5-flash-lite left the openrouter models",
    );
  });

  // Fork (2026-09-17): one button publishes the key and the list together, so
  // the key's removal withdraws the list and the default with it.
  describe('withdrawing the shared key', () => {
    const keyOf = (owner: string, scope: 'owner' | 'default') => ({
      scope,
      owner_id: scope === 'default' ? '' : owner,
      section: 'providers',
      provider_id: 'openrouter',
      api_key: `key-of-${owner}`,
      base_url: 'https://openrouter.ai/api/v1',
      updated_by: owner,
      updated_at: 1,
    });
    const setUp = async (sharedBy: string) => {
      const world = await arm();
      world.q.creds.push(
        keyOf('user:boss', 'owner'),
        keyOf('user:demo', 'owner'),
        keyOf(sharedBy, 'default'),
      );
      const admin = as('user:boss', 'admin');
      await put(world.handleOrgWrite, admin, ['llm-models', 'openrouter'], models);
      await put(world.handleOrgWrite, admin, ['llm-default'], {
        providerId: 'openrouter',
        modelId: 'google/gemini-3.5-flash-lite',
      });
      await put(world.handleOrgWrite, admin, ['llm-models', 'google'], { hidden: [], extra: [] });
      logged.info.length = 0;
      return world;
    };
    const orgOf = async (world: Awaited<ReturnType<typeof arm>>) =>
      (
        await (
          await world.handleList(
            new Request('http://s/api/studio/credentials', { headers: as('user:boss', 'admin') }),
          )
        ).json()
      ).org;
    const remove = (world: Awaited<ReturnType<typeof arm>>, owner: string, segments: string[]) =>
      world.handleWrite(
        new Request('http://s/x', { method: 'DELETE', headers: as(owner, 'admin') }),
        segments,
      );

    it("takes the provider's list and the default with the shared key", async () => {
      const world = await setUp('user:boss');
      const res = await remove(world, 'user:boss', ['default', 'providers', 'openrouter']);
      expect(res.status).toBe(200);
      const org = await orgOf(world);
      expect(org.models.openrouter).toBeUndefined();
      expect(org.models.google).toBeDefined();
      expect(org.defaultModel).toBeUndefined();
      expect(logged.info).toContainEqual(
        "Withdrew the organisation's openrouter models and its default model: the shared key was removed",
      );
    });

    it('withdraws when the sharer removes their own key, and not when another admin removes theirs', async () => {
      const world = await setUp('user:boss');
      // Another admin removes their own key: the share and the list stay.
      await remove(world, 'user:demo', ['providers', 'openrouter']);
      expect(world.q.creds.some((r) => r.scope === 'default')).toBe(true);
      expect((await orgOf(world)).models.openrouter).toBeDefined();
      // The sharer removes theirs: the share goes, and the list with it.
      await remove(world, 'user:boss', ['providers', 'openrouter']);
      expect(world.q.creds.some((r) => r.scope === 'default')).toBe(false);
      const org = await orgOf(world);
      expect(org.models.openrouter).toBeUndefined();
      expect(org.defaultModel).toBeUndefined();
      expect(logged.info).toContainEqual(
        'Stopped sharing providers/openrouter: by user:boss; they removed the key it was copied from',
      );
    });
  });
});
