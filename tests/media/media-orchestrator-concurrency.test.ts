import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fork. A course's images used to be generated strictly one after another, so
 * the last picture of a long course arrived minutes after its slides -- the
 * 2026-09-14 report "images come up slowly". The number in flight is now the
 * server's to set (`MEDIA_GENERATION_CONCURRENCY`, synced like
 * `PARALLEL_SCENE_CONCURRENCY`); without a server value the orchestrator keeps
 * upstream's one-at-a-time loop.
 */

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  mediaPut: vi.fn(),
  mediaDelete: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settings },
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: { mediaFiles: { put: mocks.mediaPut, delete: mocks.mediaDelete } },
}));

import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { resetProxyMediaFailureCache } from '@/lib/media/proxy-media-cache';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { SceneOutline } from '@/lib/types/generation';

function outlineWithImages(count: number): SceneOutline {
  return {
    id: 'outline-1',
    type: 'slide',
    title: 'Scene',
    description: 'Scene',
    keyPoints: ['media'],
    order: 1,
    mediaGenerations: Array.from({ length: count }, (_, index) => ({
      type: 'image' as const,
      elementId: `gen_img_${index + 1}`,
      prompt: `picture ${index + 1}`,
      aspectRatio: '16:9' as const,
    })),
  } as SceneOutline;
}

function settings(extra: Record<string, unknown> = {}) {
  return {
    imageGenerationEnabled: true,
    videoGenerationEnabled: true,
    imageProviderId: 'image-provider',
    imageModelId: 'image-model',
    imageProvidersConfig: {},
    videoProviderId: 'video-provider',
    videoModelId: 'video-model',
    videoProvidersConfig: {},
    ...extra,
  };
}

describe('media generation concurrency', () => {
  let inFlight = 0;
  let peak = 0;
  let waiting: Array<() => void> = [];

  beforeEach(() => {
    resetProxyMediaFailureCache();
    useMediaGenerationStore.setState({ tasks: {} });
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    inFlight = 0;
    peak = 0;
    waiting = [];
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:image'), revokeObjectURL: vi.fn() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/generate/image') {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => waiting.push(resolve));
          inFlight -= 1;
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

  /** Let every started request reach the provider, then answer them, until the run ends. */
  async function drive(run: Promise<void>): Promise<void> {
    let finished = false;
    void run.finally(() => {
      finished = true;
    });
    while (!finished) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const release of waiting.splice(0)) release();
    }
    await run;
  }

  const doneCount = () =>
    Object.values(useMediaGenerationStore.getState().tasks).filter((task) => task.status === 'done')
      .length;

  it('keeps as many image requests in flight as the server allows', async () => {
    mocks.settings.mockReturnValue(settings({ mediaGenerationConcurrency: 2 }));
    await drive(generateMediaForOutlines([outlineWithImages(5)], 'stage-parallel'));
    expect(peak).toBe(2);
    expect(doneCount()).toBe(5);
  });

  it('keeps upstream one-at-a-time without a server value', async () => {
    mocks.settings.mockReturnValue(settings());
    await drive(generateMediaForOutlines([outlineWithImages(3)], 'stage-serial'));
    expect(peak).toBe(1);
    expect(doneCount()).toBe(3);
  });
});
