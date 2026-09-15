import { describe, expect, it } from 'vitest';

import { createOwnerGuard, OWNER_HEADER } from '@/lib/store/account-kv';

/**
 * Fork. The browser half of the audit-F01 guard: the first answer fixes the
 * account a page was loaded for, every write names it, and an answer from any
 * other account asks for one reload. The server half and the two driven
 * together are in tests/persistence/account-kv.test.ts.
 */
function answering(owner: string, status = 200, body: unknown = { value: null }) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', [OWNER_HEADER]: owner },
    });
}

describe('createOwnerGuard', () => {
  it('names no account on any request until an answer has said which one', async () => {
    const guard = createOwnerGuard({ fetch: answering('tag-a'), onOwnerChanged: () => undefined });
    expect(guard.headers({ method: 'PUT' })).toEqual({});
    await guard.fetch('http://s/kv/entries/k');
    expect(guard.owner()).toBe('tag-a');
    expect(guard.headers({ method: 'PUT' })).toEqual({ [OWNER_HEADER]: 'tag-a' });
    expect(guard.headers({ method: 'DELETE' })).toEqual({ [OWNER_HEADER]: 'tag-a' });
    // Reads carry nothing: an answer to them is what reveals a switch.
    expect(guard.headers({ method: 'GET' })).toEqual({});
  });

  it('asks for one reload when an answer comes from another account', async () => {
    let owner = 'tag-a';
    let reloads = 0;
    const guard = createOwnerGuard({
      fetch: async () => answering(owner)(),
      onOwnerChanged: () => {
        reloads += 1;
      },
    });
    await guard.fetch('http://s/kv/entries/k');
    owner = 'tag-b';
    await guard.fetch('http://s/kv/entries/k');
    await guard.fetch('http://s/kv/entries/k');
    expect(reloads).toBe(1);
    // The page stays on the account it was loaded for until it reloads.
    expect(guard.owner()).toBe('tag-a');
  });

  it('asks for a reload when the server refuses a write as another account', async () => {
    let reloads = 0;
    const guard = createOwnerGuard({
      fetch: answering('tag-a', 409, { error: { code: 'OWNER_CHANGED' } }),
      onOwnerChanged: () => {
        reloads += 1;
      },
    });
    const response = await guard.fetch('http://s/kv/entries/k', { method: 'PUT' });
    expect(response.status).toBe(409);
    // The body is still there for the caller to read.
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'OWNER_CHANGED' } });
    expect(reloads).toBe(1);
  });

  it('leaves any other refusal to the caller', async () => {
    let reloads = 0;
    const guard = createOwnerGuard({
      fetch: answering('tag-a', 409, { error: { code: 'SOMETHING_ELSE' } }),
      onOwnerChanged: () => {
        reloads += 1;
      },
    });
    await guard.fetch('http://s/kv/entries/k', { method: 'PUT' });
    expect(reloads).toBe(0);
  });
});
