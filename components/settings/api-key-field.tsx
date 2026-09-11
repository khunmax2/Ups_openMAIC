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
import { Check, ChevronDown, Eye, EyeOff, Trash2, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  const defaultRow = useSettingsStore((s) => (key ? s.credentialDefaults[key] : undefined));
  // The admin's own key that is also the shared one: same mask, same base URL.
  const isShared =
    !!meta &&
    !!defaultRow &&
    meta.masked === defaultRow.masked &&
    meta.baseUrl === defaultRow.baseUrl;

  const stored = Boolean(value) && !typed && !editing;

  const withBusy = async (work: () => Promise<boolean | undefined>) => {
    if (!credential) return;
    setBusy(true);
    try {
      if (await work()) await refreshCredentials();
    } finally {
      setBusy(false);
    }
  };
  const removeOwn = () =>
    withBusy(() => removeCredential(credential!.section, credential!.providerId));
  const stopSharing = () =>
    withBusy(() => removeCredential(credential!.section, credential!.providerId, 'default'));
  const share = () =>
    withBusy(async () => {
      const stored = await putCredential(
        credential!.section,
        credential!.providerId,
        { copyFromOwner: true },
        'default',
      );
      return stored !== undefined;
    });

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
          {own && credential && role !== 'admin' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              aria-label={t('settings.apiKeyRemove')}
              title={t('settings.apiKeyRemove')}
              onClick={() => void removeOwn()}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          {own && credential && role === 'admin' && serverBacked && (
            // The admin's actions on their own key -- share it with every
            // account, stop sharing, remove it -- in one menu on the key's
            // row. Sharing is the one admin-only action in the studio, so
            // its state is also shown without opening the menu.
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant={isShared ? 'secondary' : 'outline'}
                  size="sm"
                  className="gap-1.5"
                  disabled={disabled || busy}
                  aria-label={t('settings.apiKeyActions')}
                >
                  <Users className={cn('h-3.5 w-3.5', isShared && 'text-primary')} />
                  {isShared ? t('settings.apiKeySharedShort') : null}
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[260px]">
                {isShared ? (
                  <>
                    <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
                      <Check className="h-3.5 w-3.5 text-primary" />
                      {t('settings.apiKeyIsShared')}
                    </DropdownMenuLabel>
                    <DropdownMenuItem className="gap-2" onClick={() => void stopSharing()}>
                      <Users className="h-3.5 w-3.5" />
                      {t('settings.apiKeyStopSharing')}
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem className="gap-2" onClick={() => void share()}>
                    <Users className="h-3.5 w-3.5" />
                    <span className="flex flex-col">
                      <span>{t('settings.apiKeyShare')}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {t('settings.apiKeyShareHint')}
                      </span>
                    </span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="gap-2 text-destructive focus:text-destructive"
                  onClick={() => void removeOwn()}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('settings.apiKeyRemove')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {serverBacked && fromDefault && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            <span>{t('settings.apiKeyFromShared')}</span>
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
