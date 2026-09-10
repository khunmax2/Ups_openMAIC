/**
 * Prefix a same-origin path with the base path this deployment is served under.
 *
 * Next's `basePath` rewrites the URLs **it** generates — links, assets, the
 * routes it serves. It does not touch a URL the application writes itself, so
 * every `fetch('/api/...')` and `new EventSource('/api/...')` in this codebase
 * would keep pointing at the origin root. On a host that serves this app under
 * a path beside other applications, that is not a 404: it is a request sent to
 * somebody else's `/api`.
 *
 * Empty by default, so a deployment served at the root — which is every
 * deployment upstream ships — behaves exactly as before and pays nothing.
 */
function configured(): string {
  return (process.env.NEXT_PUBLIC_STUDIO_BASE_PATH || '').replace(/\/+$/u, '');
}

/**
 * **Idempotent on purpose.** Two layers apply this: a call site prefixes a path,
 * and a helper it passes through prefixes it again. Applying it twice must be
 * the same as applying it once, or the second application produces
 * `/course-studio/course-studio/api/...` — a 404 that reads like a routing bug
 * and is in fact a double prefix.
 *
 * A path that is not absolute is returned untouched: it is either already
 * relative to the document, or an absolute URL to somewhere else entirely.
 */
export function apiPath(path: string): string {
  const base = configured();
  if (!base || !path.startsWith('/')) return path;
  if (path === base || path.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}

/**
 * The same prefixing, for a static file under `public/`.
 *
 * Next serves `public/` under the base path — `public/logos/openai.svg` really
 * is at `/deepwitya/studio/logos/openai.svg` — but a `src` the application
 * writes itself is not rewritten, so a bare `/logos/openai.svg` asks the origin
 * root and gets whatever lives there. On a shared host that is somebody else,
 * and in a browser it is a broken image with no error anyone reads.
 *
 * Applied where the value becomes a `src`, not where it is declared. These paths
 * sit in constant tables — provider logos, default avatars — that are compared,
 * stored and passed around; there are 154 such declarations and 18 places they
 * are rendered, and only the rendered form is a URL.
 *
 * Accepts `undefined` and absolute URLs untouched, because a `src` is often one
 * of those: a provider-hosted avatar, a `data:` URI, or nothing yet.
 */
export function assetPath<T extends string | undefined | null>(path: T): T {
  return (typeof path === 'string' ? apiPath(path) : path) as T;
}

/** The configured base path, without a trailing slash. Empty when served at the root. */
export function basePath(): string {
  return configured();
}
