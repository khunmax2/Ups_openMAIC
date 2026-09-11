import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { maskApiKey } from '@/components/settings/api-key-field';

describe('maskApiKey', () => {
  it('shows a stored key the way DeepWitya does: head, dots, tail', () => {
    expect(maskApiKey('sk-proj-abcdefghijklmnop-wxyz')).toBe('sk-pr••••wxyz');
  });

  it('shows less of a short key', () => {
    expect(maskApiKey('abc123')).toBe('ab••••');
  });

  it('is empty for an empty or blank value', () => {
    expect(maskApiKey('')).toBe('');
    expect(maskApiKey('   ')).toBe('');
  });
});

describe('no settings page reveals a stored key', () => {
  // Every settings page used to carry its own <Input type={show ? 'text' :
  // 'password'}> with an eye button beside it, and the eye revealed whatever
  // the browser had stored. The shared field reveals only what was typed in
  // this session. A page that grows its own toggle again would bring the old
  // behaviour back without anyone noticing, so the shape itself is forbidden
  // outside the component that implements it.
  const dir = join('components', 'settings');
  const REVEAL = /type=\{\s*show\w*\s*\?\s*'text'\s*:\s*'password'\s*\}/u;

  it('has no password/text toggle outside api-key-field.tsx', () => {
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.tsx') && f !== 'api-key-field.tsx')
      .filter((f) => REVEAL.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('would notice one that came back', () => {
    expect(REVEAL.test("<Input type={showApiKey ? 'text' : 'password'} />")).toBe(true);
    expect(REVEAL.test("<Input type={show ? 'text' : 'password'} />")).toBe(true);
    expect(REVEAL.test('<Input type="password" />')).toBe(false);
  });
});
