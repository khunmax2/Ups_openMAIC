/**
 * Fork. Which served reference each generated-media placeholder became.
 *
 * The canvas keeps its `gen_img_*` placeholder as the element src; the bytes
 * used to live only in the generating browser's IndexedDB (`mediaFiles`), so
 * another browser -- or a learner on a published course -- got an empty frame.
 * The bytes now go to the course's classroom-media directory on the server,
 * and the stage document records `placeholder -> /api/classroom-media/...`
 * here, beside `videoManifest`. The DSL's stage validator ignores unknown
 * fields, so the map travels with the stage without a schema change; these
 * helpers are its only readers and writers.
 *
 * Narration needs no map: a speech action's `audioId` (and legacy `audioUrl`)
 * simply becomes the served reference, as upstream's agent runtime writes it.
 */

import type { Scene, Stage } from '@/lib/types/stage';
import type { LegacySpeechAction } from '@/lib/types/action';

export type StageMediaAssets = Readonly<Record<string, string>>;

type StageWithMediaAssets = Stage & { mediaAssets?: Record<string, string> };

function stringEntries(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, ref] of Object.entries(value as Record<string, unknown>)) {
    if (typeof ref === 'string' && ref) out[key] = ref;
  }
  return out;
}

/** The stage's placeholder map; absent or malformed reads as empty. */
export function readStageMediaAssets(stage: Stage | null | undefined): StageMediaAssets {
  return stringEntries((stage as StageWithMediaAssets | null | undefined)?.mediaAssets);
}

/** A copy of the stage with one placeholder recorded. The input is not mutated. */
export function withStageMediaAsset(stage: Stage, placeholder: string, ref: string): Stage {
  const current = stringEntries((stage as StageWithMediaAssets).mediaAssets);
  return { ...stage, mediaAssets: { ...current, [placeholder]: ref } } as StageWithMediaAssets;
}

/**
 * The reference to resolve for a media src: its served copy when the src is a
 * placeholder this stage recorded, otherwise the src unchanged. `assets` may be
 * the raw stored value -- only own string entries count.
 */
export function mediaRefForPlaceholder(
  src: string | undefined,
  assets: unknown,
): string | undefined {
  if (!src || !assets || typeof assets !== 'object') return src;
  const ref = Object.hasOwn(assets, src) ? (assets as Record<string, unknown>)[src] : undefined;
  return typeof ref === 'string' && ref ? ref : src;
}

/**
 * A copy of the scene whose speech actions that played `fromId` now play the
 * served `ref` (as both `audioId` and legacy `audioUrl`), or `undefined` when
 * no action of this scene used `fromId`. The input is not mutated.
 */
export function withSpeechAudioRef(scene: Scene, fromId: string, ref: string): Scene | undefined {
  const actions = scene.actions ?? [];
  const uses = (action: (typeof actions)[number]) =>
    action.type === 'speech' && action.audioId === fromId;
  if (!actions.some(uses)) return undefined;
  return {
    ...scene,
    actions: actions.map((action) =>
      uses(action) ? ({ ...action, audioId: ref, audioUrl: ref } as LegacySpeechAction) : action,
    ),
  };
}
