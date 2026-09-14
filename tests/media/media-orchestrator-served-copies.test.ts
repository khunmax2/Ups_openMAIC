import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fork. The classroom resumes media generation for every image this browser
 * has no record of -- which, before media was stored on the server, meant "not
 * generated yet". Now an image can already be on the server
 * (`stage.mediaAssets`) while this browser knows nothing about it, and
 * regenerating it spends the image model and replaces the course's picture
 * every time the owner opens the course in another browser. Found 2026-09-15.
 * An image with no served copy -- an old course whose creating browser is gone
 * -- is still regenerated, which is how such a course gets pictures back.
 */

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  stage: { current: null as null | { id: string; mediaAssets?: Record<string, string> } },
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settings },
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    mediaFiles: {
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: {
    getState: () => ({ stage: mocks.stage.current, setStageMediaAsset: vi.fn() }),
  },
}));

import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { resetProxyMediaFailureCache } from '@/lib/media/proxy-media-cache';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { SceneOutline } from '@/lib/types/generation';

const SERVED = '/api/classroom-media/stage-1/media/generated-abc.png';

function outlineWithImages(...elementIds: string[]): SceneOutline {
  return {
    id: 'outline-1',
    type: 'slide',
    title: 'Scene',
    description: 'Scene',
    keyPoints: ['media'],
    order: 1,
    mediaGenerations: elementIds.map((elementId) => ({
      type: 'image' as const,
      elementId,
      prompt: `picture for ${elementId}`,
      aspectRatio: '16:9' as const,
    })),
  } as SceneOutline;
}

describe('media already stored on the server', () => {
  let imageRequests = 0;

  beforeEach(() => {
    resetProxyMediaFailureCache();
    useMediaGenerationStore.setState({ tasks: {} });
    imageRequests = 0;
    mocks.settings.mockReturnValue({
      imageGenerationEnabled: true,
      videoGenerationEnabled: true,
      imageProviderId: 'image-provider',
      imageModelId: 'image-model',
      imageProvidersConfig: {},
      videoProviderId: 'video-provider',
      videoModelId: 'video-model',
      videoProvidersConfig: {},
      mediaGenerationConcurrency: 1,
    });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:image'), revokeObjectURL: vi.fn() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/generate/image') {
          imageRequests += 1;
          return new Response(
            JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (String(input) === '/api/proxy-media') {
          return new Response(new Blob(['bytes'], { type: 'image/png' }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );
  });

  afterEach(() => {
    resetProxyMediaFailureCache();
    vi.unstubAllGlobals();
  });

  const taskIds = () => Object.keys(useMediaGenerationStore.getState().tasks).sort();

  it('does not regenerate an image the course already has a served copy of', async () => {
    mocks.stage.current = { id: 'stage-1', mediaAssets: { gen_img_1: SERVED } };
    await generateMediaForOutlines([outlineWithImages('gen_img_1', 'gen_img_2')], 'stage-1');
    expect(imageRequests).toBe(1);
    expect(taskIds()).toEqual(['gen_img_2']);
  });

  it('still generates every image of a course with no served copies', async () => {
    mocks.stage.current = { id: 'stage-1' };
    await generateMediaForOutlines([outlineWithImages('gen_img_1', 'gen_img_2')], 'stage-1');
    expect(imageRequests).toBe(2);
    expect(taskIds()).toEqual(['gen_img_1', 'gen_img_2']);
  });

  it("does not read another course's served copies", async () => {
    mocks.stage.current = { id: 'stage-other', mediaAssets: { gen_img_1: SERVED } };
    await generateMediaForOutlines([outlineWithImages('gen_img_1')], 'stage-1');
    expect(imageRequests).toBe(1);
    expect(taskIds()).toEqual(['gen_img_1']);
  });
});
