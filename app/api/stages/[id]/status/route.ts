/**
 * GET /api/stages/[id]/status
 *
 * Returns the public-state metadata for a stage. Used by the Share menu CTA
 * to know whether to show "Publish" or "Already published · Unpublish".
 *
 * Fork. Upstream answers any caller who has the stage id. This deployment
 * keeps a course private unless its owner published it, so the answer is for
 * the owner, and for anyone once the course is public; to everyone else an
 * unpublished course is the same 404 as a missing one (2026-09-11 audit, F1
 * — this route told any holder of an id that the course existed and whether
 * it was public).
 *
 * Convention: snake_case error codes (e.g. `not_found`, `internal_error`).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { resolveStageAccess } from '@/lib/server/stage-access';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const { id } = await params;
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      const access = await resolveStageAccess(id);

      // Tombstoned, never-existed and someone else's unpublished course must
      // be indistinguishable: an answer other than plain 404 would let a
      // holder of an id confirm that it names a real course.
      if (!access || (access.ownerId !== ownerId && !access.isPublic)) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }

      // Field names are the wire contract; they stay `isPublic` / `publishedAt`
      // regardless of which layer answered.
      return NextResponse.json(
        { isPublic: access.isPublic, publishedAt: access.publishedAt },
        { headers: responseHeaders },
      );
    } catch (error) {
      console.error('Failed to fetch stage status', {
        stageId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'internal_error' },
        { status: 500, headers: responseHeaders },
      );
    }
  });
}
