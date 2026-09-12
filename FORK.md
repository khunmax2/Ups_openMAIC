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
2. **Two request headers.** A gatekeeper in front of this app verifies the
   DeepWitya session and states the result as `x-deeptutor-owner: user:<uid>`
   and `x-deeptutor-role: admin|user`, stripping any copy the client sent. The
   role exists for exactly one surface, described below.

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

### Static files under `public/` need the prefix too

Next serves `public/` under the base path — `public/logos/openai.svg` really is
at `/deepwitya/studio/logos/openai.svg` — but a `src` the application writes is
not rewritten. Running the studio behind a base path produced 126 requests for
`/logos/*.svg` at the origin root, all 404, and a broken image reports nothing:
no console error, no failed check, just a picture that is not there.

`assetPath()` is applied where a value becomes a `src`, not where it is
declared. There are 154 such declarations — provider logos, default avatars, in
constant tables that are compared, stored and passed around — and 18 places they
are rendered. Only the rendered form is a URL. It accepts `undefined` and
absolute URLs untouched, because a `src` is often a provider-hosted avatar, a
`data:` URI, or nothing yet.

### Media references carry the base path, and that has a cost

`generate-image.ts`, `generate-video.ts` and `classroom-media-bytes.ts` write a
`/api/classroom-media/...` reference into the scene document, which the browser
later requests as a `src`. `lib/server/media-origin.ts` calls those references
origin-independent, and they are — but a base path is not an origin, and a bare
`/api/...` resolves against the root, which on a shared host is another team's
API rather than a 404.

The prefix goes on at **write** time. The renderer lives in
`@openmaic/renderer`, published on its own, and teaching it about this app's
base path would point the wrong way; there is no single seam in the app between
the document and that package.

**The cost, stated plainly:** a stored reference now carries the deployment's
base path. Change the base path — the `/deepwitya2` → `/deepwitya` cutover is a
known one — and stored rows point at the old path. That is one `UPDATE` over the
scene documents, and it belongs in the deploy runbook. It is free while the
database is empty, which is why the decision was taken now rather than after
launch.

The predicate that decides "did we generate this, or is it the learner's own
pick" accepts **both** shapes for the same reason. Failing to recognise the
older one would not 404; it would silently start treating our own past output as
something to preserve, and generation would stop replacing it.

### Thai, and letting the host choose the language

The studio falls back to **`zh-CN`, not English**, for any key a locale file is
missing (`lib/i18n/types.ts` sets `defaultLocale = 'zh-CN'`). A half-translated
Thai file therefore renders Thai mixed with Chinese, which is worse for a Thai
reader than plain English — and it is why the first thing anyone sees in an
untranslated build is Chinese.

So `th-TH.json` here is always **complete**: our Thai where it exists, the
English string everywhere else. It is generated by
`deploy/openmaic-patches/build_th_locale.py` in the DeepWitya repository from
`th-TH.partial.json`, which is the real artefact — 1,687 of 1,801 keys, 93.7%.
Upstream's `check:i18n-keys` gate demands exact key parity with `en-US.json`, so
without that filling step an incremental translation would not be possible at
all.

`?lang=` and `?theme=` let the host choose, because an embedder on another
origin cannot reach this app's storage keys, and `?embed=1` hides the language
and theme controls the host has taken over — two switches for one setting means
the one the reader reaches for is the one that loses on the next load.

**Migrating the partial across an upstream bump.** 64 of its keys no longer
existed at `29735f10`. Seventeen had *moved* (`editor.menu.*` →
`edit.contextMenu.*`), and their translations were already present under the new
names. Two shared a leaf name but had different English — `'Center'` became
`'Align center'`, `'Pro mode'` became `'Pro'` — and carrying those across would
have produced a confident mistranslation rather than a visible gap. The
remaining 45 were gone. Compare the *old* English against the new before moving
any translation; the archive at `origin/archive/main-2026-09-09` still has it.

### A self-hosted TTS engine can declare its own voices

Pointing a TTS provider at your own base URL already worked — the setting is
upstream's. What did not work was synthesis: a self-hosted engine serves one
voice under its own name, the client's picker sends whichever default it had,
and the request came back refused for a voice the engine never had. Well-formed,
authorised, and impossible to diagnose from the UI.

So the server entry can declare `voices` (in `server-providers.yml`, or
`<PREFIX>_VOICES`), and `resolveTTSVoice` treats them as authoritative exactly
the way `models` already is: the client's choice is honoured if it is one of
them, and otherwise the first declared voice wins. Declaring nothing keeps
upstream's behaviour, which is the right one for a hosted provider whose voice
list we do not own.

**Image generation needed no change at all.** `openai-image` already carries a
`baseUrl` the settings screen edits and the route honours, so an
OpenAI-compatible endpoint is a matter of configuration. Worth writing down
because it looked like a feature request and was a setting.

*Later:* it needed one after all. The preloaded `gpt-image-*` catalogue, an
empty base URL meaning OpenAI, a required key sent as `Bearer undefined`, and
a probe on `/models/{id}` that most self-hosted servers do not implement each
broke a real configuration, so `custom-image` ("OpenAI Compatible") exists
with none of those assumptions — `lib/media/adapters/openai-compatible-image-adapter.ts`.

### API keys live on the server, per owner

Upstream keeps every provider key in the browser's `localStorage`, because
upstream has no accounts to keep them under. Behind the gateway this fork
does, and a key in `localStorage` is readable by the next person at the same
machine and by anything injected into the page. DeepWitya keeps keys on the
server and hands the browser `***`; this is that shape.

- `lib/server/credentials/store.ts` — one table, `studio_credential`: `owner`
  rows and `default` rows, key and base URL together. Plaintext at rest, on
  the internal network, as DeepWitya's own settings files are.
- `lib/server/credentials/routes.ts` — `GET/PUT/DELETE
  /api/studio/credentials[/default]/{section}/{providerId}`. Every read is a
  mask. The default scope needs `x-deeptutor-role: admin`; an admin promotes
  their own key with `{ copyFromOwner: true }`, since the browser never holds
  it. A stored base URL passes the SSRF guard once, at write.
- `lib/server/credentials/context.ts` — the key resolvers in
  `provider-config.ts` are synchronous and have 23 callers. Rather than change
  their signature, the owner's rows are loaded once at the edge
  (`withOwnerCredentials()` on each route that resolves a key,
  `runWithCredentials()` around agent-runtime sessions and the classroom job)
  into `AsyncLocalStorage`, and the one funnel `resolveSectionApiKey` consults
  it. Precedence: operator-managed entry, own row, default row, client key.
  The sentinel `***` is never a key. Server-side jobs select from *usable*
  providers, which include what the owner stored.
- `lib/credentials/client.ts` — on boot the server's masked list replaces
  every stored key with the sentinel; a real key still in storage is sent
  once and replaced (the migration for existing users); afterwards a typed
  key is sent debounced and swapped for the sentinel on confirmation; the
  persist layer never writes a real key once the server holds them.
  A key and its endpoint are one credential (audit F2, 2026-09-11): a stored
  key is used only with the URL stored beside it, never one a request sends.
  So the URL travels with the key -- the Base URL field, or for a custom
  TTS/ASR provider the URL it was added with (`customDefaultBaseUrl`) -- and
  boot fills in the URL of an own custom-provider row stored before that. A
  custom TTS provider left without a URL refuses before any request leaves
  instead of falling back to OpenAI's endpoint (`lib/audio/tts-providers.ts`;
  2026-09-12, a custom provider's key had reached api.openai.com that way).
- `components/settings/api-key-field.tsx` — shows the server's mask, offers
  remove, and for an admin "set as the system default".

With no database (`storage: 'none'`) none of this runs and the browser keeps
its keys — upstream's shape, unchanged. The gatekeeper also refuses
DeepWitya's `learner` preset outright; that is DeepWitya's decision and lives
in its repository, but it is why an `anon:` owner never appears here in the
deployment.

### The prompt templates show the model no Chinese output

A Thai course came out with a start button reading 启动 and a fullwidth colon
in a status label, body text otherwise correct Thai. Swapping the model did
not help, because the model was not the cause: the templates showed it Chinese
output — two complete worked outlines with Chinese titles and keyPoints, a
Chinese few-shot challenge, a course-title style list in Chinese, and a
task-engine prompt announcing the learner-facing product name as 任务引擎. A
model told to teach in Thai copies the shape it is shown.

Eleven lines across four files, and a guard:
`tests/prompts/no-cjk-in-worked-examples.test.ts` bans CJK inside fenced
blocks in every template while allowing it in prose. That line is deliberate.
Chinese in prose is an example of what a learner might **say** — the
language-inference rules, the director's frustration signals, the "用中文讲"
requests — and those are inputs, paired with English; removing them would make
the product worse for Chinese users. Fenced blocks are what the model reads as
a template for its own answer. 271 CJK characters became 143, none fenced.

That fixed the outlines and left the buttons. The next Thai course had Thai
outlines and a simulation whose controls still read 暂停 and 继续, in the same
place in two different courses, because there is a second template root.
`lib/prompts` decides what a course *is*; `packages/@openmaic/generation/
templates` decides what the learner *sees* — the HTML of a simulation, a game,
a 3D view, a diagram. `simulation-content/system.md` told the model, in a
bullet list rather than a fence, that the control button reads "启动" /
"暂停" / "继续" / "重新开始", and the model did as it was told. A guard that
only looked at fences and only at `lib/prompts` passed while that shipped.

So the guard now scans both roots, and for the templates whose output is
learner-facing markup (`simulation-`, `game-`, `visualization3d-`, `diagram-`,
`code-`, `procedural-skill-content`) it bans CJK anywhere, prose included —
nothing in those files is an example of what a learner might say, so a label
named in a bullet is copied as faithfully as one named in a fence. The
button names became "Start" / "Pause" / "Resume" / "Restart" with the note that
they are written in the teaching language; the worked simulation's
`updateButton('启动')` became `updateButton(START_LABEL)` with the constant
declared beside the state, so the example no longer carries a literal in any
language. 217 CJK characters in that root became 139, all of them inputs.

Two things this deliberately does not do:

- **It does not touch fonts.** The first attempt at this, before the fork
  existed, swapped Microsoft YaHei for Tahoma in 19 places and broke slide
  layout everywhere at once: every element is an absolutely positioned box on
  a fixed 1000×562 canvas, and the model sizes those boxes for the font the
  slide renders with. Change the font and the text changes size inside boxes
  that stay where they were. That, not the prompt edit, was the breakage.
- **It does not claim to finish the job.** Chinese remains in the TS-side
  prompts (`lib/chat/pi/prompts.ts` has one fenced example, the PBL instructor
  and planner carry more, and `packages/@openmaic/generation/prompts-pbl` is
  a third root the guard does not scan) and in `agent-system` / `director`
  prose. Each is a separate, measured change.

Reverting needs no rebuild of anything else: the templates are read with
`fs.readFileSync` per call and ship into the image as files.

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
