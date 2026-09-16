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

function orgQueryable(rows = new Map<string, Row>()) {
  const queryable = {
    rows,
    async query<T extends Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<T>> {
      const sql = text.replace(/\s+/gu, ' ').trim();
      if (/^(CREATE|ALTER)/iu.test(sql)) return { rows: [] };
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
        return { rows: [] };
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
          return tag === 'OrgCatalog'
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
});
