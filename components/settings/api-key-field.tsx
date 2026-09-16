'use client';

/**
 * Fork. An API-key input that never shows a stored key in clear.
 *
 * Two storages, one field. Behind the gateway the server holds the key and
 * the store holds the sentinel `***` (lib/credentials/client.ts); the field
 * shows the mask the server sent. Without a server store the key is in the
 * browser's own storage, and the field masks it the same way. Either way the
 * eye reveals only text typed in this session, which the person at the
 * keyboard already knows.
 *
 * For an admin the field also carries the one organisation action a provider
 * has (decided 2026-09-17): "use this for every account" shares the key --
 * with the provider's definition when it is a custom one -- and, for a
 * built-in LLM provider, publishes the organisation's model list in the same
 * click (`organisation` prop). Updating and withdrawing are the same two
 * things done again or undone; removing the key withdraws everything the
 * server published with it (lib/server/credentials/routes.ts).
 */

import { useState } from 'react';
import { Building2, Eye, EyeOff, Star, Trash2, Users } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  CREDENTIAL_SENTINEL,
  metaKey,
  refreshCredentials,
  removeCredential,
  shareCredential,
  type CredentialSection,
} from '@/lib/credentials/client';
import { describeSharer, shareEffect } from '@/lib/credentials/share-audit';
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
  /**
   * Fork. What a built-in LLM provider publishes together with the key: its
   * organisation model list. `published` says the list is out, `publish`
   * sends it (after the key is shared), `confirm` is asked before the first
   * publish, `hint` shows under a published list.
   */
  organisation?: {
    published: boolean;
    publish: () => Promise<boolean>;
    confirm: { title: string; body: string };
    hint?: string;
  };
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
  organisation,
}: ApiKeyFieldProps) {
  const { t, locale } = useI18n();
  const [show, setShow] = useState(false);
  // A key the user typed here can be revealed; one that arrived from storage
  // cannot. `typed` flips on the first keystroke and never back.
  const [typed, setTyped] = useState(false);
  const [editing, setEditing] = useState(false);
  const [previous, setPrevious] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Fork: which change to the shared key is waiting on the admin's yes.
  const [confirming, setConfirming] = useState<'publish' | 'replace' | 'stop' | 'remove' | null>(
    null,
  );
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
    setConfirming(null);
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
  // Fork. Sharing my key over the shared one, or stopping a share, changes
  // what every account without its own key uses; both ask first, and say
  // whose key it is (lib/credentials/share-audit.ts).
  const effect = shareEffect(meta?.source === 'own' ? meta : undefined, defaultRow);
  const sharer = defaultRow
    ? describeSharer(defaultRow, t, (ms) =>
        new Date(ms).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }),
      )
    : undefined;

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
  // The server withdraws the provider's organisation list and default with the
  // shared key (lib/server/credentials/routes.ts).
  const withdraw = () =>
    withBusy(() => removeCredential(credential!.section, credential!.providerId, 'default'));
  // Share the key -- the provider's definition goes with it, so an account
  // whose browser never added the provider can still see and use it
  // (lib/credentials/client.ts) -- then publish what else the provider has.
  const publish = () =>
    withBusy(async () => {
      const stored = await shareCredential(credential!.section, credential!.providerId);
      if (stored === undefined) return false;
      return organisation ? organisation.publish() : true;
    });

  if (stored) {
    const masked = value === CREDENTIAL_SENTINEL && meta ? meta.masked : maskApiKey(value);
    const fromDefault = value === CREDENTIAL_SENTINEL && meta?.source === 'default';
    const own = value === CREDENTIAL_SENTINEL && meta?.source === 'own';
    const curates = !!credential && role === 'admin' && serverBacked;
    // Published: the shared key is out (mine or another admin's), or the list is.
    const published = !!defaultRow || !!organisation?.published;
    const startPublish = () => {
      if (effect === 'replace') setConfirming('replace');
      else if (organisation && !published) setConfirming('publish');
      else void publish();
    };
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <div className="flex flex-wrap gap-2">
          <Input
            name={name}
            type="text"
            readOnly
            disabled={disabled}
            value={masked}
            className="h-8 min-w-[9rem] flex-1 font-mono text-muted-foreground"
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
              onClick={() => (isShared ? setConfirming('remove') : void removeOwn())}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        {serverBacked && fromDefault && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            <span>
              {role === 'admin' ? t('settings.apiKeySharedNoOwn') : t('settings.apiKeyFromShared')}
            </span>
          </div>
        )}
        {curates && (
          // Fork: the provider's one organisation action, on the key's row.
          <div className="mt-1 rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Building2 className="h-4 w-4 text-primary" />
                {published ? t('settings.orgSetupTitle') : t('settings.orgSetupPublishHint')}
              </div>
              <div className="flex flex-wrap gap-2">
                {published ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled || busy || !own}
                      title={own ? undefined : t('settings.orgSetupNeedsKey')}
                      onClick={startPublish}
                    >
                      {t('settings.orgSetupUpdate')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={disabled || busy}
                      onClick={() => setConfirming('stop')}
                    >
                      {t('settings.orgSetupWithdraw')}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={disabled || busy || !own}
                    title={own ? undefined : t('settings.orgSetupNeedsKey')}
                    onClick={startPublish}
                  >
                    {t('settings.orgSetupPublish')}
                  </Button>
                )}
              </div>
            </div>
            {sharer && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                <span>{sharer}</span>
              </div>
            )}
            {organisation?.published && organisation.hint && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Star className="h-3 w-3" />
                {organisation.hint}
              </div>
            )}
          </div>
        )}
        <AlertDialog
          open={confirming !== null}
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirming === 'stop'
                  ? t('settings.apiKeyStopTitle')
                  : confirming === 'remove'
                    ? t('settings.apiKeyRemoveSharedTitle')
                    : confirming === 'publish' && organisation
                      ? organisation.confirm.title
                      : t('settings.apiKeyReplaceTitle')}
              </AlertDialogTitle>
              <AlertDialogDescription className="flex flex-col gap-2">
                {sharer && confirming !== 'publish' && <span>{sharer}</span>}
                <span>
                  {confirming === 'stop'
                    ? t('settings.apiKeyStopBody')
                    : confirming === 'remove'
                      ? t('settings.apiKeyRemoveSharedBody')
                      : confirming === 'publish' && organisation
                        ? organisation.confirm.body
                        : t('settings.apiKeyReplaceBody')}
                </span>
                {organisation && (confirming === 'stop' || confirming === 'remove') && (
                  <span>{t('settings.orgSetupWithdrawAlso')}</span>
                )}
                {organisation && confirming === 'replace' && (
                  <span>{organisation.confirm.body}</span>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant={
                  confirming === 'stop' || confirming === 'remove' ? 'destructive' : 'default'
                }
                onClick={() => {
                  const action = confirming;
                  setConfirming(null);
                  void (action === 'stop'
                    ? withdraw()
                    : action === 'remove'
                      ? removeOwn()
                      : publish());
                }}
              >
                {confirming === 'stop'
                  ? t('settings.apiKeyStopConfirm')
                  : confirming === 'remove'
                    ? t('settings.apiKeyRemove')
                    : confirming === 'replace'
                      ? t('settings.apiKeyReplaceConfirm')
                      : t('common.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
