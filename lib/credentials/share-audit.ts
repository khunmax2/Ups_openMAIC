/**
 * Fork. Any admin may share a provider's key with every account, replace the
 * key another admin shared, or stop a share every account relies on -- kept
 * that way on purpose (FORK.md, "Who shared a key is recorded"). These are
 * what the key row needs to make those deliberate rather than a menu click:
 * whether sharing my key would replace the shared one, and who put the shared
 * one there and when. Pure, so the rules are tested without the page.
 */

export interface SharedKey {
  masked: string;
  baseUrl: string;
  sharedAt?: number;
  sharedByYou?: boolean;
  sharedBy?: string;
}

export interface OwnKey {
  masked: string;
  baseUrl: string;
}

/**
 * What sharing my own key would do: nothing is shared yet, mine already is
 * the shared one (same mask, same endpoint), or it replaces the shared one --
 * another admin's, or an older key of my own.
 */
export type ShareEffect = 'new' | 'same' | 'replace';

export function shareEffect(own: OwnKey | undefined, shared: SharedKey | undefined): ShareEffect {
  if (!shared) return 'new';
  if (own && own.masked === shared.masked && own.baseUrl === shared.baseUrl) return 'same';
  return 'replace';
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "Shared by you / by another admin (account) / before sharers were recorded", and when. */
export function describeSharer(
  shared: SharedKey,
  t: Translate,
  formatTime: (ms: number) => string,
): string {
  const time = shared.sharedAt ? formatTime(shared.sharedAt) : '';
  if (shared.sharedByYou) return t('settings.apiKeySharedByYou', { time });
  if (shared.sharedBy) return t('settings.apiKeySharedByOther', { who: shared.sharedBy, time });
  return t('settings.apiKeySharedByUnknown', { time });
}
