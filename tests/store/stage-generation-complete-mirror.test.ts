import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fork. When the owner's deck finishes, the store tells the server
 * (`notifyServerGenerationComplete`). A visitor's store never does -- the
 * route would refuse it anyway -- and marking a deck incomplete sends nothing.
 */

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn().mockResolvedValue(true) }));

vi.mock('@/lib/classroom/generation-complete-mirror', () => ({
  notifyServerGenerationComplete: (...args: unknown[]) => notifyMock(...args),
}));
vi.mock('@/lib/pbl/v2/runtime/hydration', () => ({ hydratePBLScenesFromRuntime: vi.fn() }));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/utils/database', () => ({
  db: {
    stageOutlines: { put: vi.fn(), get: vi.fn() },
    stageFolders: { delete: vi.fn().mockResolvedValue(undefined) },
  },
}));

import { useStageStore } from '@/lib/store/stage';

describe('setGenerationComplete mirrors a finished deck to the server', () => {
  beforeEach(() => {
    notifyMock.mockClear();
    useStageStore.setState({
      stage: { id: 'stage-1', name: 'Test stage', createdAt: 1, updatedAt: 1 },
      generationComplete: false,
      isOwner: true,
      readOnly: false,
    });
  });

  it("tells the server when the owner's deck finishes", () => {
    useStageStore.getState().setGenerationComplete(true);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]?.[0]).toBe('stage-1');
  });

  it('sends nothing for a visitor, or when a deck is marked incomplete', () => {
    useStageStore.setState({ isOwner: false, readOnly: true });
    useStageStore.getState().setGenerationComplete(true);
    useStageStore.setState({ isOwner: true, readOnly: false, generationComplete: true });
    useStageStore.getState().setGenerationComplete(false);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
