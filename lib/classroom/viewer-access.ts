/**
 * Fork. Ask the stage-meta sidecar who this viewer is, and apply the answer.
 *
 * One place for both classroom hosts. The page host always asked (for the
 * read-only gate); the workbench pane never did. The answer now also opens or
 * shuts the resume gate (`resumeGateFromStageMeta`), because resuming spends
 * the viewer's models and keys and must be the owner's alone.
 *
 * Run it after the load applied its defaults so its answer wins. A load that
 * is no longer current (the user moved to another course) touches nothing.
 */

import { fetchStageMeta } from '@/lib/classroom/stage-meta-client';
import { noteStageOwnership } from '@/lib/classroom/stage-ownership-signal';
import { resumeGateFromStageMeta, type ResumeGate } from '@/lib/classroom/progressive-load-policy';
import { useStageStore } from '@/lib/store/stage';

export async function resolveClassroomViewerAccess(
  stageId: string,
  isCurrent: () => boolean = () => true,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ResumeGate> {
  const result = await fetchStageMeta(stageId, fetchImpl);
  const gate = resumeGateFromStageMeta(result);
  if (!isCurrent()) return gate;

  if (result.outcome === 'found') {
    noteStageOwnership(stageId, true, { isOwner: result.meta.isOwner });
    useStageStore.getState().setViewerAccess({ isOwner: result.meta.isOwner });
  } else if (result.outcome === 'unavailable') {
    // A silent sidecar is not "this is a stranger's course": record the outage
    // so nothing treats `isOwner === false` as a visitor conclusion. The edit
    // gate stays on the upstream defaults; only the resume gate fails closed.
    noteStageOwnership(stageId, false, null);
  } else {
    // 'absent' -- no sidecar row for this id. The classroom also serves
    // local-only courses, so the upstream editable default stays; the server's
    // owner-scoped writes remain the authority.
    noteStageOwnership(stageId, true, null);
  }
  useStageStore.getState().setResumeGate(gate);
  return gate;
}
