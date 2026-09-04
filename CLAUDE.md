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
- **The canvas must be opened and read via the Claude Design MCP tools
  before any UI work in this repo — never assumed from a prior session's
  claim to have read it, and never built from a prose description of it.**
  C3's shot-card presentation was built exactly that way (from descriptions,
  not the canvas) across its first three prompts, and had to be rebuilt
  wholesale once the canvas was actually opened — see the "C3 presentation
  rebuild" entry under Done. The canvas can also contain more than one
  vintage of a component's spec (an older section reflecting a schema that
  has since changed, alongside a newer authoritative one) — check for a
  superseding section before treating any single frame as current.
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
- **Video-model duration registry.** `src/lib/config/models.ts` also
  exports `VIDEO_MODELS` (added C3 prompt 1) — a registry keyed by
  `VideoModelId`, each entry an internal identifier, a user-facing
  `label`, and `durationMin`/`durationMax` in fractional seconds — for
  the Step 2 duration stepper to clamp against (built C3 prompt 2).
  `DEFAULT_VIDEO_MODEL` is `'mochi-1'` (`Mochi 1`, 1.4s – 5.4s), and
  `modelsConfig.video.model`'s default now derives from it
  (`VIDEO_MODELS[DEFAULT_VIDEO_MODEL].id`) rather than the old hardcoded
  `'Kling 2.1'` literal — `actions.ts`'s intake-creation fallback is the
  only reader, unchanged in shape. `ProjectHeader`'s model chip resolves
  `project.video_model` through this registry for its label, falling
  back to the raw stored value for a project created before the registry
  existed. This registry is additive to `modelsConfig` (a different
  axis — provider-call config vs. a duration-bounds catalog); adding a
  model is one entry here, not edits scattered across several places.
  **C3 prompt 2 added `'Kling 2.1'` itself** (`durationMin: 5,
  durationMax: 10`), sourced directly from fal.ai's own API docs for
  `fal-ai/kling-video/v2.1` (standard/pro/master all agree) rather than
  invented — the key is the literal `'Kling 2.1'` string (Title Case,
  with a space), not a kebab-case slug, because it has to match what old
  rows were backfilled with
  (`20260827105542_backfill_video_model_default.sql`) and there's no
  normalization layer between a stored `video_model` value and this
  registry lookup. Kling's real API is a **two-value duration enum (5s
  or 10s)**, not a continuous range like Mochi's — C3 prompt 2 recorded
  it as `durationMin: 5, durationMax: 10` anyway, so the stepper's 0.1s
  steps between them could produce a value (e.g. 7.3s) the real Kling API
  would reject, a correctness bug (not just a gap) since that failure
  wouldn't surface until Step 7, the most expensive step, after the user
  had already paid for everything upstream. **C3 prompt 3 closes this**:
  `VideoModelConfig` is now a discriminated union —
  `{ kind: 'continuous'; durationMin; durationMax }` or `{ kind:
  'discrete'; allowedDurations: number[] }` — so a model can't be defined
  without picking which kind it is; there is no optional field that
  silently defaults to continuous. `mochi-1` stays `continuous`
  (1.4s–5.4s); `'Kling 2.1'` is now `discrete` with `allowedDurations:
  [5, 10]`. `isDurationAllowed(config, seconds)` (same file) is the one
  place both kinds are checked uniformly. The duration stepper
  (`duration-stepper.tsx`) branches on `kind`: continuous still steps by
  0.1s and clamps at the nearer bound; discrete steps to the
  nearest-neighbor **allowed** value in the direction of travel, so a
  click from an out-of-range value (e.g. 7.3s) lands exactly on the
  nearest real value (10.0s) rather than an intermediate one, and the
  helper copy states the allowed values themselves ("5s or 10s") rather
  than a "between X and Y" range, which would be actively false for a
  model that only renders exact values. **Existing `'Kling 2.1'`
  projects with now-invalid durations are not migrated or rewritten** —
  they render amber (the existing out-of-range warning already covers
  both kinds uniformly via `isDurationAllowed`) and the user resolves
  them manually, same principle as every other "never silently rewrite a
  locked duration" case in this file. This closes the duration-bounds
  half of the "Per-step model selection" open question below for good
  (moved to Done — see the C3 prompt 3 entry); the broader per-step
  provider model map remains open.
  `resolveVideoModel(id)` (same file) is the stepper's lookup: an
  unresolved id throws outside production (catches a missing registry
  entry during development) and returns `null` in production (the
  stepper degrades to a disabled, explanatory state instead of crashing
  the page) — deliberately never falls back to another model's bounds,
  since that would be exactly the silent-truncation risk this registry
  exists to prevent. This is a different, stricter fallback than
  `ProjectHeader`'s chip-label lookup above, which must never blank a
  chip for an unregistered value — two different failure costs, two
  different fallbacks, both correct for their own call site.
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
  request); the system prompt (`SHOT_GENERATION_SYSTEM_PROMPT_V4` states the
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
- **Tool-schema cost note (C3 prompt 1).** `write_shots`' schema grew a
  third time — `shot_size_origin`/`camera_angle_origin`/
  `camera_movement_origin` (system prompt bumped to `_V4`) — which shifts
  the pre-flight quote again, since `estimateInputTokens`
  `JSON.stringify`'s the whole tool schema (see the `reserveUsage`
  paragraph under Database). No attempt was made to preserve the previous
  serialized size. The input-estimate calibration ratio (see
  `usage.quoted_cost` under Database) was already stale twice over from
  earlier enum-consolidation and camera-field changes; this makes it
  stale a third time. The next live run is the new baseline, not a
  regression to chase.
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
- `src/lib/config/enums.ts` is the single hand-written source for
  `video_type` (plus `CLASSIFIABLE_VIDEO_TYPES`, the `'auto'`-excluded
  subset `write_shots` classifies into), `aspect_ratio`, `shot_size`,
  `camera_angle`, `camera_movement`, and `element_type` — each an
  `as const` tuple plus its derived union type, the same idiom
  `pipeline.ts` uses for `STEPS`/`Step`. Never derived from
  `database.types.ts`: a CHECK-constrained text column is typed as plain
  `string` by the Supabase codegen, so derivation isn't available for some
  of these, and mixing derived/hand-written would mean two patterns for
  one job. This is a different axis from `pipeline.ts` — that file
  describes the pipeline itself (steps/operations/providers); this one
  describes shot attributes and project settings — so keep them in
  separate modules. `buildWriteShotsTool` (`src/lib/prompts/
  shot-generation.ts`) and `sanitizeEnum`'s call sites
  (`/api/projects/[id]/shots/logic.ts`) both import from here, so the tool
  schema Claude sees can never drift from the validator that checks its
  output. `elements.type` **does** have a DB CHECK constraint
  (`elements_type_check`, added in
  `20260827051112_elements_and_shot_elements.sql`, matching `ELEMENT_TYPES`
  exactly) — an earlier version of this note claimed otherwise; corrected
  during C3 prompt 1, which also added `element_type` coverage to
  `tests/enums-drift.spec.ts` now that there's a constraint to test
  against. `camera_origin` (`CAMERA_ORIGINS` in this same module) is a
  fourth enum added by C3 prompt 1 — see the three-origin camera model
  under Database.
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
- **Per-field save model (C3 prompt 2).** The Step 2 shot card has no
  Save button and no dirty state, anywhere. Every field saves
  independently the moment the person leaves it: text fields
  (`voice_over`, `visual_description`) on blur, dropdowns (dialogue
  speaker) on change, the duration stepper on change (each +/- press).
  One field's write never touches another's — there is no batched
  "save the card" action to accidentally couple two fields together.
  Server actions live in `src/app/(app)/projects/[id]/workbench/
  actions.ts` (`updateShotVoiceOver`/`updateShotVisualDescription`/
  `updateShotDuration`/`saveDialogueLine`/`deleteDialogueLine`), follow
  the same shape `updateProjectTitle` established (plain result object,
  never thrown, ownership verified via an explicit `projects!inner(user_id)`
  join since `shots`/`shot_dialogue` have no `user_id` column of their
  own — RLS is the backstop, not the only check) but add **field
  attribution**: every result names which field it saved
  (`{ field, success, unchanged? } | { field, success: false, error }`)
  so a card with several fields mid-edit can retry exactly the one that
  failed, never the whole card. Each action diffs the incoming value
  against what's persisted before writing anything — an edit that
  resolves to the same value performs no write and sets no staleness
  flag (see the Staleness paragraph under Database). No `revalidatePath`
  is used (consistent with the rest of this repo, which uses none) —
  the client already holds the value it just sent, so a successful save
  updates local state directly (`ShotsProvider`'s `updateShotLocal`)
  instead of re-fetching.
  Save status renders in two tiers: **per field**, a small slot (saving
  / saved / save-failed-with-Retry) that decays from "saved" to nothing
  after 2s (`use-field-save.ts`'s `useFieldSave` hook,
  `save-status-indicator.tsx`) — the field stays fully editable while
  saving, never disabled; and **per card**, a header rollup
  (`shot-card.tsx`) that shows the worst state across every field on the
  card (precedence failed > saving > saved > quiet), naming the specific
  field on a single failure and collapsing to "N fields didn't save" +
  "Retry all" on several. Each field subcomponent is wrapped in
  `React.memo` so one field's status change re-renders the card's
  status map without forcing sibling fields to re-render.
  **Camera fields (`shot_size`/`camera_angle`/`camera_movement`) stayed
  read-only through this prompt (C3 prompt 2)** — origin display only,
  no dropdown, no change handler; setting `'override'` and triggering a
  `'derived'` re-check both landed together in C3 prompt 3 so the three
  origins were never partially wired (override with no re-derivation, or
  vice versa, would have been a half-built feature). **As of C3 prompt
  3, both are wired**: `camera-origin-fields.tsx` renders a real
  `<select>` per field with its own `useFieldSave`/save action, and
  `Revert to auto` is a real button — see the "Camera fields are
  editable and AI-re-derivable" paragraph under Database for the full
  mechanics. The bound-elements `+` toggle and `Delete shot` remain
  inert, per the same design-fidelity-without-functionality treatment,
  since their real functionality still belongs to C5 and C4
  respectively.
- **Duration stepper bounds and the over-target/out-of-range split (C3
  prompt 2).** `duration-stepper.tsx` moves in 0.1s increments, always
  displaying one decimal (`5` renders as `5.0s`), against bounds pulled
  from the project's `video_model` via `resolveVideoModel` — never a
  fixed constant, never frame counts or a provider name in copy. These
  are two independent conditions, deliberately not conflated: a **saved
  duration outside the current model's range** (reachable when a
  project's model changes after durations were locked) is a per-shot,
  deterministic fact — amber on that shot's own stepper, value never
  silently rewritten, copy naming what's wrong and the way out
  ("bring it down to `{max}`s, or pick a model that can hold `{value}`s").
  An **aggregate over-target overrun** (sum of shot durations exceeds
  the project's `duration_target` tier ceiling —
  `durationConfig[...].targetSecondsMax`, added C3 prompt 2 alongside
  `targetShots`/`estimatedCredits`) is a project-level fact, stated once
  on the workbench header's Current total (amber), **not** repeated on
  every locked shot's stepper — a locked duration is an independent,
  deliberate choice, and the header's existing aggregate lock count
  already makes the cost of manual durations visible without also
  diluting the signal by painting every lock amber. `ProjectHeader`
  computes both `totalSeconds` and `isOverTarget` from the `shots` array
  it already receives; no new fetch.
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

`shots` craft fields: `visual_description`; `shot_size` / `camera_angle` /
`camera_movement` (each DB-CHECK-constrained to a fixed enum, hand-written
in `src/lib/config/enums.ts` — see Conventions); `section_label`;
`duration_locked` (boolean marking duration as user-set vs. still free to
regenerate); `image_prompt_stale` / `video_prompt_stale` (booleans, see
the Staleness paragraph below). Character dialogue lives in its own
`shot_dialogue` table, not a column — see the dedicated paragraph below.

**Camera fields have three independent origins, not a boolean.** As of
C3 prompt 1, `shots.camera_overridden` (a single boolean covering all
three camera fields together) is replaced by `shot_size_origin` /
`camera_angle_origin` / `camera_movement_origin` — each DB-CHECK-
constrained to exactly `'auto'` / `'derived'` / `'override'`
(`CAMERA_ORIGINS` in `src/lib/config/enums.ts`), one origin per field
independently:
- `auto` — the visual description said nothing about this camera choice,
  so the AI chose it freely.
- `derived` — the visual description explicitly named this choice (e.g.
  "**Wide shot** of the Taj Mahal at sunrise"), so the AI was forced to
  it. The UI shows a note that this came from the description.
- `override` — a person picked the value manually. No AI was involved,
  and the model can never return this value itself — `write_shots`'
  tool schema for these three fields is `MODEL_REPORTABLE_CAMERA_ORIGINS`
  (`CAMERA_ORIGINS` filtered to drop `'override'`), so this is enforced
  structurally, not only by validation.

`runShotsPipeline` sanitizes an unrecognized/missing origin to `'auto'`
(the columns are `NOT NULL`) rather than nulling — `'auto'` is the
conservative default, since it never claims the description names a
camera choice when the model didn't say so. The migration that
introduced these columns backfilled existing `camera_overridden = true`
rows to `'override'` on all three and left everything else at the
`'auto'` default — **nothing backfills to `'derived'`**: determining
which existing shots have a camera term in their visual description
would require a paid Claude call per shot for a purely cosmetic result,
so existing shots read as `auto` and become accurate the first time
they're re-derived (C3 prompt 3).

**Camera fields are editable and AI-re-derivable as of C3 prompt 3.**
The three dropdowns (`shot_size`/`camera_angle`/`camera_movement`) in the
expanded shot card save independently on `onChange` (a select's change
*is* its commit — no blur moment the way a text field has), following
the exact per-field save pattern prompt 2 established: same
`loadOwnedShot` ownership join, same field-attributed `ShotFieldSaveResult`
shape, same `useFieldSave`/`SaveStatusIndicator` pair
(`updateShotSize`/`updateShotCameraAngle`/`updateShotCameraMovement` in
`actions.ts`). Changing a field sets **that field's** origin to
`'override'` and that shot's `image_prompt_stale`/`video_prompt_stale` —
the other two fields' origins are completely untouched, since the three
origins are independent, not a shared flag. The diff-before-write check
compares the `(value, origin)` pair, not value alone — re-selecting an
already-`'override'` value is a real no-op, but the same value while
origin is still `'auto'`/`'derived'` is not, since origin still needs to
move to `'override'`.

**`POST /api/projects/[id]/shots/[shotId]/camera`** (`logic.ts`'s
`runCameraDerivation`) is the AI re-derivation call that produces
`'derived'`. Two trigger conditions, both client-side in
`shot-card.tsx`: (a) a `visual_description` save whose value actually
changed (the existing `VisualDescriptionField`'s own
`if (trimmed === persisted) return` guard already encodes "actually
changed" — the trigger hooks into `onSaved`, not a new check) **and** at
least one camera field isn't `'override'`; (b) a single-field "Revert to
auto" click, which is **one combined route call**, not a separate
origin-flip action followed by a route call — the route itself flips
that field's origin away from `'override'` (implicitly, by force-applying
its write-back regardless of what Claude answers) and re-derives it
atomically. This was a deliberate design choice over a two-step
alternative: it means a failed revert leaves the field completely
untouched (still `'override'`, old value) rather than stuck with a
flipped origin and a stale value, since nothing is written to `shots`
until a successful response's write-back step.

**The all-override guard** — skipped only for a revert, whose entire
point is to un-override one field — refuses the call (client before the
request, server as a second check, `400`) when all three fields are
already `'override'`: there is nothing for the model to write, so the
call would be pure waste with no derivable outcome.

**Trigger (a) always asks Claude about all three fields, including ones
currently `'override'`; code alone decides, per field, whether to apply
the answer.** This was the resolved design over dynamically filtering the
tool schema per call: Claude can't judge whether new description text
names a camera choice for a field it's never told about, so a
per-call-filtered schema can't implement "description wins" at all — the
model has to see every field's enum options to answer any of them.
Write-back (`logic.ts`) then applies unconditionally to a field whose
origin is `'auto'`/`'derived'`, and to a field whose origin is
`'override'` **only when Claude's answer for that field is `'derived'`**
(explicit textual evidence) — otherwise that field is left completely
untouched, value and origin alike. This is **the description-wins-over-a-prior-manual-choice
rule**: a camera term the user just typed into the description is a
stronger, more recent signal than a dropdown they set earlier, but only
when Claude found real textual evidence for that specific field — a
model answer of `'auto'` for an override field means "no evidence," not
"revert this," and changes nothing. `'override'` is enforced as
structurally unreachable from the model exactly like `write_shots` — the
tool schema's origin enum is `MODEL_REPORTABLE_CAMERA_ORIGINS`.

**`derive_camera` writes a `usage` row but deliberately never a
`generations` row** — the one thing in this task that spends money, and
the only paid call in the repo with no claim. `generations`' insert-to-claim
contract exists for expensive, resumable work; this is a sub-second Haiku
call answering 1–3 enum questions, and a claim row would be actively
harmful here: `'succeeded'` is terminal (see the `generations` claim
algorithm above), so a claim row would block every *subsequent* edit of
the same shot's description forever after the first successful
derivation — there is no real "job" to resume. This is the same problem
a future `agent_turn` claim would hit (see Current focus's existing
"Agent chat turns deliberately get a `usage` row but no `generations`
row" note) — a proper fix needs a policy for which operations are
claim-worthy at all (an `OPERATION_POLICY` module), which is explicitly
**C4's job, not solved here**. Concurrency here is handled entirely
client-side instead: a **coalescing in-flight guard**
(`use-camera-derivation.ts`'s `useCameraDerivation`, one instance per
`ShotCard` = per shot) tracks whether a call is running; a second trigger
that arrives mid-flight replaces any already-queued trigger (so at most
one is ever waiting) and fires automatically once the running call
finishes — it does **not** drop. Dropping was considered and rejected:
a dropped "Revert to auto" click would leave that field on `'override'`
with no feedback at all, which is worse than the accepted cost of
allowing up to 2 billed calls for 2 rapid *distinct* edits to the same
shot (never more than 2, regardless of how many times a trigger re-fires
while one is already running — repeated re-fires just keep replacing the
single queued slot).

**`reserveUsage`'s `generationId` param is now `string | null`** (was
`string`) — a minimal, additive widening for this one call site, which
has no `generations` row to attach to. `usage.generation_id` was already
nullable (`ON DELETE SET NULL`, from Phase 1's drop-and-recreate
migration), so this is a pure application-layer typing change; no
migration was needed for that column. Every other call site
(`/shots`, `/prompts`) keeps passing a real `generation.id`.

**`CLAUDE_CAMERA_MODEL`/`CLAUDE_CAMERA_MAX_TOKENS`** are new entries in
`modelsConfig.camera` (`models.ts`) and `.env.example`.
`modelsConfig.camera.model` deliberately does **not** follow the
`isProduction ? sonnet : haiku` ternary every other section uses — it is
**Haiku permanently, including production, a locked cost decision**:
deriving 1–3 enum values from a sentence is mechanical work that never
benefits from Sonnet's extra quality, and this call fires on nearly
every visual-description blur, so the cost delta compounds across every
edit of every shot in a way the other, rarer pipeline calls don't. Still
overridable via the env var for ops flexibility, but the code default is
Haiku in both environments. `modelsConfig.camera.maxTokens` defaults to
**128**, deliberately small: `reserveUsage` reserves the *full*
`max_tokens` as its worst-case pre-flight quote (see the `reserveUsage`
paragraph below), so reusing `shots`'/`prompts`' ~8192-scale ceiling
here would reserve roughly 25× the real cost of a 1–3 enum-field
answer, on every description edit. A representative 3-field call quotes
at input≈768 / output=128 tokens ≈ **$0.0014** against Haiku's real
rates — see `RATE_VERSION` in `pricing.ts`.

**Staleness is set by user edits only, never by a pipeline.**
`shots.image_prompt_stale` / `shots.video_prompt_stale` and
`projects.voiceover_stale` (all booleans, `DEFAULT false`, added in C3
prompt 1) mark a downstream output as invalidated by a later edit. C3
prompt 1 shipped them with no writers; **C3 prompt 2's per-field save
actions are now those writers** (`src/app/(app)/projects/[id]/workbench/
actions.ts` — see the per-field save model under Conventions). Step 3's
voiceover pipeline writes `duration_sec` back onto every shot where
`duration_locked = false`; if that pipeline also set `voiceover_stale`,
it would invalidate its own output on every successful run — the user
regenerates, the pipeline writes durations again, the flag sets again,
unbounded, and every cycle is a paid ElevenLabs call.
**`runVoiceoverPipeline` must never write `voiceover_stale`.** Which
edits set what (implemented as described, C3 prompt 2): editing a shot's
**voiceover text** sets `projects.voiceover_stale` (Step 3 produces one
continuous narration file for the whole project, so any narration edit
invalidates the whole render) and that shot's `image_prompt_stale` and
`video_prompt_stale`. Editing a shot's **visual description** sets that
shot's `image_prompt_stale` and `video_prompt_stale`. Editing
**character dialogue** sets that shot's `video_prompt_stale` only —
dialogue is on-camera speech, not narration, so it doesn't touch the
voiceover. Editing **duration** sets nothing stale: audio is derived
from narration text, duration doesn't change what's spoken, and the
mismatch between a locked duration and actual narration length is
resolved at Step 5 by retiming visuals against the narration, which
costs nothing. Staleness is a flag, never a null — the output was paid
for and the user may still accept it (see the never-discard-paid-output
principle under `## Phase 1`'s `usage` section). Editing a **camera
field** (`shot_size`/`camera_angle`/`camera_movement`), by dropdown or by
AI re-derivation, sets that shot's `image_prompt_stale` and
`video_prompt_stale` — the same two flags a visual description edit
sets, since a camera framing change is exactly as visually invalidating
(as of C3 prompt 3; camera fields were read-only with no edit path
through prompt 2, so this exception no longer applies).

Every field write above is preceded by a diff against the persisted
value: an edit that resolves to the same value performs no write and
sets no flag (a field is only ever marked stale by an edit that actually
changed something) — see the per-field save model under Conventions.

**Character dialogue lives in `shot_dialogue`, a separate table — not a
jsonb column on `shots`.** (As of C3 prompt 1; it was previously
`shots.dialogue jsonb`.) Columns: `id`, `shot_id` (`ON DELETE CASCADE`),
`project_id` (denormalized — see below), `element_id` (`ON DELETE
CASCADE`, the speaking character), `line`, `order_index`, `created_at`.
RLS mirrors `shots`'s own single blanket policy exactly (one `USING`
covering every command, not the split SELECT/INSERT/UPDATE pattern
`generations`/`usage` use), keyed directly on the denormalized
`project_id` rather than joining through `shots`. It's a table rather
than a jsonb array specifically because a shared array can't support
independent per-row saves without a read-modify-write race: the C3 UI
(a later slice) saves each dialogue row independently, and C4's future
agent-mutation tools will write dialogue concurrently with the UI — two
concurrent writers sharing one array would silently clobber each other.
`runShotsPipeline` writes resolved dialogue as one uniform batch insert
into `shot_dialogue` (replacing the old per-shot `Promise.all` of
`.update({ dialogue: ... })` calls); no explicit cleanup is needed on
retry/recovery, since the pipeline's existing `shots` delete-before-
reinsert already cascades `shot_dialogue` rows via `shot_id ON DELETE
CASCADE`, the same way it already cascades `shot_elements`.

**C3 prompt 2's dialogue speaker rule.** The speaker dropdown in the
expanded shot card only ever lists elements bound to *that shot* via
`shot_elements`, filtered to `type === 'character'` — not every character
in the project. A saved `shot_dialogue` row whose `element_id` isn't
among that shot's bound characters renders as a **read-only, out-of-list
value** (the speaker's name, resolved from the row's own joined element,
not blanked and not silently reassigned to some other character) rather
than an error state. This is reachable today two ways: dialogue migrated
from the old `shots.dialogue` jsonb column may reference an element that
was never (re-)bound to that shot, and generation itself can resolve a
dialogue speaker to an element without that binding being reflected in
`shot_elements` (binding is C5's job — see Current focus). When a shot
has zero bound characters, `+ Add line` is disabled with the reason shown
beside it ("Bind a character to this shot first") rather than after a
click. A new row saves nowhere until both speaker and line are filled —
there's no half-formed `shot_dialogue` row and no card-wide dirty state
for it; discarding an incomplete row costs nothing. Row removal
re-sequences the remaining rows' `order_index` to stay contiguous (a
plain re-`UPDATE` loop — no RPC).

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

**Never discard paid output to signal that it may be wrong.** Earlier
behaviour (in the pre-rename `script/` step, removed wholesale before C3)
nulled `image_prompt` and `video_prompt` when the voiceover changed. The
staleness flag strictly dominates: nulling forces a paid regeneration to
recover text that already existed, destroys any hand-editing the user did
at Step 4, removes the user's judgement about whether the change actually
matters, and renders identically to a shot that was never generated. A
flag preserves the output, keeps the edit reversible for free, and lets
the UI offer "may be out of date · regenerate" instead of showing an
empty field. C3 prompt 2's per-field save actions
(`src/app/(app)/projects/[id]/workbench/actions.ts`) follow this: every
field write sets staleness flags, never nulls a prompt column.

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
`video_prompts` / `generation` / `assembly` — as of Phase 3, DB-CHECK-
constrained to exactly these seven values
(`supabase/migrations/20260901125544_add_current_step_check.sql`),
matching `aspect_ratio`/`duration_target`/`video_type` (it was
unconstrained text, app-code-enforced only, before then). `intake` is a
pre-project screen, not a real `current_step` value — it only exists as
the step-1 anchor in `furthest_step`'s mapping. `furthest_step` (smallint,
default 1) tracks the deepest step a project has reached, 1-8 over that
same vocabulary (intake=1 ... assembly=8). As of Phase 2, `current_step`'s
column default is `'workbench'` (migration
`20260901104929_current_step_default_workbench.sql`; it was still the
pre-rename `'script'` until then, and that migration also backfilled any
stray `'script'` row to `'workbench'` — see `## Phase 2` below).
`projects.video_model` holds a single model string and is currently
populated with a placeholder value — see Open questions.

## Phase 2: `current_step` / `furthest_step` and `advanceStep()`

These two `projects` columns have precise, distinct meanings, and conflating them was the
root cause of both being broken before Phase 2:

- `current_step` = the step the user is currently on. It is "where they are," not "how
  far they got." It moves **backward** when the user navigates back via the step
  indicator, and forward via Continue.
- `furthest_step` = how far the user has unlocked. It **never decreases**.

`intake` is not a tracked step and needs no runtime lower-bound guard against it: it never
appears as a `current_step` value and has no per-project route (`/projects/new` is a
pre-project screen, and the project row doesn't exist until submit), so "the user can't
navigate back to intake" already follows from the enum and the route topology — no
separate enforcement point is needed, and none should be added (a `MIN_NAVIGABLE_STEP`
constant would be exactly the kind of scattered second enforcement point this phase
exists to avoid).

**`advanceStep(supabase, projectId, step)`** (`src/lib/projects/advance-step.ts`) is now
the **sole permitted write site for both columns outside project creation**. It runs two
statements, in order, no `.rpc()`, no read-then-write:
1. An unconditional `current_step` update — it follows the user, forward or backward.
2. A conditional `furthest_step` update, filtered `.lt('furthest_step', idx)` — a no-op
   when navigating backward or re-entering an already-unlocked step. The `.lt()` filter
   makes the never-decreases guarantee at the database, not by reading the current value
   and computing a max in application code.

`idx` comes from `stepIndex(step)` (`src/lib/config/pipeline.ts`), which derives from the
existing `STEPS` array (`STEPS.indexOf(step) + 2`, the `+2` accounting for `intake`
occupying the conceptual first slot without being a member of `Step`) rather than a
separate hand-maintained map. **Known gap**: `storyboard` is a real `current_step` value
(see the 8-step route list above) but isn't a member of `Step` — deliberately, since
`Step`/`STEPS` is the operations-attribution vocabulary mirrored into the
`generations`/`usage` CHECK constraints, and storyboard claims no generation and logs no
usage (see the `pipeline.ts` file header). Widening `STEPS` to include it would wrongly
imply storyboard belongs in those CHECK constraints too. Nothing writes `current_step`
past `'workbench'` today, so this has no live consequence yet — whoever builds Step 5's
slice must extend the `current_step` vocabulary (and `stepIndex`, and `advanceStep`'s
parameter type) at that time, rather than this being pre-solved now.

`advanceStep` is called **only on an explicit step transition — never on a save**. Saving
an edit on a revisited step (e.g. editing a shot's camera fields on the workbench) persists
via its own save action and must not call `advanceStep`; if saving advanced the step,
`current_step` would start tracking edits instead of navigation and lose its meaning.
Unsaved edits may live in component state but must never reach the database without an
explicit save. The agent is available throughout steps 2 through 8.

**`advanceStep` ships with zero callers as of Phase 2** — the Continue buttons and step
indicator that will call it are a later slice. This is deliberate: the helper exists so
the first real transition has somewhere correct to go, not so it can be exercised yet.

**COUPLING WARNING**: `workbench-step-indicator.tsx` currently derives complete/current/
locked from `current_step`'s position alone (`STEPS.findIndex`) and does not consult
`furthest_step` — see Current focus. That is correct **only** because `advanceStep` has
no callers yet, so `current_step` never regresses in practice. The moment the first
`advanceStep` caller lands, `current_step` starts regressing on backward navigation, and
the indicator would then render an already-unlocked step as locked — locking a user out
of work they've already finished. **The indicator must switch to consulting
`furthest_step` in the same slice that adds the first `advanceStep` caller, not in a
later one.**

Prior to Phase 2, `/api/projects/[id]/prompts` wrote `current_step: 'voiceover'` directly
on success — wrong three ways (advanced to a route that doesn't exist as a per-project
page yet, could do so with zero shots, and the route itself is slated to split into
separate image-prompts/video-prompts routes before Step 4 ships). That write is removed
entirely, with no substitute destination (any destination chosen now would encode an
ordering that's about to change) — see Done.

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
  entries stay null and are regenerable. Partial failure returns 422,
  enforced by the same claim/recover contract `/shots` uses (`step:
  'image_prompts'`, `operation: 'write_prompts'` — see Database's
  `generations` section, and its provisional-attribution blocker note). As
  of Phase 2 the route no longer writes `current_step` on success either —
  see `## Phase 2`. As of Phase 3 it no longer writes `status: 'in_progress'`
  either — dead vocabulary from the old script-generation era, removed with
  no substitute (see the Phase 3 Done-log entry). As of Phase 1 prompt 3 the raw
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
- **Phase 2 complete**: `advanceStep()` (`src/lib/projects/advance-step.ts`) is now the
  sole permitted write site for `current_step`/`furthest_step` outside project creation
  (see `## Phase 2`) — ships with zero callers this phase, by design. The bad
  `current_step: 'voiceover'` write in `/prompts` is removed with no substitute
  destination. `stepIndex()` (`src/lib/config/pipeline.ts`) derives a project's progress
  index from `STEPS`. A migration
  (`20260901104929_current_step_default_workbench.sql`) fixed the column default
  (`'script'` → `'workbench'`) and backfilled any stray `'script'` row. Read-only audits:
  the dashboard resume link (`project-card.tsx`) is the one `current_step` read that
  would 404 against a stale `'script'` row — closed by the migration above, no code
  change needed at the read site itself; `runShotsPipeline`'s batch shot insert is clean
  (`duration_locked`/`camera_overridden` are unconditional `false` on every row, no
  heterogeneous-key PostgREST risk). `loading.tsx` skeletons added for `dashboard` and
  `/usage`, mirroring each page's real layout so navigation streams immediately instead
  of blocking on the server fetch.
- **Phase 3 complete**: duplication and dead vocabulary from the script-generation
  rename are cleaned up. `src/lib/config/enums.ts` (see Conventions) is now the single
  hand-written source for `video_type`/`CLASSIFIABLE_VIDEO_TYPES`, `aspect_ratio`,
  `shot_size`, `camera_angle`, `camera_movement`, and `element_type` — previously
  duplicated across `video-type-labels.ts`, `projects/new/actions.ts`,
  `intake-form.tsx`, `/api/projects/[id]/shots/logic.ts`, and the `write_shots` tool
  schema (`src/lib/prompts/shot-generation.ts`), which now imports from it directly so
  the schema Claude sees can never drift from the validator that checks its output
  (this does change the tool schema's serialised size and therefore the pre-flight
  quote in `estimateInputTokens` — expected, not a regression). A drift test
  (`tests/enums-drift.spec.ts`) inserts every member of each DB-CHECK-constrained enum
  and asserts acceptance, then one bogus value per enum and asserts rejection, turning
  TS-vs-CHECK-constraint drift into a test failure instead of a runtime surprise
  (`element_type` was believed to have no DB CHECK constraint to test against at the time,
  so it was consolidated into the module but excluded from the drift test — this turned
  out to be wrong; `elements_type_check` already existed, and C3 prompt 1 added the
  coverage and corrected the stale claim, see Conventions and the C3 prompt 1 entry
  below). `/api/projects/[id]/prompts` no longer
  writes `status: 'in_progress'` — dead vocabulary from the old script-generation era,
  removed with no substitute (the project-lifecycle status design is still open, see
  Current focus). `projects.current_step` gets its first-ever DB CHECK constraint
  (`20260901125544_add_current_step_check.sql`) — it was previously app-code-enforced
  only, despite `aspect_ratio`/`duration_target`/`video_type` having had one all along —
  added in a migration that verifies no row holds `'script'` before adding the
  constraint, so it fails loudly rather than silently if that assumption is ever wrong.
  The old script-generation vocabulary (`modelsConfig.script`, a `'script'` literal in
  the usage module, `CLAUDE_SCRIPT_*` env vars) turned out to already be fully gone —
  removed in earlier phases — and `.env.example` already carried
  `CLAUDE_PROMPTS_MODEL`/`CLAUDE_PROMPTS_MAX_TOKENS`/`CLAUDE_SHOTS_MODEL`/
  `CLAUDE_SHOTS_MAX_TOKENS`, so Phase 3 confirmed rather than performed that cleanup.
- **C3 prompt 1 complete** (schema, config, and generation only — no editing UI, no save
  actions, no AI re-derivation route; those are prompts 2 and 3): `shots.camera_overridden`
  is replaced by three independent origin columns (`shot_size_origin` /
  `camera_angle_origin` / `camera_movement_origin`, each `'auto'`/`'derived'`/`'override'`
  — see the three-origin camera model under Database); `runShotsPipeline` now has
  `write_shots` report a real origin per camera field (schema-restricted to
  `MODEL_REPORTABLE_CAMERA_ORIGINS`, which excludes `'override'` — only a manual edit sets
  that), replacing the old unconditional `camera_overridden: false` on every generated
  shot. Downstream staleness flags (`shots.image_prompt_stale` / `video_prompt_stale`,
  `projects.voiceover_stale`) are added with no writers yet — see the Staleness paragraph
  under Database for the full rule, including why `runVoiceoverPipeline` must never write
  `voiceover_stale`. Character dialogue moves off `shots.dialogue` (jsonb) onto its own
  `shot_dialogue` table, migrated in place in the same migration that drops the old
  column — a table rather than jsonb specifically so the C3 edit UI and C4's future agent
  mutation tools can save dialogue rows independently without a read-modify-write race.
  `src/lib/config/models.ts` gains a `VIDEO_MODELS` duration-bounds registry
  (`DEFAULT_VIDEO_MODEL` = `'mochi-1'`), partially closing the "Per-step model selection"
  open question. Corrected two stale claims found while implementing this: `elements.type`
  already had a DB CHECK constraint (contradicting both the task brief and this file's own
  prior wording — see the enums.ts Conventions bullet and the Phase 3 entry above), so no
  new constraint migration was created; `element_type` drift-test coverage was added
  against the existing constraint instead. Three migrations:
  `20260902125700_add_camera_origin_columns.sql`, `20260902125702_add_staleness_flags.sql`,
  `20260902125705_create_shot_dialogue_and_drop_shots_dialogue.sql`.
- **C3 prompt 2 complete** (the editing UI and its save path — no camera re-derivation, no
  Claude call, no usage reserve/settle path; those remain prompt 3's job): the Step 2 shot
  card is now expandable and editable, built on the per-field save model described under
  Conventions above (no Save button anywhere, text-on-blur/dropdown-on-change, per-field
  status decaying to a card-level worst-state rollup). New server actions in
  `src/app/(app)/projects/[id]/workbench/actions.ts` — `updateShotVoiceOver`/
  `updateShotVisualDescription`/`updateShotDuration`/`saveDialogueLine`/
  `deleteDialogueLine` — are `shots`'/`shot_dialogue`'s first writers of any kind outside
  the generation pipeline, and are the staleness flags' first writers ever (see the
  Staleness paragraph under Database, updated in place). `src/lib/config/models.ts` gains
  `'Kling 2.1'` (`durationMin: 5, durationMax: 10`, sourced from fal.ai's own API docs) and
  `resolveVideoModel`, closing the gap C3 prompt 1 left where the registry held only
  `'mochi-1'` while existing projects reference `'Kling 2.1'`. `src/lib/config/duration.ts`
  gains `targetSecondsMax` per tier, read by `ProjectHeader`'s new over-target amber state.
  Camera fields render read-only (origin display only, per the three-origin model);
  `Revert to auto`, the bound-elements `+` toggle, and `Delete shot` all render inert, per
  the same design-fidelity-without-functionality treatment the task brief specified for the
  camera dropdowns — three later slices (prompt 3, C5, C4) each add one handler to
  already-correct markup rather than building new UI. No schema change this task (every
  touched column already existed from prompt 1); `npm run types:db` confirmed a no-op diff.
  One real bug found and fixed during implementation: `DialogueSection` was calling
  `updateShotLocal` (a different component's `setState`) from inside a `setRows` updater
  function - React updater functions must stay pure, since React may invoke them during
  render; moved the sync to a `useEffect` keyed on the local `rows` state instead. New
  Playwright spec `tests/shot-editing.spec.ts` (10 tests) covers per-field save-on-blur,
  the no-op-blur-writes-nothing case, the staleness table, the old-nulling-behavior
  regression (prompts survive a voiceover edit), duration clamping and the out-of-range
  warning, the dialogue fill-both-before-persisting rule, the out-of-list read-only
  render, the no-bound-characters disabled state, and that nothing in this task writes
  `current_step`/`furthest_step`.
- **C3 prompt 3 complete — C3 is now fully shipped.** Two independent pieces: (1) a
  correctness fix to the video-model duration registry, and (2) editable/re-derivable
  camera fields, the only paid call in the C3 slice. `src/lib/config/models.ts`'s
  `VideoModelConfig` becomes a discriminated union (`kind: 'continuous' | 'discrete'`) —
  see the Video-model duration registry paragraph under Conventions for the full
  rationale and `duration-stepper.tsx`'s kind-branching logic; `'Kling 2.1'` is now
  `discrete` (`allowedDurations: [5, 10]`), closing the duration-bounds gap prompt 2 left
  open. The three camera dropdowns are wired to new per-field save actions
  (`updateShotSize`/`updateShotCameraAngle`/`updateShotCameraMovement` in `actions.ts`),
  following prompt 2's exact per-field pattern. New route
  `POST /api/projects/[id]/shots/[shotId]/camera` (`logic.ts`'s `runCameraDerivation`)
  re-derives camera framing via a new Haiku-permanent, 128-max-token Claude call — see
  the "Camera fields are editable and AI-re-derivable" paragraph under Database for the
  full trigger/guard/write-back mechanics, and the `derive_camera` paragraph for why it
  has a `usage` row but no `generations` row. New client-side coalescing in-flight guard
  (`use-camera-derivation.ts`) and a dedicated `CameraDerivationStatus` component, kept
  separate from the existing per-field `fieldStatus`/`rollupStatus` rollup in
  `shot-card.tsx` since a description save can succeed even when the derivation it
  triggered afterward fails. One migration
  (`20260902200658_add_derive_camera_operation.sql`) widens `usage_operation_check` to
  include `'derive_camera'` — `generations_operation_check` is deliberately not widened,
  since no writer will ever insert a `generations` row with that operation.
  `reserveUsage`'s `generationId` param widens to `string | null` (additive; every other
  call site is unaffected). One real, pre-existing race found and fixed while building
  the discrete-duration stepper: `handleStep`'s no-op guard compared a computed next
  value against the async `persisted` state (only updated once the save round-trip
  resolves) rather than the synchronous `value` state, so a second step fired before the
  first's network round trip completed could read a stale `persisted` and silently
  no-op instead of committing — this was latent in the original continuous-only stepper
  too, just never exercised by an existing test; fixed by comparing against
  `displayValue` instead, and the now-unused `persisted` state was removed. New spec
  `tests/camera-derivation.spec.ts` (11 tests) covers the per-field origin-independence
  rule, the two staleness flags, prompt-preservation, the all-override guard, the
  no-op-blur guard, the combined revert-to-auto call, the coalescing in-flight guard (two
  rapid distinct triggers producing at most 2 calls, never dropped), the
  description-wins-over-override write-back rule end to end (via a fake gateway), the
  blocked-pre-network-call settle path, and a failed derivation leaving prior values
  untouched; `tests/shot-editing.spec.ts` gains 3 tests for the discrete-model stepper
  (exact-values-only stepping, out-of-range amber-and-not-rewritten, and many
  simultaneously out-of-range shots rendering independently without breaking the
  project-level aggregate). This resolves the "Camera re-derivation trigger" and the
  duration-bounds half of "Per-step model selection" open questions below — both moved
  here from Open questions.
- **C3 presentation rebuild complete.** C3's three prompts had shipped correct logic
  built from prose descriptions of the Reelcraft canvas rather than the canvas itself —
  the shot card's visual language (text-field resting state, camera-field treatment,
  bound-element chips, save-status visibility, expand/collapse) didn't match the design.
  This task opened the canvas via the Claude Design MCP tools (project "AI short-video
  generator design", `Reelcraft.dc.html`) and read section `09 — Step 2 · expanded shot
  card · editing states` plus its four close-ups ("Camera fields · three origins",
  "Dialogue rows", "Duration · tenths inside the model's bounds", "Save status · two
  tiers") — the authoritative, current three-origin-model spec, as opposed to the
  older `08 — Step 2 · Workbench` section, which still reflects the retired
  `camera_overridden` boolean and was not used as a build target. No schema, server
  action, staleness/origin-write logic, or re-derivation guard changed — this was a
  presentation-only rebuild. Changes: `voiceover-field.tsx`/`visual-description-field.tsx`
  gained a real border/fill at rest (previously fully transparent until focus — the
  headline defect); `camera-origin-fields.tsx`'s override treatment became a subtle
  accent inset-edge instead of a full accent-wash fill, its control text moved to the
  `text-control` token, and pending fields now dim/grey with a spinner replacing the
  origin badge; `camera-derivation-status.tsx` was repurposed as the shared note lane
  below the three camera fields (a static explainer at rest/settled, a sentence naming
  which fields are rechecking and which is held while running, a calmer "last values
  unchanged" message on a failed recheck) and moved below the grid; a settled camera
  field now shows "· was {prior value}" via a small snapshot-before-trigger state in
  `shot-card.tsx` (client-side presentation state only, not persisted); `bound-elements.tsx`
  became 60px tiles (striped/lettered/generating/failed, driven by each element's
  already-loaded `status`/`reference_image_path` — no new interactivity, matching the
  existing "binding is C5's job" scope line) instead of small chips, but only in the
  expanded card — the collapsed card's small-chip treatment already matched the canvas
  and was left alone; `dialogue-row.tsx`'s line field gained the same bordered-shell
  treatment as the speaker control, with its save-status indicator moved inside the
  field; `duration-stepper.tsx`'s buttons grew to the canvas's 32×32px and the amber
  out-of-range state now colors the value text, not just the pill; `save-status-indicator.tsx`'s
  "saved" color changed from green to quiet grey (canvas: deliberately not a celebratory
  color). The card's expand interaction changed from a dedicated "Expand" text button to
  a click-anywhere-on-the-collapsed-card affordance (`role="button"`, no visible button
  element) — "Collapse" remains a real, explicit text link in the expanded header, and
  clicking inside the expanded body never collapses the card. This required updating the
  shared `expandFirstCard()` helper in both `tests/shot-editing.spec.ts` and
  `tests/camera-derivation.spec.ts`, plus one direct loop call, from
  `getByRole('button', { name: 'Expand' }).click()` to clicking the card container
  directly — the one DOM-structure exception permitted by this task, since the canvas
  itself removes that button. One new test was added
  (`tests/shot-editing.spec.ts`, "clicking a collapsed card expands it"). All 131 tests
  (130 pre-existing + 1 new) pass unchanged otherwise.
- **Shot card select/label/indicator/casing fixes complete.** The C3 presentation
  rebuild (above) had read canvas section 09 but not section **10 — Step 2 · shot card ·
  select, labels, header slot**, which exists specifically to correct it — its own intro
  states the build fell through to the native `<select>`'s unstylable OS menu, and read
  label weight and the per-field save indicator's placement differently from the design.
  This task closed all three, plus a real bug and a display-only gap:
  - **Custom select** (new `custom-select.tsx`): a from-scratch WAI-ARIA "select-only
    combobox" (`role="combobox"` trigger button + `role="listbox"` popup,
    `aria-activedescendant` — DOM focus never leaves the trigger) replaces the native
    `<select>` for the three camera fields and the dialogue speaker field. No headless
    UI/accessible-primitive package exists in this repo, so it was built in-house;
    callers keep full control of trigger visuals (origin borders/badges) via
    `triggerClassName`/`trailing`, the component owns only the interactive/keyboard/menu
    mechanics. Implements the canvas's full keyboard spec (Space/Enter opens with focus
    landing on the selected option; ↑/↓ move the active option when open and directly
    step-and-commit when closed, native-`<select>`-like; Home/End; a–z typeahead
    resetting after ~1s; Escape/Tab/click-out close without commit; 260px scroll cap
    with a bottom gradient fade above ~8 options; opens upward near the pane's bottom
    edge) and disables the trigger with a real HTML `disabled` attribute (genuinely
    non-interactive, not styled-only). One deliberate simplification: the scroll
    container uses the browser's native scrollbar rather than a hand-drawn decorative
    thumb — the functional gradient-fade cut is kept, the pixel-exact scrollbar isn't.
    The dedup-on-re-selecting-the-same-value decision (a no-op only once a camera
    field's origin is already `'override'`) stays exactly where it was, in
    `camera-origin-fields.tsx`'s own commit handler — `CustomSelect` always calls
    `onCommit` on any explicit choice and leaves dedup to the caller, since a generic
    widget can't know a camera field's origin-aware diff rule.
  - **Label weight/spacing** (`voiceover-field.tsx`, `visual-description-field.tsx`,
    `duration-stepper.tsx`, `camera-origin-fields.tsx`, `dialogue-section.tsx`'s
    "Character dialogue" label, `bound-elements.tsx`): every field label on the card
    gains `font-medium` (500 — canvas: "the build renders 400, this is the visible
    miss") and `leading-4` (16px, fixed, so a row a label shares with a status
    indicator never changes height); the label→field gap changes from a hardcoded 3px
    to `gap-rc-2xs` (6px), the canvas's stated value.
  - **Per-field indicator placement**: each label's row gains `justify-between` and
    `min-h-4` so the status indicator sits right-aligned, opposite the label, in a
    fixed-height slot — a status appearing/disappearing never reflows the row. The
    card-header rollup's own placement was already correct and untouched. **Judgement
    call**: dialogue rows were left exactly as they were (indicator trailing inside the
    line-input control) — the canvas's own "Dialogue rows" close-up shows this
    placement explicitly and unchanged, since a dialogue row has no per-row label for
    an indicator to sit "opposite"; the task's prose ("including dialogue rows") is
    read as a verification instruction, not a mandate to contradict the canvas's own
    spec for that component.
  - **Stuck save spinner (real bug, not a canvas-fidelity issue)**: `shot-card.tsx`'s
    per-field `fieldStatus` map was append-only — nothing ever deleted a key. The
    primary trigger, found by direct reproduction of the task's own repro steps, is
    **not** row removal but the ordinary success path: `dialogue-section.tsx` promotes
    a saved draft from the `drafts` array (React key `` `dialogue:${draftKey}` ``) to
    the `rows` array (key `` `dialogue:${row.id}` ``) — a different key forces React to
    unmount-then-remount `DialogueRow` rather than update the same instance, and the
    old instance's own `'saving'` → `'saved'` transition loses the race against that
    remount (React tears the old subtree down as part of applying the same state
    update, so the old instance's pending status effect never runs). The header's map
    is left holding the draft-keyed entry stuck at `'saving'` forever, since nothing
    under that key will ever report again. Explicit row removal (`handleRemoveDraft`/
    `handleRemoveSavedRow`) has the identical defect for the same reason. **Fix**: a
    new `clearFieldStatus(key)` in `shot-card.tsx`, passed to `DialogueSection` as
    `onFieldStatusClear`, prunes the key outright (not a `'idle'` write — a pruned key
    occupies no slot at all) at the exact three points that retire one:
    `handleDraftSaved` (the actual root cause), `handleRemoveDraft`, and
    `handleRemoveSavedRow`. Two new tests in `tests/shot-editing.spec.ts` cover both:
    adding a line and letting it save resolves the header rollup on its own with no
    removal needed, and removing a row shortly after its save completes (inside the 2s
    decay window, reproducing the "entry never cleared on completion" sub-case) also
    leaves no residual status.
  - **Camera value display casing** (new `src/lib/camera-labels.ts`, mirroring
    `language-labels.ts`'s `Record<string, string>` + fallback-to-raw-value lookup
    pattern exactly): `shotSizeLabel`/`cameraAngleLabel`/`cameraMovementLabel` render
    `'extreme_close_up'` as "Extreme close up", `'eye_level'` as "Eye level", etc.
    **Display-only** — `src/lib/config/enums.ts`'s tuples, the DB CHECK constraints,
    the `write_shots` tool schema, and `tests/enums-drift.spec.ts` are all untouched;
    stored values stay exactly as persisted (lowercase, underscore-separated). Wired
    into `CameraField`'s options (closed trigger value and every menu option) via
    `CustomSelect`'s new `options: {value, label}[]` shape, retiring the ad hoc
    `humanize()` it replaced. The collapsed card summary never rendered camera values
    at all (verified directly), so there was nothing to change there.
  - **Test-compatibility exception (Task-scope pre-authorized)**: `.selectOption()` and
    `.toHaveValue()` only work on native form elements, so 6 lines across
    `tests/camera-derivation.spec.ts` and `tests/shot-editing.spec.ts` were rewritten
    from native-select interaction to role-based (`getByRole('combobox').click()` +
    `getByRole('option', { name, exact: true }).click()`, and
    `toHaveAttribute('data-value', ...)` in place of `toHaveValue(...)`) — the one
    exception a DOM-structure change the custom select itself necessitates, not a
    weakened assertion. `exact: true` was required once "Close up"/"Extreme close up"
    existed as sibling option labels (a substring match resolved both).
  - Verification: `npm run build`, `npx tsc --noEmit`, and `npm run lint` all clean;
    the full Playwright suite (133 tests, including the 2 new ones) passes. A manual
    keyboard-only smoke pass (Tab, Space-open, arrows, Enter-commit, Escape/Tab-close-
    without-commit with focus returning to the trigger, closed-trigger arrow direct
    commit, a–z typeahead, and the disabled state's real unreachability) was run and
    removed afterward — not part of the permanent suite.
- **Custom select follow-up: three of four reported defects fixed.** Found on first use
  of the shot card built above.
  - **Menu/trigger width (two of the four reports, one root cause).** `CustomSelect`'s
    root `<div className="relative">` had no `w-full`/`flex-1` — unlike the native
    `<select className="flex-1 ...">` it replaced. As a flex item with no `flex-grow`,
    it shrank to its own content's intrinsic width instead of filling its caller's
    container (a circular reference: the button inside declares `width:100%`, but that
    resolves against `.relative`'s own auto/content-based width, which itself is driven
    by that same button's content). The absolutely-positioned menu (`left-0 right-0`)
    uses `.relative` as its containing block, so it inherited that same narrow,
    selected-value-dependent width — explaining both the menu-narrower-than-trigger
    report and the dialogue-speaker-trigger-jumps-on-open report as one mechanism, not
    two. Fixed by adding `w-full` to that root div — this gives it a definite width
    (100% of its actual, already-correctly-sized parent: grid-stretched for camera
    fields, explicit `w-[156px]` for the dialogue speaker), which is now static
    regardless of `open` state or the selected label's length.
  - **Origin badge casing.** Canvas section 10's badge spans (`auto`, `described`) both
    carry `text-transform:uppercase` plus `letter-spacing:0.06em` (for legibility at
    that size, the same reasoning already applied to field labels). The badge spans in
    `camera-origin-fields.tsx` had no `uppercase` class at all, so the lowercase JSX
    source text rendered literally lowercase. Fixed by adding `uppercase
    tracking-[0.06em]` to both badges; the `override` treatment (the "· set by you"
    label suffix, deliberately `normal-case` — it's not a badge in the canvas at all)
    was confirmed already correct, no change needed.
  - **The fourth report — manually overriding a camera field emptying that field's
    dropdown — could not be reproduced and remains open.** Extensive live
    reproduction (a real dev server plus scripted Playwright interaction, not just
    static reading) was attempted against eight distinct scenarios: a plain override,
    overriding all three fields in sequence (reaching the `allCameraFieldsOverride`
    all-override state the report specifically flagged as worth checking), overriding a
    field immediately after a real re-derivation attempt, rapid double-selection on the
    same field, keyboard-driven override (the closed-trigger direct-commit path),
    clicking "Revert to auto" on one field immediately after overriding a different one,
    overriding a field whose value started `null`, and re-selecting an
    already-`override`-and-already-selected value. Every one of these rendered
    correctly — `data-value`, text content, computed styles, and screenshots all showed
    the selected value displayed normally, the other two fields untouched, and the
    options list intact on reopening. The `allCameraFieldsOverride` guard (the report's
    other specific suspicion) was re-confirmed live to only gate the `trigger()`
    re-derivation call in `handleVisualDescriptionSaved` — it has no effect on any
    render path. It's plausible the report was actually the width bug above (a
    severe-enough content/width collapse could plausibly read as "the value
    disappeared"), since reverting the `w-full` fix and repeating several of the above
    scenarios still never produced an empty `data-value` or blank text — only the
    already-diagnosed narrow-rendering symptom. This was not treated as confirmed,
    though, since it wasn't proven either way live before the session ended (see below).
    **No fix was attempted for this item — do not assume it's resolved.** Whoever picks
    this up next should start from a real repro (ideally get the exact steps from
    whoever originally saw it) rather than re-deriving hypotheses from source reading
    alone, since that path was already exhausted here without success.
  - Verification: `npm run build`, `npx tsc --noEmit`, `npm run lint` all clean; the
    full Playwright suite (133 tests, unchanged) passes. No new test was added — the
    task's requested regression test was for the fourth (unreproduced, unfixed) item,
    and per this file's own standing rule a test must not assert on hoped-for behavior
    that hasn't been confirmed.

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
- **Open bug, unreproduced**: manually overriding a camera field is reported to empty
  that field's dropdown. See the "Custom select follow-up" Done-log entry for the eight
  live-reproduction attempts that all failed to reproduce it, and the working theory
  (possibly the same root cause as the now-fixed menu/trigger width bug) that was never
  confirmed. Not fixed — start from a real repro next time, not source-reading alone.
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
- Shot editing: expand/collapse, `voice_over`/`visual_description` text
  fields, the duration stepper (now discrete-model-aware), and dialogue
  rows are done, and camera field editing + AI re-derivation is done too
  — **C3 is complete as of prompt 3** (see Conventions and Done). Still
  open: shot deletion (C4, alongside the agent's `delete_shot` tool —
  `Delete shot` renders inert today).
- Agent chat mutations on the workbench (composer is rendered but disabled
  today)
- Element upload/generation (reference images) from the Assets tab
- Step-guard navigation: gate step-to-step links on `furthest_step`, not
  just `current_step` position. `advanceStep()` (see `## Phase 2`) is now the
  write site that will keep `furthest_step` live-tracked once wired up, but
  it has zero callers yet, so this is still blocked in practice. Per the
  coupling warning in `## Phase 2`, `workbench-step-indicator.tsx` must
  switch from `current_step`-position to `furthest_step` in the same slice
  that adds `advanceStep`'s first caller — not before, not after.
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
- **Out of the four open items carried into Phase 2 from Phase 1, three are now resolved
  and one remains open:**
  - The `/prompts` split blocker before Step 4 (see Database's
    `generations` section and the Current focus bullet above) — not yet
    closed.

  The other three are resolved: two by Phase 2 (see `## Phase 2` above): `furthest_step`
  now has a real, single write site (`advanceStep()`) rather than being written once and
  never touched again — though it still has no live callers, so `furthest_step` won't
  actually advance past project creation until the step-guard navigation item above is
  built. And `/prompts` no longer advances `current_step` to `'voiceover'` at all — the
  write was removed outright rather than redirected, since any destination chosen now
  would encode an ordering that's about to change once `/prompts` splits. The third —
  `current_step` had no DB CHECK constraint, unlike `aspect_ratio`/`duration_target`/
  `video_type` — is resolved by Phase 3 (see the Done log).

## Open questions
- **Per-step model selection.** `projects.video_model` is a single column
  holding one model string. Model choice is per-step, not per-project:
  OpenAI models for image generation, ElevenLabs models for voiceover,
  fal.ai models for video clips. The schema needs to reflect that before
  Step 3 — likely a per-step model map on the project rather than one
  column — and `models.ts` needs to carry provider → model →
  `{ costPerUnit, ... }` for each. **The duration-bounds half is now
  fully closed (C3 prompt 3, see Done)**: `models.ts`'s `VIDEO_MODELS`
  registry holds a real discriminated-union duration shape
  (`kind: 'continuous' | 'discrete'`) correctly modeling both Mochi's
  continuous range and Kling's true two-value enum — no longer a
  min/max-only approximation. Still open: the broader per-step provider
  model map itself, and per-model cost config.

Resolved (moved to Done, C3 prompt 3): the "Camera re-derivation
trigger" question — editing `visual_description` fires the trigger
automatically on a successful, actually-changed save (not behind a
separate explicit action), always asking Claude about all three fields
(including `'override'` ones) so it can judge whether new text names a
choice for any of them; write-back code then applies the answer per
field based on that field's current origin. See the "Camera fields are
editable and AI-re-derivable" paragraph under Database for the full
mechanics.