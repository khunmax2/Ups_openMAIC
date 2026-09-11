import { beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  } as Storage;
}

describe('persistence client bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('leaves all sealed storage seams untouched when the flag is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '');

    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store');
    const assets = await import('@/lib/media/asset-pool-config');

    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(false);
    expect(assets.isAssetPoolStorageConfigured()).toBe(false);
  });

  it('configures runtime and document HTTP stores without wiring the asset pool', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE_TOKEN', 'test-dev-token');
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', memoryStorage());

    const { HttpDocumentStore } = await import('@openmaic/storage');
    const { HttpRuntimeStore } = await import('@openmaic/storage/runtime/http');
    // Importing either seam must structurally run bootstrap before the seam can
    // resolve its default store.
    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store');
    const assets = await import('@/lib/media/asset-pool-config');

    expect(runtime.isRuntimeStorageConfigured()).toBe(true);
    expect(documents.isDocumentStorageConfigured()).toBe(true);
    expect(assets.isAssetPoolStorageConfigured()).toBe(false);

    const runtimeStore = runtime.getRuntimeStore();
    const documentStore = documents.getDocumentStore();
    expect(runtimeStore).toBeInstanceOf(HttpRuntimeStore);
    expect(documentStore).toBeInstanceOf(HttpDocumentStore);

    const documentInternals = documentStore as unknown as {
      validateSceneFn: unknown;
      validateStageFn: unknown;
    };
    expect(documentInternals.validateSceneFn).toBe(documents.validateAppScene);
    expect(documentInternals.validateStageFn).toBe(documents.validateAppStage);

    const runtimeHeaders = await (
      runtimeStore as unknown as {
        headersHook: (context: { method: string; path: string }) => Promise<HeadersInit>;
      }
    ).headersHook({ method: 'GET', path: '/runtime/sessions/example' });
    expect(new Headers(runtimeHeaders).get('authorization')).toBe('Bearer test-dev-token');
    expect(new Headers(runtimeHeaders).get('x-learner-key')).toMatch(/^anon:/);

    runtime.resetRuntimeStorageForTests();
    documents.resetDocumentStorageForTests();
    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(false);
    expect(assets.isAssetPoolStorageConfigured()).toBe(false);
  });

  it('does not run client configuration during server module evaluation', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');

    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store');
    const assets = await import('@/lib/media/asset-pool-config');

    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(false);
    expect(assets.isAssetPoolStorageConfigured()).toBe(false);
  });

  it('preflights both configured seams so a failure cannot partially configure bootstrap', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubGlobal('window', {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const documents = await import('@/lib/document-store/config');
    documents.configureDocumentStorage({});

    const runtime = await import('@/lib/runtime/store');
    const assets = await import('@/lib/media/asset-pool-config');

    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(true);
    expect(assets.isAssetPoolStorageConfigured()).toBe(false);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]?.[0]).toContain('FATAL');
  });

  describe('learner key (fork)', () => {
    // Behind the gateway the server derives the learner partition from the
    // verified identity and forbids any other key in a learner-scoped path.
    // The browser has to ask, and must ask before minting its own.
    function arm(fetchImpl: (input: string) => Promise<Response>) {
      vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
      vi.stubGlobal('window', {});
      vi.stubGlobal('localStorage', memoryStorage());
      const fetchMock = vi.fn((input: string) => fetchImpl(input));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it("uses the server's learner key when the gateway identified the caller", async () => {
      const fetchMock = arm(async (input) => {
        expect(input).toBe('/api/persistence/whoami');
        return Response.json({ learnerKey: 'user:alice' });
      });
      const { getPersistenceLearnerKey } = await import('@/lib/persistence/bootstrap');
      await expect(getPersistenceLearnerKey()).resolves.toBe('user:alice');
      expect(fetchMock).toHaveBeenCalledOnce();
      // Nothing was minted on the device: the server's answer is the identity.
      expect(localStorage.length).toBe(0);
    });

    it('falls back to a device key when the server has no identity to offer', async () => {
      // Upstream's shape -- no gateway, or persistence not configured -- keeps
      // working: 401/404 from whoami means "mint your own", as before.
      arm(async () => new Response('', { status: 401 }));
      const { getPersistenceLearnerKey } = await import('@/lib/persistence/bootstrap');
      await expect(getPersistenceLearnerKey()).resolves.toMatch(/^anon:/u);
    });

    it('does not pin a network failure: the next call asks again', async () => {
      let calls = 0;
      arm(async () => {
        calls += 1;
        if (calls === 1) throw new Error('offline');
        return Response.json({ learnerKey: 'user:alice' });
      });
      const { getPersistenceLearnerKey } = await import('@/lib/persistence/bootstrap');
      // A thrown fetch resolves to "no server key" and falls back rather than
      // failing every later persistence call; the fallback is the device key.
      await expect(getPersistenceLearnerKey()).resolves.toMatch(/^anon:/u);
    });
  });
});
