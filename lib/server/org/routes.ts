/**
 * The HTTP surface for organisation settings (fork). Admins write; every
 * account reads them with its credentials (GET /api/studio/credentials answers
 * `org`, see {@link orgForViewer}):
 *
 *   PUT    /api/studio/org/llm-models/{providerId}   { hidden, extra }
 *   DELETE /api/studio/org/llm-models/{providerId}   back to each account's own list
 *   PUT    /api/studio/org/llm-default               { providerId, modelId }
 *   DELETE /api/studio/org/llm-default
 *
 * Any DeepWitya admin may write, the same rule as sharing a key (decided
 * 2026-09-15); who wrote it is recorded, shown to admins, and logged.
 */

import { PROVIDERS, type ProviderId } from '@/lib/ai/providers';
import { createLogger } from '@/lib/logger';
import { ownerOf } from '@/lib/server/credentials/routes';
import { credentialStore } from '@/lib/server/credentials/context';
import { readStudioRole } from '@/lib/server/studio-identity';

import {
  deleteOrgSetting,
  ORG_DEFAULT_KEY,
  orgModelsKey,
  readOrgCatalog,
  writeOrgSetting,
  type OrgDefaultModel,
  type OrgModel,
  type OrgProviderModels,
} from './store';

const log = createLogger('OrgCatalog');

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_BODY = 64 * 1024;
const MAX_MODELS = 200;
const MAX_ID = 200;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function jsonError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY) return jsonError(413, 'PAYLOAD_TOO_LARGE', 'body is too large');
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return jsonError(400, 'INVALID_REQUEST', 'body must be a JSON object');
}

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= MAX_ID;

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

/** Only what describes a model; anything else a client sends is dropped. */
function readModel(raw: unknown): OrgModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (!isId(entry.id)) return null;
  const caps = entry.capabilities as Record<string, unknown> | undefined;
  const capabilities =
    caps && typeof caps === 'object'
      ? {
          ...(caps.streaming === true ? { streaming: true } : {}),
          ...(caps.tools === true ? { tools: true } : {}),
          ...(caps.vision === true ? { vision: true } : {}),
        }
      : undefined;
  const contextWindow = positive(entry.contextWindow);
  const outputWindow = positive(entry.outputWindow);
  return {
    id: entry.id.trim(),
    name: isId(entry.name) ? entry.name.trim() : entry.id.trim(),
    ...(contextWindow ? { contextWindow } : {}),
    ...(outputWindow ? { outputWindow } : {}),
    ...(capabilities && Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  };
}

function readModels(body: Record<string, unknown>): OrgProviderModels | Response {
  const { hidden, extra } = body;
  if (!Array.isArray(hidden) || !Array.isArray(extra)) {
    return jsonError(400, 'INVALID_REQUEST', 'expected { hidden: string[], extra: model[] }');
  }
  if (hidden.length > MAX_MODELS || extra.length > MAX_MODELS) {
    return jsonError(400, 'INVALID_REQUEST', `at most ${MAX_MODELS} models`);
  }
  if (!hidden.every(isId)) return jsonError(400, 'INVALID_REQUEST', 'hidden must hold model ids');
  const models = extra.map(readModel);
  if (models.some((model) => model === null)) {
    return jsonError(400, 'INVALID_REQUEST', 'every extra model needs an id');
  }
  const seen = new Set<string>();
  const unique = (models as OrgModel[]).filter(
    (model) => !seen.has(model.id) && seen.add(model.id),
  );
  return { hidden: [...new Set(hidden.map((id) => id.trim()))], extra: unique };
}

function readDefault(body: Record<string, unknown>): OrgDefaultModel | Response {
  const { providerId, modelId } = body;
  if (typeof providerId !== 'string' || !PROVIDER_ID.test(providerId) || !isId(modelId)) {
    return jsonError(400, 'INVALID_REQUEST', 'expected { providerId, modelId }');
  }
  return { providerId, modelId: modelId.trim() };
}

type Address =
  | { key: string; kind: 'models'; providerId: string }
  | { key: string; kind: 'default' };

function parseAddress(segments: string[]): Address | Response {
  const [kind, providerId, ...rest] = segments;
  if (kind === 'llm-default' && providerId === undefined) {
    return { key: ORG_DEFAULT_KEY, kind: 'default' };
  }
  if (kind === 'llm-models' && providerId && rest.length === 0) {
    if (!PROVIDER_ID.test(providerId))
      return jsonError(400, 'INVALID_REQUEST', 'invalid provider id');
    return { key: orgModelsKey(providerId), kind: 'models', providerId };
  }
  return jsonError(404, 'ROUTE_NOT_FOUND', 'expected /llm-models/{providerId} or /llm-default');
}

/**
 * The organisation's default model only means something while the provider's
 * list offers it. When a change to that list hides it, drops it, or removes
 * the list, the default goes with it, so nothing keeps pointing at a model
 * nobody is offered and re-adding the model does not bring the star back
 * (report 2026-09-16).
 */
async function clearDefaultLeftBehind(
  store: Parameters<typeof readOrgCatalog>[0],
  providerId: string,
  offered: (modelId: string) => boolean,
): Promise<void> {
  const current = (await readOrgCatalog(store)).defaultModel?.value;
  if (!current || current.providerId !== providerId || offered(current.modelId)) return;
  await deleteOrgSetting(store, ORG_DEFAULT_KEY);
  log.info(
    `Cleared the organisation's default model: ${current.providerId}/${current.modelId} left the ${providerId} models`,
  );
}

const builtInIds = (providerId: string): Set<string> =>
  new Set((PROVIDERS[providerId as ProviderId]?.models ?? []).map((model) => model.id));

export async function handleOrgWrite(request: Request, segments: string[]): Promise<Response> {
  const owner = ownerOf(request);
  if (owner instanceof Response) return owner;
  if (readStudioRole(request.headers) !== 'admin') {
    return jsonError(
      403,
      'FORBIDDEN',
      "only an administrator can change the organisation's models",
    );
  }
  const address = parseAddress(segments);
  if (address instanceof Response) return address;
  const store = await credentialStore();
  if (!store)
    return jsonError(503, 'PERSISTENCE_NOT_CONFIGURED', 'server persistence not configured');
  const what = address.kind === 'models' ? `${address.providerId} models` : 'default model';

  if (request.method === 'DELETE') {
    const removed = await deleteOrgSetting(store, address.key);
    if (removed) log.info(`Removed the organisation's ${what}: by ${owner}`);
    if (removed && address.kind === 'models') {
      await clearDefaultLeftBehind(store, address.providerId, () => false);
    }
    return json(200, { removed });
  }
  if (request.method !== 'PUT') return jsonError(405, 'INVALID_REQUEST', 'PUT or DELETE');

  const body = await readBody(request);
  if (body instanceof Response) return body;
  const value = address.kind === 'models' ? readModels(body) : readDefault(body);
  if (value instanceof Response) return value;
  await writeOrgSetting(store, address.key, value, owner);
  log.info(
    'extra' in value
      ? `Set the organisation's ${what}: by ${owner} (hides ${value.hidden.length}, adds ${value.extra.length})`
      : `Set the organisation's default model to ${value.providerId}/${value.modelId}: by ${owner}`,
  );
  if (address.kind === 'models' && 'extra' in value) {
    const registry = builtInIds(address.providerId);
    const hidden = new Set(value.hidden);
    const added = new Set(value.extra.map((model) => model.id));
    await clearDefaultLeftBehind(
      store,
      address.providerId,
      (modelId) => !hidden.has(modelId) && (added.has(modelId) || registry.has(modelId)),
    );
  }
  return json(200, { stored: value });
}
