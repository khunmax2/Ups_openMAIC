import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  generateWithOpenAICompatibleImage,
  testOpenAICompatibleImageConnectivity,
} from '@/lib/media/adapters/openai-compatible-image-adapter';
import { IMAGE_PROVIDERS, generateImage, testImageConnectivity } from '@/lib/media/image-providers';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const BASE = 'https://gpu.example.net/qwen-image/v1';
const list = (ids: string[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: ids.map((id) => ({ id })) }),
  text: async () => '',
});
const status = (code: number, text = '') => ({
  ok: code >= 200 && code < 300,
  status: code,
  statusText: text,
  json: async () => ({}),
  text: async () => text,
});

describe('openai-compatible-image adapter', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('is registered with no catalogue, no default endpoint and no key requirement', () => {
    const provider = IMAGE_PROVIDERS['custom-image'];
    expect(provider.models).toEqual([]);
    expect(provider.defaultBaseUrl).toBe('');
    expect(provider.requiresApiKey).toBe(false);
  });

  it('refuses an empty base URL instead of defaulting to OpenAI', async () => {
    const result = await testOpenAICompatibleImageConnectivity({
      providerId: 'custom-image',
      apiKey: '',
      model: 'x',
    });
    expect(result.success).toBe(false);
    expect(result.message).toBe('OpenAI Compatible: base URL is required');
    expect(mockFetch).not.toHaveBeenCalled();

    await expect(
      generateWithOpenAICompatibleImage(
        { providerId: 'custom-image', apiKey: '', model: 'x' },
        { prompt: 'p' },
      ),
    ).rejects.toThrow('base URL is required');
  });

  it('asks /models first and accepts a listed model', async () => {
    mockFetch.mockResolvedValueOnce(list(['qwen-image-2512', 'flux-1']));
    const result = await testOpenAICompatibleImageConnectivity({
      providerId: 'custom-image',
      apiKey: 'k',
      baseUrl: `${BASE}/`,
      model: 'qwen-image-2512',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(`${BASE}/models`, {
      redirect: 'manual',
      headers: { Authorization: 'Bearer k' },
    });
    expect(result).toEqual({ success: true, message: 'Connected to OpenAI Compatible' });
  });

  it('names what the server serves when the model is not listed', async () => {
    mockFetch.mockResolvedValueOnce(list(['flux-1', 'sdxl']));
    const result = await testOpenAICompatibleImageConnectivity({
      providerId: 'custom-image',
      apiKey: 'k',
      baseUrl: BASE,
      model: 'qwen-image-2512',
    });
    expect(result.success).toBe(false);
    expect(result.message).toBe(
      'OpenAI Compatible model not found: qwen-image-2512 (server lists: flux-1, sdxl)',
    );
  });

  it('sends no Authorization header when there is no key', async () => {
    mockFetch.mockResolvedValueOnce(list(['m']));
    await testOpenAICompatibleImageConnectivity({
      providerId: 'custom-image',
      apiKey: '',
      baseUrl: BASE,
      model: 'm',
    });
    expect(mockFetch.mock.calls[0][1].headers).toEqual({});
  });

  it('reports auth failure from the list route', async () => {
    mockFetch.mockResolvedValueOnce(status(401, 'Unauthorized'));
    const result = await testOpenAICompatibleImageConnectivity({
      providerId: 'custom-image',
      apiKey: 'wrong',
      baseUrl: BASE,
      model: 'm',
    });
    expect(result).toEqual({
      success: false,
      message: 'OpenAI Compatible auth failed (401): Unauthorized',
    });
  });

  it('treats a server with neither /models route as reachable, and says the model was not checked', async () => {
    mockFetch.mockResolvedValueOnce(status(404, 'Not Found')).mockResolvedValueOnce(status(404));
    const result = await testOpenAICompatibleImageConnectivity({
      providerId: 'custom-image',
      apiKey: 'k',
      baseUrl: BASE,
      model: 'm',
    });
    expect(mockFetch).toHaveBeenNthCalledWith(2, `${BASE}/models/m`, expect.anything());
    expect(result.success).toBe(true);
    expect(result.message).toContain('no /models route');
  });

  it('still catches a wrong key on the per-model route when the list route is missing', async () => {
    mockFetch.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(status(403, 'Forbidden'));
    const result = await testOpenAICompatibleImageConnectivity({
      providerId: 'custom-image',
      apiKey: 'wrong',
      baseUrl: BASE,
      model: 'm',
    });
    expect(result).toEqual({
      success: false,
      message: 'OpenAI Compatible auth failed (403): Forbidden',
    });
  });

  it('posts the OpenAI Images request shape to /images/generations', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: 'AAAA' }] }),
    });
    const result = await generateWithOpenAICompatibleImage(
      { providerId: 'custom-image', apiKey: '', baseUrl: BASE, model: 'qwen-image-2512' },
      { prompt: 'a classroom diagram', width: 1536, height: 1024 },
    );
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/images/generations`);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      model: 'qwen-image-2512',
      prompt: 'a classroom diagram',
      n: 1,
      size: '1536x1024',
    });
    expect(result).toEqual({ url: undefined, base64: 'AAAA', width: 1536, height: 1024 });
  });

  it('is reachable through the provider dispatch for both probe and generation', async () => {
    mockFetch.mockResolvedValueOnce(list(['m']));
    await expect(
      testImageConnectivity({
        providerId: 'custom-image',
        apiKey: '',
        baseUrl: BASE,
        model: 'm',
      }),
    ).resolves.toEqual({ success: true, message: 'Connected to OpenAI Compatible' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ url: 'https://cdn.example.net/i.png' }] }),
    });
    await expect(
      generateImage(
        { providerId: 'custom-image', apiKey: '', baseUrl: BASE, model: 'm' },
        { prompt: 'p' },
      ),
    ).resolves.toMatchObject({ url: 'https://cdn.example.net/i.png' });
  });
});
