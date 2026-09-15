/**
 * Fork. The organisation's model catalog, as the browser applies it.
 *
 * An admin curates, per built-in LLM provider, which of the registry's models
 * everyone sees and which models are added, plus the model an account starts
 * with (lib/server/org/store.ts). Every account's list for that provider is:
 * the registry's built-ins the organisation (or the person) did not hide, then
 * the organisation's additions, then the person's own additions. The
 * organisation's entries are marked `fromOrg`, so the page shows them as the
 * organisation's and offers no delete; the person keeps their own additions.
 * Pure, so the rules are tested without the store.
 */

import { isProviderUsable } from '@/lib/store/settings-validation';

interface ModelLike {
  id: string;
  name?: string;
  fromOrg?: boolean;
}

export interface OrgModelsAnswer {
  hidden: string[];
  extra: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    outputWindow?: number;
    capabilities?: { streaming?: boolean; tools?: boolean; vision?: boolean };
  }>;
  updatedAt?: number;
  updatedBy?: string;
  updatedByYou?: boolean;
}

export interface OrgDefaultAnswer {
  providerId: string;
  modelId: string;
  updatedAt?: number;
  updatedBy?: string;
  updatedByYou?: boolean;
}

export interface OrgCatalogAnswer {
  models: Record<string, OrgModelsAnswer>;
  defaultModel?: OrgDefaultAnswer;
  /** When the server read it; missing when the server could not. */
  servedAt?: number;
}

/**
 * The newer of the catalog a tab holds and another copy of it: the server's
 * latest answer, or the one a tab of the same account saved with the
 * settings. Any tab may have saved, one opened long ago included, so the
 * later read wins rather than the later write. A copy with no stamp counts as
 * the oldest; on a tie the held copy stays.
 */
export function newerCatalog(
  held: OrgCatalogAnswer | null | undefined,
  other: OrgCatalogAnswer | null | undefined,
): OrgCatalogAnswer | null {
  if (!other) return held ?? null;
  if (!held) return other;
  return (other.servedAt ?? 0) > (held.servedAt ?? 0) ? other : held;
}

/** One built-in provider's list with the organisation's catalog applied. */
export function withOrgModels<T extends ModelLike>(
  builtIns: readonly T[],
  current: readonly T[],
  org: OrgModelsAnswer | undefined,
  personalHidden: readonly string[] | undefined,
): T[] {
  const builtInIds = new Set(builtIns.map((model) => model.id));
  const own = current.filter((model) => !builtInIds.has(model.id) && !model.fromOrg);
  const hidden = new Set([...(org?.hidden ?? []), ...(personalHidden ?? [])]);
  const extra = (org?.extra ?? [])
    .filter((model) => !builtInIds.has(model.id))
    .map((model) => ({ ...model, fromOrg: true }) as unknown as T);
  const extraIds = new Set(extra.map((model) => model.id));
  return [
    ...builtIns.filter((model) => !hidden.has(model.id)),
    ...extra,
    ...own.filter((model) => !extraIds.has(model.id)),
  ];
}

/** The built-ins a person hides on their own, leaving out what the organisation hides. */
export function personalBuiltIns(
  builtInIds: readonly string[],
  org: OrgModelsAnswer | undefined,
): string[] {
  if (!org || org.hidden.length === 0) return [...builtInIds];
  const orgHidden = new Set(org.hidden);
  return builtInIds.filter((id) => !orgHidden.has(id));
}

interface SelectionState {
  llmModelIsUserSet?: boolean;
  providersConfig: Record<
    string,
    | {
        models?: readonly ModelLike[];
        apiKey?: string;
        baseUrl?: string;
        requiresApiKey?: boolean;
        isServerConfigured?: boolean;
        serverDisabled?: boolean;
      }
    | undefined
  >;
}

/**
 * The organisation's default model, when this account has not picked its own
 * and the default can actually be used here (the provider has a key, own or
 * shared, and lists the model). `null` otherwise.
 */
export function orgDefaultFor(
  state: SelectionState,
  org: OrgCatalogAnswer | null | undefined,
): { providerId: string; modelId: string } | null {
  const target = org?.defaultModel;
  if (!target || state.llmModelIsUserSet) return null;
  const config = state.providersConfig[target.providerId];
  if (!config || !isProviderUsable(config)) return null;
  if (!config.models?.some((model) => model.id === target.modelId)) return null;
  return { providerId: target.providerId, modelId: target.modelId };
}

/** What an admin's list publishes as the organisation's for this provider. */
export function catalogFromList(
  builtIns: readonly ModelLike[],
  models: ReadonlyArray<
    ModelLike & {
      contextWindow?: number;
      outputWindow?: number;
      capabilities?: { streaming?: boolean; tools?: boolean; vision?: boolean };
    }
  >,
): { hidden: string[]; extra: OrgModelsAnswer['extra'] } {
  const listed = new Set(models.map((model) => model.id));
  const builtInIds = new Set(builtIns.map((model) => model.id));
  return {
    hidden: builtIns.filter((model) => !listed.has(model.id)).map((model) => model.id),
    extra: models
      .filter((model) => !builtInIds.has(model.id))
      .map(({ id, name, contextWindow, outputWindow, capabilities }) => ({
        id,
        name: name || id,
        ...(contextWindow ? { contextWindow } : {}),
        ...(outputWindow ? { outputWindow } : {}),
        ...(capabilities
          ? {
              capabilities: {
                ...(capabilities.streaming ? { streaming: true } : {}),
                ...(capabilities.tools ? { tools: true } : {}),
                ...(capabilities.vision ? { vision: true } : {}),
              },
            }
          : {}),
      })),
  };
}
