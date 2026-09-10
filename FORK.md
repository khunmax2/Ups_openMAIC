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

## Rebasing onto a new upstream

Rebase for a reason — a security fix, a wanted feature — never on a schedule,
because every rebase carries the DDL-drift risk: OpenMAIC ships no versioned
migrations and guards every DDL statement with `IF NOT EXISTS`, so a drifted
column type is accepted silently. `pg_dump` before every rebase.

The three files most likely to conflict are the ones this fork edits inside
upstream's own code: `lib/server/agent-runtime/owner.ts`,
`lib/server/agent-runtime/with-owner.ts`, and
`app/api/persistence/[...path]/route.ts`. Everything else is either a new file
or a one-line thread-through.
