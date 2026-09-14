import { describe, expect, it, vi } from 'vitest';

/**
 * Fork. The server keeps its own generation-complete flag (`stage_meta`), and
 * the route that sets it had no caller: every course on the server read as
 * unfinished. The browser now tells it, once, when the owner's deck finishes.
 */

import { notifyServerGenerationComplete } from '@/lib/classroom/generation-complete-mirror';

describe('notifyServerGenerationComplete', () => {
  it('posts to the owner-only completion route', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const ok = await notifyServerGenerationComplete(
      'stage-9',
      fetchImpl as unknown as typeof globalThis.fetch,
      true,
    );
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/stages/stage-9/generation-complete');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
  });

  it('never throws when the server refuses or cannot be reached', async () => {
    const refused = vi.fn(async () => new Response('', { status: 403 }));
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      notifyServerGenerationComplete('s', refused as unknown as typeof globalThis.fetch, true),
    ).resolves.toBe(false);
    await expect(
      notifyServerGenerationComplete('s', offline as unknown as typeof globalThis.fetch, true),
    ).resolves.toBe(false);
  });

  it('sends nothing when the studio has no server persistence', async () => {
    const fetchImpl = vi.fn();
    await expect(
      notifyServerGenerationComplete('s', fetchImpl as unknown as typeof globalThis.fetch, false),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
