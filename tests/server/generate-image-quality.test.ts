import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Fork (2026-09-17). The image route carries the quality level the provider's
 * settings name (`x-image-quality`) to the adapter, ignores anything else,
 * and logs how long each image took -- the number the user asked for when
 * images kept trailing the text.
 */

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  lines: [] as string[],
}));

vi.mock('@/lib/media/image-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/image-providers')>();
  return { ...actual, generateImage: mocks.generateImage };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: (line: string) => mocks.lines.push(`info ${line}`),
    warn: (line: string) => mocks.lines.push(`warn ${line}`),
    error: (line: string) => mocks.lines.push(`error ${line}`),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: vi.fn() }));

function request(headers: Record<string, string>) {
  return new NextRequest('http://localhost/api/generate/image', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ prompt: 'a diagram', aspectRatio: '16:9' }),
  });
}

// No base URL: the route would resolve it for the SSRF check, and the
// adapter behind it is mocked anyway.
const base = {
  'x-image-provider': 'custom-image',
  'x-image-model': 'qwen-image-2512',
};

describe('image route: quality level and timing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.generateImage.mockReset();
    mocks.lines.length = 0;
  });

  it('passes a named level to the adapter, and none when unset or unknown', async () => {
    mocks.generateImage.mockResolvedValue({ base64: 'AAAA', width: 1024, height: 576 });
    const { POST } = await import('@/app/api/generate/image/route');

    expect((await POST(request({ ...base, 'x-image-quality': 'low' }))).status).toBe(200);
    expect(mocks.generateImage.mock.calls[0]![0]).toMatchObject({ quality: 'low' });

    await POST(request(base));
    expect(mocks.generateImage.mock.calls[1]![0]).not.toHaveProperty('quality');

    await POST(request({ ...base, 'x-image-quality': 'ultra' }));
    expect(mocks.generateImage.mock.calls[2]![0]).not.toHaveProperty('quality');
  });

  it('logs how long each image took, on success and on failure', async () => {
    mocks.generateImage
      .mockResolvedValueOnce({ base64: 'AAAA', width: 1024, height: 576 })
      .mockRejectedValueOnce(new Error('server busy'));
    const { POST } = await import('@/app/api/generate/image/route');

    await POST(request({ ...base, 'x-image-quality': 'low' }));
    await POST(request(base));

    const took = mocks.lines.filter((l) => /^info Image took \d+ ms: /.test(l));
    const failed = mocks.lines.filter((l) => /^warn Image failed after \d+ ms: /.test(l));
    expect(took).toHaveLength(1);
    expect(took[0]).toContain(
      'provider=custom-image model=qwen-image-2512 size=1024x576 quality=low',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('provider=custom-image model=qwen-image-2512 size=1024x576');
    expect(failed[0]).not.toContain('quality=');
  });
});
