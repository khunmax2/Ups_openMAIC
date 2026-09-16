/**
 * Fork. Settings that belong to the organisation rather than to one account:
 * which models each LLM provider offers everyone, and the model an account
 * starts with until it picks its own.
 *
 * Model lists used to live in each account's settings blob only, so a model an
 * admin added reached nobody else, a new account started from the built-in
 * defaults, and a stale tab could erase the list (user report, 2026-09-15). The
 * organisation's list is curated by an admin in Studio Settings, kept here, and
 * handed to every browser with its credentials (lib/server/credentials/routes.ts)
 * -- the way Dify's workspace model providers and Open WebUI's admin model list
 * work. Chosen over pinning `<PREFIX>_MODELS` in env, which only applies with the
 * provider's key in env too (one key for everyone, key fields hidden) and locks
 * personal models out.
 */

import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS studio_org_setting (
  key        TEXT   PRIMARY KEY,
  value      TEXT   NOT NULL,
  updated_by TEXT   NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL
);
`;

/** A model the organisation adds to a provider's list. */
export interface OrgModel {
  id: string;
  name: string;
  contextWindow?: number;
  outputWindow?: number;
  capabilities?: { streaming?: boolean; tools?: boolean; vision?: boolean };
}

/** One provider's organisation list: built-ins it hides, models it adds. */
export interface OrgProviderModels {
  hidden: string[];
  extra: OrgModel[];
}

/** The model an account starts with until it picks its own. */
export interface OrgDefaultModel {
  providerId: string;
  modelId: string;
}

export interface OrgSetting<T> {
  value: T;
  /** The owner id that last wrote it. */
  updatedBy: string;
  updatedAt: number;
}

export interface OrgCatalog {
  models: Record<string, OrgSetting<OrgProviderModels>>;
  defaultModel?: OrgSetting<OrgDefaultModel>;
}

const MODELS_PREFIX = 'llm-models:';
export const ORG_DEFAULT_KEY = 'llm-default';
export const orgModelsKey = (providerId: string) => `${MODELS_PREFIX}${providerId}`;

const ready = new WeakMap<Queryable, Promise<void>>();

export function ensureOrgSchema(queryable: Queryable): Promise<void> {
  let schema = ready.get(queryable);
  if (!schema) {
    schema = (async () => {
      for (const statement of splitSqlStatements(SCHEMA)) await queryable.query(statement);
    })();
    // A failed attempt (database still starting) is retried by the next request.
    schema.catch(() => ready.delete(queryable));
    ready.set(queryable, schema);
  }
  return schema;
}

interface Row extends Record<string, unknown> {
  key: string;
  value: string;
  updated_by: string;
  // BIGINT: node-postgres hands it back as a string.
  updated_at: number | string;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Every organisation setting this module knows, in one query. */
export async function readOrgCatalog(queryable: Queryable): Promise<OrgCatalog> {
  await ensureOrgSchema(queryable);
  const result = await queryable.query<Row>(
    `SELECT key, value, updated_by, updated_at FROM studio_org_setting
      WHERE key = $1 OR starts_with(key, $2)`,
    [ORG_DEFAULT_KEY, MODELS_PREFIX],
  );
  const catalog: OrgCatalog = { models: {} };
  for (const row of result.rows) {
    const value = parse(row.value);
    if (!value || typeof value !== 'object') continue;
    const meta = { updatedBy: row.updated_by ?? '', updatedAt: Number(row.updated_at) || 0 };
    if (row.key === ORG_DEFAULT_KEY) {
      catalog.defaultModel = { value: value as OrgDefaultModel, ...meta };
    } else if (row.key.startsWith(MODELS_PREFIX)) {
      catalog.models[row.key.slice(MODELS_PREFIX.length)] = {
        value: value as OrgProviderModels,
        ...meta,
      };
    }
  }
  return catalog;
}

export async function writeOrgSetting(
  queryable: Queryable,
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  await ensureOrgSchema(queryable);
  await queryable.query(
    `INSERT INTO studio_org_setting (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), updatedBy, Date.now()],
  );
}

export async function deleteOrgSetting(queryable: Queryable, key: string): Promise<boolean> {
  await ensureOrgSchema(queryable);
  const result = await queryable.query(
    'DELETE FROM studio_org_setting WHERE key = $1 RETURNING key',
    [key],
  );
  return result.rows.length > 0;
}

/**
 * Withdraws a provider's organisation list and, when it points at that
 * provider, the default model. What the one "use this for every account"
 * button set, the key's removal takes away again (decided 2026-09-17), so
 * nothing is left half published. Returns what went.
 */
export async function withdrawProviderCatalog(
  queryable: Queryable,
  providerId: string,
): Promise<{ models: boolean; defaultModel: OrgDefaultModel | null }> {
  const catalog = await readOrgCatalog(queryable);
  const models = await deleteOrgSetting(queryable, orgModelsKey(providerId));
  const current = catalog.defaultModel?.value ?? null;
  const defaultModel = current?.providerId === providerId ? current : null;
  if (defaultModel) await deleteOrgSetting(queryable, ORG_DEFAULT_KEY);
  return { models, defaultModel };
}
