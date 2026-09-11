'use client';

/**
 * Fork. Says, in the provider list, that an administrator has set a shared
 * key for this provider -- so a person who never configured it can see why
 * it already works, and where their own key would take over.
 */

import { metaKey, type CredentialSection } from '@/lib/credentials/client';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';

export function CredentialDefaultBadge({
  section,
  providerId,
}: {
  section: CredentialSection;
  providerId: string;
}) {
  const { t } = useI18n();
  const source = useSettingsStore((s) => s.credentialMeta[metaKey(section, providerId)]?.source);
  if (source !== 'default') return null;
  return (
    <span
      className="text-[10px] px-1 py-0 h-4 leading-4 rounded shrink-0 bg-primary/10 text-primary"
      title={t('settings.apiKeyFromDefault')}
    >
      {t('settings.credentialDefaultBadge')}
    </span>
  );
}
