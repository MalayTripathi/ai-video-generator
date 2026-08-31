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
- `src/lib/config/pipeline.ts` is the single source for the pipeline's
  step/operation/provider vocabulary: `STEPS`/`Step`, `OPERATIONS`/
  `Operation`, `PROVIDERS`/`Provider`, the `STEP_OPERATIONS` map of which
  operations are valid per step, and `stepOperationLabel(step, operation)`
  for rendering a pair as copy (e.g. "Workbench — New shots"). The
  `generations` and `usage` tables' `step`/`operation`/`provider` CHECK
  constraints mirror these arrays by hand — Postgres can't import a TS
  module, so update both migrations' CHECK lists whenever this file's
  arrays change. **Users must never see a raw step/operation value or a
  provider/model name anywhere in the UI** — `stepOperationLabel` is the
  only sanctioned renderer.
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
  size (2048 Haiku / 1024 Sonnet), so no cache entry is created and the
  `cache_creation_input_tokens` / `cache_read_input_tokens` buckets inside
  `usage.raw_usage.breakdown` log as 0. Don't pad prompts to reach the
  threshold. It will activate on its own as prompts grow — the workbench
  agent's system prompt plus tool schemas plus shot index will clear it
  comfortably.
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
  `console.warn`'d; the `usage` table now has a `stop_reason` column
  (Phase 1), but neither `logClaudeUsage` call site writes `stopReason`/
  `requestId` into it yet — the column exists, the wiring doesn't.

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
`shot_elements`, `messages`, `generations`, `usage`. All RLS-protected.
Two tables deviate from the single-level `exists`-on-`projects` subquery
every other child table (including `generations`) uses for ownership:
`shot_elements` resolves ownership through a two-level join (shots →
projects); `usage` resolves ownership through a `user_id` column
denormalized directly onto the row, with `projects`-style per-command
policies (`user_id = auth.uid()`, split into SELECT/INSERT/UPDATE) rather
than a join — see `usage`'s own paragraph below for why. Private
`artifacts` Storage bucket.

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

## Phase 1: `generations` and the recreated `usage`

`generations` holds claim/lock state for every operation that fires a
paid external API call — the general-purpose replacement for the `jobs`
table, which was pre-provisioned for Step 7 clip generation but never
used by any code path (confirmed empty before being dropped). It's a
table rather than per-step columns on `projects` because Step 7
regenerates individual clips per shot: a project-level column can't
express "this one shot's clip is mid-generation while the others are
idle," but a `shot_id`-scoped `generations` row can (`shot_id` is null
for a project-level operation, e.g. `write_prompts`). Columns: `id`,
`project_id`, `shot_id`, `step`, `operation`, `state`
(`pending`/`generating`/`succeeded`/`failed`), `payload` (raw provider
payload, written before any derived rows — the same
persist-before-writing discipline as `pending_shots_payload`), `error`,
`external_id` (fal.ai's async polling handle; null for every other
provider), `started_at`, `created_at`, `updated_at`.

The table implements an **insert-to-claim** pattern: a row's mere
existence at a given `(project_id, step, operation, shot_id)` identity
*is* the lock, established by inserting it; a second write later settles
the same row (`state` → `succeeded`/`failed`). This is why its RLS policy
set is explicit `SELECT`/`INSERT`/`UPDATE` (not just `SELECT`/`INSERT`) —
without the `UPDATE` policy, the settle write fails silently under RLS.
The uniqueness guard is `generations_identity_idx`, a unique index on
`(project_id, step, operation, shot_id)` with **`NULLS NOT DISTINCT`**
(Postgres 15+; this project runs 17.6) — load-bearing, because without it
Postgres treats every null `shot_id` as distinct, and two concurrent
project-level claims (e.g. two `write_prompts` calls with no `shot_id`)
for the same `(step, operation)` would both succeed instead of the second
being rejected by the index.

**`generations` is currently unused by all application code.** Nothing in
this codebase reads or writes it yet — the shots route still runs
entirely on `projects.shots_generation`/`pending_shots_payload` (see
below), and `/prompts` still uses `generation-lock.ts`'s plain
`generating_at`-only CAS lock. Migrating either route onto `generations`
is future work, not done in Phase 1.

`usage` is the model-spend ledger, one row per provider call — dropped
and recreated in Phase 1 with a provider-neutral shape; its old rows were
discarded deliberately (they predate the Phase 0 fixes and are known
under-counts — no `user_id`, no `model`, no `status`). Columns: `id`,
`user_id`, `project_id` (nullable, `ON DELETE SET NULL`), `generation_id`
(nullable, `ON DELETE SET NULL`), `message_id` (nullable, `ON DELETE SET
NULL`), `shot_id` (nullable, `ON DELETE SET NULL`), `step`, `operation`,
`provider`, `model`, `status` (`pending`/`succeeded`/`failed`),
`stop_reason`, `quantity`, `unit`, `raw_usage` (jsonb —
`{ breakdown: <provider's own numbers>, rates: <rates applied> }`),
`rate_version`, `estimated_cost numeric(12,6)`, `created_at`,
`updated_at`. `estimated_cost` is computed by `estimateClaudeCostUsd` from
`src/lib/config/models.ts` — never inline a second cost calculation.

`user_id` is denormalized directly onto the row on purpose: `project_id`
is nullable `ON DELETE SET NULL` specifically so billing history survives
project deletion, and `usage`'s RLS policy follows that — ownership is a
direct `user_id = auth.uid()` check (SELECT/INSERT/UPDATE, `projects`-
style), not the join-through-`projects` pattern every other child table
uses, because a join-based policy would deny a user access to their own
orphaned billing rows the instant a project is deleted. The INSERT
policy's `project_id`-ownership `exists` check is a **data-integrity**
guard, not a security one (`user_id = auth.uid()` alone already fully
secures the row) — it guarantees that when `project_id` is set, it
actually belongs to the inserting user, so a future "cost per project"
query joining `usage` to `projects` stays meaningful.

`generation_id` and `message_id` are independent dimensions, not
alternatives — a row may carry both (an agent turn that triggers a
claimed operation), either, or neither. `message_id` is a grouping key
only and must never appear in a unique constraint, since multiple `usage`
rows may legitimately share one agent-chat message.

`estimated_cost` is **reserve-then-settle, not null-then-populate**:
written on INSERT with the pre-flight quote, then overwritten on settle
with the measured cost — `status` distinguishes the two (`pending` =
quoted, `succeeded`/`failed` = measured). It is never null while `status
= 'pending'`. This matters because a per-user spend cap is coming, and it
will sum `estimated_cost` over the user's current period to enforce it —
if pending rows carried null, in-flight spend would be invisible to that
sum and two concurrent expensive operations could both pass the check and
both bill. The pending row is a reservation, not a placeholder; don't let
this get "simplified" to null-until-settled later.

A `max_tokens` truncation is not its own status: it settles as `status:
'failed'` with `stop_reason: 'max_tokens'` — `stop_reason` is data, never
a status value.

Two routes write to `usage` today: `/api/projects/[id]/shots` logs
`step: 'workbench'` / `operation: 'generate_shots'` after the
`write_shots` call, and `/api/projects/[id]/prompts` logs `step:
'image_prompts'` / `operation: 'write_prompts'` after `write_prompts`.
Both still only insert once, always with `status: 'succeeded'`, after a
successful Claude response — `logClaudeUsage` (`src/lib/claude.ts`)
hasn't been restructured onto the reserve-then-settle lifecycle described
above, and it still logs only after success and swallows its own insert
failure. Fixing that is future work. `src/lib/config/pipeline.ts` is the
single source for the `step`/`operation`/`provider` vocabulary these
columns use — see Conventions. Every new provider call must log a `usage`
row.

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
- `usage`'s column expansion (`user_id`, `model`, `status`, and a
  constrained `step`/`operation` vocabulary) is done as of Phase 1 (see
  `## Phase 1` in Database). Still open: a per-user monthly spend cap
  checked server-side before any expensive call (reading `estimated_cost`
  summed over the user's current period — this is exactly why that column
  is reserve-then-settle, never null while pending), and real data behind
  the Usage screen and Queue rail item.
- Agent chat turns deliberately get a `usage` row but no `generations`
  row — there's no "claim" concept for a chat turn the way there is for a
  generation, so nothing would hold that claim. Accepted consequence: a
  page refresh mid-turn can cause the turn to re-fire and be billed
  twice. Known, accepted gap, not an oversight — revisit when C4 (the
  agent-turn work) is built.

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