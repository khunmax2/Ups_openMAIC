import { describe, expect, it, vi, type Mock } from 'vitest';

/**
 * Fork. A course generated before its media went to the server keeps its
 * pictures and narration only in the browser that made them. When the owner
 * opens it there, each local file goes up once and the document learns its
 * served reference; media this browser never held is left for the browser that
 * has it, and a refused upload stops the run so the next visit retries.
 */

import {
  migrateStageMediaToServer,
  planStageMediaMigration,
  type StageMediaMigrationDeps,
} from '@/lib/media/migrate-stage-media';
import type { Scene, Stage } from '@/lib/types/stage';

const served = (name: string) => `/api/classroom-media/s/media/${name}`;

function course(stageId: string, stageExtra: Record<string, unknown> = {}) {
  const stage = {
    id: stageId,
    name: 'Course',
    createdAt: 1,
    updatedAt: 1,
    ...stageExtra,
  } as unknown as Stage;
  const scenes = [
    {
      id: 'sc1',
      stageId,
      order: 1,
      type: 'slide',
      title: 'One',
      content: {
        type: 'slide',
        canvas: {
          id: 'c1',
          elements: [
            { type: 'image', id: 'e1', src: 'gen_img_1' },
            { type: 'image', id: 'e2', src: 'gen_img_2' },
            { type: 'image', id: 'e3', src: served('already.png') },
            { type: 'video', id: 'v1', src: 'gen_vid_1' },
          ],
        },
      },
      actions: [
        { id: 'a1', type: 'speech', text: 'one', audioId: 'tts_s1_a1' },
        { id: 'a2', type: 'speech', text: 'two', audioId: 'tts_s1_a2' },
        { id: 'a3', type: 'speech', text: 'three', audioId: served('tts-x.mp3') },
        {
          id: 'a4',
          type: 'speech',
          text: 'four',
          audioId: 'tts_s1_a4',
          audioUrl: served('tts-y.mp3'),
        },
      ],
    },
    {
      id: 'sc2',
      stageId,
      order: 2,
      type: 'slide',
      title: 'Two',
      content: { type: 'slide', canvas: { id: 'c2', elements: [] } },
      actions: [{ id: 'b1', type: 'speech', text: 'again', audioId: 'tts_s1_a1' }],
    },
  ] as unknown as Scene[];
  return { stage, scenes };
}

type Deps = StageMediaMigrationDeps;
type MockDeps = { [K in keyof Deps]: Mock<Deps[K]> };

function deps(overrides: Partial<MockDeps> = {}): MockDeps {
  let n = 0;
  return {
    readAudio: vi.fn<Deps['readAudio']>(async (audioId) => ({
      blob: new Blob([audioId], { type: 'audio/mpeg' }),
      mime: 'audio/mpeg',
    })),
    readImage: vi.fn<Deps['readImage']>(async () => new Blob(['img'], { type: 'image/png' })),
    upload: vi.fn<Deps['upload']>(async (input) => served(`${input.prefix}-${++n}`)),
    applyAudio: vi.fn<Deps['applyAudio']>(async () => undefined),
    applyImage: vi.fn<Deps['applyImage']>(async () => undefined),
    ...overrides,
  };
}

describe('planStageMediaMigration', () => {
  it('lists local narration and image placeholders, each once', () => {
    const { stage, scenes } = course('plan-1');
    expect(planStageMediaMigration(stage, scenes)).toEqual({
      audio: ['tts_s1_a1', 'tts_s1_a2'],
      images: ['gen_img_1', 'gen_img_2'],
    });
  });

  it('leaves out an image the course already recorded a served copy for', () => {
    const { stage, scenes } = course('plan-2', { mediaAssets: { gen_img_1: served('g.png') } });
    expect(planStageMediaMigration(stage, scenes).images).toEqual(['gen_img_2']);
  });
});

describe('migrateStageMediaToServer', () => {
  it('uploads each local file once and records its served reference', async () => {
    const d = deps();
    await expect(migrateStageMediaToServer('run-1', course('run-1'), d)).resolves.toBe('done');
    expect(d.upload).toHaveBeenCalledTimes(4);
    const prefixes = d.upload.mock.calls.map(([input]) => input.prefix).sort();
    expect(prefixes).toEqual(['generated', 'generated', 'tts', 'tts']);
    expect(d.applyAudio.mock.calls.map(([, fromId]) => fromId).sort()).toEqual([
      'tts_s1_a1',
      'tts_s1_a2',
    ]);
    expect(d.applyImage.mock.calls.map(([, placeholder]) => placeholder).sort()).toEqual([
      'gen_img_1',
      'gen_img_2',
    ]);
    for (const [stageId, , ref] of [...d.applyAudio.mock.calls, ...d.applyImage.mock.calls]) {
      expect(stageId).toBe('run-1');
      expect(ref).toMatch(/^\/api\/classroom-media\//u);
    }
  });

  it('skips media this browser does not hold without counting it as a failure', async () => {
    const d = deps({
      readAudio: vi.fn<Deps['readAudio']>(async (audioId) =>
        audioId === 'tts_s1_a2' ? null : { blob: new Blob(['a']), mime: 'audio/mpeg' },
      ),
      readImage: vi.fn<Deps['readImage']>(async (_stageId, ref) =>
        ref === 'gen_img_2' ? null : new Blob(['i'], { type: 'image/png' }),
      ),
    });
    await expect(migrateStageMediaToServer('run-2', course('run-2'), d)).resolves.toBe('done');
    expect(d.upload).toHaveBeenCalledTimes(2);
  });

  it('skips an image type the server does not store', async () => {
    const d = deps({
      readImage: vi.fn<Deps['readImage']>(
        async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }),
      ),
    });
    await expect(migrateStageMediaToServer('run-3', course('run-3'), d)).resolves.toBe('done');
    expect(d.upload.mock.calls.map(([input]) => input.prefix)).toEqual(['tts', 'tts']);
  });

  it('stops at a refused upload and tries again on a later visit', async () => {
    const refused = deps({ upload: vi.fn<Deps['upload']>(async () => undefined) });
    await expect(migrateStageMediaToServer('run-4', course('run-4'), refused)).resolves.toBe(
      'stopped',
    );
    expect(refused.upload).toHaveBeenCalledOnce();
    expect(refused.applyAudio).not.toHaveBeenCalled();
    expect(refused.applyImage).not.toHaveBeenCalled();

    const later = deps();
    await expect(migrateStageMediaToServer('run-4', course('run-4'), later)).resolves.toBe('done');
    expect(later.upload).toHaveBeenCalledTimes(4);
  });

  it('does not run twice for one course, at once or after finishing', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = deps({
      readAudio: vi.fn<Deps['readAudio']>(async () => {
        await gate;
        return { blob: new Blob(['a']), mime: 'audio/mpeg' };
      }),
    });
    const first = migrateStageMediaToServer('run-5', course('run-5'), slow);
    await expect(migrateStageMediaToServer('run-5', course('run-5'), deps())).resolves.toBe('busy');
    release();
    await expect(first).resolves.toBe('done');

    const again = deps();
    await expect(migrateStageMediaToServer('run-5', course('run-5'), again)).resolves.toBe(
      'skipped',
    );
    expect(again.upload).not.toHaveBeenCalled();
  });
});
