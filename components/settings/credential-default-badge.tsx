'use client';

/**
 * Fork. Says, in the provider list, that a shared key EXISTS for this
 * provider -- whether or not this account is the one using it. A person who
 * never configured the provider sees why it already works; an admin sees at
 * a glance which providers they have shared, including the ones they still
 * hold their own key for (where their own wins and the chip would otherwise
 * be silent).
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
  const exists = useSettingsStore((s) =>
    Boolean(s.credentialDefaults[metaKey(section, providerId)]),
  );
  if (!exists) return null;
  return (
    <span
      className="text-[10px] px-1 py-0 h-4 leading-4 rounded shrink-0 bg-primary/10 text-primary"
      title={t('settings.apiKeyFromShared')}
    >
      {t('settings.credentialDefaultBadge')}
    </span>
  );
}
