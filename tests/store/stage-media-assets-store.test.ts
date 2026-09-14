import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fork. When a generated image or narration clip is stored on the server, the
 * store records its served reference on the course document and schedules the
 * write like any other mutation. A late result for a course the user has
 * already left is dropped.
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
import type { Scene } from '@/lib/types/stage';

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

describe('replaceSpeechAudio', () => {
  const REF = '/api/classroom-media/stage-1/media/tts-abc.mp3';
  const sceneWith = (id: string, audioId: string) =>
    ({
      id,
      stageId: 'stage-1',
      order: 1,
      actions: [{ id: `${id}-a`, type: 'speech', text: 'hello', audioId }],
    }) as unknown as Scene;

  beforeEach(() => {
    useStageStore.setState({
      stage: { id: 'stage-1', name: 'Test stage', createdAt: 1, updatedAt: 1 },
      scenes: [sceneWith('sc1', 'tts_s1_a'), sceneWith('sc2', 'tts_s2_b')],
    });
  });

  it('points the loaded course at the served clip and leaves other scenes alone', () => {
    const before = useStageStore.getState().scenes;
    useStageStore.getState().replaceSpeechAudio('stage-1', 'tts_s1_a', REF);
    const after = useStageStore.getState().scenes;
    expect(after[0]?.actions?.[0]).toMatchObject({ audioId: REF, audioUrl: REF });
    expect(after[1]).toBe(before[1]);
  });

  it('drops a result that belongs to a course no longer loaded', () => {
    const before = useStageStore.getState().scenes;
    useStageStore.getState().replaceSpeechAudio('stage-other', 'tts_s1_a', REF);
    expect(useStageStore.getState().scenes).toBe(before);
  });
});
