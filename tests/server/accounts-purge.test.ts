/**
 * Fork. Purging an account's studio data (admin design §4, Phase 2). The
 * real schemas are built on PGlite, so a table this module forgets shows up
 * here as rows the purged id still owns.
 */

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import { ensureUserSkillSchema } from '@openmaic/storage/skill/pg';

import { ensureAccountKvSchema } from '@/lib/persistence/account-kv';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  accountFootprint,
  isPurgeableOwnerId,
  listOwnerIds,
  purgeAccountRows,
  tombstoneFor,
} from '@/lib/server/accounts/purge';
import { ensureCredentialSchema } from '@/lib/server/credentials/store';
import { ensureOrgSchema } from '@/lib/server/org/store';
import { readStudioPrimary } from '@/lib/server/studio-identity';

const A = 'user:u_gone';
const B = 'user:u_stays';

async function seedOwner(db: PGlite, owner: string, tag: string): Promise<void> {
  const now = Date.now();
  // Three courses: a draft, a published one, and a published one the owner deleted.
  for (const [suffix, isPublic, deleted] of [
    ['draft', false, false],
    ['pub', true, false],
    ['binned', true, true],
  ] as const) {
    const id = `${tag}-${suffix}`;
    await db.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
       VALUES ($1, $2, $3, $3, $4, '{}'::jsonb)`,
      [id, id, now, owner],
    );
    await db.query(
      `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, 's1', 1, '{}'::jsonb)`,
      [id],
    );
    await db.query(`INSERT INTO document_outlines (stage_id, data) VALUES ($1, '{}'::jsonb)`, [id]);
    await db.query(
      `INSERT INTO stage_meta (stage_id, owner_id, is_public, published_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, owner, isPublic, isPublic ? now : null, deleted ? new Date() : null],
    );
  }
  await db.query(
    `INSERT INTO agent_sessions (id, owner_id, prompt, stage_id) VALUES ($1, $2, 'p', $3)`,
    [`${tag}-sess`, owner, `${tag}-draft`],
  );
  await db.query(
    `INSERT INTO agent_session_events (session_id, seq, ts, attempt, type, data)
     VALUES ($1, 1, $2, 0, 'note', '{}'::jsonb)`,
    [`${tag}-sess`, now],
  );
  await db.query(`INSERT INTO agent_owner_session_event_counters (owner_id, n) VALUES ($1, 1)`, [
    owner,
  ]);
  await db.query(
    `INSERT INTO agent_owner_session_events (owner_id, id, ts, session_id, type, data)
     VALUES ($1, 1, $2, $3, 'session_created', '{}'::jsonb)`,
    [owner, now, `${tag}-sess`],
  );
  await db.query(
    `INSERT INTO agent_user_skill (id, owner_id, name, title, description, content)
     VALUES ($1, $2, $3, 't', 'd', 'c')`,
    [`${tag}-skill`, owner, `my-${tag}-skill`],
  );
  await db.query(
    `INSERT INTO document_folders (owner_id, id, name, normalized_name, created_at, updated_at)
     VALUES ($1, $2, 'f', 'f', $3, $3)`,
    [owner, `${tag}-folder`, now],
  );
  await db.query(
    `INSERT INTO owner_material (id, owner_id, kind, mime, bytes, original_name, oss_key, status, created_at)
     VALUES ($1, $2, 'source', 'text/plain', 3, 'a.txt', $3, 'ready', $4)`,
    [`${tag}-mat`, owner, `materials/${tag}/a.txt`, now],
  );
  await db.query(
    `INSERT INTO studio_account_kv (owner_id, key, value, updated_at) VALUES ($1, 'settings-storage', '{}', $2)`,
    [owner, now],
  );
  await db.query(
    `INSERT INTO studio_credential (scope, owner_id, section, provider_id, api_key, updated_at, updated_by)
     VALUES ('owner', $1, 'providers', 'openai', 'sk-own', $2, $1)`,
    [owner, now],
  );
}

async function seedAssets(db: PGlite): Promise<void> {
  const now = Date.now();
  for (const hash of ['h-shared', 'h-a-only', 'h-b-only']) {
    await db.query(`INSERT INTO asset_blobs (content_hash, byte_size) VALUES ($1, 1)`, [hash]);
  }
  const entry = (id: string, principal: string, hash: string) =>
    db.query(
      `INSERT INTO asset_entries (id, principal, content_hash, mime, meta, created_at)
       VALUES ($1, $2, $3, 'image/png', '{}'::jsonb, $4)`,
      [id, principal, hash, now],
    );
  await entry('a1', A, 'h-shared');
  await entry('a2', A, 'h-a-only');
  await entry('b1', B, 'h-shared');
  await entry('b2', B, 'h-b-only');
}

async function seedShared(db: PGlite): Promise<void> {
  const now = Date.now();
  // A shared a key and published the organisation's list; both belong to the deployment.
  await db.query(
    `INSERT INTO studio_credential (scope, owner_id, section, provider_id, api_key, updated_at, updated_by)
     VALUES ('default', '', 'providers', 'openrouter', 'sk-shared', $1, $2)`,
    [now, A],
  );
  await db.query(
    `INSERT INTO studio_org_setting (key, value, updated_by, updated_at)
     VALUES ('llm-models:openrouter', '{"hidden":[],"extra":[]}', $1, $2)`,
    [A, now],
  );
}

async function ownedBy(db: PGlite, owner: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const tables: Array<[string, string]> = [
    ['document_stages', 'owner_id'],
    ['stage_meta', 'owner_id'],
    ['agent_sessions', 'owner_id'],
    ['agent_owner_session_events', 'owner_id'],
    ['agent_owner_session_event_counters', 'owner_id'],
    ['agent_user_skill', 'owner_id'],
    ['document_folders', 'owner_id'],
    ['owner_material', 'owner_id'],
    ['asset_entries', 'principal'],
    ['studio_account_kv', 'owner_id'],
    ['studio_credential', 'owner_id'],
  ];
  for (const [table, column] of tables) {
    const result = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1`,
      [owner],
    );
    counts[table] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

const zero = (counts: Record<string, number>) => Object.values(counts).every((n) => n === 0);

describe('purging an account', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureDocumentSchema(db);
    await ensureStageMetaSchema(db);
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    await ensureUserSkillSchema(db);
    await ensureOwnerMaterialSchema(db);
    await ensureAssetSchema(db);
    await ensureAccountKvSchema(db);
    await ensureCredentialSchema(db);
    await ensureOrgSchema(db);
    await seedOwner(db, A, 'a');
    await seedOwner(db, B, 'b');
    await seedAssets(db);
    await seedShared(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('the footprint counts what a purge would touch, without touching it', async () => {
    const footprint = await accountFootprint(db, A);
    expect(footprint).toMatchObject({
      ownerId: A,
      stagesRemoved: ['a-binned', 'a-draft'],
      stagesKept: ['a-pub'],
      agentSessions: 1,
      ownerSessionEvents: 1,
      skills: 1,
      folders: 1,
      materials: 1,
      assets: 2,
      accountKv: 1,
      credentials: 1,
      sharedWrites: 2,
    });
    expect(zero(await ownedBy(db, A))).toBe(false);
  });

  it('removes every row the account owned and nothing of anyone else', async () => {
    const before = await ownedBy(db, B);
    const result = await purgeAccountRows(db, A);

    expect(zero(await ownedBy(db, A))).toBe(true);
    expect(await ownedBy(db, B)).toEqual(before);
    expect(result).toMatchObject({
      stagesRemoved: ['a-binned', 'a-draft'],
      stagesKept: ['a-pub'],
      agentSessions: 1,
      ownerSessionEvents: 1,
      skills: 1,
      folders: 1,
      materials: 1,
      assets: 2,
      accountKv: 1,
      credentials: 1,
      sharedWrites: 2,
      materialKeys: ['materials/a/a.txt'],
    });

    // Cascades: the removed courses' scenes, outlines and meta went with them,
    // and so did the session's events; the revision companions are clean.
    const scenes = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM document_scenes WHERE stage_id IN ('a-draft', 'a-binned')`,
    );
    expect(scenes.rows[0]?.n).toBe('0');
    const revisions = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM document_stage_revision WHERE stage_id IN ('a-draft', 'a-binned')`,
    );
    expect(revisions.rows[0]?.n).toBe('0');
    const events = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_session_events WHERE session_id = 'a-sess'`,
    );
    expect(events.rows[0]?.n).toBe('0');
  });

  it('keeps the published course under the tombstone owner, so learners keep it', async () => {
    await purgeAccountRows(db, A);
    const tombstone = tombstoneFor(A);
    expect(tombstone).toBe('deleted:u_gone');

    const stage = await db.query<{ owner_id: string; name: string }>(
      `SELECT owner_id, name FROM document_stages WHERE id = 'a-pub'`,
    );
    expect(stage.rows[0]).toEqual({ owner_id: tombstone, name: 'a-pub' });
    const meta = await db.query<{ owner_id: string; is_public: boolean }>(
      `SELECT owner_id, is_public FROM stage_meta WHERE stage_id = 'a-pub'`,
    );
    expect(meta.rows[0]).toEqual({ owner_id: tombstone, is_public: true });
    const scenes = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM document_scenes WHERE stage_id = 'a-pub'`,
    );
    expect(scenes.rows[0]?.n).toBe('1');
  });

  it('keeps what the account shared with the deployment, re-attributed', async () => {
    await purgeAccountRows(db, A);
    const shared = await db.query<{ api_key: string; updated_by: string }>(
      `SELECT api_key, updated_by FROM studio_credential WHERE scope = 'default' AND provider_id = 'openrouter'`,
    );
    expect(shared.rows[0]).toEqual({ api_key: 'sk-shared', updated_by: 'deleted:u_gone' });
    const org = await db.query<{ updated_by: string }>(
      `SELECT updated_by FROM studio_org_setting WHERE key = 'llm-models:openrouter'`,
    );
    expect(org.rows[0]).toEqual({ updated_by: 'deleted:u_gone' });
  });

  it('marks only the blobs nobody references any more', async () => {
    await purgeAccountRows(db, A);
    const blobs = await db.query<{ content_hash: string; unreferenced: boolean }>(
      `SELECT content_hash, unreferenced_at IS NOT NULL AS unreferenced FROM asset_blobs ORDER BY content_hash`,
    );
    expect(blobs.rows).toEqual([
      { content_hash: 'h-a-only', unreferenced: true },
      { content_hash: 'h-b-only', unreferenced: false },
      { content_hash: 'h-shared', unreferenced: false },
    ]);
  });

  it('is idempotent: a second purge finds nothing and says so', async () => {
    await purgeAccountRows(db, A);
    const again = await purgeAccountRows(db, A);
    expect(again).toMatchObject({
      stagesRemoved: [],
      stagesKept: [],
      agentSessions: 0,
      ownerSessionEvents: 0,
      skills: 0,
      folders: 0,
      materials: 0,
      assets: 0,
      accountKv: 0,
      credentials: 0,
      sharedWrites: 0,
      materialKeys: [],
    });
  });

  it('lists the accounts that hold rows, never tombstones or anonymous visitors', async () => {
    await db.query(
      `INSERT INTO studio_account_kv (owner_id, key, value, updated_at) VALUES ('anon:abc', 'k', '{}', 1)`,
    );
    expect(await listOwnerIds(db)).toEqual([A, B]);
    await purgeAccountRows(db, A);
    expect(await listOwnerIds(db)).toEqual([B]);
  });
});

describe('the primary header', () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('counts only beside the admin role', () => {
    expect(
      readStudioPrimary(headers({ 'x-deeptutor-role': 'admin', 'x-deeptutor-primary': '1' })),
    ).toBe(true);
    expect(readStudioPrimary(headers({ 'x-deeptutor-role': 'admin' }))).toBe(false);
    expect(
      readStudioPrimary(headers({ 'x-deeptutor-role': 'user', 'x-deeptutor-primary': '1' })),
    ).toBe(false);
    expect(readStudioPrimary(headers({ 'x-deeptutor-primary': '1' }))).toBe(false);
    expect(
      readStudioPrimary(headers({ 'x-deeptutor-role': 'admin', 'x-deeptutor-primary': 'yes' })),
    ).toBe(false);
  });

  it('can be renamed with the other two', () => {
    vi.stubEnv('STUDIO_PRIMARY_HEADER', 'X-Owner-Primary');
    expect(
      readStudioPrimary(headers({ 'x-deeptutor-role': 'admin', 'x-owner-primary': '1' })),
    ).toBe(true);
    expect(
      readStudioPrimary(headers({ 'x-deeptutor-role': 'admin', 'x-deeptutor-primary': '1' })),
    ).toBe(false);
  });
});

describe('owner ids a purge accepts', () => {
  it('takes the gateway form and nothing else', () => {
    expect(isPurgeableOwnerId('user:u_8d809b7e')).toBe(true);
    expect(isPurgeableOwnerId('anon:abc')).toBe(false);
    expect(isPurgeableOwnerId('deleted:u_1')).toBe(false);
    expect(isPurgeableOwnerId('user:')).toBe(false);
    expect(isPurgeableOwnerId('user:a b')).toBe(false);
    expect(isPurgeableOwnerId(`user:${'x'.repeat(65)}`)).toBe(false);
  });
});
