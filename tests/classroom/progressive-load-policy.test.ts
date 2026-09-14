import { describe, expect, it } from 'vitest';
import {
  paneAvailabilityRetryDelay,
  resumeGateFromStageMeta,
  shouldResumeClassroomGeneration,
} from '@/lib/classroom/progressive-load-policy';

describe('progressive classroom policy', () => {
  it('uses a bounded pane availability backoff', () => {
    expect(Array.from({ length: 6 }, (_, attempt) => paneAvailabilityRetryDelay(attempt))).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      null,
    ]);
  });

  it.each([
    {
      loading: true,
      error: null,
      transportPersistenceFenced: false,
      generationStarted: false,
      resumeGate: 'allowed' as const,
    },
    {
      loading: false,
      error: 'failed',
      transportPersistenceFenced: false,
      generationStarted: false,
      resumeGate: 'allowed' as const,
    },
    {
      loading: false,
      error: null,
      transportPersistenceFenced: true,
      generationStarted: false,
      resumeGate: 'allowed' as const,
    },
    {
      loading: false,
      error: null,
      transportPersistenceFenced: false,
      generationStarted: true,
      resumeGate: 'allowed' as const,
    },
  ])('blocks generation resume while progressive state is unsafe: %o', (state) => {
    expect(shouldResumeClassroomGeneration(state)).toBe(false);
  });

  it('allows generation resume only after loading and transport fencing settle', () => {
    expect(
      shouldResumeClassroomGeneration({
        loading: false,
        error: null,
        transportPersistenceFenced: false,
        generationStarted: false,
        resumeGate: 'allowed',
      }),
    ).toBe(true);
  });

  // Fork. Resuming generates slides and media with the VIEWER's models and
  // keys. A course loaded from the server in another browser -- a learner on a
  // published course included -- used to resume whenever a slide or its media
  // was missing, because nothing asked whether this viewer owns the course.
  it.each(['unknown', 'denied'] as const)(
    'blocks resume until the viewer is known to own the course: %s',
    (resumeGate) => {
      expect(
        shouldResumeClassroomGeneration({
          loading: false,
          error: null,
          transportPersistenceFenced: false,
          generationStarted: false,
          resumeGate,
        }),
      ).toBe(false);
    },
  );

  it.each([
    [{ outcome: 'found', meta: { isOwner: true } }, 'allowed'],
    [{ outcome: 'found', meta: { isOwner: false } }, 'denied'],
    // No sidecar row: a local-only course, or a studio without persistence --
    // upstream's single-user case, which keeps resuming as before.
    [{ outcome: 'absent' }, 'allowed'],
    // No answer at all: fail closed; a reload asks again.
    [{ outcome: 'unavailable' }, 'denied'],
  ] as const)('maps the stage-meta answer %o to the resume gate %s', (result, gate) => {
    expect(resumeGateFromStageMeta(result)).toBe(gate);
  });
});
