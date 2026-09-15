/**
 * Fork. A built-in model someone removed from a provider stays removed.
 *
 * Upstream rebuilds every built-in provider's model list on each rehydrate --
 * the registry's built-ins first, then whatever the person added -- so a
 * built-in deleted in Settings came back on the next load. With settings on
 * the server and re-read whenever a tab comes back (lib/store/account-kv.ts)
 * that became "the models I deleted keep coming back" (user report,
 * 2026-09-15). The store now remembers which built-ins are missing from a
 * provider's list after an edit, and the rebuild leaves exactly those out.
 * Adding the model back, or Reset, shows it again; a built-in the registry
 * gains later is shown, since nobody removed it.
 */

/** Per provider, the built-in model ids its list no longer shows. */
export type HiddenBuiltInModels = Partial<Record<string, string[]>>;

interface ModelLike {
  id: string;
}

/** The built-in ids a provider hides once its model list is `models`. */
export function hiddenAfterEdit(
  builtInIds: readonly string[],
  models: readonly ModelLike[],
): string[] {
  const shown = new Set(models.map((model) => model.id));
  return builtInIds.filter((id) => !shown.has(id));
}

/** `map` with `providerId` set to `hidden`, or without it when nothing is hidden. */
export function withHidden(
  map: HiddenBuiltInModels | undefined,
  providerId: string,
  hidden: readonly string[],
): HiddenBuiltInModels {
  const next: HiddenBuiltInModels = { ...(map ?? {}) };
  if (hidden.length > 0) next[providerId] = [...hidden];
  else delete next[providerId];
  return next;
}

/** Hidden built-ins for every provider of a bulk replace (import, add, delete). */
export function hiddenAfterBulkEdit(
  builtInIdsOf: (providerId: string) => readonly string[],
  configs: Readonly<Record<string, { models?: readonly ModelLike[] } | undefined>>,
): HiddenBuiltInModels {
  let next: HiddenBuiltInModels = {};
  for (const [providerId, config] of Object.entries(configs)) {
    const builtIns = builtInIdsOf(providerId);
    if (builtIns.length === 0 || !config?.models) continue;
    next = withHidden(next, providerId, hiddenAfterEdit(builtIns, config.models));
  }
  return next;
}

/** The registry's built-ins a provider still shows. */
export function shownBuiltIns<T extends ModelLike>(
  builtIns: readonly T[],
  hidden: readonly string[] | undefined,
): T[] {
  if (!hidden || hidden.length === 0) return [...builtIns];
  const gone = new Set(hidden);
  return builtIns.filter((model) => !gone.has(model.id));
}
