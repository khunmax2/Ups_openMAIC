import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Fork. POST /api/stages/[id]/media -- the browser's way into upstream's
 * classroom-media byte path. Owner-only: a course's media is written by the
 * account that owns the course and nobody else; the route only checks and
 * delegates to `persistClassroomMediaBytes`.
 */

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  accessRow: null as Record<string, unknown> | null,
  persist: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: {
      query: vi.fn(async (text: string) => {
        if (text.includes('LEFT JOIN stage_meta')) {
          return { rows: mocks.accessRow ? [mocks.accessRow] : [] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({ query: vi.fn(), release: vi.fn() })),
    },
  }),
}));
vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: (...args: unknown[]) => mocks.persist(...args),
}));

import { POST } from '@/app/api/stages/[id]/media/route';

const STAGE_ID = 'stage-1';
const params = { params: Promise.resolve({ id: STAGE_ID }) };
const REF = '/api/classroom-media/stage-1/media/generated-abc.png';

function upload(headers: Record<string, string>, body: BodyInit = new Uint8Array([1, 2, 3])) {
  return POST(
    new NextRequest(`http://localhost/api/stages/${STAGE_ID}/media`, {
      method: 'POST',
      body,
      headers,
    }),
    params,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.accessRow = {
    meta_owner_id: 'owner-1',
    meta_is_public: false,
    meta_published_at: null,
    meta_generation_complete: false,
    meta_deleted_at: null,
    document_name: 'Course',
  };
  mocks.persist.mockResolvedValue(REF);
});

describe('POST /api/stages/[id]/media', () => {
  it("stores the owner's bytes through the classroom-media path and returns its reference", async () => {
    const response = await upload({ 'content-type': 'image/png', 'x-media-prefix': 'generated' });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ url: REF });
    expect(mocks.persist).toHaveBeenCalledOnce();
    const input = mocks.persist.mock.calls[0]?.[0] as {
      stageId: string;
      bytes: Uint8Array;
      mime: string;
      prefix: string;
    };
    expect(input).toMatchObject({ stageId: STAGE_ID, mime: 'image/png', prefix: 'generated' });
    expect(input.bytes.byteLength).toBe(3);
  });

  it('refuses anyone who does not own the course, and writes nothing', async () => {
    mocks.resolveRequestOwnerId.mockReturnValue('someone-else');
    const response = await upload({ 'content-type': 'image/png' });
    expect(response.status).toBe(403);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('answers 404 for a course that does not exist', async () => {
    mocks.accessRow = null;
    const response = await upload({ 'content-type': 'image/png' });
    expect(response.status).toBe(404);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('refuses a type the classroom-media route does not serve', async () => {
    const response = await upload({ 'content-type': 'text/html' });
    expect(response.status).toBe(415);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('refuses a body over the size limit before reading it', async () => {
    const response = await upload({
      'content-type': 'image/png',
      'content-length': String(64 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('keeps a filename prefix inside its directory', async () => {
    await upload({ 'content-type': 'audio/mpeg', 'x-media-prefix': '../../evil' });
    expect(mocks.persist.mock.calls[0]?.[0]).toMatchObject({ prefix: 'generated' });
    await upload({ 'content-type': 'audio/mpeg', 'x-media-prefix': 'tts-a1b2' });
    expect(mocks.persist.mock.calls[1]?.[0]).toMatchObject({ prefix: 'tts-a1b2' });
  });
});
