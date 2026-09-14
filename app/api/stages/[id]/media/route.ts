/**
 * POST /api/stages/[id]/media (fork)
 *
 * The browser's way into upstream's classroom-media byte path. Media the
 * browser generates (slide images, narration) used to stay in that browser's
 * IndexedDB, so the course had no pictures or sound anywhere else -- including
 * for a published course's learners. Upstream's own server-side generation
 * already writes bytes with `persistClassroomMediaBytes` and stores the
 * returned `/api/classroom-media/...` reference in the document; this route
 * lets the owner's browser do the same.
 *
 * Owner-only. The body is the raw bytes; `content-type` names the media type
 * (only the types the classroom-media route serves) and `x-media-prefix` an
 * optional filename prefix. Answers `201 { url }`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { persistClassroomMediaBytes } from '@/lib/server/classroom-media-bytes';
import { isValidClassroomId } from '@/lib/server/classroom-storage';
import { resolveStageAccess } from '@/lib/server/stage-access';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** The types `/api/classroom-media` serves, by the extension it maps them to. */
const ACCEPTED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'video/mp4',
  'video/webm',
]);

/** A generated clip or picture is well under this; the cap bounds a hostile body. */
const MAX_BYTES = 32 * 1024 * 1024;

const PREFIX = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export async function POST(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const reply = (status: number, body: unknown) =>
      NextResponse.json(body, { status, headers: responseHeaders });
    const { id: stageId } = await params;
    if (!isValidClassroomId(stageId)) return reply(404, { error: 'not_found' });

    const mime = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!ACCEPTED_TYPES.has(mime)) return reply(415, { error: 'unsupported_media_type' });
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      return reply(413, { error: 'payload_too_large' });
    }

    const access = await resolveStageAccess(stageId);
    // Absent and tombstoned are the same 404, as on the sibling stage routes.
    if (!access) return reply(404, { error: 'not_found' });
    if (access.ownerId !== ownerId) return reply(403, { error: 'forbidden' });

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength === 0) return reply(400, { error: 'empty_body' });
    if (bytes.byteLength > MAX_BYTES) return reply(413, { error: 'payload_too_large' });

    const requested = (req.headers.get('x-media-prefix') ?? '').trim();
    const prefix = PREFIX.test(requested) ? requested : 'generated';
    try {
      const url = await persistClassroomMediaBytes({ stageId, bytes, mime, prefix });
      return reply(201, { url });
    } catch (error) {
      console.error('Failed to store classroom media', {
        stageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return reply(500, { error: 'internal_error' });
    }
  });
}
