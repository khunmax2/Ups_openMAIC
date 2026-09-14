import { describe, expect, it } from 'vitest';

/**
 * Fork. A generated image's bytes are uploaded to the course's classroom-media
 * directory, and the course records which served reference each canvas
 * placeholder became (`gen_img_*` -> `/api/classroom-media/...`), so any
 * browser can render it -- not only the one that generated it. The map lives
 * on the stage document beside `videoManifest`; these helpers are the only
 * readers and writers.
 */

import {
  mediaRefForPlaceholder,
  readStageMediaAssets,
  withSpeechAudioRef,
  withStageMediaAsset,
} from '@/lib/media/stage-media-assets';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = { id: 's1', name: 'Course', createdAt: 1, updatedAt: 1 };

describe('stage media assets', () => {
  it('reads an absent or malformed map as empty', () => {
    expect(readStageMediaAssets(stage)).toEqual({});
    expect(readStageMediaAssets(null)).toEqual({});
    expect(readStageMediaAssets({ ...stage, mediaAssets: 'nope' } as unknown as Stage)).toEqual({});
    expect(
      readStageMediaAssets({
        ...stage,
        mediaAssets: { gen_img_1: 'ast_x', gen_img_2: 42 },
      } as unknown as Stage),
    ).toEqual({ gen_img_1: 'ast_x' });
  });

  it('records a placeholder and keeps the rest of the stage and the map', () => {
    const once = withStageMediaAsset(stage, 'gen_img_1', 'ast_a');
    const twice = withStageMediaAsset(once, 'gen_img_2', 'ast_b');
    expect(readStageMediaAssets(twice)).toEqual({ gen_img_1: 'ast_a', gen_img_2: 'ast_b' });
    expect(twice.name).toBe('Course');
    // The input is not mutated: the store compares references.
    expect(readStageMediaAssets(stage)).toEqual({});
  });

  it('maps a generation placeholder to its pool asset, and leaves anything else alone', () => {
    const assets = { gen_img_1: 'ast_a' };
    expect(mediaRefForPlaceholder('gen_img_1', assets)).toBe('ast_a');
    expect(mediaRefForPlaceholder('gen_img_9', assets)).toBe('gen_img_9');
    expect(mediaRefForPlaceholder('https://cdn/x.png', assets)).toBe('https://cdn/x.png');
    expect(mediaRefForPlaceholder(undefined, assets)).toBeUndefined();
  });

  it('points the speech lines that played a local clip at its served copy', () => {
    const REF = '/api/classroom-media/s1/media/tts-abc.mp3';
    const scene = {
      id: 'sc1',
      stageId: 's1',
      order: 1,
      actions: [
        { id: 'a1', type: 'speech', text: 'one', audioId: 'tts_s1_a1' },
        { id: 'a2', type: 'speech', text: 'two', audioId: 'tts_s1_a2' },
        { id: 'a3', type: 'spotlight', elementId: 'e1' },
      ],
    } as unknown as Scene;
    const next = withSpeechAudioRef(scene, 'tts_s1_a1', REF);
    expect(next?.actions?.[0]).toMatchObject({ audioId: REF, audioUrl: REF, text: 'one' });
    expect(next?.actions?.[1]).toBe(scene.actions?.[1]);
    expect(next?.actions?.[2]).toBe(scene.actions?.[2]);
    // The input is not mutated, and a scene that never used the clip is left alone.
    expect(scene.actions?.[0]).toMatchObject({ audioId: 'tts_s1_a1' });
    expect(withSpeechAudioRef(scene, 'tts_s9_x', REF)).toBeUndefined();
  });
});
