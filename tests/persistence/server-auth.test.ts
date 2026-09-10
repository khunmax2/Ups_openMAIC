import type { IncomingMessage } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authenticatePersistenceHeaders,
  authenticatePersistenceRequest,
} from '@/lib/persistence/server-auth';

function request(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

function gatewaySays(owner: string): Headers {
  return new Headers({ 'x-deeptutor-owner': owner });
}

describe('persistence authentication from the gateway identity', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('derives both partitions from the one verified owner', () => {
    expect(authenticatePersistenceHeaders(gatewaySays('user:alice'))).toEqual({
      key: 'user:alice',
      learnerKey: 'user:alice',
    });
  });

  it('gives two accounts different asset partitions', () => {
    // The property the whole change exists for, asserted on `key` rather than
    // `learnerKey`: upstream partitioned runtime sessions but filed every asset
    // under one 'shared' principal, so an isolation test that only looked at
    // learner keys would have passed against the old code too.
    const alice = authenticatePersistenceHeaders(gatewaySays('user:alice'));
    const bob = authenticatePersistenceHeaders(gatewaySays('user:bob'));
    expect(alice?.key).not.toBe(bob?.key);
    expect(alice?.key).toBe('user:alice');
    expect(bob?.key).toBe('user:bob');
  });

  it('refuses a request the gateway said nothing about', () => {
    expect(authenticatePersistenceHeaders(new Headers())).toBeUndefined();
  });

  it('ignores the credentials upstream used to accept', () => {
    // A client that still speaks the old scheme gets nothing: the bearer token
    // and x-learner-key are client-supplied, which is the entire reason they
    // were replaced.
    const headers = new Headers({
      authorization: 'Bearer shared-secret',
      'x-learner-key': 'anon:someone-else',
    });
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'shared-secret');
    vi.stubEnv('PERSISTENCE_ALLOW_INSECURE_DEV_AUTH', 'true');
    expect(authenticatePersistenceHeaders(headers)).toBeUndefined();
  });

  it('refuses an identity that is not a verified user', () => {
    // `anon:` is upstream's own prefix for a cookie-minted visitor. Accepting
    // it here would let anything that can set the header claim a partition
    // without ever having been verified.
    expect(authenticatePersistenceHeaders(gatewaySays('anon:11111111'))).toBeUndefined();
    expect(authenticatePersistenceHeaders(gatewaySays('alice'))).toBeUndefined();
    expect(authenticatePersistenceHeaders(gatewaySays('user:'))).toBeUndefined();
  });

  it('refuses a uid longer than the one DeepWitya can issue', () => {
    // AuthStatusResponse.user_id is max_length=64, so a longer value did not
    // come from the place this header is supposed to come from.
    expect(authenticatePersistenceHeaders(gatewaySays(`user:${'a'.repeat(64)}`))?.key).toBe(
      `user:${'a'.repeat(64)}`,
    );
    expect(authenticatePersistenceHeaders(gatewaySays(`user:${'a'.repeat(65)}`))).toBeUndefined();
  });

  it('reads the same identity from a node request', async () => {
    await expect(
      authenticatePersistenceRequest(request({ 'x-deeptutor-owner': 'user:alice' })),
    ).resolves.toEqual({ key: 'user:alice', learnerKey: 'user:alice' });
  });

  it('takes the first value when the header arrives twice', async () => {
    // A duplicated identity header is a request something tampered with.
    // Joining them would invent an owner id belonging to nobody, and taking the
    // last would let an appended value win.
    await expect(
      authenticatePersistenceRequest(request({ 'x-deeptutor-owner': ['user:alice', 'user:bob'] })),
    ).resolves.toEqual({ key: 'user:alice', learnerKey: 'user:alice' });
  });

  it('follows a renamed header on both sides', () => {
    vi.stubEnv('STUDIO_IDENTITY_HEADER', 'x-owner');
    expect(authenticatePersistenceHeaders(new Headers({ 'x-owner': 'user:alice' }))?.key).toBe(
      'user:alice',
    );
    expect(authenticatePersistenceHeaders(gatewaySays('user:alice'))).toBeUndefined();
  });
});
