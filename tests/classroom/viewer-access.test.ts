import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fork. The classroom asks the stage-meta sidecar who this viewer is BEFORE
 * it may resume generation. Both hosts -- the classroom page and the
 * workbench pane -- go through `resolveClassroomViewerAccess`, so the answer
 * lands in one place: the store's ownership fields and its resume gate.
 */

import { resolveClassroomViewerAccess } from '@/lib/classroom/viewer-access';
import {
  getStageAccessSignal,
  isStageOwnershipUnknown,
  resetStageOwnershipSignals,
} from '@/lib/classroom/stage-ownership-signal';
import { useStageStore } from '@/lib/store/stage';

function answering(status: number, body?: unknown) {
  return vi.fn(async () =>
    status === 200
      ? new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('', { status }),
  ) as unknown as typeof globalThis.fetch;
}

describe('resolveClassroomViewerAccess', () => {
  beforeEach(() => {
    resetStageOwnershipSignals();
    useStageStore.setState({ isOwner: true, readOnly: false, resumeGate: 'unknown' });
  });

  it("opens the resume gate for the course's owner", async () => {
    const gate = await resolveClassroomViewerAccess(
      's1',
      () => true,
      answering(200, { isOwner: true }),
    );
    expect(gate).toBe('allowed');
    expect(useStageStore.getState()).toMatchObject({
      isOwner: true,
      readOnly: false,
      resumeGate: 'allowed',
    });
    expect(getStageAccessSignal('s1')).toEqual({ isOwner: true });
  });

  it('keeps it shut for a visitor, and makes the classroom read-only', async () => {
    const gate = await resolveClassroomViewerAccess(
      's1',
      () => true,
      answering(200, { isOwner: false }),
    );
    expect(gate).toBe('denied');
    expect(useStageStore.getState()).toMatchObject({
      isOwner: false,
      readOnly: true,
      resumeGate: 'denied',
    });
  });

  it('opens it for a course the sidecar has no row for (local-only, upstream behaviour)', async () => {
    const gate = await resolveClassroomViewerAccess('s1', () => true, answering(404));
    expect(gate).toBe('allowed');
    expect(useStageStore.getState().resumeGate).toBe('allowed');
    expect(isStageOwnershipUnknown('s1')).toBe(false);
  });

  it('keeps it shut when the sidecar does not answer, and records the outage', async () => {
    const offline = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof globalThis.fetch;
    const gate = await resolveClassroomViewerAccess('s1', () => true, offline);
    expect(gate).toBe('denied');
    expect(useStageStore.getState().resumeGate).toBe('denied');
    expect(isStageOwnershipUnknown('s1')).toBe(true);
  });

  it('touches nothing when the load it belonged to is no longer current', async () => {
    await resolveClassroomViewerAccess('s1', () => false, answering(200, { isOwner: false }));
    expect(useStageStore.getState()).toMatchObject({
      isOwner: true,
      readOnly: false,
      resumeGate: 'unknown',
    });
  });
});
