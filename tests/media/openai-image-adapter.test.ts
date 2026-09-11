import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  generateWithOpenAIImage,
  testOpenAIImageConnectivity,
} from '@/lib/media/adapters/openai-image-adapter';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

describe('openai-image-adapter', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts image generation requests to the configured OpenAI Images endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ url: 'https://cdn.example.com/image.png' }] }),
    });

    const result = await generateWithOpenAIImage(
      {
        providerId: 'openai-image',
        apiKey: 'sk-test',
        baseUrl: 'https://proxy.example.com/v1/',
        model: 'gpt-image-2',
      },
      { prompt: 'a classroom diagram', width: 1536, height: 1024 },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://proxy.example.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-test',
        },
      }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      model: 'gpt-image-2',
      prompt: 'a classroom diagram',
      n: 1,
      size: '1536x1024',
    });
    expect(result).toEqual({
      url: 'https://cdn.example.com/image.png',
      base64: undefined,
      width: 1536,
      height: 1024,
    });
  });

  it('returns base64 image data when OpenAI responds inline', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: 'aW1hZ2U=' }] }),
    });

    const result = await generateWithOpenAIImage(
      { providerId: 'openai-image', apiKey: 'sk-test', model: 'gpt-image-2' },
      { prompt: 'inline result' },
    );

    expect(result.base64).toBe('aW1hZ2U=');
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
  });

  it('throws a useful error on failed generation responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'bad request',
      statusText: 'Bad Request',
    });

    await expect(
      generateWithOpenAIImage(
        { providerId: 'openai-image', apiKey: 'sk-test', model: 'gpt-image-2' },
        { prompt: 'bad request' },
      ),
    ).rejects.toThrow('OpenAI image generation failed (400): bad request');
  });

  it('reports connectivity failures for missing models', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'not found',
      statusText: 'Not Found',
    });

    const result = await testOpenAIImageConnectivity({
      providerId: 'openai-image',
      apiKey: 'sk-test',
      model: 'gpt-image-unknown',
    });

    expect(mockFetch).toHaveBeenCalledWith('https://api.openai.com/v1/models/gpt-image-unknown', {
      redirect: 'manual',
      headers: { Authorization: 'Bearer sk-test' },
    });
    expect(result.success).toBe(false);
    expect(result.message).toBe('OpenAI Image model not found: gpt-image-unknown');
  });

  // An OpenAI-compatible server (vLLM, LiteLLM, a self-hosted image endpoint)
  // commonly serves `/models` and `/images/generations` and no per-model route,
  // so `/models/{id}` is 404 for every model including the ones it serves.
  describe('when the per-model route is missing', () => {
    const notFound = () => ({ ok: false, status: 404, text: async () => 'Not Found' });
    const list = (ids: string[]) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    });
    const probe = () =>
      testOpenAIImageConnectivity({
        providerId: 'openai-image',
        apiKey: 'sk-test',
        baseUrl: 'https://gpu.example.net/qwen-image/v1',
        model: 'qwen-image-2512',
      });

    it('accepts a model the list route names', async () => {
      mockFetch.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(list(['qwen-image-2512']));
      const result = await probe();
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://gpu.example.net/qwen-image/v1/models', {
        redirect: 'manual',
        headers: { Authorization: 'Bearer sk-test' },
      });
      expect(result).toEqual({ success: true, message: 'Connected to OpenAI Image' });
    });

    it('names what the server does serve when the model is not among them', async () => {
      mockFetch.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(list(['flux-1', 'sdxl']));
      const result = await probe();
      expect(result.success).toBe(false);
      expect(result.message).toBe(
        'OpenAI Image model not found: qwen-image-2512 (server lists: flux-1, sdxl)',
      );
    });

    it('keeps the original verdict when the list route is unusable too', async () => {
      mockFetch
        .mockResolvedValueOnce(notFound())
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
      const result = await probe();
      expect(result).toEqual({
        success: false,
        message: 'OpenAI Image model not found: qwen-image-2512',
      });
    });
  });
});
