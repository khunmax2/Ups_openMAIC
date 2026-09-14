/**
 * Fork. Tell the server the owner's deck finished.
 *
 * The server keeps its own generation-complete flag (`stage_meta`, read by
 * the stage-meta sidecar), and `POST /api/stages/:id/generation-complete`
 * sets it -- but nothing called that route, so every course on the server
 * read as unfinished. The document's own outline flag stays the authority for
 * the classroom; this keeps the server's copy truthful. Owner-only on the
 * server side; best-effort here: it never throws and never blocks.
 */

import { apiPath } from '@/lib/base-path';

function serverPersistenceEnabled(): boolean {
  return typeof window !== 'undefined' && process.env.NEXT_PUBLIC_PERSISTENCE === '1';
}

export async function notifyServerGenerationComplete(
  stageId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  persistenceEnabled: boolean = serverPersistenceEnabled(),
): Promise<boolean> {
  if (!persistenceEnabled || !stageId) return false;
  try {
    const response = await fetchImpl(
      apiPath(`/api/stages/${encodeURIComponent(stageId)}/generation-complete`),
      { method: 'POST', credentials: 'include' },
    );
    return response.ok;
  } catch {
    return false;
  }
}
