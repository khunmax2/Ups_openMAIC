'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiKeyField } from '@/components/settings/api-key-field';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  Loader2,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Plus,
  Zap,
  Settings2,
  Trash2,
  Sparkles,
  Wrench,
  FileText,
  Send,
  Download,
  Building2,
  Eye,
  Star,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { PROVIDERS, type ProviderConfig, type ProviderId } from '@/lib/ai/providers';
import type { ProvidersConfig } from '@/lib/types/settings';
import { createVerifyModelRequest, formatContextWindow } from './utils';
import { cn } from '@/lib/utils';
import { apiPath } from '@/lib/base-path';
import { refreshCredentials } from '@/lib/credentials/client';
import { catalogFromList } from '@/lib/credentials/org-models';
import { useSettingsStore } from '@/lib/store/settings';

interface ProviderConfigPanelProps {
  provider: ProviderConfig;
  initialApiKey: string;
  initialBaseUrl: string;
  initialRequiresApiKey: boolean;
  providersConfig: ProvidersConfig;
  onConfigChange: (apiKey: string, baseUrl: string, requiresApiKey: boolean) => void;
  onSave: () => void; // Auto-save on blur
  onEditModel: (index: number) => void;
  onDeleteModel: (index: number) => void;
  onAddModel: () => void;
  /** Merge probed model ids into the provider's list; returns the count added. */
  onModelsFetched?: (ids: string[]) => number;
  /** Optional explicit /models URL override (from a preset). */
  modelsUrl?: string;
  onResetToDefault?: () => void; // Reset provider to default configuration
  isBuiltIn: boolean; // To determine if reset button should be shown
}

export function ProviderConfigPanel({
  provider,
  initialApiKey,
  initialBaseUrl,
  initialRequiresApiKey,
  providersConfig,
  onConfigChange,
  onSave,
  onEditModel,
  onDeleteModel,
  onAddModel,
  onModelsFetched,
  modelsUrl,
  onResetToDefault,
  isBuiltIn,
}: ProviderConfigPanelProps) {
  const { t, locale } = useI18n();

  // Local state for this provider
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [requiresApiKey, setRequiresApiKey] = useState(initialRequiresApiKey);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'fetching' | 'success' | 'error'>('idle');
  const [fetchMessage, setFetchMessage] = useState('');

  // Update local state when provider changes or initial values change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync local state from props on provider change
    setApiKey(initialApiKey);

    setBaseUrl(initialBaseUrl);

    setRequiresApiKey(initialRequiresApiKey);

    setTestStatus('idle');

    setTestMessage('');
    setFetchStatus('idle');
    setFetchMessage('');
  }, [provider.id, initialApiKey, initialBaseUrl, initialRequiresApiKey]);

  // Notify parent of changes
  const handleApiKeyChange = (key: string) => {
    setApiKey(key);
    onConfigChange(key, baseUrl, requiresApiKey);
  };

  const handleBaseUrlChange = (url: string) => {
    setBaseUrl(url);
    onConfigChange(apiKey, url, requiresApiKey);
  };

  const handleRequiresApiKeyChange = (requires: boolean) => {
    setRequiresApiKey(requires);
    onConfigChange(apiKey, baseUrl, requires);
  };

  const handleTestApi = useCallback(async () => {
    setTestStatus('testing');
    setTestMessage('');

    const availableModels = providersConfig[provider.id]?.models || [];

    if (availableModels.length === 0) {
      setTestStatus('error');
      setTestMessage(t('settings.noModelsAvailable') || 'No models available for testing');
      return;
    }

    const testModelId = availableModels[0].id;

    try {
      const response = await fetch(apiPath('/api/verify-model'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          createVerifyModelRequest({
            providerId: provider.id,
            modelId: testModelId,
            apiKey,
            baseUrl,
            providerType: provider.type,
            requiresApiKey,
          }),
        ),
      });

      const data = await response.json();

      if (data.success) {
        setTestStatus('success');
        setTestMessage(t('settings.connectionSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(data.error || t('settings.connectionFailed'));
      }
    } catch (_error) {
      setTestStatus('error');
      setTestMessage(t('settings.connectionFailed'));
    }
  }, [apiKey, baseUrl, provider.id, provider.type, requiresApiKey, providersConfig, t]);

  const effectiveBaseUrl = baseUrl || provider.defaultBaseUrl || '';

  // Probe the provider's /models endpoint and merge results into the model list.
  const handleFetchModels = useCallback(async () => {
    setFetchStatus('fetching');
    setFetchMessage('');
    try {
      const response = await fetch(apiPath('/api/provider/probe-models'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: effectiveBaseUrl, apiKey, modelsUrl }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        const ids: string[] = (data.models || []).map((m: { id: string }) => m.id);
        const added = onModelsFetched?.(ids) ?? 0;
        setFetchStatus('success');
        setFetchMessage(
          t('settings.fetchModelsResult')
            .replace('{added}', String(added))
            .replace('{total}', String(ids.length)),
        );
      } else if (response.status === 404) {
        setFetchStatus('error');
        setFetchMessage(t('settings.fetchModelsNoEndpoint'));
      } else if (response.status === 401) {
        setFetchStatus('error');
        setFetchMessage(t('settings.fetchModelsAuthError'));
      } else {
        setFetchStatus('error');
        setFetchMessage(data.error || t('settings.fetchModelsFailed'));
      }
    } catch {
      setFetchStatus('error');
      setFetchMessage(t('settings.fetchModelsFailed'));
    }
  }, [apiKey, effectiveBaseUrl, modelsUrl, onModelsFetched, t]);

  const models = providersConfig[provider.id]?.models || [];
  const isServerConfigured = providersConfig[provider.id]?.isServerConfigured;
  // When the operator pins an allowed model list (MODELS env/yaml), the model
  // catalog is admin-managed too — view-only, no add/edit/delete. Without a
  // pinned list the server manages only credentials and the user curates models.
  const modelsLocked = !!providersConfig[provider.id]?.serverModels?.length;

  // Fork: the organisation's model list for this provider, curated by an admin
  // here and applied to every account (lib/credentials/org-models.ts).
  const role = useSettingsStore((s) => s.credentialRole);
  const serverBacked = useSettingsStore((s) => s.credentialStorage === 'server');
  const orgCatalog = useSettingsStore((s) => s.orgModelCatalog);
  const orgHere = orgCatalog?.models[provider.id];
  const orgDefault = orgCatalog?.defaultModel;
  const registry = PROVIDERS[provider.id as ProviderId]?.models ?? [];
  const builtInIds = new Set(registry.map((m) => m.id));
  const canCurate =
    serverBacked && role === 'admin' && isBuiltIn && !modelsLocked && registry.length > 0;
  const [orgConfirm, setOrgConfirm] = useState<
    { kind: 'publish' } | { kind: 'remove' } | { kind: 'drop'; modelId: string } | null
  >(null);
  const [orgBusy, setOrgBusy] = useState(false);

  const orgRequest = async (method: 'PUT' | 'DELETE', path: string, body?: unknown) => {
    setOrgBusy(true);
    try {
      const res = await fetch(apiPath(`/api/studio/org/${path}`), {
        method,
        credentials: 'include',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (res.ok) await refreshCredentials();
    } finally {
      setOrgBusy(false);
    }
  };
  const putOrgModels = (hidden: string[], extra: NonNullable<typeof orgHere>['extra']) =>
    orgRequest('PUT', `llm-models/${provider.id}`, { hidden, extra });
  const isOrgDefault = (modelId: string) =>
    orgDefault?.providerId === provider.id && orgDefault.modelId === modelId;
  const orgStamp = (() => {
    if (!orgHere?.updatedAt) return '';
    const time = new Date(orgHere.updatedAt).toLocaleString(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    if (orgHere.updatedByYou) return t('settings.orgModelsByYou', { time });
    return orgHere.updatedBy
      ? t('settings.orgModelsByOther', { who: orgHere.updatedBy, time })
      : '';
  })();

  // An admin's delete of the organisation's entry edits the organisation's list
  // (after a question); anything else is this person's own list.
  const deleteRow = (index: number) => {
    const model = models[index];
    if (model && canCurate && orgHere && (model.fromOrg || builtInIds.has(model.id))) {
      setOrgConfirm({ kind: 'drop', modelId: model.id });
      return;
    }
    onDeleteModel(index);
  };
  const confirmOrg = () => {
    const pending = orgConfirm;
    setOrgConfirm(null);
    if (!pending) return;
    if (pending.kind === 'publish') {
      void orgRequest('PUT', `llm-models/${provider.id}`, catalogFromList(registry, models));
    } else if (pending.kind === 'remove') {
      void orgRequest('DELETE', `llm-models/${provider.id}`);
    } else if (orgHere) {
      void (builtInIds.has(pending.modelId)
        ? putOrgModels([...new Set([...orgHere.hidden, pending.modelId])], orgHere.extra)
        : putOrgModels(
            orgHere.hidden,
            orgHere.extra.filter((m) => m.id !== pending.modelId),
          ));
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* Managed providers are admin-owned: the operator's key and base URL are
          authoritative and not overridable here, so the editing inputs are hidden. */}
      {!isServerConfigured && (
        <>
          {/* API Key */}
          <div className="space-y-2">
            <Label>{t('settings.apiSecret')}</Label>
            <div className="flex gap-2">
              <ApiKeyField
                credential={{ section: 'providers', providerId: provider.id }}
                name={`llm-api-key-${provider.id}`}
                placeholder="sk-..."
                value={apiKey}
                onChange={handleApiKeyChange}
                onBlur={onSave}
                disabled={!requiresApiKey}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestApi}
                disabled={testStatus === 'testing' || (requiresApiKey && !apiKey)}
                className="gap-1.5"
              >
                {testStatus === 'testing' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Zap className="h-3.5 w-3.5" />
                    {t('settings.testConnection')}
                  </>
                )}
              </Button>
            </div>
            {testMessage && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm overflow-hidden',
                  testStatus === 'success' && 'bg-green-50 text-green-700 border border-green-200',
                  testStatus === 'error' && 'bg-red-50 text-red-700 border border-red-200',
                )}
              >
                <div className="flex items-start gap-2 min-w-0">
                  {testStatus === 'success' && <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />}
                  {testStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                  <p className="flex-1 min-w-0 break-all">{testMessage}</p>
                </div>
              </div>
            )}
            <div className="flex items-center space-x-2">
              <Checkbox
                id={`requires-api-key-${provider.id}`}
                checked={requiresApiKey}
                onCheckedChange={(checked) => {
                  handleRequiresApiKeyChange(checked as boolean);
                  onSave();
                }}
              />
              <label
                htmlFor={`requires-api-key-${provider.id}`}
                className="text-sm cursor-pointer text-muted-foreground"
              >
                {t('settings.requiresApiKey')}
              </label>
            </div>
          </div>

          {/* API Host */}
          <div className="space-y-2">
            <Label>{t('settings.apiHost')}</Label>
            <Input
              name={`llm-base-url-${provider.id}`}
              type="url"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={
                provider.baseUrlPlaceholder ||
                provider.defaultBaseUrl ||
                'https://api.example.com/v1'
              }
              value={baseUrl}
              onChange={(e) => handleBaseUrlChange(e.target.value)}
              onBlur={onSave}
              className="h-8"
            />
            {provider.alternateBaseUrls && provider.alternateBaseUrls.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {provider.alternateBaseUrls.map((alt) => {
                  const active = (baseUrl || provider.defaultBaseUrl) === alt.url;
                  return (
                    <button
                      key={alt.url}
                      type="button"
                      onClick={() => {
                        handleBaseUrlChange(alt.url);
                        onSave();
                      }}
                      className={cn(
                        'px-2 py-0.5 text-xs rounded-md border transition-colors',
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-muted-foreground border-border hover:bg-muted',
                      )}
                    >
                      {t(alt.label)}
                    </button>
                  );
                })}
              </div>
            )}
            {(() => {
              const effectiveBaseUrl = baseUrl || provider.defaultBaseUrl || '';
              if (!effectiveBaseUrl) return null;

              // Generate endpoint path based on provider type
              let endpointPath = '';
              switch (provider.type) {
                case 'openai':
                  endpointPath = '/chat/completions';
                  break;
                case 'azure':
                  endpointPath = '/v1/responses?api-version=v1';
                  break;
                case 'anthropic':
                  endpointPath = '/messages';
                  break;
                case 'google':
                  endpointPath = '/models/[model]';
                  break;
                default:
                  endpointPath = '';
              }

              const fullUrl = effectiveBaseUrl + endpointPath;

              return (
                <p className="text-xs text-muted-foreground break-all">
                  {t('settings.requestUrl')}: {fullUrl}
                </p>
              );
            })()}
          </div>
        </>
      )}

      {/* Models - No selection state, just list for management */}
      <div className="space-y-3">
        {provider.id === 'azure' && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
            {t('settings.azureDeploymentHint')}
          </div>
        )}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Label className="text-base">{t('settings.models')}</Label>
            {modelsLocked && (
              <span className="text-[10px] px-1 py-0 h-4 leading-4 rounded bg-muted text-muted-foreground">
                {t('settings.serverConfigured')}
              </span>
            )}
          </div>
          {!modelsLocked && (
            <div className="flex items-center gap-2 flex-wrap">
              {isBuiltIn && onResetToDefault && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowResetDialog(true)}
                  className="gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('settings.reset')}
                </Button>
              )}
              {provider.supportsModelDiscovery !== false && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleFetchModels}
                  disabled={fetchStatus === 'fetching' || (requiresApiKey && !apiKey)}
                  className="gap-1.5"
                >
                  {fetchStatus === 'fetching' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {t('settings.fetchModels')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={onAddModel} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                {t('settings.addNewModel')}
              </Button>
            </div>
          )}
        </div>

        {/* Fetch-models result message */}
        {fetchMessage && (
          <div
            className={cn(
              'rounded-lg p-2.5 text-xs',
              fetchStatus === 'success' && 'bg-green-50 text-green-700 border border-green-200',
              fetchStatus === 'error' && 'bg-amber-50 text-amber-700 border border-amber-200',
            )}
          >
            {fetchMessage}
          </div>
        )}

        {/* Fork: the organisation's model list (lib/credentials/org-models.ts). */}
        {canCurate && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Building2 className="h-4 w-4 text-primary" />
                {orgHere ? t('settings.orgModelsTitle') : t('settings.orgModelsPublishHint')}
              </div>
              <div className="flex flex-wrap gap-2">
                {orgHere ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={orgBusy}
                      onClick={() => setOrgConfirm({ kind: 'publish' })}
                    >
                      {t('settings.orgModelsUpdate')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={orgBusy}
                      onClick={() => setOrgConfirm({ kind: 'remove' })}
                    >
                      {t('settings.orgModelsRemove')}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    disabled={orgBusy}
                    onClick={() => setOrgConfirm({ kind: 'publish' })}
                  >
                    {t('settings.orgModelsPublish')}
                  </Button>
                )}
              </div>
            </div>
            {orgStamp && <div className="text-xs text-muted-foreground">{orgStamp}</div>}
            {orgHere && orgHere.hidden.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t('settings.orgModelsHidden')}</span>
                {orgHere.hidden.map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={orgBusy}
                    title={t('settings.orgModelsShowAgain')}
                    onClick={() =>
                      void putOrgModels(
                        orgHere.hidden.filter((hidden) => hidden !== id),
                        orgHere.extra,
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 hover:bg-muted"
                  >
                    <Eye className="h-3 w-3" />
                    {registry.find((m) => m.id === id)?.name ?? id}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!canCurate && orgHere && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" />
            {t('settings.orgModelsForEveryone')}
          </div>
        )}

        <div className="space-y-1.5">
          {models.map((model, index) => {
            return (
              <div
                key={model.id}
                className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-card"
              >
                <div className="flex-1">
                  <div className="font-mono text-sm font-medium mb-1.5 flex flex-wrap items-center gap-1.5">
                    {model.name}
                    {model.fromOrg && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 font-sans text-[10px] font-medium text-primary">
                        <Building2 className="h-3 w-3" />
                        {t('settings.orgModelBadge')}
                      </span>
                    )}
                    {isOrgDefault(model.id) && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 font-sans text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        <Star className="h-3 w-3" />
                        {t('settings.orgDefaultBadge')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {/* Capabilities */}
                    <div className="flex items-center gap-1">
                      {model.capabilities?.vision && (
                        <div title={t('settings.capabilities.vision')}>
                          <Sparkles className="h-3 w-3" />
                        </div>
                      )}
                      {model.capabilities?.tools && (
                        <div title={t('settings.capabilities.tools')}>
                          <Wrench className="h-3 w-3" />
                        </div>
                      )}
                      {model.capabilities?.streaming && (
                        <div title={t('settings.capabilities.streaming')}>
                          <Zap className="h-3 w-3" />
                        </div>
                      )}
                    </div>
                    {/* Context Window */}
                    {model.contextWindow && (
                      <span className="flex items-center gap-0.5">
                        <FileText className="h-3 w-3" />
                        <span className="text-[10px]">
                          {formatContextWindow(model.contextWindow)}
                        </span>
                      </span>
                    )}
                    {/* Output Window */}
                    {model.outputWindow && (
                      <span className="flex items-center gap-0.5">
                        <Send className="h-3 w-3" />
                        <span className="text-[10px]">
                          {formatContextWindow(model.outputWindow)}
                        </span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Edit/Delete Buttons — hidden when the model catalog is server-managed.
                    Fork: the organisation's entries are the organisation's to change --
                    an admin's delete edits its list; nobody edits them in place. */}
                {!modelsLocked && (!model.fromOrg || canCurate) && (
                  <div className="flex items-center gap-1">
                    {canCurate &&
                      (builtInIds.has(model.id) || model.fromOrg) &&
                      !isOrgDefault(model.id) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2"
                          disabled={orgBusy}
                          onClick={() =>
                            void orgRequest('PUT', 'llm-default', {
                              providerId: provider.id,
                              modelId: model.id,
                            })
                          }
                          title={t('settings.orgDefaultSet')}
                        >
                          <Star className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    {!model.fromOrg && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2"
                        onClick={() => onEditModel(index)}
                        title={t('settings.editModel')}
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => deleteRow(index)}
                      title={t('settings.deleteModel')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Reset Confirmation Dialog */}
      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.resetToDefault')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.resetConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowResetDialog(false);
                onResetToDefault?.();
              }}
            >
              {t('settings.confirmReset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Fork: every change to the organisation's list asks first. */}
      <AlertDialog
        open={orgConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setOrgConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {orgConfirm?.kind === 'remove'
                ? t('settings.orgModelsRemoveTitle')
                : orgConfirm?.kind === 'drop'
                  ? t('settings.orgModelDeleteTitle')
                  : t('settings.orgModelsPublishTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {orgConfirm?.kind === 'remove'
                ? t('settings.orgModelsRemoveBody')
                : orgConfirm?.kind === 'drop'
                  ? t('settings.orgModelDeleteBody')
                  : t('settings.orgModelsPublishBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant={orgConfirm?.kind === 'publish' ? 'default' : 'destructive'}
              onClick={confirmOrg}
            >
              {t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
