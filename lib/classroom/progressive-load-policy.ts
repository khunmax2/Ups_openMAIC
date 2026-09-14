/** Bounded pane probe schedule for the stage-link/document availability gap. */
export const PANE_AVAILABILITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export function paneAvailabilityRetryDelay(attempt: number): number | null {
  return PANE_AVAILABILITY_RETRY_DELAYS_MS[attempt] ?? null;
}

/**
 * Fork. Whether this viewer may resume generation of the loaded course.
 *
 * Resuming generates the missing slides and their media with the VIEWER's
 * models and keys. Upstream is single-user and never asks; this deployment
 * serves every course from the server, so a course opened in another browser
 * -- a learner on a published course included -- resumed whenever a slide or
 * its media was missing. The stage-meta sidecar decides: `unknown` until it
 * answers, then `allowed` or `denied`.
 */
export type ResumeGate = 'unknown' | 'allowed' | 'denied';

export function shouldResumeClassroomGeneration({
  loading,
  error,
  transportPersistenceFenced,
  generationStarted,
  resumeGate,
}: {
  loading: boolean;
  error: string | null;
  transportPersistenceFenced: boolean;
  generationStarted: boolean;
  resumeGate: ResumeGate;
}): boolean {
  return (
    !loading &&
    !error &&
    !transportPersistenceFenced &&
    !generationStarted &&
    resumeGate === 'allowed'
  );
}

/**
 * The resume gate a stage-meta answer opens. The owner resumes; a visitor
 * does not. No sidecar row (`absent`: a local-only course, or a studio with no
 * server persistence) is upstream's single-user case and keeps resuming. No
 * answer at all (`unavailable`) fails closed: nothing is lost, the outlines
 * stay, and a reload asks again.
 */
export function resumeGateFromStageMeta(
  result:
    | { readonly outcome: 'found'; readonly meta: { readonly isOwner: boolean } }
    | { readonly outcome: 'absent' }
    | { readonly outcome: 'unavailable' },
): Exclude<ResumeGate, 'unknown'> {
  if (result.outcome === 'found') return result.meta.isOwner ? 'allowed' : 'denied';
  return result.outcome === 'absent' ? 'allowed' : 'denied';
}
