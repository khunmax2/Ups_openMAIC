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

/** The configured base path, without a trailing slash. Empty when served at the root. */
export function basePath(): string {
  return configured();
}
