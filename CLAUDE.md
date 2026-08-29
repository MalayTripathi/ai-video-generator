@AGENTS.md

# Reelcraft — AI Video Generator

Users start from an idea, a script, or a screenplay and get a finished
short video. An 8-step pipeline turns that text into a film-style shot
list, then takes it through voiceover, images, storyboard, video prompts,
clip generation, and final assembly with subtitles and social copy.

The steps: **1 Intake** (pre-project) → **2 Workbench** (shot list) →
**3 Voiceover** → **4 Image prompts** → **5 Storyboard** →
**6 Video prompts** → **7 Generation** (most expensive) → **8 Assembly**.

## Stack
- Claude API: shot-list generation from the intake text, plus the
  workbench agent; returns structured shots through tool calls, never
  prose.
- ElevenLabs API (`eleven_v3`): text-to-speech. v3 is required — scripts
  carry inline audio tags (`[slowly]`, `[warmly]`) that older models
  would read aloud as words. Also covers Hindi.
- OpenAI Images API: per-shot image generation, individually regenerable
- fal.ai: image + video prompt → per-shot video clip, all shots in
  parallel

## Conventions
- All external API calls happen server-side only (API routes / server
  actions), never in client components — these keys must never reach the browser.
- Design tokens come from the **Reelcraft canvas** in Claude Design (not the
  Nocturne design-system project directly — Reelcraft is the actual product
  token overlay; Nocturne is the foundation it's built on but isn't a token
  source itself), bound as `:root` / `.dark` CSS variables and mapped into
  the Tailwind theme. **Light is the default mode.** Use tokens, never
  hard-coded hex.
- The rail nav is always dark, in both light and dark mode — never
  inverted. Its tokens (`--rail-bg`, `--rail-fg`, `--rail-fg-muted`,
  `--rail-item-active-bg`, `--rail-border`) carry different-but-both-dark
  values under `:root` and `.dark` in `globals.css` (dark mode is one step
  lighter, so the rail reads as elevated, not inverted), mapped into
  Tailwind as `bg-rail-bg`/`text-rail-fg`/etc. Don't let `.dark` flip the
  rail the way it flips the rest of the UI.
- Fonts: Inter (400/500/600) via `next/font/google`, exposed as
  `--font-inter` and consumed through `--font-body`/`--font-ui` — not the
  create-next-app default (Geist).
- Dark mode is class-based (`@custom-variant dark (&:where(.dark, .dark *))`
  in globals.css), not `prefers-color-scheme` — `.dark` is an explicit
  opt-in, matching "light is default."
- Tailwind gotcha: never name a custom `--spacing-*` theme key after a bare
  t-shirt size (sm/md/lg/xl/2xl/3xs/...). Tailwind v4 resolves
  max-w/w/h/min-w/max-h/min-h through `["--max-width", "--spacing",
  "--container"]` in that order, so a colliding `--spacing-sm` silently
  hijacks `max-w-sm` before Tailwind's real container scale is reached.
  Reelcraft's spacing scale is namespaced `--spacing-rc-*` (`gap-rc-sm`,
  `px-rc-lg`, ...) specifically to avoid this.
- **One horizontal padding token, no exceptions.** Every block in the
  workbench uses `rc-md` (16px) as its horizontal padding, applied flat
  with no responsive breakpoints: the title/chip header block, the step
  indicator band, the Agent heading and subtitle, the message list, the
  composer, the tab strip, the shots content column, and the footer bar.
  No element gets its own inset, indent, or override. Two reference
  edges, both correct: full-width bands (title, step indicator) and the
  agent panel measure from the rail's right edge and therefore share one
  left inset; the shots column measures from the column divider instead,
  so its content sits one token in from that divider. Vertical padding is
  tuned separately — don't touch it when adjusting horizontal.
- Do not modify `src/proxy.ts` (Next.js 16's renamed `middleware.ts`) or
  `src/lib/supabase/*` unless the task is explicitly about session handling.
- Wizard state lives in the DB, not client state. Each step is a real URL
  (`/projects/[id]/workbench`, `/voiceover`, `/image_prompts`,
  `/storyboard`, `/video_prompts`, `/generation`, `/assembly`) so work is
  resumable — generation is slow and costs money. `intake` (`/projects/new`)
  is a pre-project screen, not a tracked step: it never appears as a
  `current_step` value, since the project row doesn't exist until submit.
- `/projects/new` creates no DB row on load. The row is created on submit
  by `createProjectFromIntake` (`src/app/projects/new/actions.ts`), already
  fully populated (`source_text`, `video_type`, `aspect_ratio`,
  `duration_target`, `language`, `status: 'draft'`,
  `current_step: 'workbench'`, `furthest_step: 2`,
  `shots_generation: 'pending'`), before redirecting into
  `/projects/[id]/workbench`.
- `dashboard`, `projects/new`, and `projects/[id]/*` live in the
  `src/app/(app)/` route group (URLs unchanged). Its shared `layout.tsx`
  fetches the user once and renders `Rail` there, so the rail survives
  navigation without unmounting. `Rail` is a client component that derives
  its own active state via `usePathname()` rather than taking a prop —
  don't pass it one, and don't render a second `Rail` from a page,
  `WorkbenchShell`, or a `loading.tsx`.
- Claude returns scripts as structured shots (JSON), not prose. One shot
  = one image = one voiceover segment.
- Model and provider config lives in `src/lib/config/models.ts`, read from
  env with defaults. Never hard-code a model name at a call site. Config
  sections are added when a step is built, not ahead of it. The same
  module exports `estimateClaudeCostUsd`, the single source for turning
  token counts into the `usage.estimated_cost` figure — don't compute cost
  anywhere else.
- **Provider calls.** See `## Provider calls` below for the gateway seam,
  the live-call guard, and the Playwright guard. Never set, export, or add
  `ALLOW_REAL_CLAUDE` anywhere in the repo — that decision belongs to the
  developer, not the agent.
- Duration → shot-count/credit mapping lives in `src/lib/config/duration.ts`
  (`durationConfig`, keyed by `DurationTarget`) — the single source for
  `targetShots`/`estimatedCredits`. The intake duration tiles, shot
  generation, and `RetryConfirmModal`'s credit-cost copy all read from
  it; don't duplicate these numbers elsewhere. Every billed generation
  outside the initial `pending` trigger (i.e. every retry) is confirmed
  through that modal before the request fires.
- `displayTitle(project)` (`src/lib/display-title.ts`) is the single title
  fallback helper (`title` → truncated `source_text` → `'Untitled
  project'`) — used by the dashboard card, the workbench header, and the
  intake template picker. Use it anywhere a project title is displayed
  instead of reading `title` directly.
- Anything the UI needs from a Claude call goes in the tool schema, not in
  free-text alongside it. Models frequently return tool_use with no text
  block.
- Playwright uses `channel: 'chrome'` (macOS 12 has no bundled chromium
  build). Don't run `npx playwright install chromium`. Integration tests
  mint a real throwaway Supabase user via `tests/supabase-test-session.ts`
  (`createTestSession`/`deleteTestUser`, admin-API magic-link session)
  rather than mocking auth — see `tests/new-project-intake.spec.ts`. See
  the Testing section below for how provider calls are faked and the run
  guard that keeps the suite off the real Anthropic API.
- Schema changes go in `supabase/migrations/` via `supabase migration new`,
  applied with `db push` — never pasted into the dashboard SQL editor.
  Re-run `npm run types:db` after any change; `src/lib/database.types.ts`
  is generated, never hand-edited.
- Supabase clients are typed with the generated `Database` type. Don't
  infer schema from usage — read the types file.
- Prompt caching is wired on both `/prompts` and `/shots` but is currently
  inert on both: the static prefixes still sit under the minimum cacheable
  size (2048 Haiku / 1024 Sonnet), so no cache entry is created and
  `usage.cache_creation_units` / `cache_read_units` log as 0. Don't pad
  prompts to reach the threshold. It will activate on its own as prompts
  grow — the workbench agent's system prompt plus tool schemas plus shot
  index will clear it comfortably.
- Tailwind v4 gotcha: `<button>` has no default `cursor: pointer` in
  preflight (unlike v3). Every clickable button needs `cursor-pointer`
  added explicitly, plus `disabled:cursor-not-allowed` where the button
  toggles `disabled`.
- Shot keys are stable and immutable. `shots.shot_key` is 5 lowercase
  characters from `23456789bcdfghjkmnpqrstvwxz` (no vowels, no
  `0/1/i/l/o`), generated server-side in TypeScript
  (`src/lib/shot-key.ts`, `generateUniqueShotKeys`) with
  retry-on-collision against the `(project_id, shot_key)` unique
  constraint — never a Postgres function, never reused after delete,
  never shown in the UI (card headers show `order_index + 1` instead).
- `workbench-shell.tsx` (`src/components/workbench-shell.tsx`) is the
  shared chrome for Steps 2–8: a `header` slot, the 8-step indicator, the
  agent panel, a `children` content slot, and an optional `footer` slot.
  The rail is present on these routes but comes from the `(app)` route
  group's layout, not from the shell — the shell renders no `Rail` of its
  own. Project routes have no top bar at all; the user menu lives in the
  rail footer, below the credits block.
  Step-specific UI (sub-tabs, tab bodies, what actually goes in the
  footer) is deliberately not in the shell — only Step 2 exists so far;
  don't hoist a step's specifics into the shell ahead of the step that
  needs them.
- The agent panel's message list has a fixed six-kind taxonomy across all
  steps: `assistant` (accent-wash bubble), `user` (inset bubble,
  right-aligned), `tool_run` (amber dot + credit cost), `success` (green
  dot), `error` (failed-hue rule + Retry), `working` (pulsing dot + Stop)
  — see `src/components/workbench/agent-message.tsx`. Only `assistant` is
  populated today (from `write_shots`'s `message` field); the other five
  render structurally but have no real caller yet.
- The step indicator (`workbench-step-indicator.tsx`) only links a step
  if it's actually built and has a real per-project route
  (`/projects/[id]/{step}`); `intake` has no such route (`/projects/new`
  is a pre-project screen) and always renders inert even when shown
  complete. Complete/current/locked is derived from `current_step`'s
  position alone — it does not consult `furthest_step` yet (see Current
  focus).
- `src/lib/video-type-labels.ts` and `src/lib/language-labels.ts` are the
  single source for turning raw `video_type`/`language` codes into
  display labels — used by both the intake picker and the workbench
  header chips. Don't inline a second copy of either mapping.
- A system prompt that's been explicitly pulled out of its route gets its
  own versioned module under `src/lib/prompts/` (e.g.
  `shot-generation.ts`, exporting a `_V1`-suffixed constant bumped on any
  content change). Not every route follows this yet — `/prompts`'s
  `PROMPTS_SYSTEM_PROMPT` is still inline — check the specific route
  rather than assuming.

## Provider calls
- `ClaudeGateway` (`src/lib/claude.ts`) is the only place `@anthropic-ai/sdk`
  is instantiated — `createClaudeClient` no longer exists in this codebase.
  Routes receive an injected gateway via `createClaudeGateway()`; tests
  inject hand-written fakes from `tests/helpers/claude-fakes.ts`
  (`successMessage`, `truncatedMessage`, `throwingGateway`) — never the real
  SDK.
- `assertLiveCallsAllowed()` runs at call time, inside `createMessage`, not
  at import time. It returns early when `NODE_ENV === 'production'`.
  Outside production it throws unless `ALLOW_REAL_CLAUDE === '1'` — an exact
  string match; `'0'`, unset, or anything else all block. A permitted live
  call logs a `console.warn` banner naming the model and tool before the
  request fires.
- **Never set, export, or add `ALLOW_REAL_CLAUDE` to any env file, npm
  script, test config, CI workflow, or shell command.** Whether to spend
  money on a live call is the developer's decision alone. If a task appears
  to need a live call to verify, stop and say so instead of enabling the
  flag.
- Playwright has no live path, enforced three times over:
  `tests/global-setup.ts` throws unconditionally if `ALLOW_REAL_CLAUDE=1` is
  set; `tests/load-env.ts` deletes the flag from the test-runner's own
  process immediately after loading `.env.local`; `playwright.config.ts`
  forces `webServer.env.ALLOW_REAL_CLAUDE` to `''` for the spawned dev
  server. There is no `test:live` script and nothing in the suite is tagged
  `@live`.
- Calls are streaming-only (`messages.stream()` + `finalMessage()`, never
  `create()`) with `maxRetries: 0` — an SDK-level retry on a partially
  generated response would be a silent second charge — and a 600s client
  timeout. The `/shots` route additionally sets `export const maxDuration =
  300`. `stop_reason` and `request_id` are captured off every call and
  `console.warn`'d; persisting them onto the `usage` row is Phase 1 (see
  `usage`'s "Known gaps" note).

## Testing
- Business logic (`runShotGeneration`, etc.) is tested by injecting a `ClaudeGateway`
  literal built from `tests/helpers/claude-fakes.ts`'s canned-shape builders
  (`successMessage`, `truncatedMessage`, `throwingGateway`) — never a fixture/scenario
  system, never an env var selecting behavior. No test ever imports or calls
  `createClaudeGateway()` / the real Anthropic SDK to make a request; `@anthropic-ai/sdk`
  may only be imported for types in tests.
- `tests/global-setup.ts` throws unconditionally if `ALLOW_REAL_CLAUDE=1` is set for a
  Playwright run — there is no sanctioned way to make a live call through Playwright.
  `tests/load-env.ts` strips the flag from the test-runner's own process immediately
  after loading `.env.local`, and `playwright.config.ts`'s `webServer.env` forces it
  empty for the spawned dev server, so a value left in `.env.local` from a manual
  live-debugging session can't leak into either process. The one deliberate live-call
  path is `npm run dev` with `ALLOW_REAL_CLAUDE=1` exported by hand in a developer's own
  shell, entirely outside Playwright/CI.
- Caveat: the guard cannot protect a manually pre-started `npm run dev` process, since
  `webServer.reuseExistingServer: true` means Playwright reuses rather than re-spawns it
  — always start the dev server fresh (or stop a stray one) before trusting the guard.
- Any test that drives the retry control through the UI must go through the real
  `RetryConfirmModal` (`role="dialog"`, `retry-confirm-modal.tsx`) — there is no
  `window.confirm` to handle anymore.

## Database
Tables: `projects`, `shots` (renamed from `scenes`), `elements`,
`shot_elements`, `messages`, `jobs`, `usage`. All RLS-protected;
`shot_elements` resolves ownership through a two-level join (shots →
projects), unlike every other child table's single-level `exists`
subquery. Private `artifacts` Storage bucket.

`shots.shot_key` is a stable, immutable 5-character key (see Conventions)
with a `(project_id, shot_key)` unique constraint — not the ordinal
`s001`-style values it originally shipped with.

`shots` craft fields: `visual_description`; `dialogue` (jsonb
`{element_id, line}[]`, resolved against `elements` for display — never
raw speaker names); `shot_size` / `camera_angle` / `camera_movement`
(each DB-CHECK-constrained to a fixed enum — read the migration, not just
the types file, for the allowed values); `section_label`;
`camera_overridden` / `duration_locked` (booleans marking a field as
user-set vs. still free to regenerate).

`elements` (character / location / prop) are deduped per project by
`lower(name)` (unique index), so a recurring character reuses one row —
and eventually one reference image — across every shot it appears in.
`reference_image_path` is null and `status` is `'pending'` until a later
step generates one.

`usage` is the model-spend ledger, one row per provider call. Columns:
`id`, `project_id`, `provider`, `kind`, `input_units`, `output_units`,
`cache_creation_units`, `cache_read_units`, `estimated_cost`,
`created_at`. `estimated_cost` is computed by `estimateClaudeCostUsd`
from `src/lib/config/models.ts` — never inline a second cost calculation.
Two routes write to it today: `/api/projects/[id]/shots` logs
`kind: 'shots'` after the `write_shots` call, and
`/api/projects/[id]/prompts` logs `kind: 'prompts'` after `write_prompts`.
A third value, `kind: 'script'`, exists in historical rows only — the
route that wrote it is gone. Every new provider call must log here.
Known gaps, deliberately not yet addressed (see Current focus): no
`user_id` (reachable only via `project_id`, and a project delete would
orphan or erase the spend record), no `model` column (so Haiku-vs-Sonnet
routing can't be verified from the ledger), no `status` column (so a
failed-but-billed call can't be recorded), and `kind` is unconstrained
text.

`projects.shots_generation` (text, CHECK-constrained, default `'pending'`)
is the shot-generation state machine:
- `pending` — intake has created the row, shot generation has not run yet.
- `generating` — a claim is held; `generating_at` holds the claim
  timestamp.
- `ready` — shots exist and are committed.
- `failed` — the last attempt failed. `pending_shots_payload` (jsonb,
  nullable) is non-null if and only if Claude already returned
  successfully and only the database writes failed, in which case
  recovery must replay the payload and MUST NOT call Claude again.
`pending_shots_payload` is always cleared once shots and shot_elements are
committed. `generating_at` is unchanged in role — still the claim
timestamp — and is now written in the same UPDATE that transitions
`shots_generation` to `'generating'`. `shots_generation` — not "the shots
table is empty" — is now the only trigger for shot generation.

A `/api/projects/[id]/shots` request runs a strict **claim → recover →
persist → settle** order (`runShotGeneration` in
`src/app/api/projects/[id]/shots/logic.ts`). **Claim**: one atomic
conditional `UPDATE` (project id + user id + a state predicate —
`pending`, or `generating` with a stale `generating_at`, or `failed` with
a request-time `retry: true`) is both the lock and the idempotency guard;
a zero-row result is a refused claim (409, with `reason: 'already_ready' |
'already_generating' | 'retry_required'`), never a partial attempt.
**Recover**: if the claimed row already carries a non-null
`pending_shots_payload`, the gateway is never called — the stored payload
is replayed through the same parse → resolve-elements → insert pipeline.
**Persist**: on a fresh call, the raw `write_shots` tool_use input is
written to `pending_shots_payload` in its own `UPDATE` immediately after
the Claude call returns, before any `shots` row is inserted. **Settle**: a
`finally` block runs on every exit path including a thrown exception —
success writes `ready`/`generating_at: null`/`pending_shots_payload:
null`; failure writes `failed`/`generating_at: null`, leaving
`pending_shots_payload` intact for later recovery — except a `max_tokens`
truncation, which also settles `failed` but always clears the payload,
since a truncated answer was never "returned successfully" in the sense
this contract requires.

**A stored `pending_shots_payload` means Claude has already been paid
for; recovery replays it and never re-calls.**

A retry or recovery run replaces the shot list wholesale: `runShotsPipeline` deletes all
existing `shots` rows for the project (cascading `shot_elements`, which has `ON DELETE
CASCADE` on both foreign keys) immediately before inserting the fresh/replayed batch,
always sequenced after `pending_shots_payload` is already durably written — a crash
between the two still leaves the payload intact for the next retry to recover from.
`elements` are never deleted: they're project-level and deduped by name, so
`resolveElement` re-matches existing rows (including any reference image already
generated) on replay instead of creating duplicates. This is what makes the
confirmation modal's "existing shots will be replaced" copy true rather than aspirational.

This mechanism is specific to `/shots` — `/prompts` still uses the plain
`generating_at`-only CAS lock in `generation-lock.ts`, unchanged. The two
locking strategies are scheduled to converge; until then, `/prompts`'s
422-on-partial-failure guarantee (see Done log) is enforced by that older
CAS lock, not by the claim/recover contract described above.

The workbench shot list derives its UI phase from `shots_generation` +
`shots.length`, not `shots.length` alone (`shots-context.tsx`):
`pending`/`generating` → `generating` (skeleton, polls via
`router.refresh()` every 3s so a passive tab picks up another tab/device's
result); `ready` with shots → `list`; `ready` with zero shots → `failed`
(defensive, never auto-retried); `failed` with zero shots → `failed`;
`failed` with saved shots → `partial` (renders the saved list with a
cut-short warning banner, not a silent success). This table lives in
`derivePhase()` (`derive-phase.ts`) as a pure function of
`(shots_generation, shotCount)`. The client never triggers generation off a
raw `shots.length === 0` check — the only trigger is `derivePhase()`
returning `'trigger'` (i.e. `shots_generation === 'pending'`), fired once
via a ref guard in `ShotsProvider` (`shots-context.tsx`), so a project that
legitimately has zero shots for another reason can never re-fire
generation. Retry is gated behind `RetryConfirmModal`
(`retry-confirm-modal.tsx`), which states the credit cost from
`durationConfig` when `pending_shots_payload` is absent, or that
resuming is free when it's present — the same modal warns that
existing shots will be replaced when retrying from the `partial` phase.

Read `src/lib/database.types.ts` for columns — don't rely on this file.
Conventions not visible in the types: `projects.status` is unconstrained
text (draft / in_progress / completed / failed). `current_step` is one of
`workbench` / `voiceover` / `image_prompts` / `storyboard` /
`video_prompts` / `generation` / `assembly` — also unconstrained text, with
no DB CHECK (unlike `aspect_ratio`/`duration_target`/`video_type`, which do
have one), so the vocabulary is enforced by app code only. `intake` is a
pre-project screen, not a real `current_step` value — it only exists as
the step-1 anchor in `furthest_step`'s mapping. `furthest_step` (smallint,
default 1) tracks the deepest step a project has reached, 1-8 over that
same vocabulary (intake=1 ... assembly=8). `projects.video_model` holds a
single model string and is currently populated with a placeholder value —
see Open questions.

## Done
- Supabase email/password auth: signup, login, sign-out, protected dashboard
- Root redirect: `/` → `/dashboard` or `/login`
- Auth screens styled to the design system, with inline validation
  (required fields, email format, password match, terms, min length)
- Deployed to Vercel
- Dashboard: left rail, status filter chips, project card grid reading
  live `projects` rows, empty state. "New Project" (rail + empty state)
  links to `/projects/new`, the intake screen. Cards link to
  `/projects/[id]/{current_step}` — resumes wherever the project left
  off. Card thumbnails and the remaining nav items (Assets, Queue, Usage,
  Settings, search) are still visual-only pending real data/routes.
- Shared app chrome: the `(app)` route group's layout fetches the user
  once and renders the rail for the dashboard, intake, and all project
  routes. The user menu with real sign-out sits in the rail footer below
  the credits block; project routes render no top bar. Verified via a
  DOM-marker test that the same rail button instance survives a
  `/projects/[id]/workbench` → `/dashboard` navigation with no
  unmount/remount.
- `/api/projects/[id]/prompts` generates `image_prompt`/`video_prompt` per
  shot, validated (min 50 chars, non-empty) before persistence — invalid
  entries stay null and are regenerable. Partial failure returns 422 and
  does not advance `current_step` (enforced by the older `generating_at`-only
  CAS lock, not the `/shots` claim/recover contract — see Database).
  Prompt caching is wired but inert (see Conventions).
- Double-submit guards on prompt generation and project creation.
  `/prompts` acquires a DB-level CAS lock (`projects.generating_at`,
  `src/lib/generation-lock.ts`) before doing any work and releases it in a
  `finally` on every exit path; a concurrent request gets a 409, and a
  stale lock (crashed/killed request) self-heals after 15 minutes (tied to
  the real gateway's 600s SDK timeout plus margin, see `claude.ts`) rather
  than wedging the project. The intake screen's `BuildButton` disables
  itself via `useFormStatus` while `createProjectFromIntake` is in flight.
- Step 2 Workbench (`/projects/[id]/workbench`): built on
  `workbench-shell.tsx` (see Conventions), read-only shot list. On first
  load while `shots_generation` is `'pending'`, the client triggers `POST
  /api/projects/[id]/shots`, which runs the claim → recover → persist →
  settle sequence (see Database) via `runShotGeneration` in
  `src/app/api/projects/[id]/shots/logic.ts` — one `write_shots` Claude
  tool call (system prompt in `src/lib/prompts/shot-generation.ts`, target
  shot count from `durationConfig`), persisting
  shots/elements/`shot_elements`/dialogue, guarding the `projects.title`
  write (only if still null), inserting an `assistant` message, and
  logging a `usage` row. This is not `generation-lock.ts`'s
  `generating_at`-only CAS lock (that mechanism stays reserved for
  `/prompts`) — shots is driven entirely by `shots_generation`/
  `pending_shots_payload`. Shot cards are grouped by `section_label`,
  collapsed only (no editing yet). A `ShotsProvider` client context keeps
  the header's Target/Current readout, the Shots/Assets tab counts, and
  the footer's "N elements without a reference image" banner in sync with
  the client-fetched result once generation completes — none of it is
  server-rendered-once-and-forgotten. Assets and Script tabs render fixed
  empty states this task regardless of whether elements already exist
  (deliberate scope line, not an oversight). Explicitly deferred: shot
  editing, agent chat mutations, element upload/generation, step-guard
  navigation (see Current focus).
- `video_type` resolution: when intake stores `'auto'`, `write_shots`
  returns the detected type and the route persists it — but only while the
  stored value is still `'auto'`, never overwriting a user's explicit
  choice.
- **Phase 0 complete**: the `ClaudeGateway` seam and its live-call guard,
  the shots state machine with `pending_shots_payload` recovery, removal
  of the mount-time generate-on-empty-shots trigger in favor of
  `derivePhase()`, and a hardened fake-gateway test suite (see `##
  Provider calls` and `## Testing`). The delete-before-insert-existing-shots
  bug in `runShotsPipeline` was found during P0-5 — it was unreachable
  before the retry path existed, since a first-ever generation always ran
  against zero existing rows.

## Superseded
The old 4-step wizard (`script`/`voiceover`/`images`/`video`, driven by a
`WizardStep` type and its own `StepIndicator`) has been removed now that
intake and the 8-step workbench flow work end to end.
`/projects/[id]/script` redirected to `/projects/[id]/workbench` for
bookmarked URLs as a temporary shim; that redirect route has since been
deleted now that bookmark traffic has aged out.

Two loose ends left behind by the removal, both live in the codebase
today:
- `updateProjectTitle` in `projects/[id]/actions.ts` is unused, pending a
  workbench title editor.
- `/api/projects/[id]/prompts` kept its validation logic intact but lost
  its caller; it awaits new ones in Steps 4 and 6, where it will likely
  split into separate image-prompt and video-prompt routes.

## Current focus
- Shot editing: expand/collapse a shot card, edit voice_over / visual
  description / camera fields, duration stepper, delete
- Agent chat mutations on the workbench (composer is rendered but disabled
  today)
- Element upload/generation (reference images) from the Assets tab
- Step-guard navigation: gate step-to-step links on `furthest_step`, not
  just `current_step` position
- Expand `usage`: add `user_id`, `model`, and `status`; constrain `kind`
  to a fixed vocabulary covering the remaining steps
  (`shots` / `camera_derive` / `element_reference` / `voiceover` /
  `image_prompt` / `image_gen` / `video_prompt` / `clip_gen` /
  `assembly` / `social_metadata`). Then a per-user monthly cap checked
  server-side before any expensive call, and real data behind the Usage
  screen and Queue rail item.

## Open questions
- **Per-step model selection.** `projects.video_model` is a single column
  holding one model string, currently a placeholder. But model choice is
  per-step, not per-project: OpenAI models for image generation,
  ElevenLabs models for voiceover, fal.ai models for video clips. The
  schema needs to reflect that before Step 3 — likely a per-step model
  map on the project rather than one column — and `models.ts` needs to
  carry provider → model → `{ costPerUnit, ... }` plus, for video models,
  the clip-duration constraints (`durationMin` / `durationMax` /
  `durationStep`) that bound the workbench duration stepper.
- **Camera re-derivation trigger.** Editing `visual_description` should
  re-derive `shot_size`/`camera_angle`/`camera_movement` only while
  `camera_overridden` is false — but whether that fires automatically on
  save or behind an explicit user action is undecided. It costs a model
  call per save at production model tiers, multiplied across users.