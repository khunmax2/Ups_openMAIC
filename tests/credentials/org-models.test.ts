import { describe, expect, it } from 'vitest';

import {
  catalogFromList,
  newerCatalog,
  orgDefaultFor,
  personalBuiltIns,
  withOrgModels,
  type OrgCatalogAnswer,
} from '@/lib/credentials/org-models';

/**
 * Fork. The organisation's model catalog as the browser applies it: an admin
 * curates a provider's list for every account (report 2026-09-15: a model the
 * user added kept vanishing, deleted built-ins came back, and every new account
 * started from the built-in defaults).
 */
const builtIns = [
  { id: 'ds/pro', name: 'Pro' },
  { id: 'ds/flash', name: 'Flash' },
];
const gemini = { id: 'google/gemini-3.5-flash-lite', name: 'Gemini Flash Lite' };

describe('withOrgModels', () => {
  it('without a catalog: the built-ins the person kept, then their own', () => {
    const list = withOrgModels(builtIns, [...builtIns, { id: 'mine', name: 'mine' }], undefined, [
      'ds/flash',
    ]);
    expect(list.map((m) => m.id)).toEqual(['ds/pro', 'mine']);
  });

  it("with a catalog: built-ins minus the hidden, the organisation's models, then the person's", () => {
    const list = withOrgModels(
      builtIns,
      [{ id: 'mine', name: 'mine' }],
      { hidden: ['ds/flash'], extra: [gemini] },
      undefined,
    );
    expect(list.map((m) => m.id)).toEqual(['ds/pro', gemini.id, 'mine']);
    expect(list.find((m) => m.id === gemini.id)).toMatchObject({ fromOrg: true });
    expect(list.find((m) => m.id === 'mine')).not.toHaveProperty('fromOrg');
  });

  it('drops organisation entries the catalog no longer has, unless the person had added them too', () => {
    const saved = [
      { id: 'old-org', name: 'gone', fromOrg: true },
      { id: gemini.id, name: 'my copy' },
    ];
    // The organisation lists a model the person added: its entry shows, and
    // remembers that the person had it.
    const withCatalog = withOrgModels(builtIns, saved, { hidden: [], extra: [gemini] }, undefined);
    expect(withCatalog.map((m) => m.id)).toEqual(['ds/pro', 'ds/flash', gemini.id]);
    expect(withCatalog.find((m) => m.id === gemini.id)).toMatchObject({
      fromOrg: true,
      ownCopy: true,
    });
    // The organisation drops it, or its whole list: the model is the person's
    // again, not gone (report 2026-09-15: models the user added kept vanishing).
    for (const org of [{ hidden: [], extra: [] }, undefined]) {
      const after = withOrgModels(builtIns, withCatalog, org, undefined);
      expect(after.map((m) => m.id)).toEqual(['ds/pro', 'ds/flash', gemini.id]);
      expect(after.find((m) => m.id === gemini.id)).toEqual({ ...gemini });
    }
    // An organisation entry the person never added just goes.
    expect(withOrgModels(builtIns, saved, undefined, undefined).map((m) => m.id)).toEqual([
      'ds/pro',
      'ds/flash',
      gemini.id,
    ]);
  });

  it('ignores an addition that is really a built-in', () => {
    const list = withOrgModels(
      builtIns,
      [],
      { hidden: [], extra: [{ id: 'ds/pro', name: 'dup' }] },
      undefined,
    );
    expect(list.map((m) => m.id)).toEqual(['ds/pro', 'ds/flash']);
  });
});

describe('personalBuiltIns', () => {
  it('leaves out what the organisation hides', () => {
    expect(personalBuiltIns(['ds/pro', 'ds/flash'], { hidden: ['ds/flash'], extra: [] })).toEqual([
      'ds/pro',
    ]);
    expect(personalBuiltIns(['ds/pro'], undefined)).toEqual(['ds/pro']);
  });
});

describe('orgDefaultFor', () => {
  const org: OrgCatalogAnswer = {
    models: {},
    defaultModel: { providerId: 'openrouter', modelId: gemini.id },
  };
  const usable = { openrouter: { apiKey: '***', requiresApiKey: true, models: [gemini] } };

  it('applies to an account that has not picked its own model', () => {
    expect(orgDefaultFor({ providersConfig: usable }, org)).toEqual({
      providerId: 'openrouter',
      modelId: gemini.id,
    });
  });

  it('never overrides a model the person picked', () => {
    expect(orgDefaultFor({ llmModelIsUserSet: true, providersConfig: usable }, org)).toBeNull();
  });

  it('waits until the default can be used here', () => {
    const noKey = { openrouter: { apiKey: '', requiresApiKey: true, models: [gemini] } };
    const notListed = { openrouter: { apiKey: '***', requiresApiKey: true, models: [] } };
    expect(orgDefaultFor({ providersConfig: noKey }, org)).toBeNull();
    expect(orgDefaultFor({ providersConfig: notListed }, org)).toBeNull();
    expect(orgDefaultFor({ providersConfig: usable }, { models: {} })).toBeNull();
  });
});

describe('newerCatalog', () => {
  const at = (servedAt?: number): OrgCatalogAnswer => ({
    models: {},
    ...(servedAt ? { servedAt } : {}),
  });

  it('keeps whichever copy the server read later, held or saved', () => {
    expect(newerCatalog(at(2), at(1))?.servedAt).toBe(2);
    expect(newerCatalog(at(1), at(2))?.servedAt).toBe(2);
  });

  it('counts a copy with no stamp as the oldest, and keeps the held copy on a tie', () => {
    const held = at(5);
    expect(newerCatalog(held, at())).toBe(held);
    expect(newerCatalog(at(), held)).toBe(held);
    expect(newerCatalog(held, at(5))).toBe(held);
    expect(newerCatalog(null, held)).toBe(held);
    expect(newerCatalog(held, undefined)).toBe(held);
    expect(newerCatalog(undefined, null)).toBeNull();
  });
});

describe('catalogFromList', () => {
  it('publishes the built-ins left out as hidden and the rest as added, descriptions only', () => {
    const catalog = catalogFromList(builtIns, [
      builtIns[0],
      {
        ...gemini,
        contextWindow: 100,
        capabilities: { tools: true, vision: false },
        fromOrg: true,
      },
    ]);
    expect(catalog).toEqual({
      hidden: ['ds/flash'],
      extra: [
        { id: gemini.id, name: gemini.name, contextWindow: 100, capabilities: { tools: true } },
      ],
    });
  });
});
