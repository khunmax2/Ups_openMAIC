/**
 * Fork. The admin surface DeepWitya calls when it purges an account (admin
 * design §4, Phase 2):
 *
 *   GET    /api/studio/admin/accounts                      owner ids with rows here
 *   GET    /api/studio/admin/accounts/{ownerId}/footprint  what a purge would remove
 *   DELETE /api/studio/admin/accounts/{ownerId}            remove it
 *
 * Every call requires the gateway's `admin` role **and** its primary header:
 * only the deployment's primary administrator purges, the same rule DeepWitya
 * applies on its side. `ownerId` is the `user:<uid>` form every owner column
 * stores. A purge is idempotent -- an owner with nothing left answers 200 with
 * zeros -- which is what lets ids stranded by an older delete be cleaned up.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { createLogger } from '@/lib/logger';
import { ensureAccountKvSchema } from '@/lib/persistence/account-kv';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { CLASSROOMS_DIR, isValidClassroomId } from '@/lib/server/classroom-storage';
import { ensureCredentialSchema } from '@/lib/server/credentials/store';
import { ownerOf } from '@/lib/server/credentials/routes';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';
import { ensureOrgSchema } from '@/lib/server/org/store';
import { readStudioPrimary } from '@/lib/server/studio-identity';

import {
  accountFootprint,
  isPurgeableOwnerId,
  listOwnerIds,
  purgeAccountRows,
  type PurgeResult,
} from './purge';

const log = createLogger('Accounts');

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function jsonError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

/**
 * The pool, with every table this module touches in place. The provider
 * ensures the storage package's schemas and the fork's stage/material ones;
 * the credential, organisation and account-KV tables are created by their
 * own modules on first use, so a purge on a fresh database must not be the
 * first thing to mention them.
 */
async function pool(): Promise<ConnectableQueryable | undefined> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return undefined;
  const provider = await getServerPersistenceProvider(connectionString);
  const queryable = provider.pool as unknown as ConnectableQueryable;
  await ensureCredentialSchema(queryable);
  await ensureOrgSchema(queryable);
  await ensureAccountKvSchema(queryable);
  return queryable;
}

/** Removes a course's media directory; a directory that is not there is fine. */
async function removeClassroomMedia(stageId: string): Promise<boolean> {
  if (!isValidClassroomId(stageId)) return false;
  const dir = path.resolve(CLASSROOMS_DIR, stageId);
  if (!dir.startsWith(`${path.resolve(CLASSROOMS_DIR)}${path.sep}`)) return false;
  try {
    await fs.access(dir);
  } catch {
    return false;
  }
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

export interface PurgeSummary extends Omit<PurgeResult, 'materialKeys'> {
  mediaDirectoriesRemoved: number;
  materialFilesRemoved: number;
}

/**
 * Rows in one transaction, then files. A file that will not delete is logged
 * and skipped: the rows that named it are already gone, and the collector's
 * "disk only grows" caveat in FORK.md is the known state of the volume.
 */
export async function purgeAccount(
  db: ConnectableQueryable,
  ownerId: string,
): Promise<PurgeSummary> {
  const withTransaction = nodePostgresTransaction(db);
  const result = await withTransaction((queryable) => purgeAccountRows(queryable, ownerId));

  let mediaDirectoriesRemoved = 0;
  for (const stageId of result.stagesRemoved) {
    try {
      if (await removeClassroomMedia(stageId)) mediaDirectoriesRemoved += 1;
    } catch (error) {
      log.warn(`Could not remove media of ${stageId} for ${ownerId}: ${String(error)}`);
    }
  }
  let materialFilesRemoved = 0;
  const bytes = getMaterialByteStore();
  for (const key of result.materialKeys) {
    try {
      await bytes.delete(key);
      materialFilesRemoved += 1;
    } catch (error) {
      log.warn(`Could not remove material ${key} for ${ownerId}: ${String(error)}`);
    }
  }
  const { materialKeys: _keys, ...counts } = result;
  return { ...counts, mediaDirectoriesRemoved, materialFilesRemoved };
}

function describe(summary: PurgeSummary): string {
  return (
    `stages removed=${summary.stagesRemoved.length} kept=${summary.stagesKept.length}, ` +
    `sessions=${summary.agentSessions}, session events=${summary.ownerSessionEvents}, ` +
    `skills=${summary.skills}, folders=${summary.folders}, materials=${summary.materials}, ` +
    `assets=${summary.assets}, kv=${summary.accountKv}, credentials=${summary.credentials}, ` +
    `shared writes re-attributed=${summary.sharedWrites}, ` +
    `media dirs=${summary.mediaDirectoriesRemoved}, material files=${summary.materialFilesRemoved}`
  );
}

function parseTarget(segments: string[]): { ownerId: string; footprint: boolean } | Response {
  const [ownerId, tail, ...rest] = segments;
  if (!ownerId || rest.length > 0 || (tail !== undefined && tail !== 'footprint')) {
    return jsonError(404, 'ROUTE_NOT_FOUND', 'expected /{ownerId} or /{ownerId}/footprint');
  }
  const decoded = decodeURIComponent(ownerId);
  if (!isPurgeableOwnerId(decoded)) {
    return jsonError(400, 'INVALID_REQUEST', 'ownerId must be user:<uid>');
  }
  return { ownerId: decoded, footprint: tail === 'footprint' };
}

export async function handleAccounts(request: Request, segments: string[]): Promise<Response> {
  const actor = ownerOf(request);
  if (actor instanceof Response) return actor;
  if (!readStudioPrimary(request.headers)) {
    log.warn(
      `Refused ${request.method} accounts${segments.length ? '/' + segments.join('/') : ''}: ${actor} is not the primary administrator`,
    );
    return jsonError(403, 'FORBIDDEN', 'only the primary administrator can purge accounts');
  }
  const db = await pool();
  if (!db) return jsonError(503, 'PERSISTENCE_NOT_CONFIGURED', 'server persistence not configured');

  if (segments.length === 0) {
    if (request.method !== 'GET') return jsonError(405, 'INVALID_REQUEST', 'GET');
    return json(200, { owners: await listOwnerIds(db) });
  }

  const target = parseTarget(segments);
  if (target instanceof Response) return target;

  if (target.footprint) {
    if (request.method !== 'GET') return jsonError(405, 'INVALID_REQUEST', 'GET');
    return json(200, { footprint: await accountFootprint(db, target.ownerId) });
  }
  if (request.method !== 'DELETE') return jsonError(405, 'INVALID_REQUEST', 'DELETE');
  if (target.ownerId === actor) {
    return jsonError(400, 'INVALID_REQUEST', 'an account cannot purge itself');
  }
  const summary = await purgeAccount(db, target.ownerId);
  log.warn(`Purged ${target.ownerId} by ${actor}: ${describe(summary)}`);
  return json(200, { purged: summary });
}
