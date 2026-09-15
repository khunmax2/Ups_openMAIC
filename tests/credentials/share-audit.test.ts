import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { describeSharer, shareEffect } from '@/lib/credentials/share-audit';

/**
 * Fork. Any admin may share, replace or stop a provider's shared key; the key
 * row asks before the two that change what every account uses, and says whose
 * key it is (FORK.md, "Who shared a key is recorded").
 */
describe('shareEffect', () => {
  const mine = { masked: 'AIza-••••abcd', baseUrl: '' };

  it('is new when nothing is shared yet', () => {
    expect(shareEffect(mine, undefined)).toBe('new');
  });

  it('is the same when my key already is the shared one', () => {
    expect(shareEffect(mine, { ...mine, sharedByYou: true })).toBe('same');
  });

  it("replaces another admin's key", () => {
    expect(shareEffect(mine, { masked: 'AIza-••••wxyz', baseUrl: '', sharedBy: 'boss' })).toBe(
      'replace',
    );
  });

  it('replaces an older key of my own, and my key shared for another endpoint', () => {
    expect(shareEffect(mine, { masked: 'AIza-••••0000', baseUrl: '', sharedByYou: true })).toBe(
      'replace',
    );
    expect(shareEffect(mine, { masked: mine.masked, baseUrl: 'https://proxy.example/v1' })).toBe(
      'replace',
    );
  });
});

describe('describeSharer', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    `${key} ${JSON.stringify(options ?? {})}`;
  const at = () => '15 Sep 05:50';

  it('names who shared and when', () => {
    expect(
      describeSharer({ masked: 'x', baseUrl: '', sharedByYou: true, sharedAt: 1 }, t, at),
    ).toBe('settings.apiKeySharedByYou {"time":"15 Sep 05:50"}');
    expect(
      describeSharer(
        { masked: 'x', baseUrl: '', sharedByYou: false, sharedBy: 'u_909cf3245b', sharedAt: 1 },
        t,
        at,
      ),
    ).toBe('settings.apiKeySharedByOther {"who":"u_909cf3245b","time":"15 Sep 05:50"}');
  });

  it('says so when the share predates the record', () => {
    expect(
      describeSharer({ masked: 'x', baseUrl: '', sharedByYou: false, sharedAt: 1 }, t, at),
    ).toBe('settings.apiKeySharedByUnknown {"time":"15 Sep 05:50"}');
  });

  it('uses keys the locale files carry', () => {
    const keys = [
      'apiKeySharedByYou',
      'apiKeySharedByOther',
      'apiKeySharedByUnknown',
      'apiKeyShareReplace',
      'apiKeyShareReplaceHint',
      'apiKeyReplaceTitle',
      'apiKeyReplaceBody',
      'apiKeyReplaceConfirm',
      'apiKeyStopTitle',
      'apiKeyStopBody',
      'apiKeyStopConfirm',
    ];
    for (const locale of ['en-US', 'th-TH']) {
      const settings = JSON.parse(readFileSync(`lib/i18n/locales/${locale}.json`, 'utf8')).settings;
      for (const key of keys) expect(settings[key], `${locale} settings.${key}`).toBeTruthy();
    }
  });
});
