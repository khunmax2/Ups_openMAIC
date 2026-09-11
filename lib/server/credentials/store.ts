/**
 * Provider credentials, stored server-side per owner (fork).
 *
 * Upstream keeps every API key in the browser's localStorage, because upstream
 * has no accounts to keep them under. Behind the gateway this deployment does,
 * and a key in localStorage is readable by the next person at the same
 * machine and by anything injected into the page. DeepWitya keeps keys on the
 * server and hands the browser `***`; this is the same shape.
 *
 * Two scopes. `owner` rows belong to one account. `default` rows are set by
 * an admin and are what any account without its own row falls back to --
 * decided 2026-09-11: admin default, per-user override. Rows hold the key and
 * the base URL together because a self-hosted endpoint is not usable without
 * both, and one without the other is a configuration that half works.
 *
 * Plaintext at rest, in a database on the internal network, as DeepWitya's
 * own settings files are. Encryption at rest is a separate decision.
 */

import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

export const CREDENTIAL_SECTIONS = [
  'providers',
  'tts',
  'asr',
  'pdf',
  'image',
  'video',
  'webSearch',
] as const;
export type CredentialSection = (typeof CREDENTIAL_SECTIONS)[number];

export type CredentialScope = 'owner' | 'default';

export interface StoredCredential {
  apiKey: string;
  baseUrl: string;
}

/** Everything one request may need: the caller's own rows and the defaults. */
export interface CredentialSet {
  own: Partial<Record<CredentialSection, Record<string, StoredCredential>>>;
  defaults: Partial<Record<CredentialSection, Record<string, StoredCredential>>>;
}

/** The owner_id column for a default row. Empty, not NULL, so it can be in the key. */
const DEFAULT_OWNER = '';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS studio_credential (
  scope        TEXT   NOT NULL,
  owner_id     TEXT   NOT NULL DEFAULT '',
  section      TEXT   NOT NULL,
  provider_id  TEXT   NOT NULL,
  api_key      TEXT   NOT NULL DEFAULT '',
  base_url     TEXT   NOT NULL DEFAULT '',
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (scope, owner_id, section, provider_id)
);
CREATE INDEX IF NOT EXISTS studio_credential_owner_idx ON studio_credential (owner_id);
`;

export async function ensureCredentialSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(SCHEMA)) {
    await queryable.query(statement);
  }
}

export function isCredentialSection(value: string): value is CredentialSection {
  return (CREDENTIAL_SECTIONS as readonly string[]).includes(value);
}

/**
 * What the browser is shown instead of a key. DeepWitya's shape: enough of
 * the head and tail to recognise which key it is, never enough to use it.
 */
export function maskCredential(apiKey: string): string {
  const key = apiKey.trim();
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 2)}••••`;
  return `${key.slice(0, 5)}••••${key.slice(-4)}`;
}

interface Row extends Record<string, unknown> {
  scope: string;
  owner_id: string;
  section: string;
  provider_id: string;
  api_key: string;
  base_url: string;
}

function fold(rows: Row[], ownerId: string): CredentialSet {
  const set: CredentialSet = { own: {}, defaults: {} };
  for (const row of rows) {
    if (!isCredentialSection(row.section)) continue;
    const bucket =
      row.scope === 'default'
        ? set.defaults
        : row.scope === 'owner' && row.owner_id === ownerId
          ? set.own
          : null;
    if (!bucket) continue;
    (bucket[row.section] ??= {})[row.provider_id] = {
      apiKey: row.api_key,
      baseUrl: row.base_url,
    };
  }
  return set;
}

/** One query: the owner's rows and every default row. */
export async function listCredentials(queryable: Queryable, ownerId: string): Promise<CredentialSet> {
  const result = await queryable.query<Row>(
    `SELECT scope, owner_id, section, provider_id, api_key, base_url
       FROM studio_credential
      WHERE (scope = 'owner' AND owner_id = $1) OR scope = 'default'`,
    [ownerId],
  );
  return fold(result.rows, ownerId);
}

export interface CredentialAddress {
  scope: CredentialScope;
  ownerId: string;
  section: CredentialSection;
  providerId: string;
}

function ownerColumn(address: CredentialAddress): string {
  return address.scope === 'default' ? DEFAULT_OWNER : address.ownerId;
}

/**
 * Write a row. An omitted field keeps the stored value, so a base-URL edit
 * does not blank a key the browser never sees; an explicit empty string
 * clears it. A row with neither a key nor a base URL is deleted rather than
 * kept as an empty record that would still read as "configured".
 */
export async function upsertCredential(
  queryable: Queryable,
  address: CredentialAddress,
  patch: Partial<StoredCredential>,
): Promise<StoredCredential | null> {
  const existing = await readCredential(queryable, address);
  const next: StoredCredential = {
    apiKey: patch.apiKey ?? existing?.apiKey ?? '',
    baseUrl: patch.baseUrl ?? existing?.baseUrl ?? '',
  };
  if (!next.apiKey && !next.baseUrl) {
    await deleteCredential(queryable, address);
    return null;
  }
  await queryable.query(
    `INSERT INTO studio_credential (scope, owner_id, section, provider_id, api_key, base_url, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (scope, owner_id, section, provider_id)
     DO UPDATE SET api_key = EXCLUDED.api_key, base_url = EXCLUDED.base_url, updated_at = EXCLUDED.updated_at`,
    [
      address.scope,
      ownerColumn(address),
      address.section,
      address.providerId,
      next.apiKey,
      next.baseUrl,
      Date.now(),
    ],
  );
  return next;
}

export async function readCredential(
  queryable: Queryable,
  address: CredentialAddress,
): Promise<StoredCredential | null> {
  const result = await queryable.query<Row>(
    `SELECT scope, owner_id, section, provider_id, api_key, base_url
       FROM studio_credential
      WHERE scope = $1 AND owner_id = $2 AND section = $3 AND provider_id = $4`,
    [address.scope, ownerColumn(address), address.section, address.providerId],
  );
  const row = result.rows[0];
  return row ? { apiKey: row.api_key, baseUrl: row.base_url } : null;
}

export async function deleteCredential(
  queryable: Queryable,
  address: CredentialAddress,
): Promise<boolean> {
  const result = await queryable.query(
    `DELETE FROM studio_credential
      WHERE scope = $1 AND owner_id = $2 AND section = $3 AND provider_id = $4
      RETURNING provider_id`,
    [address.scope, ownerColumn(address), address.section, address.providerId],
  );
  return result.rows.length > 0;
}

/** Everything an owner stored, for account deletion. Defaults are not theirs. */
export async function deleteOwnerCredentials(queryable: Queryable, ownerId: string): Promise<number> {
  const result = await queryable.query(
    `DELETE FROM studio_credential WHERE scope = 'owner' AND owner_id = $1 RETURNING provider_id`,
    [ownerId],
  );
  return result.rows.length;
}
