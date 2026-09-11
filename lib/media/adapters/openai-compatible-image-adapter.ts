/**
 * OpenAI-Compatible Image Generation Adapter (fork addition)
 *
 * The same `/images/generations` protocol as OpenAI Image, aimed at a server
 * the operator runs: vLLM, LiteLLM, a diffusion server behind an
 * OpenAI-shaped API. Three things differ from api.openai.com and each one
 * has broken a real configuration:
 *
 *  - there is no default endpoint; an empty base URL is an error, not OpenAI;
 *  - a key is optional, and is sent only when present;
 *  - `/models/{id}` is usually not implemented, so the probe asks `/models`
 *    first and treats a server with neither route as reachable-but-unlisted
 *    rather than as a missing model.
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import { requireModel } from '../require-model';

const NAME = 'OpenAI Compatible';

type Probe = { success: boolean; message: string };

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function requireBaseUrl(baseUrl?: string): string | null {
  const trimmed = baseUrl?.trim().replace(/\/$/, '');
  return trimmed ? trimmed : null;
}

async function bodyText(response: Response): Promise<string> {
  return response.text().catch(() => response.statusText);
}

export async function testOpenAICompatibleImageConnectivity(
  config: ImageGenerationConfig,
): Promise<Probe> {
  const baseUrl = requireBaseUrl(config.baseUrl);
  if (!baseUrl) {
    return { success: false, message: `${NAME}: base URL is required` };
  }
  const model = config.model?.trim();

  try {
    const list = await fetch(`${baseUrl}/models`, {
      redirect: 'manual',
      headers: authHeaders(config.apiKey),
    });

    if (list.status === 401 || list.status === 403) {
      return {
        success: false,
        message: `${NAME} auth failed (${list.status}): ${await bodyText(list)}`,
      };
    }

    if (list.ok) {
      const body = (await list.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
      const ids = (body.data ?? [])
        .map((entry) => entry?.id)
        .filter((id): id is string => typeof id === 'string');
      if (!model) {
        return {
          success: true,
          message: ids.length
            ? `Connected to ${NAME}; server lists: ${ids.join(', ')}`
            : `Connected to ${NAME}`,
        };
      }
      if (ids.includes(model)) {
        return { success: true, message: `Connected to ${NAME}` };
      }
      return {
        success: false,
        message: ids.length
          ? `${NAME} model not found: ${model} (server lists: ${ids.join(', ')})`
          : `${NAME} model not found: ${model}`,
      };
    }

    if (list.status === 404) {
      // No list route. Some servers still answer the per-model route; if
      // neither exists the server is reachable and the model name cannot be
      // checked without paying for a generation — say so, do not fail.
      if (model) {
        const item = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}`, {
          redirect: 'manual',
          headers: authHeaders(config.apiKey),
        });
        if (item.ok) return { success: true, message: `Connected to ${NAME}` };
        if (item.status === 401 || item.status === 403) {
          return {
            success: false,
            message: `${NAME} auth failed (${item.status}): ${await bodyText(item)}`,
          };
        }
      }
      return {
        success: true,
        message: `${NAME} endpoint reachable; it has no /models route, so the model name was not checked`,
      };
    }

    return {
      success: false,
      message: `${NAME} API error (${list.status}): ${await bodyText(list)}`,
    };
  } catch (err) {
    return { success: false, message: `${NAME} connectivity error: ${err}` };
  }
}

export async function generateWithOpenAICompatibleImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = requireBaseUrl(config.baseUrl);
  if (!baseUrl) {
    throw new Error(`${NAME}: base URL is required`);
  }
  const model = requireModel(config.model, NAME);
  const width = options.width || 1024;
  const height = options.height || 1024;

  // Same request the OpenAI adapter sends, minus the unconditional
  // `Authorization: Bearer undefined` a keyless server would have to ignore.
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(config.apiKey),
    },
    body: JSON.stringify({
      model,
      prompt: options.prompt,
      n: 1,
      size: `${width}x${height}`,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `${NAME} image generation failed (${response.status}): ${await bodyText(response)}`,
    );
  }

  const data = await response.json();
  const imageData = data.data?.[0];
  if (!imageData?.url && !imageData?.b64_json) {
    throw new Error(`${NAME} returned empty image response`);
  }

  return { url: imageData.url, base64: imageData.b64_json, width, height };
}
