/**
 * Fork. Everything the studio holds for one account, and how it is removed
 * when DeepWitya purges that account (admin design §4, Phase 2, 2026-09-18).
 *
 * Every table with an owner column is listed here by name, on purpose: a
 * table added later that this module does not know is a table a purge leaves
 * behind, and the test that builds the real schema on PGlite and checks that
 * nothing owned by the purged id remains is what keeps the list honest.
 *
 * What survives, and why:
 *
 * - **Published courses.** A course the account published is in use by
 *   learners who did not lose their author. It is kept and re-owned to
 *   `deleted:<uid>` -- the way Moodle keeps a deleted user's forum posts and
 *   GitHub re-attributes comments to `ghost`. Drafts and soft-deleted courses
 *   go, with their media on disk.
 * - **Shared credentials and the organisation's catalog.** A shared row has
 *   `scope = 'default'` and no owner: it belongs to the deployment. Only its
 *   `updated_by` is rewritten to the tombstone, so the settings page can say
 *   "shared by an account that no longer exists" instead of showing a dead id.
 * - **Asset blobs.** Content-addressed and possibly shared. The account's
 *   entries go; a blob nothing references any more is marked unreferenced,
 *   and the storage package's offline collector reclaims it, as with every
 *   other removal.
 */

import type { Queryable } from '@openmaic/storage/document/pg';

/** The owner id DeepWitya's gateway states: `user:<uid>`. */
const OWNER = /^user:[^\s\u0000-\u001f\u007f]{1,64}$/u;

export function isPurgeableOwnerId(value: string): boolean {
  return OWNER.test(value);
}

/** What a purged account's surviving rows are re-owned to. */
export function tombstoneFor(ownerId: string): string {
  return `deleted:${ownerId.slice('user:'.length)}`;
}

export interface AccountFootprint {
  ownerId: string;
  /** Courses that will be removed: drafts and soft-deleted ones. */
  stagesRemoved: string[];
  /** Published courses that will be kept under the tombstone owner. */
  stagesKept: string[];
  agentSessions: number;
  ownerSessionEvents: number;
  skills: number;
  folders: number;
  materials: number;
  assets: number;
  accountKv: number;
  credentials: number;
  /** Shared rows and organisation settings this account wrote (kept, re-attributed). */
  sharedWrites: number;
}

interface StageRow extends Record<string, unknown> {
  id: string;
  is_public: boolean | null;
  deleted_at: unknown;
}

async function ownedStages(
  queryable: Queryable,
  ownerId: string,
): Promise<{ removed: string[]; kept: string[] }> {
  const result = await queryable.query<StageRow>(
    `SELECT s.id, m.is_public, m.deleted_at
       FROM document_stages s
       LEFT JOIN stage_meta m ON m.stage_id = s.id
      WHERE s.owner_id = $1 OR m.owner_id = $1
      ORDER BY s.id`,
    [ownerId],
  );
  const removed: string[] = [];
  const kept: string[] = [];
  for (const row of result.rows) {
    const published =
      row.is_public === true && (row.deleted_at === null || row.deleted_at === undefined);
    (published ? kept : removed).push(row.id);
  }
  return { removed, kept };
}

async function count(queryable: Queryable, sql: string, params: unknown[]): Promise<number> {
  const result = await queryable.query<{ n: number | string }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

/** The same numbers a purge would report, without changing anything. */
export async function accountFootprint(
  queryable: Queryable,
  ownerId: string,
): Promise<AccountFootprint> {
  const stages = await ownedStages(queryable, ownerId);
  const one = (sql: string) => count(queryable, sql, [ownerId]);
  return {
    ownerId,
    stagesRemoved: stages.removed,
    stagesKept: stages.kept,
    agentSessions: await one('SELECT count(*) AS n FROM agent_sessions WHERE owner_id = $1'),
    ownerSessionEvents: await one(
      'SELECT count(*) AS n FROM agent_owner_session_events WHERE owner_id = $1',
    ),
    skills: await one('SELECT count(*) AS n FROM agent_user_skill WHERE owner_id = $1'),
    folders: await one('SELECT count(*) AS n FROM document_folders WHERE owner_id = $1'),
    materials: await one('SELECT count(*) AS n FROM owner_material WHERE owner_id = $1'),
    assets: await one('SELECT count(*) AS n FROM asset_entries WHERE principal = $1'),
    accountKv: await one('SELECT count(*) AS n FROM studio_account_kv WHERE owner_id = $1'),
    credentials: await one(
      `SELECT count(*) AS n FROM studio_credential WHERE owner_id = $1 AND scope <> 'default'`,
    ),
    sharedWrites:
      (await one(
        `SELECT count(*) AS n FROM studio_credential WHERE updated_by = $1 AND scope = 'default'`,
      )) + (await one('SELECT count(*) AS n FROM studio_org_setting WHERE updated_by = $1')),
  };
}

export interface PurgeResult extends AccountFootprint {
  /** Byte-store keys of the removed materials, for the caller to delete after commit. */
  materialKeys: string[];
}

async function deleteCount(queryable: Queryable, sql: string, params: unknown[]): Promise<number> {
  const result = await queryable.query(sql, params);
  return result.rows.length;
}

/**
 * Removes the account's rows inside the caller's transaction. Files on disk
 * (classroom media, material bytes) are not touched here: the caller removes
 * them once the transaction has committed, from the ids this returns, so a
 * rolled-back purge leaves nothing half gone.
 */
export async function purgeAccountRows(
  queryable: Queryable,
  ownerId: string,
): Promise<PurgeResult> {
  const tombstone = tombstoneFor(ownerId);
  const stages = await ownedStages(queryable, ownerId);

  if (stages.kept.length > 0) {
    await queryable.query('UPDATE document_stages SET owner_id = $2 WHERE id = ANY($1)', [
      stages.kept,
      tombstone,
    ]);
    await queryable.query('UPDATE stage_meta SET owner_id = $2 WHERE stage_id = ANY($1)', [
      stages.kept,
      tombstone,
    ]);
  }
  if (stages.removed.length > 0) {
    // Cascades scenes, outlines and stage_meta. The revision triggers write
    // their companion rows on delete, so those go afterwards.
    await queryable.query('DELETE FROM document_stages WHERE id = ANY($1)', [stages.removed]);
    await queryable.query('DELETE FROM document_scene_revision WHERE stage_id = ANY($1)', [
      stages.removed,
    ]);
    await queryable.query('DELETE FROM document_stage_revision WHERE stage_id = ANY($1)', [
      stages.removed,
    ]);
  }

  // Cascades events, entries, urls and session materials.
  const agentSessions = await deleteCount(
    queryable,
    'DELETE FROM agent_sessions WHERE owner_id = $1 RETURNING id',
    [ownerId],
  );
  const ownerSessionEvents = await deleteCount(
    queryable,
    'DELETE FROM agent_owner_session_events WHERE owner_id = $1 RETURNING id',
    [ownerId],
  );
  await queryable.query('DELETE FROM agent_owner_session_event_counters WHERE owner_id = $1', [
    ownerId,
  ]);
  const skills = await deleteCount(
    queryable,
    'DELETE FROM agent_user_skill WHERE owner_id = $1 RETURNING id',
    [ownerId],
  );
  const folders = await deleteCount(
    queryable,
    'DELETE FROM document_folders WHERE owner_id = $1 RETURNING id',
    [ownerId],
  );

  const materials = await queryable.query<{ oss_key: string }>(
    'DELETE FROM owner_material WHERE owner_id = $1 RETURNING oss_key',
    [ownerId],
  );
  const materialKeys = materials.rows.map((row) => row.oss_key).filter((key) => key !== '');

  const assets = await queryable.query<{ content_hash: string }>(
    'DELETE FROM asset_entries WHERE principal = $1 RETURNING content_hash',
    [ownerId],
  );
  const hashes = [...new Set(assets.rows.map((row) => row.content_hash))];
  if (hashes.length > 0) {
    await queryable.query(
      `UPDATE asset_blobs b
          SET unreferenced_at = now()
        WHERE b.content_hash = ANY($1)
          AND b.unreferenced_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM asset_entries e WHERE e.content_hash = b.content_hash)`,
      [hashes],
    );
  }

  const accountKv = await deleteCount(
    queryable,
    'DELETE FROM studio_account_kv WHERE owner_id = $1 RETURNING key',
    [ownerId],
  );
  const credentials = await deleteCount(
    queryable,
    `DELETE FROM studio_credential WHERE owner_id = $1 AND scope <> 'default' RETURNING provider_id`,
    [ownerId],
  );
  const sharedWrites =
    (await deleteCount(
      queryable,
      `UPDATE studio_credential SET updated_by = $2 WHERE updated_by = $1 AND scope = 'default' RETURNING provider_id`,
      [ownerId, tombstone],
    )) +
    (await deleteCount(
      queryable,
      'UPDATE studio_org_setting SET updated_by = $2 WHERE updated_by = $1 RETURNING key',
      [ownerId, tombstone],
    ));

  return {
    ownerId,
    stagesRemoved: stages.removed,
    stagesKept: stages.kept,
    agentSessions,
    ownerSessionEvents,
    skills,
    folders,
    materials: materials.rows.length,
    assets: assets.rows.length,
    accountKv,
    credentials,
    sharedWrites,
    materialKeys,
  };
}

/**
 * Every `user:` owner id the studio holds rows for, so DeepWitya can show
 * leftovers: ids with studio data but no account. Tombstones and anonymous
 * visitors are not accounts and are left out.
 */
export async function listOwnerIds(queryable: Queryable): Promise<string[]> {
  const result = await queryable.query<{ owner_id: string }>(
    `SELECT DISTINCT owner_id FROM (
       SELECT owner_id FROM document_stages WHERE owner_id IS NOT NULL
       UNION ALL SELECT owner_id FROM stage_meta
       UNION ALL SELECT owner_id FROM agent_sessions
       UNION ALL SELECT owner_id FROM agent_owner_session_events
       UNION ALL SELECT owner_id FROM agent_user_skill
       UNION ALL SELECT owner_id FROM document_folders
       UNION ALL SELECT owner_id FROM owner_material
       UNION ALL SELECT principal FROM asset_entries
       UNION ALL SELECT owner_id FROM studio_account_kv
       UNION ALL SELECT owner_id FROM studio_credential WHERE scope <> 'default'
     ) AS owners
     WHERE owner_id LIKE 'user:%'
     ORDER BY owner_id`,
  );
  return result.rows.map((row) => row.owner_id);
}
