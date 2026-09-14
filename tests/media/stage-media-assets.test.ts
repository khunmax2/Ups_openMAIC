import { describe, expect, it } from 'vitest';

/**
 * Fork. A generated image's bytes are uploaded to the server's asset pool,
 * and the course records which pool asset each canvas placeholder became
 * (`gen_img_*` -> `ast_*`), so any browser can render it -- not only the one
 * that generated it. The map lives on the stage document beside
 * `videoManifest`; these helpers are the only readers and writers.
 */

import {
  mediaRefForPlaceholder,
  readStageMediaAssets,
  withStageMediaAsset,
} from '@/lib/media/stage-media-assets';
import type { Stage } from '@/lib/types/stage';

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
});
