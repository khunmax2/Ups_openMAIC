# What this fork changes, and why

This is a fork of [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) (MIT),
maintained at `khunmax2/OpenMAIC`. It exists so the course studio can run as a
sibling application beside **DeepWitya**, a fork of HKUDS/DeepTutor. The design
is recorded there, in `docs/adr/0005-course-studio-sibling-application.md`.

The fork is deliberately small, and stays a readable set of commits on top of
upstream's real history rather than a vendored copy: `git log`, `blame` and
`bisect` all keep working, and anything upstream accepts drops out of the next
rebase by itself.

## The coupling, in full

DeepWitya and the studio are joined by exactly two things:

1. **A URL.** The studio is opened in an iframe with `?lang`, `?theme` and
   `?embed=1`. Nothing is read back.
2. **One request header.** A gatekeeper in front of this app verifies the
   DeepWitya session and states the result as `x-deeptutor-owner: user:<uid>`,
   stripping any copy the client sent.

Providers, API keys, model configuration and storage stay independent on both
sides. There is no shared database, no shared config file, and no callback.

## Changes on top of upstream

### Identity comes from the gateway, not from a client-supplied credential

Upstream resolves ownership from an anonymous cookie it mints itself
(`lib/server/agent-runtime/owner.ts`) and documents `authenticatedOwnerId` as
the seam "a future auth integration must thread". This fork is that
integration.

- **`lib/server/studio-identity.ts`** (new) reads and validates the header.
- Every call site threads it: one wrapper (`with-owner.ts`) covers most routes,
  three routes call the resolver directly, and one Server Action
  (`lib/workbench/workspace-actions.ts`) reads the same header through
  `headers()`.
- **`lib/persistence/server-auth.ts`** is replaced. Upstream ships a
  development authenticator whose bearer token is compiled into the public
  browser bundle and whose learner key is client-supplied; its own docstring
  says "anyone who can load the page can read and write EVERY learner
  partition" and asks production to replace it. Identity now comes from the
  header instead, and **assets are partitioned per owner** — upstream filed
  every asset under one `'shared'` principal, which would have left the
  isolation stopping at the first image.
- **`STUDIO_REQUIRE_GATEWAY=1`** makes a request with no identity a 401 rather
  than a fresh anonymous visitor. Without it, a request that bypassed the
  gateway is answered with an empty workspace and looks like the app working.

Upstream's anonymous path is kept intact and is what runs when the variable is
unset, so this fork still starts the way upstream starts.

### The app can be served under a path

The deployment host serves seven applications under one origin and opens no
port but 443, so the studio lives at `/course-studio`. Next's `basePath`
handles the URLs **Next** generates; it does not touch a URL the application
writes itself, and this codebase writes 71 of them (69 `fetch`, 2
`EventSource`).

On a shared host that is not a 404. `fetch('/api/stages')` resolves against the
origin, so it is a request sent to another team's `/api`.

- **`lib/base-path.ts`** (new) — `apiPath()`, idempotent because two layers can
  apply it, and empty by default so a root deployment pays nothing.
- Every call site goes through it, and
  **`tests/base-path/api-path.test.ts`** fails if one stops: the sites were
  converted in bulk, and without something that fails they come back one at a
  time.

  The guard matches three shapes, because `fetch(` was never the whole surface.
  The first version matched only that one and reported a clean tree while
  `lib/persistence/bootstrap.ts` — the entire persistence layer — was still
  addressing the origin root through a `baseUrl:`. It found that by being run,
  not by being read. The three are a direct `fetch`/`EventSource` call, a URL
  handed to something as configuration (`baseUrl:`, `endpoint:`, `url:`,
  narrowed to `/api/` so a provider's own `/v1/...` path is not rewritten to
  point here), and a URL handed to an injected factory (`createEventSource(`).

  What no static rule can catch is `fetch(someVariable)`. Where a URL travels as
  a variable it is wrapped at the call rather than at the declaration — the
  pbl/v2 endpoint is a union of path literals that wrapping individually would
  retype, so it is wrapped once at its single `fetch`. Those two files are
  exempt from the scan, and the exemption is paired with an assertion that the
  wrap is still there.
- `NEXT_PUBLIC_STUDIO_BASE_PATH` is read by `next.config.ts` and by
  `apiPath()` — the two halves have to agree, and a mismatch is not a build
  error but a working page whose every request goes somewhere else. Being
  `NEXT_PUBLIC_` also makes it a **build argument**: changing it means
  rebuilding the image, not restarting the container.

## Rebasing onto a new upstream

Rebase for a reason — a security fix, a wanted feature — never on a schedule,
because every rebase carries the DDL-drift risk: OpenMAIC ships no versioned
migrations and guards every DDL statement with `IF NOT EXISTS`, so a drifted
column type is accepted silently. `pg_dump` before every rebase.

The files most likely to conflict are the ones this fork edits inside
upstream's own code: `lib/server/agent-runtime/owner.ts`,
`lib/server/agent-runtime/with-owner.ts`, and
`app/api/persistence/[...path]/route.ts`. Everything else is either a new file
or a one-line change.

The `apiPath()` conversion touches 41 files but only ever wraps an existing
argument, so a conflict there resolves by re-wrapping — and any new `fetch` an
upstream release adds will be caught by the guard test rather than found in
production.
