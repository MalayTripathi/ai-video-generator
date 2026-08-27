@AGENTS.md

# Reelcraft — AI Video Generator

Users describe a topic, get an AI-generated script, edit it conversationally,
then generate a voiceover, scene images, and a short video from it.

## Stack
- Claude API: script generation/editing; outputs structured shots
- ElevenLabs API (`eleven_v3`): text-to-speech. v3 is required — the
  scripts carry inline audio tags (`[slowly]`, `[warmly]`) that older
  models would read aloud as words. Also covers Hindi.
- OpenAI Images API: per-scene image generation, individually regenerable
- fal.ai: image + video prompt → per-scene video, all scenes in parallel

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
  `/projects/[id]/workbench`.
- Claude returns scripts as structured shots (JSON), not prose. One shot
  = one image = one voiceover segment.
- Model and provider config lives in `src/lib/config/models.ts`, read from
  env with defaults. Never hard-code a model name at a call site. Config
  sections are added when a step is built, not ahead of it.
- Duration → shot-count/credit mapping lives in `src/lib/config/duration.ts`
  (`durationConfig`, keyed by `DurationTarget`) — the single source for
  `targetShots`/`estimatedCredits`. Both the intake duration tiles and
  shot generation read from it; don't duplicate these numbers elsewhere.
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
  rather than mocking auth — see `tests/new-project-intake.spec.ts`.
- Schema changes go in `supabase/migrations/` via `supabase migration new`,
  applied with `db push` — never pasted into the dashboard SQL editor.
  Re-run `npm run types:db` after any change; `src/lib/database.types.ts`
  is generated, never hand-edited.
- Supabase clients are typed with the generated `Database` type. Don't
  infer schema from usage — read the types file.
- Prompt caching is wired on /prompts but currently inert — static prompts
  (~400-450 tokens with tool schemas) sit under the minimum cacheable
  prefix (2048 Haiku / 1024 Sonnet). Don't pad prompts to reach it. It
  will activate on its own as prompts grow.
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
  shared chrome for Steps 2–8: rail, a top bar trimmed to just the back
  link and user menu, a `header` slot, the 8-step indicator, the agent
  panel, a `children` content slot, and an optional `footer` slot.
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
same vocabulary (intake=1 ... assembly=8).

## Done
- Supabase email/password auth: signup, login, sign-out, protected dashboard
- Root redirect: `/` → `/dashboard` or `/login`
- Auth screens styled to the design system, with inline validation
  (required fields, email format, password match, terms, min length)
- Deployed to Vercel
- Dashboard: left rail, top bar with user dropdown (real sign-out), status
  filter chips, project card grid reading live `projects` rows, empty
  state. "New Project" (rail + empty state) links to `/projects/new`, the
  intake screen. Cards link to `/projects/[id]/{current_step}` — resumes
  wherever the project left off. Card thumbnails and the remaining nav
  items (Assets, Usage, Settings, search) are still visual-only pending
  real data/routes.
- `/api/projects/[id]/prompts` generates `image_prompt`/`video_prompt` per
  scene, validated (min 50 chars, non-empty) before persistence — invalid
  entries stay null and are regenerable. Partial failure returns 422 and
  does not advance `current_step`. Prompt caching and a history window are
  wired on this route.
- Double-submit guards on prompt generation and project creation.
  `/prompts` acquires a DB-level CAS lock (`projects.generating_at`,
  `src/lib/generation-lock.ts`) before doing any work and releases it in a
  `finally` on every exit path; a concurrent request gets a 409, and a
  stale lock (crashed/killed request) self-heals after 3 minutes rather
  than wedging the project. The intake screen's `BuildButton` disables
  itself via `useFormStatus` while `createProjectFromIntake` is in flight.
- Step 2 Workbench (`/projects/[id]/workbench`): built on
  `workbench-shell.tsx` (see Conventions), read-only shot list. On first
  load with zero shots, the client triggers `POST
  /api/projects/[id]/shots`, which drives one `write_shots` Claude tool
  call (system prompt in `src/lib/prompts/shot-generation.ts`, target shot
  count from `durationConfig`), persists shots/elements/`shot_elements`/
  dialogue, guards the `projects.title` write (only if still null), and
  inserts an `assistant` message — same CAS-lock/409/stale-self-heal
  pattern as `/prompts`. Shot cards are grouped by `section_label`,
  collapsed only (no editing yet). A `ShotsProvider` client context keeps
  the header's Target/Current readout, the Shots/Assets tab counts, and
  the footer's "N elements without a reference image" banner in sync with
  the client-fetched result once generation completes — none of it is
  server-rendered-once-and-forgotten. Assets and Script tabs render fixed
  empty states this task regardless of whether elements already exist
  (deliberate scope line, not an oversight). Explicitly deferred: shot
  editing, agent chat mutations, element upload/generation, step-guard
  navigation (see Current focus).

## Superseded
The old 4-step wizard (`script`/`voiceover`/`images`/`video`, driven by a
`WizardStep` type and its own `StepIndicator`) has been removed now that
intake and the 8-step workbench flow work end to end. `/projects/[id]/script`
now just redirects to `/projects/[id]/workbench` for bookmarked URLs. Kept
here as a historical record, not current behavior:
- Script step (`/projects/[id]/script`): dashboard shell reused (`Rail` +
  `TopBar`'s `left`/`right` slots), step indicator row (Script/Voiceover/
  Images/Video), inline-editable project title kept in sync between manual
  edits and Claude's auto-title update, 42/58 chat/scene-document split.
  Chat: message history, empty state, composer, busy/drafting indicator,
  posts to `/api/projects/[id]/script`. Chat failures render as a distinct
  `role: 'error'` message (icon + `status-failed-fg`, local-only — never
  persisted to `messages`), not a plain assistant bubble. Scene document:
  scene rows (`Scene N` + voice-over text), empty/skeleton-loading states,
  a "just changed" highlight diffed after each turn, word count, and a
  "Continue to voiceover" link gated on scenes existing. The API route
  itself drove a Claude `write_scenes` tool call, persisted
  `scenes`/`messages`/a guarded `projects.title` update, and returned the
  applied title so the client stayed in sync without a refetch.
- Scene voice-over text was inline-editable: click a scene row to edit,
  save on blur/Enter, Escape cancels (`SceneRow`, mirrored the title-edit
  pattern). Saved via `updateSceneVoiceOver` (`projects/[id]/actions.ts`)
  — a plain server action, no Claude call — which verified project
  ownership and nulled `image_prompt`/`video_prompt` on change. Each row
  showed its own Saving…/Saved/Save failed+Retry indicator per the
  Reelcraft canvas's "Save indicator" spec.
- Two-phase scene generation was triggered from the script chat: chat
  produced voice_over only, and the script step's "Continue" button called
  `/api/projects/[id]/prompts` to generate image_prompt/video_prompt. That
  trigger is gone with the script step; the route's own validation logic
  is unchanged and documented live above, awaiting a new caller in Steps
  4/6.
- Project creation used to be a direct server action (`createProject`)
  fired straight from the "New Project" button, disabled via
  `useFormStatus` (`NewProjectButton`) and deduped on the server against a
  just-created untouched draft. That's replaced by the `/projects/new`
  intake screen and `createProjectFromIntake`. Inline title/scene edits
  also had `saving`/`saveState` re-entrancy guards blocking re-opening a
  field mid-save — the scene half of that went with `SceneRow`; the title
  half (`updateProjectTitle`) is still in `actions.ts`, unused, pending a
  workbench title editor.

## Current focus
- Shot editing: expand/collapse a shot card, edit voice_over / visual
  description / camera fields, duration stepper, delete
- Agent chat mutations on the workbench (composer is rendered but disabled
  today)
- Element upload/generation (reference images) from the Assets tab
- Step-guard navigation: gate step-to-step links on `furthest_step`, not
  just `current_step` position
