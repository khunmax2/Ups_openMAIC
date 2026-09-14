import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fork. When a generated image lands in the server asset pool, the store
 * records `placeholder -> pool asset` on the stage document and schedules the
 * stage write like any other stage mutation. A late result for a course the
 * user has already left is dropped.
 */

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
import { readStageMediaAssets } from '@/lib/media/stage-media-assets';

describe('setStageMediaAsset', () => {
  beforeEach(() => {
    useStageStore.setState({
      stage: { id: 'stage-1', name: 'Test stage', createdAt: 1, updatedAt: 1 },
    });
  });

  it('records the pool asset a placeholder became on the loaded stage', () => {
    useStageStore.getState().setStageMediaAsset('stage-1', 'gen_img_1', 'ast_a');
    useStageStore.getState().setStageMediaAsset('stage-1', 'gen_img_2', 'ast_b');
    expect(readStageMediaAssets(useStageStore.getState().stage)).toEqual({
      gen_img_1: 'ast_a',
      gen_img_2: 'ast_b',
    });
  });

  it('drops a result that belongs to a course no longer loaded', () => {
    useStageStore.getState().setStageMediaAsset('stage-other', 'gen_img_1', 'ast_a');
    expect(readStageMediaAssets(useStageStore.getState().stage)).toEqual({});
  });
});
