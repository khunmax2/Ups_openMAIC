import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Fork. How many generated images/videos a course requests at once, set by the
 * operator (`MEDIA_GENERATION_CONCURRENCY`) and handed to the browser with the
 * other server-side generation settings. Two by default: enough that a course's
 * pictures no longer queue strictly behind one another, few enough that a
 * single self-hosted GPU or a low per-key quota is not flooded.
 */

import { getMediaGenerationConcurrency } from '@/lib/server/provider-config';

describe('getMediaGenerationConcurrency', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is two when the operator set nothing usable', () => {
    vi.stubEnv('MEDIA_GENERATION_CONCURRENCY', '');
    expect(getMediaGenerationConcurrency()).toBe(2);
    vi.stubEnv('MEDIA_GENERATION_CONCURRENCY', 'lots');
    expect(getMediaGenerationConcurrency()).toBe(2);
  });

  it("takes the operator's number, between one and six", () => {
    vi.stubEnv('MEDIA_GENERATION_CONCURRENCY', '1');
    expect(getMediaGenerationConcurrency()).toBe(1);
    vi.stubEnv('MEDIA_GENERATION_CONCURRENCY', '4');
    expect(getMediaGenerationConcurrency()).toBe(4);
    vi.stubEnv('MEDIA_GENERATION_CONCURRENCY', '0');
    expect(getMediaGenerationConcurrency()).toBe(1);
    vi.stubEnv('MEDIA_GENERATION_CONCURRENCY', '40');
    expect(getMediaGenerationConcurrency()).toBe(6);
  });
});
