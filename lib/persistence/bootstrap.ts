import { BrowserKVStore, HttpDocumentStore, type HttpDocumentHeadersHook } from '@openmaic/storage';
import { HttpRuntimeStore, type HttpRuntimeHeadersHook } from '@openmaic/storage/runtime/http';

import {
  assertDocumentStorageConfigurable,
  configureDocumentStorage,
  type DocumentStorageOptions,
} from '@/lib/document-store/config';
import { assertRuntimeStorageConfigurable, configureRuntimeStorage } from '@/lib/runtime/config';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { apiPath } from '@/lib/base-path';

let deviceKv: BrowserKVStore | undefined;
let learnerKeyPromise: Promise<string> | undefined;

export function isBrowserPersistenceEnabled(): boolean {
  return typeof window !== 'undefined' && process.env.NEXT_PUBLIC_PERSISTENCE === '1';
}

/**
 * Fork. The server decides the learner partition, not the device.
 *
 * Upstream mints a per-device `anon:<uuid>` and puts it in every learner-scoped
 * runtime path. Behind the gateway the server derives the learner key from the
 * verified identity instead (server-auth.ts) and forbids a path that names any
 * other -- so a device key in the URL was a 403 on every quiz, whiteboard and
 * chat-history request, forty of them in one classroom session. Ask `whoami`
 * first; fall back to the device key only when the server has no identity to
 * offer (no gateway, or persistence not configured), which is upstream's shape.
 */
async function resolveServerLearnerKey(): Promise<string | undefined> {
  try {
    const response = await fetch(apiPath('/api/persistence/whoami'), { credentials: 'include' });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { learnerKey?: unknown };
    return typeof body.learnerKey === 'string' && body.learnerKey ? body.learnerKey : undefined;
  } catch {
    return undefined;
  }
}

export function getPersistenceLearnerKey(): Promise<string> {
  if (!isBrowserPersistenceEnabled()) {
    return Promise.reject(new Error('Browser persistence is not enabled'));
  }
  return (learnerKeyPromise ??= resolveServerLearnerKey()
    .then((serverKey) => serverKey ?? getLearnerKey((deviceKv ??= new BrowserKVStore())))
    .catch((error) => {
      learnerKeyPromise = undefined;
      throw error;
    }));
}

export async function getPersistenceRequestHeaders(): Promise<Record<string, string>> {
  if (!isBrowserPersistenceEnabled()) return {};
  const resolvedLearnerKey = await getPersistenceLearnerKey();
  const token = process.env.NEXT_PUBLIC_PERSISTENCE_TOKEN;
  return {
    'x-learner-key': resolvedLearnerKey,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

if (isBrowserPersistenceEnabled()) {
  const learnerKey = getPersistenceLearnerKey;
  const headers = getPersistenceRequestHeaders;

  const runtimeOptions = {
    store: () =>
      new HttpRuntimeStore({
        baseUrl: apiPath('/api/persistence'),
        headers: headers satisfies HttpRuntimeHeadersHook,
      }),
    learnerKey,
  };
  const documentOptions: DocumentStorageOptions = {
    store: ({ validateScene, validateStage }) =>
      new HttpDocumentStore({
        baseUrl: apiPath('/api/persistence'),
        headers: headers satisfies HttpDocumentHeadersHook,
        validateScene,
        validateStage,
      }),
  };
  try {
    // All checks are mutation-free. Once they pass, the synchronous configure
    // calls cannot leave only a subset of the persistence seams configured.
    assertRuntimeStorageConfigurable();
    assertDocumentStorageConfigurable();
    configureRuntimeStorage(runtimeOptions);
    configureDocumentStorage(documentOptions);
  } catch (error) {
    console.error(
      'FATAL: server-backed persistence bootstrap failed; no storage seam changes were applied',
      error,
    );
  }
}
