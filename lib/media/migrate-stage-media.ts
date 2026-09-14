/**
 * Fork. Move an older course's generated media to the server -- once, from the
 * browser that made it.
 *
 * Courses generated before `persist-generated-media.ts` keep their pictures
 * (`mediaFiles`) and narration (`audioFiles`) only in the creating browser's
 * IndexedDB, so everyone else -- the owner in another browser, a learner on a
 * published course -- gets silent slides with empty frames. When the owner
 * opens such a course where the bytes are, each local file goes up through the
 * same owner-only route new media uses, and the document learns its served
 * reference: `stage.mediaAssets[placeholder]` for an image, the speech
 * action's `audioId`/`audioUrl` for a clip.
 *
 * - Media this browser never held is skipped, not failed: it lives in some
 *   other browser, and that browser's visit moves it.
 * - The first refused upload (not the owner, offline, server busy) stops the
 *   run; nothing is marked done, so the next visit tries again. Uploads are
 *   content-addressed, so a retry never duplicates a file.
 * - A course is migrated at most once per page session, and never twice at
 *   the same time.
 * - Video is not moved: nothing maps a video placeholder to a served copy yet.
 */

import { enumerateAssetManifest } from '@openmaic/dsl';
import type { LegacySpeechAction } from '@/lib/types/action';
import type { Scene, Stage } from '@/lib/types/stage';
import { isConcreteMediaAddress } from './resolve-media-ref';
import { readStageMediaAssets } from './stage-media-assets';

export interface StageMediaMigrationPlan {
  /** Local narration ids, each once. */
  readonly audio: readonly string[];
  /** Image placeholders with no recorded served copy, each once. */
  readonly images: readonly string[];
}

/** What still lives only in a browser: the refs a migration would upload. */
export function planStageMediaMigration(
  stage: Stage,
  scenes: readonly Scene[],
): StageMediaMigrationPlan {
  const audio = new Set<string>();
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech' || !action.audioId) continue;
      // Already served: a server-stored id, or a legacy URL playback falls back to.
      if (isConcreteMediaAddress(action.audioId)) continue;
      if (isConcreteMediaAddress((action as LegacySpeechAction).audioUrl)) continue;
      audio.add(action.audioId);
    }
  }

  const recorded = readStageMediaAssets(stage);
  const images = enumerateAssetManifest({ stage, scenes })
    .entries.filter(
      (entry) =>
        entry.kind === 'image' &&
        !isConcreteMediaAddress(entry.ref) &&
        !Object.hasOwn(recorded, entry.ref),
    )
    .map((entry) => entry.ref);

  return { audio: [...audio], images };
}

export interface StageMediaMigrationDeps {
  /** This browser's bytes for a clip and the type to store them under, if it has both. */
  readAudio(audioId: string): Promise<{ blob: Blob; mime: string } | null>;
  /** This browser's bytes for an image placeholder, if it has them. */
  readImage(stageId: string, ref: string): Promise<Blob | null>;
  /** The served reference, or undefined when the server did not store it. */
  upload(input: {
    stageId: string;
    blob: Blob;
    mime: string;
    prefix: string;
  }): Promise<string | undefined>;
  applyAudio(stageId: string, fromId: string, ref: string): Promise<void>;
  applyImage(stageId: string, placeholder: string, ref: string): Promise<void>;
}

export type StageMediaMigrationOutcome = 'done' | 'stopped' | 'busy' | 'skipped';

/** The types `POST /api/stages/[id]/media` stores. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg']);

const finished = new Set<string>();
const running = new Set<string>();

export async function migrateStageMediaToServer(
  stageId: string,
  document: { stage: Stage; scenes: readonly Scene[] },
  deps: StageMediaMigrationDeps = browserDeps,
): Promise<StageMediaMigrationOutcome> {
  if (finished.has(stageId)) return 'skipped';
  if (running.has(stageId)) return 'busy';
  running.add(stageId);
  try {
    const plan = planStageMediaMigration(document.stage, document.scenes);

    for (const placeholder of plan.images) {
      const blob = await deps.readImage(stageId, placeholder);
      if (!blob) continue;
      // An untyped blob is what the image generators hand back as PNG.
      const mime = blob.type || 'image/png';
      if (!IMAGE_TYPES.has(mime)) continue;
      const ref = await deps.upload({ stageId, blob, mime, prefix: 'generated' });
      if (!ref) return 'stopped';
      await deps.applyImage(stageId, placeholder, ref);
    }

    for (const audioId of plan.audio) {
      const local = await deps.readAudio(audioId);
      if (!local) continue;
      const ref = await deps.upload({ stageId, blob: local.blob, mime: local.mime, prefix: 'tts' });
      if (!ref) return 'stopped';
      await deps.applyAudio(stageId, audioId, ref);
    }

    finished.add(stageId);
    return 'done';
  } catch {
    return 'stopped';
  } finally {
    running.delete(stageId);
  }
}

/**
 * Host entry: migrate the loaded course, when this deployment stores media on
 * the server. Call it only once the viewer is known to be the owner; the route
 * refuses anyone else anyway. Fire-and-forget, never throws.
 */
export function startStageMediaMigration(stageId: string): void {
  if (typeof window === 'undefined' || process.env.NEXT_PUBLIC_PERSISTENCE !== '1') return;
  void import('@/lib/store/stage')
    .then(({ useStageStore }) => {
      const { stage, scenes } = useStageStore.getState();
      if (!stage || stage.id !== stageId) return;
      return migrateStageMediaToServer(stageId, { stage, scenes });
    })
    .catch(() => undefined);
}

// Loaded lazily: the planner above stays importable without IndexedDB or the store.
const browserDeps: StageMediaMigrationDeps = {
  async readAudio(audioId) {
    const [{ resolveAudioBlob }, { db }, { audioMimeForFormat }] = await Promise.all([
      import('./resolve-audio-bytes'),
      import('@/lib/utils/database'),
      import('./persist-generated-media'),
    ]);
    const blob = await resolveAudioBlob(audioId).catch(() => null);
    if (!blob) return null;
    const row = await db.audioFiles.get(audioId).catch(() => undefined);
    const mime =
      (row?.format ? audioMimeForFormat(row.format) : undefined) ??
      (AUDIO_TYPES.has(blob.type) ? blob.type : undefined);
    return mime ? { blob, mime } : null;
  },

  async readImage(stageId, ref) {
    const { resolveStoredBytes } = await import('./resolve-stored-bytes');
    return resolveStoredBytes(ref, {
      stageId,
      loadCompatRow: true,
      fetchPolicy: { requireOk: true, requireNonEmpty: true },
    });
  },

  async upload(input) {
    const { uploadGeneratedMedia } = await import('./persist-generated-media');
    return uploadGeneratedMedia(input);
  },

  async applyAudio(stageId, fromId, ref) {
    const [{ db }, { useStageStore }] = await Promise.all([
      import('@/lib/utils/database'),
      import('@/lib/store/stage'),
    ]);
    // Keep this browser playing its own copy first under the new id, exactly
    // as a freshly generated server-stored clip is kept.
    const row = await db.audioFiles.get(fromId).catch(() => undefined);
    if (row) await db.audioFiles.put({ ...row, id: ref }).catch(() => undefined);
    useStageStore.getState().replaceSpeechAudio(stageId, fromId, ref);
  },

  async applyImage(stageId, placeholder, ref) {
    const { useStageStore } = await import('@/lib/store/stage');
    useStageStore.getState().setStageMediaAsset(stageId, placeholder, ref);
  },
};
