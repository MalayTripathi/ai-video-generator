# Frozen history — NOT AUTHORITATIVE

Snapshot taken 2026-09-06. Never updated, never trusted for current
behaviour. Superseded entirely by CLAUDE.md. This file is known to contain
at least one false claim (a line asserting `camera_overridden` is written on
every generated shot row — that column was dropped). It has not been audited.
Read it only to recover why something was once done, never to learn what is
true now.

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
- **Camera re-derivation scope-widening bug fixed; all-override skip guard removed;
  "Reset all to auto" added.** Root cause of a confirmed bug (a shot with all three
  camera fields overridden; reverting just one also silently overwrote a different,
  untouched field): `runCameraDerivation` (`logic.ts`) fell back to asking about all
  three fields whenever a caller's `fields` list was missing/empty, and the client's
  single-field revert request never sent one, so the sibling field entered scope and
  could be overwritten by the "description wins over override" rule. Fixed by making
  `fields` a required, server-validated parameter with no fallback and no
  server-side widening — see the "Camera-scope invariant" paragraph under Database for
  the full rule and both call sites' fix. Two related changes shipped alongside: (1)
  the "all three fields already override → skip the call" guard on the description-edit
  trigger is removed — it was blocking exactly the case (an explicit new description)
  where re-derivation should always win; see "Change B" under Database. (2) A "Reset all
  to auto" control (`camera-derivation-status.tsx`, right-aligned on the same line as
  the (rewritten) helper text, hidden only when every field is already `'auto'`) issues
  one combined three-field call (`fields` = all three, `resetAll: true`) rather than
  three sequential per-field reverts, force-applying Claude's answer for every field so
  each lands independently on `'auto'` or `'derived'`. The per-field control was renamed
  "Revert to auto" → "Reset to auto" (sentence case, same position/icon/visibility rule)
  to read clearly alongside the new "Reset all to auto". `RevertIcon` was exported from
  `camera-origin-fields.tsx` so both controls share the exact same glyph. New/updated
  tests in `tests/camera-derivation.spec.ts`: a direct-call regression test proving a
  single-field revert leaves two overridden sibling fields byte-identical (value and
  origin); a direct-call test proving a judgement for a field outside the requested
  scope is discarded, not written; three `page.request.post` tests proving `fields`
  omitted/empty/containing an unknown member all `400` before any DB read or AI call,
  with zero `usage` rows and zero shot mutation; a UI test replacing the old (now
  incorrect) "no re-derivation when all-override" test, proving a description edit
  while all three fields are override still re-derives and honors explicit new
  evidence; four "Reset all to auto" UI tests (hidden-when-all-auto, visible-with-one
  non-auto, exactly-one-call-scoped-to-all-three, and per-field-vs-reset-all
  cardinality). The pre-existing "Revert to auto"/coalescing tests were updated for the
  rename and the now-required `fields` field in the request body. All 142 Playwright
  tests pass; `npm run build`, `npx tsc --noEmit`, `npm run lint` all clean.

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

## Past-tense blocks removed from CLAUDE.md

Copied verbatim from the positions they occupied before the restructure.
Labelled by their audit item number in `docs/claude-md-audit.md`.

### Audit item 23 — tool-schema cost note

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

### Audit item 58 — camera-origin backfill narrative

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

### Audit item 75 — the `ready` → `succeeded` rename

**The `ready` → `succeeded` rename happens in exactly one place**:
`settleGeneration`'s success branch writes `state: 'succeeded'`; every
other state name (`pending`/`generating`/`failed`) is unchanged between
the old `projects.shots_generation` vocabulary and this one.
`settleGeneration` also always clears `payload` on success unconditionally
(it was only ever a recovery aid for an in-flight or failed attempt), and
clears it on failure only when the caller explicitly asks (the
`max_tokens` truncation case) — otherwise a failed row's payload survives
for RECOVER, same as before.

### Audit item 76 — the deleted `generation-lock.ts` passage

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

### Audit item 83 — the removed `logClaudeUsage` note

**As of Phase 1 prompt 4, `logClaudeUsage` no longer exists.** `usage`
rows are written by `src/lib/usage/` (`reserveUsage`/`settleUsage`/
`assertWithinAllowance`), called *around* the gateway call rather than
after it: `assertWithinAllowance` → `reserveUsage` →
`gateway.createMessage` → `settleUsage` (in a `finally`).

### Audit item 86 — the measured input-estimate gap

This closes a real, measured gap: the first live shot-generation call
quoted input 536 / output 4000 ($0.020536) against an actual input of
1814 / output 1009 ($0.006859) — a 3.4x under-estimate, almost entirely
the excluded `write_shots` tool schema (`JSON.stringify([WRITE_SHOTS_TOOL]).length`
was 2396 chars on its own). Recomputing that same call's quote with the
new formula lands around 1442 tokens against the actual 1814 — the
remaining gap (~372 tokens, vs. the old 1278) is consistent with the
chars/4-on-JSON bias noted above, not a new omission.

### Audit item 91 — the four closed spend mechanisms

With this, all four mechanisms behind the original unexplained-spend
incident are closed: the gateway-seam live-call guard (Phase 0), the
`generations` claim replacing the old CAS lock (Phase 1), the
`ready`→`succeeded`/payload-recovery contract (Phase 1), and now
reserve-then-settle usage logging replacing `logClaudeUsage`'s
log-only-after-success-and-swallow-failure behavior (Phase 1 prompt 4).

### Audit item 92 — dropped `projects.shots_generation` / `pending_shots_payload`

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

### Audit item 99 — the "As of Phase 2/3" migration clauses

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

### Audit item 107 — the removed `current_step` write in `/prompts`

Prior to Phase 2, `/api/projects/[id]/prompts` wrote `current_step: 'voiceover'` directly
on success — wrong three ways (advanced to a route that doesn't exist as a per-project
page yet, could do so with zero shots, and the route itself is slated to split into
separate image-prompts/video-prompts routes before Step 4 ships). That write is removed
entirely, with no substitute destination (any destination chosen now would encode an
ordering that's about to change) — see Done.
