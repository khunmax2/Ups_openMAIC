'use client';

/**
 * Fork. An API-key input that never shows a stored key in clear.
 *
 * Two storages, one field. Behind the gateway the server holds the key and
 * the store holds the sentinel `***` (lib/credentials/client.ts); the field
 * shows the mask the server sent and, for an admin, can promote the key to
 * the shared default. Without a server store the key is in the browser's own
 * storage, and the field masks it the same way. Either way the eye reveals
 * only text typed in this session, which the person at the keyboard already
 * knows.
 */

import { useState } from 'react';
import { Eye, EyeOff, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  CREDENTIAL_SENTINEL,
  metaKey,
  putCredential,
  refreshCredentials,
  removeCredential,
  type CredentialSection,
} from '@/lib/credentials/client';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { cn } from '@/lib/utils';

export function maskApiKey(value: string): string {
  const key = value.trim();
  if (!key) return '';
  if (key === CREDENTIAL_SENTINEL) return '••••••••';
  if (key.length <= 10) return `${key.slice(0, 2)}••••`;
  return `${key.slice(0, 5)}••••${key.slice(-4)}`;
}

interface ApiKeyFieldProps {
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onBlur?: () => void;
  className?: string;
  /** Which server-side credential this field edits, when the server holds keys. */
  credential?: { section: CredentialSection; providerId: string };
}

export function ApiKeyField({
  name,
  value,
  onChange,
  placeholder,
  disabled,
  onBlur,
  className,
  credential,
}: ApiKeyFieldProps) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  // A key the user typed here can be revealed; one that arrived from storage
  // cannot. `typed` flips on the first keystroke and never back.
  const [typed, setTyped] = useState(false);
  const [editing, setEditing] = useState(false);
  const [previous, setPrevious] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The pages swap providers without remounting their inputs. Reset when the
  // field's identity changes, or a key typed for provider A would leave
  // provider B's stored key revealable.
  const [boundTo, setBoundTo] = useState(name);
  if (boundTo !== name) {
    setBoundTo(name);
    setShow(false);
    setTyped(false);
    setEditing(false);
    setPrevious(null);
  }

  const key = credential ? metaKey(credential.section, credential.providerId) : undefined;
  const meta = useSettingsStore((s) => (key ? s.credentialMeta[key] : undefined));
  const role = useSettingsStore((s) => s.credentialRole);
  const serverBacked = useSettingsStore((s) => s.credentialStorage === 'server');

  const stored = Boolean(value) && !typed && !editing;

  if (stored) {
    const masked = value === CREDENTIAL_SENTINEL && meta ? meta.masked : maskApiKey(value);
    const fromDefault = value === CREDENTIAL_SENTINEL && meta?.source === 'default';
    const own = value === CREDENTIAL_SENTINEL && meta?.source === 'own';
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <div className="flex gap-2">
          <Input
            name={name}
            type="text"
            readOnly
            disabled={disabled}
            value={masked}
            className="h-8 flex-1 font-mono text-muted-foreground"
            aria-label={t('settings.apiKeyStored')}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={() => {
              setPrevious(value);
              setEditing(true);
              onChange('');
            }}
          >
            {t('settings.apiKeyChange')}
          </Button>
          {own && credential && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              aria-label={t('settings.apiKeyRemove')}
              title={t('settings.apiKeyRemove')}
              onClick={async () => {
                setBusy(true);
                try {
                  if (await removeCredential(credential.section, credential.providerId)) {
                    await refreshCredentials();
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        {serverBacked && (fromDefault || (own && role === 'admin')) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {fromDefault && <span>{t('settings.apiKeyFromDefault')}</span>}
            {own && role === 'admin' && credential && (
              <button
                type="button"
                className="underline-offset-2 hover:underline disabled:opacity-50"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const stored = await putCredential(
                      credential.section,
                      credential.providerId,
                      { copyFromOwner: true },
                      'default',
                    );
                    if (stored !== undefined) await refreshCredentials();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('settings.apiKeySetDefault')}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn('flex gap-2', className)}>
      <div className="relative flex-1">
        <Input
          name={name}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder ?? t('settings.enterApiKey')}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            setTyped(true);
            onChange(e.target.value);
          }}
          onBlur={onBlur}
          className="h-8 pr-8"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          disabled={disabled}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={show ? t('settings.apiKeyHide') : t('settings.apiKeyShow')}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {editing && previous !== null && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange(previous);
            setPrevious(null);
            setEditing(false);
            setTyped(false);
            setShow(false);
            onBlur?.();
          }}
        >
          {t('settings.apiKeyKeep')}
        </Button>
      )}
    </div>
  );
}
