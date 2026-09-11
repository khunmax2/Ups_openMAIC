/**
 * OpenAI Image Generation Adapter
 *
 * Uses the OpenAI Images API.
 * Endpoint: https://api.openai.com/v1/images/generations
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import { requireModel } from '../require-model';

const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function resolveSize(options: ImageGenerationOptions): string {
  return `${options.width || 1024}x${options.height || 1024}`;
}

export async function testOpenAIImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  try {
    const response = await fetch(
      `${baseUrl}/models/${encodeURIComponent(config.model || DEFAULT_MODEL)}`,
      {
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      },
    );

    if (response.ok) {
      return { success: true, message: 'Connected to OpenAI Image' };
    }

    const text = await response.text().catch(() => response.statusText);
    if (response.status === 401 || response.status === 403) {
      return { success: false, message: `OpenAI Image auth failed (${response.status}): ${text}` };
    }
    if (response.status === 404) {
      return probeModelList(baseUrl, config.apiKey, config.model || DEFAULT_MODEL);
    }
    return { success: false, message: `OpenAI Image API error (${response.status}): ${text}` };
  } catch (err) {
    return { success: false, message: `OpenAI Image connectivity error: ${err}` };
  }
}

/**
 * `GET /models/{id}` answered 404. On api.openai.com that means the model does
 * not exist; on an OpenAI-compatible server it more often means the server
 * never implemented the per-model route at all (vLLM, LiteLLM and most
 * self-hosted image endpoints serve `/models` and `/images/generations` and
 * nothing else). Ask the list route before deciding: a 200 that names the
 * model is a working provider, a 200 that does not is a genuinely unknown
 * model, and anything else keeps the original verdict.
 */
async function probeModelList(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
): Promise<{ success: boolean; message: string }> {
  const notFound = { success: false, message: `OpenAI Image model not found: ${model}` };
  try {
    const response = await fetch(`${baseUrl}/models`, {
      redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response?.ok) return notFound;
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? [])
      .map((entry) => entry?.id)
      .filter((id): id is string => typeof id === 'string');
    if (ids.includes(model)) {
      return { success: true, message: 'Connected to OpenAI Image' };
    }
    return {
      success: false,
      message: ids.length
        ? `OpenAI Image model not found: ${model} (server lists: ${ids.join(', ')})`
        : notFound.message,
    };
  } catch {
    return notFound;
  }
}

export async function generateWithOpenAIImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = requireModel(config.model, 'OpenAI Image');
  const width = options.width || 1024;
  const height = options.height || 1024;

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt: options.prompt,
      n: 1,
      size: resolveSize(options),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`OpenAI image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const imageData = data.data?.[0];
  if (!imageData?.url && !imageData?.b64_json) {
    throw new Error('OpenAI Image returned empty image response');
  }

  return {
    url: imageData.url,
    base64: imageData.b64_json,
    width,
    height,
  };
}
