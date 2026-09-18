/**
 * Fork. The admin accounts routes: who may call them, and that a purge
 * removes the files on disk after the rows.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import { ensureUserSkillSchema } from '@openmaic/storage/skill/pg';

import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';

/** The node-postgres pool surface, backed by the single-connection PGlite. */
class PGlitePool {
  constructor(readonly db: PGlite) {}
  query<TRow>(text: string, params?: unknown[]) {
    return this.db.query<TRow>(text, params);
  }
  async connect() {
    return {
      query: <TRow>(text: string, params?: unknown[]) => this.db.query<TRow>(text, params),
      release() {},
    };
  }
}

const PRIMARY = 'user:u_primary';
const OTHER_ADMIN = 'user:u_admin2';
const GONE = 'user:u_gone';

const as = (owner: string, role?: 'admin' | 'user', primary?: boolean) => ({
  'x-deeptutor-owner': owner,
  ...(role ? { 'x-deeptutor-role': role } : {}),
  ...(primary ? { 'x-deeptutor-primary': '1' } : {}),
});

describe('admin accounts routes', () => {
  let db: PGlite;
  let classrooms: string;
  const deletedKeys: string[] = [];
  const warned: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    deletedKeys.length = 0;
    warned.length = 0;
    db = new PGlite();
    await db.waitReady;
    await ensureDocumentSchema(db);
    await ensureStageMetaSchema(db);
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    await ensureUserSkillSchema(db);
    await ensureOwnerMaterialSchema(db);
    await ensureAssetSchema(db);
    classrooms = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-classrooms-'));

    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool: new PGlitePool(db) }),
    }));
    vi.doMock('@/lib/server/classroom-storage', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
      return { ...actual, CLASSROOMS_DIR: classrooms };
    });
    vi.doMock('@/lib/server/materials/bytes', () => ({
      getMaterialByteStore: () => ({
        put: async () => {},
        get: async () => Buffer.alloc(0),
        delete: async (key: string) => {
          deletedKeys.push(key);
        },
      }),
    }));
    vi.doMock('@/lib/logger', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/logger')>();
      return {
        ...actual,
        createLogger: (tag: string) => {
          const real = actual.createLogger(tag);
          return tag === 'Accounts' ? { ...real, warn: (line: string) => warned.push(line) } : real;
        },
      };
    });
    vi.stubEnv('DATABASE_URL', 'postgres://fake');
    vi.stubEnv('STUDIO_REQUIRE_GATEWAY', '1');
  });

  afterEach(async () => {
    await db.close();
    await fs.rm(classrooms, { recursive: true, force: true });
  });

  const handler = async () => (await import('@/lib/server/accounts/routes')).handleAccounts;

  const call = async (
    method: string,
    segments: string[],
    headers: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const handle = await handler();
    const response = await handle(
      new Request(`http://s/api/studio/admin/accounts/${segments.join('/')}`, { method, headers }),
      segments,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  async function seedGone(): Promise<{ draftDir: string; pubDir: string }> {
    const now = Date.now();
    for (const [id, isPublic] of [
      ['gone-draft', false],
      ['gone-pub', true],
    ] as const) {
      await db.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
         VALUES ($1, $1, $2, $2, $3, '{}'::jsonb)`,
        [id, now, GONE],
      );
      await db.query(
        `INSERT INTO stage_meta (stage_id, owner_id, is_public, published_at) VALUES ($1, $2, $3, $4)`,
        [id, GONE, isPublic, isPublic ? now : null],
      );
    }
    await db.query(
      `INSERT INTO owner_material (id, owner_id, kind, mime, bytes, original_name, oss_key, status, created_at)
       VALUES ('m1', $1, 'source', 'text/plain', 3, 'a.txt', 'materials/gone/a.txt', 'ready', $2)`,
      [GONE, now],
    );
    const draftDir = path.join(classrooms, 'gone-draft', 'media');
    const pubDir = path.join(classrooms, 'gone-pub', 'media');
    await fs.mkdir(draftDir, { recursive: true });
    await fs.writeFile(path.join(draftDir, 'slide.png'), 'x');
    await fs.mkdir(pubDir, { recursive: true });
    await fs.writeFile(path.join(pubDir, 'slide.png'), 'x');
    return { draftDir, pubDir };
  }

  const exists = (p: string) =>
    fs.access(p).then(
      () => true,
      () => false,
    );

  it('refuses every call that is not from the primary administrator', async () => {
    for (const headers of [
      as(OTHER_ADMIN, 'admin'),
      as(OTHER_ADMIN, 'user', true),
      as(OTHER_ADMIN),
    ]) {
      expect((await call('GET', [], headers)).status).toBe(403);
      expect((await call('GET', [GONE, 'footprint'], headers)).status).toBe(403);
      expect((await call('DELETE', [GONE], headers)).status).toBe(403);
    }
    expect(warned.some((line) => line.includes(`${OTHER_ADMIN} is not the primary`))).toBe(true);
    // Nothing without an identity either.
    expect((await call('DELETE', [GONE], {})).status).toBe(401);
  });

  it('refuses a malformed owner id and a self-purge', async () => {
    const primary = as(PRIMARY, 'admin', true);
    expect((await call('DELETE', ['anon:abc'], primary)).status).toBe(400);
    expect((await call('DELETE', ['deleted:u_1'], primary)).status).toBe(400);
    expect((await call('DELETE', [GONE, 'extra', 'x'], primary)).status).toBe(404);
    const self = await call('DELETE', [PRIMARY], primary);
    expect(self.status).toBe(400);
    expect(self.body).toEqual({
      error: { code: 'INVALID_REQUEST', message: 'an account cannot purge itself' },
    });
  });

  it('lists, measures, then purges rows and the files that belonged to them', async () => {
    const primary = as(PRIMARY, 'admin', true);
    const { draftDir, pubDir } = await seedGone();

    expect((await call('GET', [], primary)).body).toEqual({ owners: [GONE] });

    const footprint = await call('GET', [GONE, 'footprint'], primary);
    expect(footprint.status).toBe(200);
    expect(footprint.body.footprint).toMatchObject({
      stagesRemoved: ['gone-draft'],
      stagesKept: ['gone-pub'],
      materials: 1,
    });
    expect(await exists(draftDir)).toBe(true);

    const purged = await call('DELETE', [GONE], primary);
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toMatchObject({
      stagesRemoved: ['gone-draft'],
      stagesKept: ['gone-pub'],
      materials: 1,
      mediaDirectoriesRemoved: 1,
      materialFilesRemoved: 1,
    });
    expect(await exists(draftDir)).toBe(false);
    expect(await exists(pubDir)).toBe(true);
    expect(deletedKeys).toEqual(['materials/gone/a.txt']);
    expect(warned.some((line) => line.startsWith(`Purged ${GONE} by ${PRIMARY}:`))).toBe(true);

    expect((await call('GET', [], primary)).body).toEqual({ owners: [] });
    // Idempotent: the stranded-id case answers 200 with nothing to do.
    const again = await call('DELETE', [GONE], primary);
    expect(again.status).toBe(200);
    expect(again.body.purged).toMatchObject({ stagesRemoved: [], mediaDirectoriesRemoved: 0 });
  });
});
