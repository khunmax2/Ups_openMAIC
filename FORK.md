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

### A custom speech-recognition server is sent WAV, not WebM

A custom (OpenAI-compatible) ASR pointed at a LiteLLM gateway passed its Run
test and then refused every real recording: `422 … Failed to decode audio:
Error opening '/tmp/….webm': Format not recognised`. The browser records WebM;
the gateway decodes with libsndfile, which has no WebM. DeepWitya hit the same
wall with the same server (its PR #96) and converts on its server; this image
carries no ffmpeg, so the conversion happens where the recording is made.

Upstream already had the mechanism: `normalizeASRUploadAudio`
(`lib/audio/wav-utils.ts`) decodes the recording in the browser and re-encodes
it as mono PCM WAV for the two providers that read nothing else, FunASR and
Lemonade. Custom providers (`custom-asr-*`) join that list. Hosted providers
(OpenAI, Qwen, Azure) keep receiving what they received before.

The server half: `transcribeCustomOpenAICompatibleASR` named every upload
`audio.webm`, whatever it held. The name now follows the bytes (`audio.wav`
for WAV), since a gateway that saves the upload under the given name and
decodes by what that name claims fails on WAV called WebM.

Tests: `tests/audio/wav-utils.test.ts`, `tests/audio/custom-asr.test.ts` (three
new cases, red before the change), both now in `fork-ci.yml`.

### A shared custom provider travels with its definition

Sharing a key (the admin action in "API keys live on the server", above) put a
key and a URL on a default row, and every account's server-side lookups found
it. No account's *browser* could show it, though, when the provider was one
somebody had added by hand: a custom TTS, ASR or LLM provider exists as an
entry in the adding browser's storage and nowhere else, so the shared row named
a provider id the other browsers had never heard of. Found 2026-09-14 when a
promoted admin could not see a custom TTS the first admin had shared. The same
gap left a shared "OpenAI Compatible" image key without a model: the model
name lives in each browser's own list, and image generation failed with
"requires a model to be configured".

A default row now carries a `profile` (new `profile` column, added with
`ADD COLUMN IF NOT EXISTS`): the provider's definition -- name, endpoint,
voices, models -- or, for a built-in image/video provider, the models the admin
added. Never a key: the route drops anything that looks like one, refuses a
profile on an owner row, and caps it at 64 KiB. The browser
(`lib/credentials/client.ts`) sends it when an admin shares, builds a provider
it lacks from it (marked `fromShare`), fills an empty model list from it, and
drops what it built when the share goes -- unless it is the provider in use.
A share made before this has no profile; the sharing admin's own browser (its
own row is the shared one) fills it in once, at the next boot.

While there: applying the server's answer rewrites base URLs in the store, and
the store watcher could read that as the person typing and write a URL-only
own row that shadows the shared key. The watcher now ignores changes made
while the answer is applied.

Tests: `tests/server/credentials.test.ts`, `tests/credentials/client.test.ts`
(nine new cases, red before the change), both now in `fork-ci.yml`.

### Only the course's owner resumes its generation

The classroom resumes an interrupted generation on mount: missing slides
(`generateRemaining`) and, on a deck that has all its slides, missing media
(`generateMediaForOutlines`). Both run with the **viewer's** models and keys.
Upstream is single-user, so it never asks who the viewer is -- the workbench
pane's own comment says as much. Here every course loads from the server in any
browser, and found by the 2026-09-14 audit:

- a course loaded from the server gets `generationComplete: false`
  (`applyClassroomStageAndScenes`), and the server's own flag was never set --
  `POST /api/stages/:id/generation-complete` had no caller;
- so anyone opening a course with a missing slide (an unfinished generation,
  or a slide deleted afterwards) started generating it with their own model,
  a learner on a published course included, and opening a finished course in a
  new browser regenerated every image, because the generated media lives only
  in the creator's browser. The server refuses the visitor's writes (audit F1);
  the model calls still ran.

The fix is a resume gate (`lib/classroom/progressive-load-policy.ts`):
`unknown` until the stage-meta sidecar answers, `allowed` for the owner or for a
course with no sidecar row (local-only, or no server persistence -- upstream's
case), `denied` for a visitor or when the sidecar does not answer (fail closed;
a reload asks again). `lib/classroom/viewer-access.ts` asks the sidecar for both
hosts: the page always did, the workbench pane never did. When the owner's deck
finishes, `lib/classroom/generation-complete-mirror.ts` sets the server's flag.

Tests: `tests/classroom/progressive-load-policy.test.ts`,
`tests/classroom/viewer-access.test.ts`,
`tests/classroom/generation-complete-mirror.test.ts`,
`tests/store/stage-generation-complete-mirror.test.ts` (red before the change),
all in `fork-ci.yml`.

### A course's generated media lives on the server

Upstream's browser generation is local-first: generated slide images went to
IndexedDB (`mediaFiles`) and narration to `audioFiles`, and the scene document
kept only opaque ids (`gen_img_*`, `tts_s*_…`). With documents on the server
here, a course opened in another browser -- or by a learner on a published
course -- had its slides and no pictures or sound (found by the 2026-09-14
audit).

Upstream already has a server-side answer, and this follows it rather than
inventing one. Its 1.0.0 release retired the asset-registry wiring for
generated media (#1242: "media and materials follow the reference byte
model"); its agent runtime writes media bytes into the course's classroom-media
directory (`persistClassroomMediaBytes`, `lib/server/classroom-media-bytes.ts`)
and stores the returned `/api/classroom-media/...` reference in the document.
The only missing piece was a way in for the browser:

- `POST /api/stages/[id]/media` (`app/api/stages/[id]/media/route.ts`),
  owner-only, calls `persistClassroomMediaBytes` with the uploaded bytes --
  only the types the classroom-media route serves, at most 32 MiB.
- Narration: `generateAndStoreTTS` uploads the clip and uses the served
  reference as the action's `audioId`, and `generateTTSForScene` puts it on the
  legacy `audioUrl` too -- the exact shape the agent runtime's scene TTS
  stamps. `AudioPlayer` plays an `audioId` that is itself a served reference
  when this browser has no bytes, so a regenerated line plays too.
- Images: the orchestrator uploads the bytes in the background and the stage
  records `placeholder -> reference` in `mediaAssets`
  (`lib/media/stage-media-assets.ts`, beside `videoManifest`; the DSL validator
  ignores unknown stage fields, so no schema change). The image renderer maps a
  recorded placeholder to its reference, which renders as a concrete URL.
- Both uploads are best-effort (`lib/media/persist-generated-media.ts`): a
  failure -- not the owner, offline, no server persistence -- never fails
  generation, and the IndexedDB copy stays what the generating browser plays.

Published courses need nothing more: `/api/classroom-media` is upstream's
serving route and has no per-reader check, so a learner who can open the course
loads its media. That is also the privacy posture, stated plainly: the files of
a private course are readable by anyone who has the exact URL. The URL is a
content hash (`generated-<sha256>.<ext>`), unguessable, and appears only in the
owner's documents. The bytes live on the studio's `/app/data` volume, which
`deploy/backup-studio.sh` archives nightly.

Generated video still uses the browser path.

Courses generated before this keep their media in the creating browser, so the
owner's visit there moves it (`lib/media/migrate-stage-media.ts`, started by
both classroom hosts behind the same owner gate as resuming). Each local image
and clip goes up once through the same route; the document then records it the
same way new media is recorded (`mediaAssets`, or the speech action's
`audioId`/`audioUrl` via the store's `replaceSpeechAudio`). Media this browser
never held is skipped -- the browser that has it moves it on its own visit. The
first refused upload stops the run without marking the course done, so the next
visit retries; uploads are content-addressed, so a retry never duplicates a
file. A course the owner never reopens in its creating browser keeps its media
there: nothing on the server can reach those bytes.

Tests: `tests/agent-runtime/stage-media-upload-route.test.ts`,
`tests/media/persist-generated-media.test.ts`,
`tests/audio/audio-player-server-audio-id.test.ts`,
`tests/media/stage-media-assets.test.ts`,
`tests/store/stage-media-assets-store.test.ts`,
`tests/media/migrate-stage-media.test.ts` (red before the change).

### A custom TTS provider is only sent a voice it lists

The settings store's generic fallback voice is `default`. A built-in provider
maps it to its own default; a custom server does not know it and answers 400.
Found 2026-09-14 on a shared custom provider (see "A shared custom provider
travels with its definition"): it was selected before its voice list arrived
through the credential sync, the selection stayed `default`, and every
narration request failed with "OpenAI TTS API error: Bad Request" until the
user switched providers away and back -- only `setTTSProvider` picked a listed
voice.

- `lib/audio/custom-tts-voice.ts`: `customTTSVoiceFor` (the chosen voice when
  the custom provider lists it, else its first listed voice) and
  `correctedCustomTTSVoice`.
- The settings store applies it after every change and once at load
  (`useSettingsStore.subscribe`, bottom of `lib/store/settings.ts`), so no
  write path -- sync, restored blob, direct `setState` -- can leave it out.
- Narration requests apply it to a course's saved voice binding
  (`generateAndStoreTTS`), which can hold `default` from before.
- `generateOpenAITTS` names a custom provider's failure "Custom TTS API error"
  and reads the reason the way the other OpenAI-compatible providers do
  (`readTTSApiError`: FastAPI `detail`, then `error`).

Tests: `tests/audio/custom-tts-voice.test.ts`,
`tests/store/settings-custom-tts-voice.test.ts`,
`tests/audio/custom-tts-endpoint.test.ts` (red before the change).

### Settings and the profile follow the account, not the browser

Upstream persists provider settings (`settings-storage`: model lists,
deletions, toggles, the selected voice) and the user profile
(`user-profile-storage`: avatar, nickname, bio) through the KV store's
`account` scope -- by its own definition the data "a server-backed deployment
may sync across devices" -- and ships the client for that (`HttpKVStore`), but
no server, and the app only ever built the browser store. So a new browser came
up with upstream's defaults: deleted models back, added ones gone, image and TTS
toggles off, voice `default`, blank profile (found by the 2026-09-14 audit).

- Server: `lib/persistence/account-kv.ts` answers upstream's KV contract at
  `/api/persistence/kv/...` (keys, get, put, delete), one row per (owner, key)
  in `studio_account_kv`, created on first use. The persistence route hands it
  `/kv` paths after the gateway identity is resolved, like `/whoami`; nothing on
  the wire names a principal or a scope.
- Client: `lib/store/account-kv.ts` is the backend `kv-persist` now builds.
  With `NEXT_PUBLIC_PERSISTENCE=1` the `account` scope goes to that route
  (`HttpKVStore`); `device` values stay in the browser as before; without it,
  upstream's browser store exactly as before.
- First load after the switch: the server has nothing yet and upstream's
  persist seam never migrates, so an empty answer would hydrate defaults over
  the user's settings. When the server has no value, this browser's copy is
  adopted and sent up once; from then on the server's value is the one read. A
  person who used two browsers gets whichever browser opens the studio first.
  Deleting a value deletes the local copy too, so it is not adopted back.
- Keys never travel in the blob: whenever the scope is server-backed the
  settings are persisted with every API key masked, whatever the credential
  sync has reported. Keys stay in `studio_credential`.
- Values over 4 MiB are refused (a very large uploaded avatar would be); the
  persist seam then reports the write as unsaved instead of dropping it
  silently.

Tests: `tests/persistence/account-kv.test.ts` (including upstream's own
`HttpKVStore` round-tripping through the handler),
`tests/store/account-kv.test.ts`, `tests/persistence/route.test.ts` (red before
the change).

### A course's images are generated a few at a time, and the pill names the model

Two findings from the 2026-09-14 report.

"Images come up slowly": the media orchestrator starts alongside slide
generation but upstream requested every image strictly one after another, so a
long course's last picture arrived minutes behind its slides. It now keeps up to
`MEDIA_GENERATION_CONCURRENCY` requests in flight (server env, default 2,
clamped to 1..6), handed to the browser through `/api/server-providers` beside
`PARALLEL_SCENE_CONCURRENCY` and for the same reason: the right number depends
on the image backend -- one self-hosted GPU wants few, a hosted API takes more
-- and a burst over a key's quota comes back as 429s. `1` is upstream's order
exactly, and a browser whose server does not report the value stays serial.
Requests still start in outline order; an abort stops anything not yet started.

The home model pill showed only the provider's icon and the thinking level, so
two models of one provider looked the same until hovered. It now shows the
model's name, truncated (`ModelSettingsPopover`, `generation-toolbar.tsx`).

Tests: `tests/media/media-orchestrator-concurrency.test.ts`,
`tests/server/media-generation-concurrency.test.ts` (red before the change).

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
