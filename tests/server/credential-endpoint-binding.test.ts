import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Queryable, QueryResult } from '@openmaic/storage/runtime/pg';

/**
 * Fork. A key and the endpoint it is sent to are one credential.
 *
 * Found by the 2026-09-11 audit (F2): the key and the base URL were resolved
 * by two independent functions, so a caller who could not see the admin's
 * shared key could still pair it with a base URL of their own whenever the
 * stored row had no URL -- and the request then carried
 * `Authorization: Bearer <shared key>` to an endpoint the caller controls.
 *
 * These tests pin the rule for every section the resolver serves: when the
 * key comes from a stored row, the URL comes from that row (empty means the
 * provider's built-in default), never from the caller. The caller's URL is
 * honoured only where the caller's key is.
 */

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

const CALLER_URL = 'https://caller-controlled.example/v1';

const SECTIONS = [
  { section: 'providers', provider: 'openrouter', key: 'resolveApiKey', url: 'resolveBaseUrl' },
  { section: 'tts', provider: 'custom-tts-1', key: 'resolveTTSApiKey', url: 'resolveTTSBaseUrl' },
  { section: 'asr', provider: 'custom-asr', key: 'resolveASRApiKey', url: 'resolveASRBaseUrl' },
  { section: 'pdf', provider: 'mineru', key: 'resolvePDFApiKey', url: 'resolvePDFBaseUrl' },
  {
    section: 'image',
    provider: 'custom-image',
    key: 'resolveImageApiKey',
    url: 'resolveImageBaseUrl',
  },
] as const;

describe('a stored key never travels to a caller-supplied endpoint', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const name of Object.keys(process.env)) {
      if (/_(API_KEY|BASE_URL)$/.test(name)) delete process.env[name];
    }
  });

  async function arm(rows: Row[]) {
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool: memoryQueryable(rows) }),
    }));
    vi.stubEnv('DATABASE_URL', 'postgres://fake');
    const { runWithCredentials } = await import('@/lib/server/credentials/context');
    const config = await import('@/lib/server/provider-config');
    return {
      runWithCredentials,
      config: config as unknown as Record<string, (...a: string[]) => unknown>,
    };
  }

  for (const s of SECTIONS) {
    it(`${s.section}: shared default key with an empty URL ⇒ the provider default, not the caller's URL`, async () => {
      const { runWithCredentials, config } = await arm([
        {
          scope: 'default',
          owner_id: '',
          section: s.section,
          provider_id: s.provider,
          api_key: 'shared-key',
          base_url: '',
        },
      ]);
      await runWithCredentials('user:bob', 'user', async () => {
        expect(config[s.key]!(s.provider, '***')).toBe('shared-key');
        const url = config[s.url]!(s.provider, CALLER_URL);
        expect(url).not.toBe(CALLER_URL);
        // Either the provider's built-in default or nothing -- never the caller's.
        if (url !== undefined) expect(String(url)).not.toContain('caller-controlled');
      });
    });

    it(`${s.section}: shared default key with a stored URL ⇒ that URL`, async () => {
      const { runWithCredentials, config } = await arm([
        {
          scope: 'default',
          owner_id: '',
          section: s.section,
          provider_id: s.provider,
          api_key: 'shared-key',
          base_url: 'https://stored.example/v1',
        },
      ]);
      await runWithCredentials('user:bob', 'user', async () => {
        expect(config[s.url]!(s.provider, CALLER_URL)).toBe('https://stored.example/v1');
      });
    });

    it(`${s.section}: the owner's own key with an empty URL ⇒ still not the request's URL`, async () => {
      // The owner's own row is theirs, but the URL they want goes on the row
      // too (the settings form stores both); the request body is not the
      // place a stored credential's endpoint comes from.
      const { runWithCredentials, config } = await arm([
        {
          scope: 'owner',
          owner_id: 'user:bob',
          section: s.section,
          provider_id: s.provider,
          api_key: 'own-key',
          base_url: '',
        },
      ]);
      await runWithCredentials('user:bob', 'user', async () => {
        expect(config[s.key]!(s.provider, '***')).toBe('own-key');
        expect(config[s.url]!(s.provider, CALLER_URL)).not.toBe(CALLER_URL);
      });
    });

    it(`${s.section}: nothing stored ⇒ the caller's key and the caller's URL, as before`, async () => {
      const { runWithCredentials, config } = await arm([]);
      await runWithCredentials('user:bob', 'user', async () => {
        expect(config[s.key]!(s.provider, 'caller-key')).toBe('caller-key');
        expect(config[s.url]!(s.provider, CALLER_URL)).toBe(CALLER_URL);
      });
    });
  }

  it('a URL-only stored row (keyless provider) keeps its stored URL', async () => {
    const { runWithCredentials, config } = await arm([
      {
        scope: 'owner',
        owner_id: 'user:bob',
        section: 'providers',
        provider_id: 'ollama',
        api_key: '',
        base_url: 'http://ollama.internal:11434/v1',
      },
    ]);
    await runWithCredentials('user:bob', 'user', async () => {
      expect(config.resolveBaseUrl!('ollama', CALLER_URL)).toBe('http://ollama.internal:11434/v1');
    });
  });
});
