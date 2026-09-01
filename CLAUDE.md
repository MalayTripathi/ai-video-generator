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
  `current_step: 'workbench'`, `furthest_step: 2`), before redirecting into
  `/projects/[id]/workbench`. It writes no `generations` row either — a
  brand-new project simply has none until its first claim (see Phase 1).
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
  sections are added when a step is built, not ahead of it.
- Pricing lives in `src/lib/config/pricing.ts`, separate from
  `models.ts` — the single place a rate is edited, and the single source
  of `computeCost`, which turns a provider's raw usage report into the
  `usage.estimated_cost`/`quantity`/`unit`/`raw_usage` figures — don't
  compute cost anywhere else. `RATE_VERSION` (a hand-bumped date string)
  is stamped onto every settled `usage` row so a past row's cost stays
  reconstructable even after rates change later. `pricing.ts` is
  deliberately client-importable (rates aren't secrets) and holds only
  Anthropic's real rates today — `openai`/`elevenlabs`/`fal` are stub
  shapes with no values yet, filled in as each provider is wired up.
- **Provider calls.** See `## Provider calls` below for the gateway seam,
  the live-call guard, and the Playwright guard. Never set, export, or add
  `ALLOW_REAL_CLAUDE` anywhere in the repo — that decision belongs to the
  developer, not the agent.
- Duration → shot-count/credit mapping lives in `src/lib/config/duration.ts`
  (`durationConfig`, keyed by `DurationTarget`) — the single source for
  `targetShots`/`estimatedCredits`. The intake duration tiles, shot
  generation, and `RetryConfirmModal`'s credit-cost copy all read from
  it; don't duplicate these numbers elsewhere. The same file exports
  `DEFAULT_DURATION_TARGET` (currently `'30-60s'`, the permanent product
  default, not a placeholder) — `intake-form.tsx`'s pre-selected tile reads
  from it rather than carrying its own literal, so intake tests assert
  against the constant instead of a hardcoded string. Every billed generation
  outside the initial `pending` trigger (i.e. every retry) is confirmed
  through that modal before the request fires.
- **`targetShots` is a hard ceiling, not a soft target.** Source text may
  request fewer shots than the tier's `targetShots` (honored as-is — a
  4-shot request on an 8-target tier correctly produces 4 shots), but never
  more. Enforced three ways: the tool schema (`buildWriteShotsTool(targetShots)`
  in `src/lib/prompts/shot-generation.ts` sets `maxItems` on the `shots`
  property — the primary enforcement, since it's a constraint the model
  can't exceed rather than an instruction it might weigh against the user's
  request); the system prompt (`SHOT_GENERATION_SYSTEM_PROMPT_V3` states the
  count is a hard maximum, and `buildShotsDynamicBlock` says "up to N shots
  (hard maximum)", not "about N" — belt-and-braces with the schema, not a
  substitute for it); and a non-blocking intake warning (`intake-form.tsx`
  runs a light client-side regex — a number immediately before "shot(s)"/
  "scene(s)" — against `source_text`, and shows an amber (`status-active`,
  never `status-failed`) hint when the detected count exceeds the selected
  tile's `targetShots`). The intake check warns rather than blocks because
  the heuristic has no semantic understanding and false-positives readily
  (a pasted screenplay's own prose describing its scene count, a mention of
  a reference video's shot count) — blocking a legitimate submission on a
  regex match would cost the user more than the warning is meant to save;
  it never touches `BuildButton`'s `disabled` state. Server-side,
  `runShotsPipeline` never silently truncates an over-count result even if
  the schema constraint is somehow exceeded (e.g. a payload recovered from
  before this constraint existed): the call is already paid for at that
  point, and dropping trailing shots would leave a story missing its
  ending, which is worse than a slightly long shot list — it persists the
  full array and logs a `[shots] over_count ...` warning with the project
  id, generation id, target, and actual count instead.
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
  request fires. It throws a typed `LiveCallsBlockedError` (`src/lib/claude.ts`),
  not a plain `Error` — `settleUsage` detects it by `instanceof`, never by
  message text (same principle as detecting a `23505` unique violation by error
  code), to settle a blocked local call at zero cost instead of the full
  pre-flight quote. See the `settleUsage` paragraph under `## Phase 1` in
  Database for the full pre-network-vs-unverifiable distinction.
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
  `console.warn`'d; `stop_reason` is also written onto the `usage` row by
  `settleUsage` (`src/lib/usage/reserve-settle.ts` — see the `usage`
  section under Database for the full reserve-then-settle lifecycle);
  `request_id` is still console-only, not persisted anywhere.

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
- **Auth in tests is `storageState`-first, not per-test `createTestSession()`.**
  Supabase's hosted auth rate-limits magic-link `verifyOtp` per project (roughly
  30/hour) — the old pattern of every test minting its own throwaway user made a full
  suite run consume ~45 of those in one go, so the suite itself exhausted the limit and
  every retry pushed the reset further out. `tests/global-setup.ts` now authenticates
  two **fixed, reused-across-runs** identities once per run — `primary` and
  `secondary` (idempotent get-or-create by a stable email, not a fresh UUID each time)
  — and writes each one's session to `tests/.auth/{name}.storageState.json` (a real
  Playwright storageState file, consumed via `playwright.config.ts`'s
  `use.storageState`, the default for every spec's `page`/`context`) and
  `tests/.auth/{name}.session.json` (raw `access_token`/`refresh_token`, for a spec that
  needs a Supabase client directly rather than a browser). `tests/.auth/` is gitignored
  — real (if throwaway-identity) tokens, never committed. `tests/fixed-users.ts` reads
  those files and exports `primary`/`secondary`; import from there, not
  `createTestSession()`, unless the spec is one of the exceptions below. A spec that
  needs `secondary`'s browser identity opts in with
  `test.use({ storageState: SECONDARY_STORAGE_STATE })`; none currently do, since the
  one multi-user spec builds its own scoped Supabase client instead of a browser context
  (see below) — the opt-in mechanism exists for a future one that would.
- **Specs assert against their own project's rows, not global per-user totals.**
  Because `primary`/`secondary` are persistent and accumulate `projects`/`shots`/
  `generations`/`usage` rows across every run forever (Task 3's explicit trade-off — no
  global truncate-between-runs step was added, since that would eventually run against
  real data), every spec using them scopes its assertions to the specific
  `project_id`/`generation_id`/row `id` it just created, never to "all of this user's
  rows." A handful of specs assert something that's *inherently* a global-per-user fact
  and so must keep their own fresh, never-attempted `createTestSession()` user instead
  of sharing `primary`/`secondary` — do not "fix" these by switching them to a fixed
  user:
  - `usage-page.spec.ts`'s RLS test (two users, since it's proving user A's row is
    invisible to user B — cannot share one identity for both sides of that check).
  - `usage-page.spec.ts`'s `/usage` empty-state test (needs a user with literally zero
    `usage` rows).
  - `new-project-intake.spec.ts`'s dashboard-empty-state-click test (the empty-state
    "New Project" CTA only renders when the user has zero `projects` rows).
  - `usage-module.spec.ts`'s `assertWithinAllowance` "exceeds the ceiling" test (asserts
    an exact row count for the user this month).
  - `usage-page.spec.ts`'s rail-spending test (asserts an exact dollar figure for "this
    user, this month" — same reason as the allowance-ceiling test above).
- Moving to a local Supabase instance (`supabase start`) is the eventual answer for full
  test isolation and zero shared rate limits — every run would get a clean database, and
  even the five fresh-user specs above could reuse a fixed identity. Deliberately not
  done here; this fix keeps the suite on the shared hosted dev project but cuts its auth
  load from ~45 `verifyOtp` calls per run to 8 (2 fixed identities + the five specs
  above, one of which needs two).
- **`primary`/`secondary` accumulate `projects`/`usage` rows every run** (every spec
  that shares them creates fresh, project-scoped rows under their user ids — see above),
  so `tests/global-teardown.ts` (wired via `playwright.config.ts`'s `globalTeardown`)
  deletes them at the end of the run. It is deliberately a `globalTeardown`, not
  `afterEach`: the suite runs at full parallelism
  (`playwright.config.ts`'s `fullyParallel: true`), so per-test cleanup of the *shared*
  fixed users' data would delete rows another in-flight test is still asserting against
  — only a single pass after every test has finished is safe. It reads
  `primary`/`secondary` from `tests/fixed-users.ts` — the same module every spec
  imports — so the ids it deletes by can never drift from the ones `global-setup.ts`
  minted; it never deletes by pattern or truncates a table. It deletes **`usage` rows
  first, explicitly**, `WHERE user_id IN (...)`, before deleting `projects`: unlike
  every other child table, `usage.project_id` is `ON DELETE SET NULL`, not `CASCADE`
  (see the `usage` section under Database), so deleting `projects` first would only null
  out `usage.project_id` on the fixed users' rows rather than remove them, and they'd
  accumulate forever. Deleting `projects` after that cascades `shots`/`generations`/
  `elements`/`shot_elements` normally. The two fixed auth users themselves are never
  deleted — they're reused every run. A teardown failure is `console.error`'d and
  swallowed, never rethrown: a cleanup failure must not turn a green suite red, and by
  the time teardown runs the suite's actual pass/fail result is already determined. The
  four fresh-user specs above are unaffected by any of this — they still clean up their
  own `createTestSession()` user via `deleteTestUser()` in their own `finally` block,
  same as before; teardown has no way to know their ids, and doesn't need to, since each
  one is unique to its own test and can't collide with another in-flight test under
  parallelism the way the shared fixed users could.

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
payload, written before any derived rows — the same persist-before-writing
discipline the now-dropped `projects.pending_shots_payload` used to
enforce), `error`,
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

`src/lib/generations/claim.ts` is the one module that reads or writes
`state`/`payload`/`started_at`/`error` — every claimant goes through
`claimGeneration`/`persistGenerationPayload`/`settleGeneration`; nothing
writes those columns inline. `claimGeneration({ supabase, identity, retry
})` implements the insert-to-claim algorithm: a plain `INSERT` (state
`'generating'`) claims a never-attempted identity outright; a `23505`
unique violation (detected by Postgres error code — see `isUniqueViolation`
in `shot-key.ts`, reused here rather than string-matching the message)
means a row already exists, and the function reads it and branches on
`state`: `'succeeded'` refuses with `already_ready`; `'failed'` without
`retry` refuses with `retry_required`; `'generating'` refuses with
`already_generating` unless `started_at` is older than `STALE_AFTER_MS`
(now defined in `claim.ts`, not `shots/logic.ts` — see below); `'failed'`
with `retry`, a stale `'generating'`, or a `'pending'` row (only possible
via backfill, for a project that was never attempted) are all
reclaimable. Every reclaim is a **conditional `UPDATE`** filtered on the
exact state it expects (`.eq('state', <expected>)`, plus a staleness
bound for the `'generating'` case) — if it affects zero rows, another
caller reclaimed first, and the loser is refused with `already_generating`
uniformly regardless of which state it was racing from (this reproduces
the old single-atomic-UPDATE claim's behaviour exactly: any race loser's
follow-up read would, by the time it read, always see `'generating'` — the
winner's write). A reclaim never touches `payload` — a stale or failed row
may already carry one Claude was paid for, and RECOVER must still see it.

**The `ready` → `succeeded` rename happens in exactly one place**:
`settleGeneration`'s success branch writes `state: 'succeeded'`; every
other state name (`pending`/`generating`/`failed`) is unchanged between
the old `projects.shots_generation` vocabulary and this one.
`settleGeneration` also always clears `payload` on success unconditionally
(it was only ever a recovery aid for an in-flight or failed attempt), and
clears it on failure only when the caller explicitly asks (the
`max_tokens` truncation case) — otherwise a failed row's payload survives
for RECOVER, same as before.

`generations` is used by both `/shots` (`step: 'workbench'`, `operation:
'generate_shots'`, `shot_id: null`) and, as of Phase 1 prompt 3, `/prompts`
(`step: 'image_prompts'`, `operation: 'write_prompts'`, `shot_id: null`) —
see the claim → recover → persist → settle description below.
`claimGeneration`/`persistGenerationPayload`/`settleGeneration` are now
the **only** locking mechanism in the codebase; `generation-lock.ts` and
its `projects.generating_at`-only CAS lock (`acquireGenerationLock`/
`releaseGenerationLock`) are deleted, and the `generating_at` column is
dropped. See "`/prompts`'s step attribution is provisional" below for why
`image_prompts` is the wrong long-term home for half of what this route
does.

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
`updated_at`. `estimated_cost` is computed by `computeCost` from
`src/lib/config/pricing.ts` — never inline a second cost calculation.

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

**As of Phase 1 prompt 4, `logClaudeUsage` no longer exists.** `usage`
rows are written by `src/lib/usage/` (`reserveUsage`/`settleUsage`/
`assertWithinAllowance`), called *around* the gateway call rather than
after it: `assertWithinAllowance` → `reserveUsage` →
`gateway.createMessage` → `settleUsage` (in a `finally`).

`reserveUsage` runs BEFORE the gateway call and writes `status: 'pending'`
with `estimated_cost` set to a deliberately worst-case pre-flight quote —
estimated input tokens (a crude chars/4 heuristic, `src/lib/usage/quote.ts`)
at the input rate, plus the full `max_tokens` ceiling at the output rate.
A reservation built this way can never be overrun by the real call, which
is exactly why pending rows are safe to sum into a spend cap (see
`assertWithinAllowance` below) — the number can only move down at settle,
never up. **If the INSERT fails, `reserveUsage` throws** before the
gateway is ever called: calling Claude without a reservation row would be
exactly the unguarded spend this replaces.

**As of Phase 1 prompt 6, `estimateInputTokens` counts everything actually
sent to the model**, not just the system-prompt text: the system prompt,
the literal user message, and the serialised tool schema JSON —
`JSON.stringify`'d from the same `tools` array the call passes to the
gateway, so it can't drift out of sync as a schema grows; never a
hardcoded size. A fixed `TOOL_USE_SYSTEM_OVERHEAD_TOKENS` constant
(`src/lib/config/pricing.ts`, currently `300` — an approximation, not a
measurement, to be refined against more data) is added on top, since
Anthropic's tool-use system overhead isn't proportional to any text sent
and so doesn't belong in the chars/4 math. The chars/4 heuristic itself is
kept (JSON is punctuation-dense and likely tokenises at fewer than 4
chars/token, so the schema portion may still run a little low — a
remaining bias to check with more data points, not a reason to add a
network round trip to `count_tokens` before every call).

This closes a real, measured gap: the first live shot-generation call
quoted input 536 / output 4000 ($0.020536) against an actual input of
1814 / output 1009 ($0.006859) — a 3.4x under-estimate, almost entirely
the excluded `write_shots` tool schema (`JSON.stringify([WRITE_SHOTS_TOOL]).length`
was 2396 chars on its own). Recomputing that same call's quote with the
new formula lands around 1442 tokens against the actual 1814 — the
remaining gap (~372 tokens, vs. the old 1278) is consistent with the
chars/4-on-JSON bias noted above, not a new omission.

`usage.quoted_cost` is the immutable half of that pre-flight quote:
`reserveUsage` writes it once, alongside `estimated_cost`, and
`settleUsage` never writes it under any status or breakdown outcome — no
branch of its `update` object references the column, and a comment on
that function says so explicitly so a future edit doesn't add it by
habit next to `estimated_cost`. `estimated_cost` keeps its name even
after settle overwrites it with a measured cost, because it is still a
list-price figure computed from token counts, not a provider invoice —
that naming is deliberate and load-bearing in the `/usage` UI copy,
where every section is labelled "estimated" for exactly this reason.
Because `quoted_cost` never moves, `(estimated_cost - quoted_cost)`
stays a valid calibration delta after settle — surfaced as the
"Estimate calibration" line in `/usage`'s Anomalies section — and is
the evidence behind the `estimateInputTokens` fix above and behind
wherever `SPEND_CAP_MONTHLY_USD` should actually be set, rather than
that ceiling staying a guess indefinitely. `quoted_cost` is nullable
with no backfill (added after `estimated_cost` already existed in
production), so the calibration figure is computed only over rows that
have one — **and, as of Phase 1 prompt 6, only over rows that aren't
blocked** (`aggregate.ts`'s `buildCalibration`). A blocked row settles
at `estimated_cost: 0` by design (see the `settleUsage` paragraph
below), so its ratio against a nonzero `quoted_cost` is always 0 and
would drag the calibration mean toward zero for a call that was never
actually measured — the same exclusion the settled total and the
per-step call count already applied to blocked rows now applies to
calibration too, consistently.

`settleUsage` runs in a `finally`, so it runs on success, on a thrown
exception, and on `max_tokens` truncation alike, and each case settles
differently: on success it overwrites `estimated_cost` with the measured
cost and writes `quantity`/`unit`/`raw_usage: { breakdown, rates }`/
`stop_reason`; on `max_tokens` it settles `status: 'failed'` with
`stop_reason: 'max_tokens'` and a cost measured from the real (truncated)
usage — truncation is billed in full, so the measured number is the true
one; on a throw with partial usage data available (Claude responded but a
later step failed) it settles `failed` with the cost measured from what's
known; on a throw with NO usage data at all (the gateway call itself
threw), the settle branch depends on WHEN the throw happened, not merely
that it happened. A throw *verified* to have occurred before any request
reached the provider — today, exactly `LiveCallsBlockedError` from
`assertLiveCallsAllowed()` (identified by `instanceof`, never by message
text — see Provider calls) — is provably unbilled, so it settles `failed`
with `estimated_cost: 0` and `raw_usage: { blocked: true, billed: false,
reason: <message> }`. Every other throw with no usage data (a network
failure, stream error, or timeout after the request already left the
process) is unverifiable, not provably harmless, and keeps the old
behavior: it settles `failed` but **retains the pre-flight quote** as
`estimated_cost` instead of overwriting it, and records in `raw_usage`
that the cost is unmeasured — over-counting is the safe direction for a
spend cap to be wrong in. **This is a single, deliberately narrow
exception, not a pattern** — do not add a second branch for a throw
that merely seems unlikely to have been billed; only a throw that is
structurally guaranteed to precede the network call qualifies. A blocked
row still shows in `/usage`'s Anomalies as a failed row (a real failure
worth seeing), but is excluded from `byStep`/`byProject`'s `callCount` —
a blocked call was never a call — via `UsageRow.blocked`, derived from
`raw_usage.blocked` in `page.tsx` and filtered out in `aggregateUsage`
(`src/app/(app)/usage/aggregate.ts`). **`settleUsage` never throws**: if its own
UPDATE fails, it `console.error`s with the usage id and leaves the row
`'pending'` — by that point the money may already be spent, and failing
the request now would lose the user's work on top of it. **A `usage` row
stuck `'pending'` is therefore the deliberate signal for a call that died
mid-flight**, not a bug to paper over. This asymmetry (reserve throws /
settle never throws) is spelled out in `src/lib/usage/reserve-settle.ts`'s
module docblock and must not be "tidied" into symmetry later.

Both `/api/projects/[id]/shots` (`step: 'workbench'` / `operation:
'generate_shots'`) and `/api/projects/[id]/prompts` (`step:
'image_prompts'` / `operation: 'write_prompts'`) pass their claimed
`generations` row's `id` into `reserveUsage`, so both carry
`generation_id`. Neither reserves/settles usage on the RECOVER path or
(prompts only) the "nothing needs generating" path, since neither spends
anything there. `src/lib/config/pipeline.ts` is the single source for the
`step`/`operation`/`provider` vocabulary these columns use — see
Conventions. Every new provider call must go through
`reserveUsage`/`settleUsage`, never a direct `usage` insert.

`assertWithinAllowance` (`src/lib/usage/allowance.ts`) is called
immediately before `reserveUsage` and enforces a per-user monthly spend
ceiling by summing `estimated_cost` over the user's `usage` rows for the
current calendar month — pending rows count, which is the whole reason
they carry the quote. **It is wired but disabled by default**: off, it
performs zero queries, gated by the `SPEND_CAP_ENABLED` env flag (default
unset/off; the ceiling itself is `SPEND_CAP_MONTHLY_USD`, default $100).
When enabled and a quote would exceed the ceiling, it throws
`AllowanceExceededError`, which both routes' `catch` blocks map to a
`402` response (Payment Required — not `429`, which would invite retry
logic that can't succeed until the period resets, and would be
indistinguishable from a real rate limit in logs). Flipping
`SPEND_CAP_ENABLED=1` on is a product decision for whoever owns spend
policy, not implied by this change.

With this, all four mechanisms behind the original unexplained-spend
incident are closed: the gateway-seam live-call guard (Phase 0), the
`generations` claim replacing the old CAS lock (Phase 1), the
`ready`→`succeeded`/payload-recovery contract (Phase 1), and now
reserve-then-settle usage logging replacing `logClaudeUsage`'s
log-only-after-success-and-swallow-failure behavior (Phase 1 prompt 4).

**As of Phase 1 prompt 2, `projects.shots_generation` and
`projects.pending_shots_payload` no longer exist.** The shot-generation
claim/state lives entirely in the `generations` row identified by
`(project_id, step: 'workbench', operation: 'generate_shots', shot_id:
null)` — one row per project, created by that project's first claim
attempt (a brand-new project has none until then). `state` is
`pending`/`generating`/`succeeded`/`failed` (see the Phase 1 section
above for the full claim algorithm and the `ready` → `succeeded` rename);
`payload` plays the role `pending_shots_payload` used to; `started_at`
plays the role `generating_at` used to.

A `/api/projects/[id]/shots` request runs the same strict **claim →
recover → persist → settle** order as before (`runShotGeneration` in
`src/app/api/projects/[id]/shots/logic.ts`), now built on
`src/lib/generations/claim.ts` instead of a bespoke `projects` UPDATE.
**Claim**: `claimGeneration` (see Phase 1 above) is both the lock and the
idempotency guard; a `blocked` outcome is a refused claim (409, with
`reason: 'already_ready' | 'already_generating' | 'retry_required'`),
never a partial attempt — the project's own fields (`source_text`,
`video_type`, `language`, `duration_target`, `title`) are loaded in a
separate `SELECT` *before* the claim, so a vanished/unowned project
returns 404 without needing to interpret an RLS/FK error off the claim
`INSERT`. **Recover**: if the claimed row already carries a non-null
`payload`, the gateway is never called — the stored payload is replayed
through the same parse → resolve-elements → insert pipeline.
**Persist**: on a fresh call, the raw `write_shots` tool_use input is
written to the row's `payload` via `persistGenerationPayload`
immediately after the Claude call returns, before any `shots` row is
inserted. **Settle**: a `finally` block runs on every exit path including
a thrown exception, calling `settleGeneration` — success writes
`succeeded` and always clears `payload`; failure writes `failed`, leaving
`payload` intact for later recovery — except a `max_tokens` truncation,
which also settles `failed` but always clears the payload, since a
truncated answer was never "returned successfully" in the sense this
contract requires. `reserveUsage`/`settleUsage` are passed the claimed
row's `id` as `generationId`, so the resulting `usage` row carries
`generation_id` (see the `usage` section above for the full
reserve-then-settle lifecycle, which runs independently of this
claim/recover/persist/settle sequence).

**A generations row with a non-null `payload` means Claude has already
been paid for; recovery replays it and never re-calls.**

A retry or recovery run replaces the shot list wholesale: `runShotsPipeline` deletes all
existing `shots` rows for the project (cascading `shot_elements`, which has `ON DELETE
CASCADE` on both foreign keys) immediately before inserting the fresh/replayed batch,
always sequenced after the payload is already durably persisted — a crash
between the two still leaves the payload intact for the next retry to recover from.
`elements` are never deleted: they're project-level and deduped by name, so
`resolveElement` re-matches existing rows (including any reference image already
generated) on replay instead of creating duplicates. This is what makes the
confirmation modal's "existing shots will be replaced" copy true rather than aspirational.

`/prompts` runs the identical claim → recover → persist → settle sequence
(`runPromptGeneration` in `src/app/api/projects/[id]/prompts/logic.ts`,
`step: 'image_prompts'`, `operation: 'write_prompts'`, `shot_id: null`) as
of Phase 1 prompt 3 — there is no second variant of the claim helper, and
no route left on the old `generation-lock.ts` CAS lock. Unlike `/shots`,
`/prompts` claims unconditionally even when nothing needs generating (a
call where every shot already has usable prompts still claims, finds
nothing to do via `runPromptsPipeline`'s empty target set, and settles
`succeeded` with no payload and no Claude call) — this is a deliberate
behavior change from the old lock, which was freely re-callable forever;
a `/prompts` call after `succeeded` now needs `retry: true`, same as
`/shots`. Recovery/derived-write semantics differ from `/shots` in one
respect: `runPromptsPipeline` only `.update()`s the specific shots
Claude was asked about — there is no wholesale delete-and-reinsert, since
prompts are a field on an existing shot, not the shot itself. The
422-on-partial-failure guarantee (see Done log) is now enforced by the
claim/recover contract, not a CAS lock: a non-truncation 422 (some
requested shot_keys came back missing) leaves `payload` intact for
recovery — mirroring `runShotsPipeline`'s own "nothing usable" 422, which
also doesn't clear its payload — while a `max_tokens` truncation clears
it, identically to `/shots`.

**`/prompts`'s step attribution is provisional and is a blocker for Step
4.** The route's `write_prompts` tool call requires both `image_prompt`
and `video_prompt` for every requested shot in one Claude call — a
leftover from an older step ordering where this was a single step. In the
current 8-step pipeline these are Steps 4 and 6, separated by Step 5
(storyboard), so one undivided call is wrong on the merits, not just on
attribution: video prompts get written before the image exists and so
can't reference it; they go stale by Step 6 once storyboard retiming
happens and must be regenerated at additional cost; and the user pays for
video prompts at Step 4 that they may never reach if they abandon at Step
5. **Before Step 4 (Image Prompts) ships, `/api/projects/[id]/prompts`
must be split into separate image-prompts and video-prompts routes, each
with its own claim (`image_prompts`/`write_prompts` and
`video_prompts`/`write_prompts`). Until then the single route is
provisionally attributed to `image_prompts`, which under-reports Step 6
spend as zero. This is a prerequisite for Step 4, not a Phase 3
consistency task.** The route has no frontend caller today (see
Superseded), so nothing is corrupted by the provisional attribution yet —
but it must not ship to real users unsplit.

The workbench shot list derives its UI phase from the `generations` row's
`state` + `shots.length`, not `shots.length` alone (`shots-context.tsx`):
no row, or `state: 'pending'` → `trigger` (fires the auto-POST once); `
'generating'` → `generating` (skeleton, polls via `router.refresh()`
every 3s so a passive tab picks up another tab/device's result);
`'succeeded'` with shots → `list`; `'succeeded'` with zero shots →
`failed` (defensive, never auto-retried); `'failed'` with zero shots →
`failed`; `'failed'` with saved shots → `partial` (renders the saved list
with a cut-short warning banner, not a silent success). This table lives
in `derivePhase()` (`derive-phase.ts`) as a pure function of
`(generation: { state: string } | null, shotCount)` — a missing row and
`state: 'pending'` collapse to the same `trigger` output, matching what
the old absent/unrecognized-status fallback produced. The client never
triggers generation off a raw `shots.length === 0` check — the only
trigger is `derivePhase()` returning `'trigger'`, fired once via a ref
guard in `ShotsProvider` (`shots-context.tsx`), so a project that
legitimately has zero shots for another reason can never re-fire
generation. Retry is gated behind `RetryConfirmModal`
(`retry-confirm-modal.tsx`), which states the credit cost from
`durationConfig` when the row's `payload` is null, or that
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
  does not advance `current_step`, enforced by the same claim/recover
  contract `/shots` uses (`step: 'image_prompts'`, `operation:
  'write_prompts'` — see Database's `generations` section, and its
  provisional-attribution blocker note). As of Phase 1 prompt 3 the raw
  Claude payload is persisted before any `shots.update()` (previously it
  wrote straight from the in-memory response — a real crash-safety
  improvement, not just a lock swap). Prompt caching is wired but inert
  (see Conventions).
- Double-submit guards on prompt generation and project creation.
  `/prompts` claims via `claimGeneration` (see Database) before doing any
  work and settles in a `finally` on every exit path; a concurrent request
  gets a 409, and a stale claim (crashed/killed request) self-heals after
  15 minutes (tied to the real gateway's 600s SDK timeout plus margin, see
  `claude.ts`) rather than wedging the project. The intake screen's
  `BuildButton` disables itself via `useFormStatus` while
  `createProjectFromIntake` is in flight.
- Step 2 Workbench (`/projects/[id]/workbench`): built on
  `workbench-shell.tsx` (see Conventions), read-only shot list. On first
  load while its `generations` row is absent or `state: 'pending'`, the
  client triggers `POST /api/projects/[id]/shots`, which runs the claim →
  recover → persist → settle sequence (see Database) via `runShotGeneration`
  in `src/app/api/projects/[id]/shots/logic.ts` — one `write_shots` Claude
  tool call (system prompt in `src/lib/prompts/shot-generation.ts`, target
  shot count from `durationConfig`), persisting
  shots/elements/`shot_elements`/dialogue, guarding the `projects.title`
  write (only if still null), inserting an `assistant` message, and
  logging a `usage` row — driven entirely by the `generations` row's
  `state`/`payload` (see Database; `/prompts` runs the identical
  claim/recover/persist/settle contract as of Phase 1 prompt 3). Shot cards are grouped by `section_label`,
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
- **Phase 1 complete**: the `generations` table and insert-to-claim
  (`claimGeneration`/`persistGenerationPayload`/`settleGeneration`) are
  now the one locking mechanism in the codebase — the old
  `acquireGenerationLock`/`releaseGenerationLock` CAS lock and
  `projects.generating_at` are deleted. The `usage` table was dropped and
  recreated with a provider-neutral shape and reserve-then-settle logging
  (`reserveUsage`/`settleUsage` in `src/lib/usage/`, replacing
  `logClaudeUsage`'s log-only-after-success-and-swallow-failure
  behavior) — see the `usage` section under Database for the full
  mechanism. `src/lib/config/pricing.ts` (`computeCost`, `RATE_VERSION`)
  is the single place a rate is edited and cost is computed.
  `assertWithinAllowance` (a per-user monthly spend ceiling) is wired
  into both `/shots` and `/prompts` but disabled by default
  (`SPEND_CAP_ENABLED`). The `/usage` page (`src/app/(app)/usage/`)
  makes all of this visible: spend grouped by step and by project for a
  selected period, with settled/pending spend kept separate and a
  dedicated anomalies section for stuck-pending, blocked, and genuinely
  failed rows (each its own line, shown only when its count is non-zero —
  blocked and failed are deliberately separate lines with different copy,
  since a blocked call cost nothing and a failed one was billed for what
  was used), plus an estimate-calibration line (mean quoted-vs-actual
  delta and ratio, `usage.quoted_cost`, excluding blocked rows so a
  never-billed call can't drag the mean toward zero) diagnosing the spend
  estimate itself. **All four mechanisms behind the original
  unexplained-spend incident are now closed**: the gateway-seam live-call
  guard (Phase 0), the `generations` claim replacing the old CAS lock, the
  `ready`→`succeeded`/payload-recovery contract, and reserve-then-settle
  usage logging. As of Phase 1 prompt 6, `estimateInputTokens` also counts
  the serialised tool schema and user message (not just the system
  prompt), closing a measured 3.4x input under-estimate (see the
  `reserveUsage` paragraph under Database), and the rail
  (`(app)/dashboard/rail.tsx`) shows real settled, non-blocked spend for
  the current calendar month under "Usage spending" (not a credits
  figure — there is no credit system), linking to `/usage`; it's sourced
  from `aggregateUsage` via a request-memoized `getUsageRows`
  (`usage/data.ts`, wrapped in React's `cache()`) so the shared layout and
  the `/usage` page itself don't double-query when both render in the same
  request.

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
- **Blocker for Step 4**: `/api/projects/[id]/prompts` must be split into
  separate image-prompts and video-prompts routes before Step 4 ships —
  see the "step attribution is provisional" note in Database's
  `generations` section for why the current single-call design
  under-reports Step 6 spend. Not a Phase 3 consistency task; a
  prerequisite.
- `/shots` and, as of Phase 1 prompt 3, `/prompts` are both migrated onto
  `generations` (see Database) — `claimGeneration` /
  `persistGenerationPayload` / `settleGeneration` are the only locking
  mechanism left in the codebase.
- Shot editing: expand/collapse a shot card, edit voice_over / visual
  description / camera fields, duration stepper, delete
- Agent chat mutations on the workbench (composer is rendered but disabled
  today)
- Element upload/generation (reference images) from the Assets tab
- Step-guard navigation: gate step-to-step links on `furthest_step`, not
  just `current_step` position — blocked on `furthest_step` actually
  being live-tracked (see Phase 2 open items below).
- The actual product decision on when/whether to flip
  `SPEND_CAP_ENABLED` on is still open — Phase 1 only wired the
  mechanism (see `## Phase 1` in Database and the `/usage` page).
  The Queue rail item is still visual-only, pending real data.
- Agent chat turns deliberately get a `usage` row but no `generations`
  row — there's no "claim" concept for a chat turn the way there is for a
  generation, so nothing would hold that claim. Accepted consequence: a
  page refresh mid-turn can cause the turn to re-fire and be billed
  twice. Known, accepted gap, not an oversight — revisit when C4 (the
  agent-turn work) is built.
- **Going into Phase 2, four open items carried over from Phase 1:**
  - `current_step` has no DB CHECK constraint (unconstrained text,
    app-code-enforced only) — unlike `aspect_ratio`/`duration_target`/
    `video_type`, which do have one.
  - `furthest_step` is written once, at project creation
    (`createProjectFromIntake`, `= 2`), and never incremented anywhere
    else in the codebase — step-guard navigation (above) can't gate on it
    until something advances it as a project progresses.
  - `/prompts` advances `current_step` straight to `'voiceover'`
    (`runPromptGeneration`), skipping storyboard/video_prompts — a
    leftover of the pre-8-step single-call design, the same root cause as
    the provisional step-attribution issue in the `generations` section
    under Database.
  - The `/prompts` split blocker before Step 4 (see Database's
    `generations` section and the Current focus bullet above) — not yet
    closed.

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