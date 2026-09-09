# CLAUDE.md audit

Read-only audit. No edit was made to `CLAUDE.md`, and `docs/decisions.md` was not created.

**The test applied to every line:** *would a fresh session do the WRONG THING without this line?*

Item numbers are stable. A follow-up session should act on them by number.

Verification legend: **CONFIRMED** (checked against the code), **STALE** (code says
otherwise), **UNVERIFIABLE**, **N/A** (pure convention/policy — deliberately not verified
against code, per Task 2).

---

## Header and product summary (lines 1–12)

**[1] Section:** (file top)
**Lines:** 1
**Opening words:** "@AGENTS.md"
**Verdict:** KEEP
**Why:** The import that makes the Next.js 16 warning load; load-bearing.
**Verification:** CONFIRMED — `AGENTS.md` exists at repo root, 9 lines, self-describing as written by `next dev`.

**[2] Section:** `# Reelcraft — AI Video Generator`
**Lines:** 3–12
**Opening words:** "Users start from an idea, a script, or a screenplay and"
**Verdict:** KEEP
**Why:** The 8-step vocabulary is referenced by name everywhere else in the file and in code.
**Verification:** CONFIRMED — step names match `STEPS` in `src/lib/config/pipeline.ts` plus `storyboard`/`intake` as documented.

**[3] Section:** `## Stack`
**Lines:** 14–23
**Opening words:** "- Claude API: shot-list generation from the intake text, plus"
**Verdict:** KEEP
**Why:** Provider assignment per step; a session would pick the wrong provider without it. The `eleven_v3` clause is the one short why.
**Verification:** CONFIRMED (Anthropic wired); OpenAI/ElevenLabs/fal are stubs — `pricing.ts` has empty rate objects for all three, consistent with "filled in as each provider is wired up."

---

## `## Conventions` (lines 25–411)

**[4]** **Lines:** 26–27 · "- All external API calls happen server-side only (API routes"
**Verdict:** KEEP · **Why:** Security invariant. · **Verification:** N/A

**[5]** **Lines:** 28–33 · "- Design tokens come from the **Reelcraft canvas** in Claude Design"
**Verdict:** KEEP · **Why:** Token source + light-default; a session would hard-code hex without it. · **Verification:** N/A

**[6]** **Lines:** 34–43 · "- **The canvas must be opened and read via the Claude Design MCP"
**Verdict:** REWRITE
**Why:** The rule is load-bearing, but lines 37–40 are a C3 post-mortem that cross-references the `Done` section this audit cuts, leaving a dangling reference.
**Verification:** N/A
**Exact corrected text:**
```
- **The canvas must be opened and read via the Claude Design MCP tools
  before any UI work in this repo — never assumed from a prior session's
  claim to have read it, and never built from a prose description of it.**
  Building from a description instead of the canvas has already cost one
  full presentation rebuild. The canvas can also contain more than one
  vintage of a component's spec (an older section reflecting a schema that
  has since changed, alongside a newer authoritative one) — check for a
  superseding section before treating any single frame as current.
```

**[7]** **Lines:** 44–50 · "- The rail nav is always dark, in both light and dark mode"
**Verdict:** KEEP · **Why:** A session would invert the rail under `.dark` without it. · **Verification:** N/A (token names not code-verified; they are CSS, not TS)

**[8]** **Lines:** 51–53 · "- Fonts: Inter (400/500/600) via `next/font/google`, exposed as"
**Verdict:** KEEP · **Why:** Prevents falling back to the create-next-app default. · **Verification:** N/A

**[9]** **Lines:** 54–56 · "- Dark mode is class-based (`@custom-variant dark (&:where(.dark, .dark *))`"
**Verdict:** KEEP · **Why:** A session would reach for `prefers-color-scheme`. · **Verification:** N/A

**[10]** **Lines:** 57–63 · "- Tailwind gotcha: never name a custom `--spacing-*` theme key after"
**Verdict:** KEEP · **Why:** Silent-failure trap; unrecoverable by reasoning. · **Verification:** N/A

**[11]** **Lines:** 64–74 · "- **One horizontal padding token, no exceptions.** Every block in the"
**Verdict:** KEEP · **Why:** A session adjusting layout would add per-element insets. · **Verification:** N/A

**[12]** **Lines:** 75–76 · "- Do not modify `src/proxy.ts` (Next.js 16's renamed `middleware.ts`)"
**Verdict:** KEEP · **Why:** Explicit do-not-touch. · **Verification:** CONFIRMED — `src/proxy.ts` and `src/lib/supabase/{client,server}.ts` exist.

**[13]** **Lines:** 77–82 · "- Wizard state lives in the DB, not client state. Each step is a real"
**Verdict:** KEEP · **Why:** Architectural invariant plus the intake-is-not-a-step rule. · **Verification:** CONFIRMED — only `/projects/[id]/workbench` is built; `/projects/new` creates the row on submit.

**[14]** **Lines:** 83–89 · "- `/projects/new` creates no DB row on load. The row is created on"
**Verdict:** REWRITE
**Why:** Rule is correct and load-bearing; the file path is stale.
**Verification:** STALE — the file is at `src/app/(app)/projects/new/actions.ts`, not `src/app/projects/new/actions.ts`. (`createProjectFromIntake` confirmed exported there, line 9.)
**Exact corrected text:**
```
- `/projects/new` creates no DB row on load. The row is created on submit
  by `createProjectFromIntake` (`src/app/(app)/projects/new/actions.ts`),
  already fully populated (`source_text`, `video_type`, `aspect_ratio`,
  `duration_target`, `language`, `status: 'draft'`,
  `current_step: 'workbench'`, `furthest_step: 2`), before redirecting into
  `/projects/[id]/workbench`. It writes no `generations` row either — a
  brand-new project simply has none until its first claim.
```

**[15]** **Lines:** 90–96 · "- `dashboard`, `projects/new`, and `projects/[id]/*` live in the"
**Verdict:** KEEP · **Why:** "Don't render a second Rail" and "don't pass it a prop" are both violate-able. · **Verification:** CONFIRMED — `src/app/(app)/layout.tsx` + `src/app/(app)/dashboard/rail.tsx` exist; no other `Rail` render site.

**[16]** **Lines:** 97–98 · "- Claude returns scripts as structured shots (JSON), not prose."
**Verdict:** KEEP · **Why:** One shot = one image = one voiceover segment is a modelling invariant. · **Verification:** N/A

**[17]** **Lines:** 99–101 · "- Model and provider config lives in `src/lib/config/models.ts`, read"
**Verdict:** KEEP · **Why:** "Never hard-code a model name at a call site" is the rule. · **Verification:** CONFIRMED — `modelsConfig` reads every model from env with defaults.

**[18]** **Lines:** 102–165 · "- **Video-model duration registry.** `src/lib/config/models.ts` also"
**Verdict:** MOVE
**Why:** 64 lines. The rule is four facts; the rest is a per-prompt changelog of how the discriminated union came to be, plus rationale that is already a comment inside `models.ts` itself.
**Verification:** CONFIRMED — `VIDEO_MODELS`, `VideoModelConfig` discriminated union (`kind: 'continuous' | 'discrete'`), `mochi-1` continuous 1.4–5.4, `'Kling 2.1'` discrete `[5, 10]`, `DEFAULT_VIDEO_MODEL = 'mochi-1'`, `resolveVideoModel` (throws outside production, `null` in production), `isDurationAllowed` — all present in `src/lib/config/models.ts`.
**Exact compressed replacement text:**
```
- **Video-model duration registry.** `src/lib/config/models.ts` exports
  `VIDEO_MODELS` (keyed by the literal string `projects.video_model` can
  hold — no normalization layer), `resolveVideoModel(id)`, and
  `isDurationAllowed(config, seconds)`. `VideoModelConfig` is a
  discriminated union on `kind: 'continuous' | 'discrete'` — a model
  cannot be defined without picking one, because a discrete model (Kling
  2.1: exactly 5s or 10s) would otherwise let a stepper produce a value
  the provider rejects at Step 7, after everything upstream was paid for.
  Adding a model is one entry here. `resolveVideoModel` never falls back
  to another model's bounds: it throws outside production and returns
  `null` in production. `ProjectHeader`'s chip-label lookup deliberately
  uses the opposite fallback (raw value, never blank) — different failure
  costs, both correct.
```

**[19]** **Lines:** 166–175 · "- Pricing lives in `src/lib/config/pricing.ts`, separate from"
**Verdict:** KEEP · **Why:** "Don't compute cost anywhere else" + `RATE_VERSION` bump duty. · **Verification:** CONFIRMED — `RATE_VERSION = '2026-09-01'`; `OPENAI_RATES`/`ELEVENLABS_RATES`/`FAL_RATES` are empty stubs; `computeCost` exported.

**[20]** **Lines:** 176–179 · "- **Provider calls.** See `## Provider calls` below for the gateway"
**Verdict:** KEEP · **Why:** The `ALLOW_REAL_CLAUDE` prohibition is worth stating twice; this is the pointer copy. · **Verification:** N/A

**[21]** **Lines:** 180–190 · "- Duration → shot-count/credit mapping lives in `src/lib/config/duration.ts`"
**Verdict:** KEEP · **Why:** Single-source rule plus `DEFAULT_DURATION_TARGET`. · **Verification:** CONFIRMED — `durationConfig`, `DEFAULT_DURATION_TARGET = '30-60s'`, `targetShots`/`estimatedCredits`/`targetSecondsMax` all present.

**[22]** **Lines:** 191–217 · "- **`targetShots` is a hard ceiling, not a soft target.** Source text may"
**Verdict:** MOVE
**Why:** The three enforcement points are the rule; the paragraph on *why the intake check warns rather than blocks* and *why the server never truncates* is a decision record that stops a future session undoing it, not something needed to follow it.
**Verification:** CONFIRMED — `buildWriteShotsTool(targetShots)` sets `maxItems: targetShots` (`shot-generation.ts:62`); `SHOT_GENERATION_SYSTEM_PROMPT_V4` and `buildShotsDynamicBlock` exist; `intake-form.tsx` has `SHOT_COUNT_PATTERN` + a `data-testid="shot-count-warning"` styled `text-status-active-fg`; `shots/logic.ts:241` logs `[shots] over_count …`.
**Exact compressed replacement text:**
```
- **`targetShots` is a hard ceiling, not a soft target** — fewer shots than
  the tier is honored, more is never persisted. Enforced at three points,
  all of which must stay: `buildWriteShotsTool(targetShots)`'s `maxItems`
  (primary — a constraint the model cannot exceed), the system prompt's
  "hard maximum" wording, and a non-blocking amber intake hint. The intake
  check warns and must never block (the regex has no semantics and
  false-positives readily); `runShotsPipeline` must never truncate an
  over-count result (the call is already paid for) — it persists in full
  and logs `[shots] over_count …`.
```

**[23]** **Lines:** 218–228 · "- **Tool-schema cost note (C3 prompt 1).** `write_shots`' schema grew a"
**Verdict:** CUT
**Why:** Pure past-tense changelog about a calibration figure being stale; no instruction a session could follow or violate.
**Verification:** CONFIRMED as accurate but non-actionable — `estimateInputTokens` does `JSON.stringify(params.tools)` (`quote.ts`).

**[24]** **Lines:** 229–239 · "- `src/lib/config/pipeline.ts` is the single source for the pipeline's"
**Verdict:** KEEP
**Why:** Two rules a session would violate: mirror CHECK constraints by hand when the arrays change, and never render a raw step/operation/provider/model value in UI.
**Verification:** CONFIRMED — `STEPS`, `OPERATIONS`, `PROVIDERS`, `STEP_OPERATIONS`, `stepOperationLabel`, `stepIndex` all exported from `pipeline.ts`.

**[25]** **Lines:** 240–264 · "- `src/lib/config/enums.ts` is the single hand-written source for"
**Verdict:** REWRITE
**Why:** The source-of-truth rule and the "never derive from `database.types.ts`" reason are load-bearing. Lines 256–264 are a correction-of-a-prior-correction narrative referencing "C3 prompt 1."
**Verification:** CONFIRMED — all named exports present in `enums.ts`, including `CAMERA_ORIGINS` and `MODEL_REPORTABLE_CAMERA_ORIGINS`; `elements_type_check` confirmed in `20260827051112_elements_and_shot_elements.sql`.
**Exact corrected text:**
```
- `src/lib/config/enums.ts` is the single hand-written source for
  `video_type` (plus `CLASSIFIABLE_VIDEO_TYPES`), `aspect_ratio`,
  `shot_size`, `camera_angle`, `camera_movement`, `element_type`, and
  `camera_origin` (plus `MODEL_REPORTABLE_CAMERA_ORIGINS`, which drops
  `'override'` so the model can never report it). Never derived from
  `database.types.ts`: the Supabase codegen types a CHECK-constrained text
  column as plain `string`. Every one of these has a real DB CHECK
  constraint, mirrored by hand in a migration and enforced by
  `tests/enums-drift.spec.ts`. This is a different axis from
  `pipeline.ts` — that file describes the pipeline, this one describes
  shot attributes and project settings; keep them separate.
  `buildWriteShotsTool` and `sanitizeEnum`'s call sites both import from
  here, so the tool schema can never drift from its validator.
```

**[26]** **Lines:** 265–269 · "- `displayTitle(project)` (`src/lib/display-title.ts`) is the single"
**Verdict:** KEEP · **Why:** A session would read `title` directly. · **Verification:** CONFIRMED — `src/lib/display-title.ts` exists.

**[27]** **Lines:** 270–272 · "- Anything the UI needs from a Claude call goes in the tool schema, not"
**Verdict:** KEEP · **Why:** Real failure mode (tool_use with no text block). · **Verification:** N/A

**[28]** **Lines:** 273–279 · "- Playwright uses `channel: 'chrome'` (macOS 12 has no bundled chromium"
**Verdict:** REWRITE
**Why:** The `channel: 'chrome'` half is load-bearing. The auth half contradicts the Testing section's canonical `storageState`-first rule (item 50) and would lead a session to write a new spec with `createTestSession()`.
**Verification:** STALE (auth half) — `playwright.config.ts` sets `use.storageState: './tests/.auth/primary.storageState.json'` as the default for every spec; `createTestSession()` is now the documented exception, not the pattern.
**Exact corrected text:**
```
- Playwright uses `channel: 'chrome'` (macOS 12 has no bundled chromium
  build). Don't run `npx playwright install chromium`. Auth, fakes, and
  the live-call run guard are all covered in the Testing section below —
  read it before writing a spec.
```

**[29]** **Lines:** 280–283 · "- Schema changes go in `supabase/migrations/` via `supabase migration new`,"
**Verdict:** KEEP · **Why:** Migration + typegen sequence; the exact thing a session gets wrong. · **Verification:** CONFIRMED — `npm run types:db` = `supabase gen types typescript --linked > src/lib/database.types.ts`.

**[30]** **Lines:** 284–285 · "- Supabase clients are typed with the generated `Database` type."
**Verdict:** KEEP · **Why:** "Read the types file, don't infer." · **Verification:** CONFIRMED

**[31]** **Lines:** 286–293 · "- Prompt caching is wired on both `/prompts` and `/shots` but is"
**Verdict:** KEEP
**Why:** The instruction "don't pad prompts to reach the threshold" is exactly a wrong thing a session would otherwise do on seeing zeroed cache buckets.
**Verification:** CONFIRMED — `prompts/logic.ts:353` passes `cache_control: { type: 'ephemeral' }`.

**[32]** **Lines:** 294–297 · "- Tailwind v4 gotcha: `<button>` has no default `cursor: pointer`"
**Verdict:** KEEP · **Why:** Silent v3→v4 difference. · **Verification:** N/A

**[33]** **Lines:** 298–304 · "- Shot keys are stable and immutable. `shots.shot_key` is 5 lowercase"
**Verdict:** KEEP
**Why:** Canonical location for the shot-key rule (item 55 cuts the Database duplicate). "Never a Postgres function" and "never shown in the UI" are both violate-able.
**Verification:** CONFIRMED — `src/lib/shot-key.ts` exports `generateUniqueShotKeys` and `isUniqueViolation`; unique constraint in `20260827062037_backfill_shot_key_and_constrain_unique.sql`.

**[34]** **Lines:** 305–315 · "- `workbench-shell.tsx` (`src/components/workbench-shell.tsx`) is the"
**Verdict:** REWRITE
**Why:** The slot contract and "don't hoist a step's specifics into the shell" are load-bearing. "below the credits block" is stale.
**Verification:** STALE (one clause) — `rail.tsx:105` renders a **"Usage spending"** block, not a credits block; there is no credit system (a dollar figure is shown).
**Exact corrected text:**
```
- `workbench-shell.tsx` (`src/components/workbench-shell.tsx`) is the
  shared chrome for Steps 2–8: a `header` slot, the 8-step indicator, the
  agent panel, a `children` content slot, and an optional `footer` slot.
  The rail is present on these routes but comes from the `(app)` route
  group's layout, not from the shell — the shell renders no `Rail` of its
  own. Project routes have no top bar at all; the user menu lives in the
  rail footer, below the "Usage spending" block. Step-specific UI
  (sub-tabs, tab bodies, footer contents) is deliberately not in the
  shell — don't hoist a step's specifics into it ahead of the step that
  needs them.
```

**[35]** **Lines:** 316–322 · "- The agent panel's message list has a fixed six-kind taxonomy across"
**Verdict:** KEEP · **Why:** Fixed taxonomy — a session would invent a seventh kind. · **Verification:** CONFIRMED — `AgentMessageKind` is exactly those six in `src/components/workbench/agent-message.tsx`.

**[36]** **Lines:** 323–372 · "- **Per-field save model (C3 prompt 2).** The Step 2 shot card has no"
**Verdict:** MOVE
**Why:** 50 lines. The rules are: no Save button, no dirty state, per-field independent save, field-attributed results, diff-before-write, two-tier status, `React.memo`. Lines 359–372 are prompt-by-prompt history *and* contain stale claims.
**Verification:** CONFIRMED for the save model — `updateShotVoiceOver`/`updateShotVisualDescription`/`updateShotDuration`/`updateShotSize`/`updateShotCameraAngle`/`updateShotCameraMovement`/`saveDialogueLine`/`deleteDialogueLine` all exported from `src/app/(app)/projects/[id]/workbench/actions.ts`; `ShotFieldSaveResult` is field-attributed; `use-field-save.ts` and `save-status-indicator.tsx` exist.
**STALE within the block (lines 359–372):** (a) "`camera-origin-fields.tsx` renders a real `<select>` per field" — it renders `CustomSelect` (`custom-select.tsx`, a WAI-ARIA combobox); no native `<select>` remains in `src`. (b) "`Revert to auto` is a real button" — the control is now labelled **"Reset to auto"** (`camera-origin-fields.tsx:151`), with a sibling **"Reset all to auto"** (`camera-derivation-status.tsx:82`). (c) "The bound-elements `+` toggle … remain inert" — there is **no** `+` toggle in `bound-elements.tsx`; the hover-to-unbind affordance was deliberately not built at all.
**Exact compressed replacement text:**
```
- **Per-field save model.** The Step 2 shot card has no Save button and no
  dirty state, anywhere. Every field saves independently the moment the
  person leaves it: text on blur, selects on change, the duration stepper
  on each +/- press. One field's write never touches another's — there is
  no batched save-the-card action. Server actions live in
  `src/app/(app)/projects/[id]/workbench/actions.ts`, return a plain
  result object (never thrown), verify ownership via an explicit
  `projects!inner(user_id)` join (`shots`/`shot_dialogue` have no
  `user_id`; RLS is the backstop, not the only check), and are **field-
  attributed** — every result names which field it saved, so a card with
  several fields mid-edit retries exactly the one that failed. Each action
  diffs against the persisted value first: an edit resolving to the same
  value performs no write and sets no staleness flag. No `revalidatePath`
  anywhere in this repo — a successful save updates local state via
  `ShotsProvider`'s `updateShotLocal`. Status renders in two tiers:
  per-field (`useFieldSave` + `save-status-indicator.tsx`, decaying from
  "saved" after 2s, field never disabled while saving) and a per-card
  header rollup showing the worst state (failed > saving > saved > quiet).
  Field subcomponents are `React.memo`'d so one field's status change does
  not re-render its siblings. The selects are `CustomSelect`
  (`custom-select.tsx`), not native `<select>`; `Delete shot` renders
  inert pending C4.
```

**[37]** **Lines:** 373–394 · "- **Duration stepper bounds and the over-target/out-of-range split (C3"
**Verdict:** MOVE
**Why:** The two-conditions-not-one rule is load-bearing; the paragraph explaining why locked shots aren't painted amber is a decision record.
**Verification:** CONFIRMED — `project-header.tsx` computes `totalSeconds` from the `shots` array and `isOverTarget` against `tierConfig.targetSecondsMax`; no extra fetch.
**Exact compressed replacement text:**
```
- **Duration: two independent conditions, never conflated.** The stepper
  moves in 0.1s steps (always one decimal) against bounds resolved from
  the project's `video_model` — never a fixed constant, and never frame
  counts or a provider name in copy. A **saved duration invalid for the
  current model** is per-shot: amber on that shot's own stepper, value
  never silently rewritten, copy naming the way out. An **aggregate
  over-target overrun** (sum vs. `durationConfig[...].targetSecondsMax`)
  is project-level: stated once on the header's Current total, and
  deliberately not repeated on every locked shot's stepper.
```

**[38]** **Lines:** 395–401 · "- The step indicator (`workbench-step-indicator.tsx`) only links a step"
**Verdict:** KEEP
**Why:** The "only link a built step; `intake` is always inert" rule stands. The trailing "(see Current focus)" cross-reference dies with item 111 — drop those three words when applying.
**Verification:** CONFIRMED — `workbench-step-indicator.tsx:86` derives `currentIndex` from `STEPS.findIndex(step.key === currentStep)`; no `furthest_step` read anywhere in the file.

**[39]** **Lines:** 402–405 · "- `src/lib/video-type-labels.ts` and `src/lib/language-labels.ts` are the"
**Verdict:** REWRITE
**Why:** Correct but incomplete — a third label module now exists and a session would re-inline its mapping, which is the exact thing this bullet exists to prevent.
**Verification:** CONFIRMED for the two named; **incomplete** — `src/lib/camera-labels.ts` (`shotSizeLabel`/`cameraAngleLabel`/`cameraMovementLabel`) exists and is unmentioned anywhere in `## Conventions`.
**Exact corrected text:**
```
- `src/lib/video-type-labels.ts`, `src/lib/language-labels.ts`, and
  `src/lib/camera-labels.ts` are the single source for turning raw
  `video_type` / `language` / `shot_size` / `camera_angle` /
  `camera_movement` codes into display labels. All three are
  display-only: stored values, the enum tuples, the DB CHECK constraints,
  and the tool schema stay exactly as persisted. Don't inline a second
  copy of any of these mappings.
```

**[40]** **Lines:** 406–411 · "- A system prompt that's been explicitly pulled out of its route gets"
**Verdict:** KEEP · **Why:** Versioned-module convention plus the honest "not every route follows this yet — check." · **Verification:** CONFIRMED — `PROMPTS_SYSTEM_PROMPT` is still inline at `prompts/logic.ts:70`; `src/lib/prompts/` holds `shot-generation.ts` and `camera-derivation.ts`.

---

## `## Provider calls` (lines 413–451)

**[41]** **Lines:** 414–419 · "- `ClaudeGateway` (`src/lib/claude.ts`) is the only place `@anthropic-ai/sdk`"
**Verdict:** KEEP · **Why:** The seam. A session would `new Anthropic()` at a call site. · **Verification:** CONFIRMED — `src/lib/claude.ts:49` is the only `new Anthropic(...)`; `tests/helpers/claude-fakes.ts` exists.

**[42]** **Lines:** 420–430 · "- `assertLiveCallsAllowed()` runs at call time, inside `createMessage`, not"
**Verdict:** KEEP · **Why:** Exact-string-match semantics and the `instanceof`-not-message-text detection rule. · **Verification:** CONFIRMED — `claude.ts:29-32` (production early-return, `=== '1'` exact match, `throw new LiveCallsBlockedError()`); `reserve-settle.ts:120` uses `params.error instanceof LiveCallsBlockedError`.

**[43]** **Lines:** 431–435 · "- **Never set, export, or add `ALLOW_REAL_CLAUDE` to any env file, npm"
**Verdict:** KEEP · **Why:** Highest-consequence prohibition in the file, including the "stop and say so" escape hatch. · **Verification:** CONFIRMED — the flag appears in no npm script, no `.env.example` line, and is force-emptied in `playwright.config.ts`.

**[44]** **Lines:** 436–442 · "- Playwright has no live path, enforced three times over:"
**Verdict:** KEEP
**Why:** Canonical location for the three-guard description. Item 47 cuts the near-verbatim copy in `## Testing`.
**Verification:** CONFIRMED all three — `tests/global-setup.ts:80` throws; `tests/load-env.ts` ends with `delete process.env.ALLOW_REAL_CLAUDE`; `playwright.config.ts` `webServer.env: { ALLOW_REAL_CLAUDE: '' }`. No `test:live` script in `package.json`.

**[45]** **Lines:** 443–451 · "- Calls are streaming-only (`messages.stream()` + `finalMessage()`, never"
**Verdict:** KEEP · **Why:** `maxRetries: 0` is a money rule; a session would "fix" it. · **Verification:** CONFIRMED — `claude.ts:49` `new Anthropic({ maxRetries: 0, timeout: 600_000 })`, `:53` `client.messages.stream(params)`, `:54` `finalMessage()`; `shots/route.ts:6` `export const maxDuration = 300`.

---

## `## Testing` (lines 453–543)

**[46]** **Lines:** 454–459 · "- Business logic (`runShotGeneration`, etc.) is tested by injecting a"
**Verdict:** KEEP · **Why:** "Never a fixture/scenario system, never an env var selecting behavior" is a design prohibition. · **Verification:** CONFIRMED — `tests/helpers/claude-fakes.ts` exists; no test calls `createClaudeGateway()`.

**[47]** **Lines:** 460–467 · "- `tests/global-setup.ts` throws unconditionally if `ALLOW_REAL_CLAUDE=1`"
**Verdict:** CUT
**Why:** Near-verbatim duplicate of item 44. Nominate `## Provider calls` (item 44) as canonical; the one unique clause here — the sanctioned live path is `npm run dev` with the flag exported by hand — should be folded into item 44's block when applying.
**Verification:** CONFIRMED (accurate, but duplicated)

**[48]** **Lines:** 468–470 · "- Caveat: the guard cannot protect a manually pre-started `npm run dev`"
**Verdict:** KEEP · **Why:** A real hole in the guard a session must know about. · **Verification:** CONFIRMED — `playwright.config.ts` sets `reuseExistingServer: true`.

**[49]** **Lines:** 471–473 · "- Any test that drives the retry control through the UI must go through"
**Verdict:** KEEP · **Why:** A session would write `page.on('dialog', …)`. · **Verification:** CONFIRMED — `retry-confirm-modal.tsx` exists and portals a dialog; no `window.confirm` in `src`.

**[50]** **Lines:** 474–492 · "- **Auth in tests is `storageState`-first, not per-test `createTestSession()`.**"
**Verdict:** MOVE
**Why:** The rule (import from `tests/fixed-users.ts`) is four lines. The rate-limit arithmetic and the opt-in-mechanism-exists-for-a-future-spec note are the argument.
**Verification:** CONFIRMED — `global-setup.ts` uses fixed emails `pw-fixed-primary@reelcraft.local` / `pw-fixed-secondary@reelcraft.local`, writes both `{name}.storageState.json` and `{name}.session.json` under `tests/.auth/`; `playwright.config.ts` consumes the primary as `use.storageState`.
**Exact compressed replacement text:**
```
- **Auth in tests is `storageState`-first.** `tests/global-setup.ts`
  authenticates two fixed, reused-across-runs identities (`primary`,
  `secondary`) once per run and writes each to
  `tests/.auth/{name}.storageState.json` (consumed as
  `playwright.config.ts`'s default `use.storageState`) and
  `tests/.auth/{name}.session.json` (raw tokens, for a spec needing a
  Supabase client rather than a browser). `tests/.auth/` is gitignored.
  Import `primary`/`secondary` from `tests/fixed-users.ts`, not
  `createTestSession()`, unless the spec is one of the exceptions below —
  Supabase's hosted auth rate-limits magic-link `verifyOtp` to roughly
  30/hour per project, which a per-test-user suite exhausts on its own.
  A spec needing `secondary`'s browser identity opts in with
  `test.use({ storageState: SECONDARY_STORAGE_STATE })`.
```

**[51]** **Lines:** 493–512 · "- **Specs assert against their own project's rows, not global per-user totals.**"
**Verdict:** KEEP
**Why:** The rule plus the enumerated five exceptions with a "do not 'fix' these" instruction — a session would otherwise convert them and break the suite. Drop the "(Task 3's explicit trade-off …)" parenthetical on lines 495–497 when applying.
**Verification:** CONFIRMED — `createTestSession` is imported by `new-project-intake.spec.ts`, `usage-page.spec.ts`, and `usage-module.spec.ts`; the only other `tests/*.spec.ts` match (`retry-partial-phase.spec.ts`) is a comment, not a call. The five listed exceptions are accurate and complete.

**[52]** **Lines:** 513–518 · "- Moving to a local Supabase instance (`supabase start`) is the eventual"
**Verdict:** CUT
**Why:** Roadmap. "The eventual answer … deliberately not done here" reads as licence to migrate the test harness.
**Verification:** N/A

**[53]** **Lines:** 519–543 · "- **`primary`/`secondary` accumulate `projects`/`usage` rows every run**"
**Verdict:** MOVE
**Why:** 25 lines. Two rules matter: teardown is `globalTeardown` (never `afterEach`), and it deletes `usage` **first** by `user_id`. The parallelism explanation and the swallow-failure rationale are the argument.
**Verification:** CONFIRMED — `playwright.config.ts` wires `globalTeardown: './tests/global-teardown.ts'` and `fullyParallel: true`; the teardown deletes `usage` (line 27) then `projects` (line 37), `console.error`s and never rethrows (line 47).
**Exact compressed replacement text:**
```
- **`tests/global-teardown.ts` cleans up the fixed users' rows once per
  run.** It must stay a `globalTeardown`, never an `afterEach` — the suite
  is `fullyParallel`, so per-test cleanup of *shared* fixed-user data
  would delete rows an in-flight test is still asserting against. It
  deletes `usage` rows first, explicitly, `WHERE user_id IN (...)`, before
  `projects`: `usage.project_id` is `ON DELETE SET NULL`, not `CASCADE`,
  so the reverse order orphans rather than removes them. It reads its ids
  from `tests/fixed-users.ts` — never by pattern, never a truncate. The
  two auth users themselves are never deleted. A teardown failure is
  logged and swallowed, never rethrown.
```

---

## `## Database` (lines 545–833)

**[54]** **Lines:** 546–555 · "Tables: `projects`, `shots` (renamed from `scenes`), `elements`,"
**Verdict:** KEEP
**Why:** The three RLS ownership patterns (single-level `exists`, two-level join for `shot_elements`, denormalized `user_id` for `usage`) are what a session gets wrong writing a new policy. Drop "(renamed from `scenes`)" when applying.
**Verification:** CONFIRMED — `database.types.ts` lists exactly `elements`, `generations`, `messages`, `projects`, `shot_dialogue`, `shot_elements`, `shots`, `usage`.

**[55]** **Lines:** 557–559 · "`shots.shot_key` is a stable, immutable 5-character key (see Conventions)"
**Verdict:** CUT
**Why:** Duplicate of item 33. Nominate `## Conventions` (item 33) as canonical.
**Verification:** CONFIRMED (accurate, duplicated)

**[56]** **Lines:** 561–567 · "`shots` craft fields: `visual_description`; `shot_size` / `camera_angle` /"
**Verdict:** CUT
**Why:** Restated column list. Line 1234 already says "Read `src/lib/database.types.ts` for columns — don't rely on this file," which this contradicts by inviting reliance.
**Verification:** CONFIRMED (accurate today, which is precisely the drift risk)

**[57]** **Lines:** 569–585 · "**Camera fields have three independent origins, not a boolean.** As of"
**Verdict:** KEEP
**Why:** The *semantics* of `auto`/`derived`/`override` are not derivable from the code, and the "one origin per field independently, never a shared flag" invariant governs every camera write. Drop "As of C3 prompt 1, `shots.camera_overridden` … is replaced by" and state it in the present tense.
**Verification:** CONFIRMED — `CAMERA_ORIGINS` and `MODEL_REPORTABLE_CAMERA_ORIGINS` in `enums.ts`; `camera_overridden` no longer appears in `database.types.ts`.

**[58]** **Lines:** 587–597 · "`runShotsPipeline` sanitizes an unrecognized/missing origin to `'auto'`"
**Verdict:** REWRITE
**Why:** The sanitize-to-`'auto'` rule is load-bearing; the backfill narrative is one-time migration history.
**Verification:** CONFIRMED — `shots/logic.ts:222-225` `sanitizeEnum(..., MODEL_REPORTABLE_CAMERA_ORIGINS) ?? 'auto'`.
**Exact corrected text:**
```
`runShotsPipeline` sanitizes an unrecognized or missing origin to `'auto'`
(the columns are `NOT NULL`) rather than nulling — `'auto'` never claims
the description named a camera choice the model didn't report. Nothing
ever backfills to `'derived'`: that would need a paid Claude call per shot
for a cosmetic result. Pre-existing shots read as `auto` and become
accurate the first time they're re-derived.
```

**[59]** **Lines:** 599–614 · "**Camera fields are editable and AI-re-derivable as of C3 prompt 3.**"
**Verdict:** MOVE
**Why:** One rule survives compression and is genuinely violate-able: the diff-before-write compares the **`(value, origin)` pair**, not value alone. The rest restates the save pattern already stated in item 36.
**Verification:** CONFIRMED — `updateShotSize`/`updateShotCameraAngle`/`updateShotCameraMovement` at `actions.ts:178/182/186`.
**Exact compressed replacement text:**
```
The three camera selects save independently on change, via the same
per-field pattern as every other field, and set **that field's** origin to
`'override'` plus that shot's `image_prompt_stale`/`video_prompt_stale` —
the other two origins are untouched, always. The diff-before-write check
compares the `(value, origin)` pair, not value alone: the same value while
origin is still `'auto'`/`'derived'` is a real write, not a no-op.
```

**[60]** **Lines:** 616–632 · "**Camera-scope invariant.** A camera field may be written ONLY if it is"
**Verdict:** KEEP
**Why:** The single most consequential rule in this section. Cut only the closing bug post-mortem (lines 629–632, "This closed a real bug: …") — the invariant is stated without it.
**Verification:** CONFIRMED — `camera/route.ts`'s `parseFields` rejects non-array, empty, unknown member, and duplicates with a `400` before any DB read or gateway construction; `logic.ts` takes `fields` as-is with no fallback.

**[61]** **Lines:** 634–657 · "**`POST /api/projects/[id]/shots/[shotId]/camera`** (`logic.ts`'s"
**Verdict:** MOVE
**Why:** The three trigger shapes and their exact `fields`/`revertField`/`resetAll` payloads are needed to call the route correctly; the force-apply-vs-two-step comparison is the argument.
**Verification:** CONFIRMED — route accepts `fields`, `revertField`, `resetAll`; `runCameraDerivation` in `src/app/api/projects/[id]/shots/[shotId]/camera/logic.ts`.
**Exact compressed replacement text:**
```
**`POST /api/projects/[id]/shots/[shotId]/camera`** (`runCameraDerivation`)
is the AI re-derivation that produces `'derived'`. Three client triggers,
one function: a changed `visual_description` save sends all three fields;
a single-field "Reset to auto" sends `fields: [thatField], revertField:
thatField` as **one combined call** (never an origin flip followed by a
route call); "Reset all to auto" sends all three plus `resetAll: true`.
Nothing is written to `shots` until a successful response, so a failed
revert or reset leaves every touched field completely untouched.
```

**[62]** **Lines:** 659–671 · "**Change B: there is no \"all fields already override → skip\" guard.**"
**Verdict:** MOVE
**Why:** Textbook "stops a future session from UNDOING the rule but is not needed to FOLLOW it" — a session re-adding the guard is exactly the risk, so one clause must survive.
**Verification:** CONFIRMED — no all-override skip exists in `shot-card.tsx` or `camera/logic.ts`.
**Exact compressed replacement text:**
```
There is deliberately **no** "all three fields already override → skip"
guard on the description-edit trigger, at either layer: it blocked exactly
the case where the user's intent was most deliberate. Do not re-add one.
```

**[63]** **Lines:** 673–692 · "**Trigger (a) always asks Claude about all three fields, including ones"
**Verdict:** MOVE
**Why:** The write-back rule (apply unconditionally to `auto`/`derived` and to `resetAll`/`revertField` targets; apply to an `'override'` field **only** when the answer is `'derived'`) is load-bearing and must be kept. The "why not filter the schema per call" comparison is the argument.
**Verification:** CONFIRMED — the tool schema's origin enum is `MODEL_REPORTABLE_CAMERA_ORIGINS` (`enums.ts`), making `'override'` structurally unreachable from the model.
**Exact compressed replacement text:**
```
Claude is always asked about all three fields, including `'override'`
ones — it cannot judge a field it is never told about. Code alone decides
per field whether to apply the answer: unconditionally for an
`'auto'`/`'derived'` field and for any `resetAll`/`revertField` target;
for an `'override'` field **only when the answer is `'derived'`** (real
textual evidence). An answer of `'auto'` for an override field means "no
evidence," not "revert," and changes nothing. This is the
description-wins-over-a-prior-manual-choice rule. `'override'` is
unreachable from the model by schema, not by validation.
```

**[64]** **Lines:** 694–719 · "**`derive_camera` writes a `usage` row but deliberately never a"
**Verdict:** MOVE
**Why:** Two rules matter (no `generations` row for this operation; the client-side coalescing guard never drops a queued trigger). The `'succeeded'`-is-terminal reasoning, the `OPERATION_POLICY`/C4 forward reference, and the dropped-vs-queued comparison are the argument — and the C4 reference is roadmap.
**Verification:** CONFIRMED — `pipeline.ts`'s `OPERATIONS` includes `'derive_camera'` with an inline comment saying `generations_operation_check` is not widened; `20260902200658_add_derive_camera_operation.sql` widens only `usage_operation_check`; `use-camera-derivation.ts` exists.
**Exact compressed replacement text:**
```
**`derive_camera` writes a `usage` row but never a `generations` row** —
the only paid call in the repo with no claim, because `'succeeded'` is
terminal and a claim row would block every subsequent description edit of
the same shot forever. Concurrency is handled client-side instead:
`use-camera-derivation.ts`'s coalescing in-flight guard (one per shot)
holds at most one queued trigger and fires it when the running call
finishes — it never drops one.
```

**[65]** **Lines:** 721–727 · "**`reserveUsage`'s `generationId` param is now `string | null`** (was"
**Verdict:** CUT
**Why:** Restated type signature plus a "was X, is now Y" note. A session reads the signature from the module.
**Verification:** CONFIRMED — `reserve-settle.ts:39` `generationId: string | null`.

**[66]** **Lines:** 729–746 · "**`CLAUDE_CAMERA_MODEL`/`CLAUDE_CAMERA_MAX_TOKENS`** are new entries in"
**Verdict:** MOVE
**Why:** Two rules a session would undo: `camera` is Haiku permanently (not the `isProduction` ternary), and `maxTokens: 128` is deliberately small because `reserveUsage` reserves the full ceiling. Both rationales are already verbatim comments inside `models.ts`; the worked $0.0014 example is the argument.
**Verification:** CONFIRMED — `models.ts` `camera.model` = `process.env.CLAUDE_CAMERA_MODEL ?? 'claude-haiku-4-5-20251001'` with no ternary; `maxTokens` default 128; `.env.example` lines 12–13 carry both vars.
**Exact compressed replacement text:**
```
`modelsConfig.camera` deliberately does **not** use the
`isProduction ? sonnet : haiku` ternary every other section uses — it is
Haiku in both environments, a locked cost decision (mechanical enum
extraction, fired on nearly every description blur). Its `maxTokens`
default of 128 is deliberately small: `reserveUsage` reserves the full
`max_tokens` as its worst-case quote, so a shots-scale ceiling here would
over-reserve ~25x on every edit. Both stay overridable via
`CLAUDE_CAMERA_MODEL` / `CLAUDE_CAMERA_MAX_TOKENS`.
```

**[67]** **Lines:** 748–781 · "**Staleness is set by user edits only, never by a pipeline.**"
**Verdict:** MOVE
**Why:** The which-edit-sets-what table and the `runVoiceoverPipeline` prohibition are both load-bearing and must survive in full. What compresses is the "C3 prompt 1 shipped them with no writers; C3 prompt 2's actions are now those writers" history and the closing "(as of C3 prompt 3 …)" parenthetical.
**Verification:** CONFIRMED — `voiceover_stale` on `projects`, `image_prompt_stale`/`video_prompt_stale` on `shots` in `database.types.ts`; migration `20260902125702_add_staleness_flags.sql`.
**Exact compressed replacement text:**
```
**Staleness is set by user edits only, never by a pipeline.**
`shots.image_prompt_stale` / `shots.video_prompt_stale` and
`projects.voiceover_stale` mark a downstream output invalidated by a later
edit. **`runVoiceoverPipeline` must never write `voiceover_stale`**: Step 3
writes `duration_sec` back onto every unlocked shot, so a pipeline that
also set the flag would invalidate its own output on every successful run —
an unbounded loop, every cycle a paid ElevenLabs call. Which edit sets
what: **voiceover text** → `projects.voiceover_stale` (one continuous
narration file per project, so any narration edit invalidates the whole
render) plus that shot's two prompt flags; **visual description** → that
shot's two prompt flags; **a camera field** (dropdown or AI re-derivation)
→ that shot's two prompt flags, a framing change being exactly as visually
invalidating; **dialogue** → that shot's `video_prompt_stale` only
(on-camera speech, not narration); **duration** → nothing (audio derives
from narration text; a locked-duration mismatch is resolved for free at
Step 5 by retiming). Staleness is a flag, never a null.
```

**[68]** **Lines:** 783–786 · "Every field write above is preceded by a diff against the persisted"
**Verdict:** KEEP · **Why:** "Only an edit that actually changed something marks a field stale." · **Verification:** CONFIRMED — each action in `actions.ts` diffs before writing.

**[69]** **Lines:** 788–807 · "**Character dialogue lives in `shot_dialogue`, a separate table — not a"
**Verdict:** MOVE
**Why:** The table-not-jsonb decision and its RLS shape are rules; the column list is restated schema and the "(As of C3 prompt 1; it was previously …)" clause is history.
**Verification:** CONFIRMED — `shot_dialogue` in `database.types.ts` with FKs to `element_id`/`project_id`/`shot_id`; migration `20260902125705_create_shot_dialogue_and_drop_shots_dialogue.sql`.
**Exact compressed replacement text:**
```
**Character dialogue lives in the `shot_dialogue` table, never a jsonb
column** — a shared array cannot support independent per-row saves without
a read-modify-write race, and the UI and C4's agent tools will write it
concurrently. Its RLS mirrors `shots`'s single blanket policy, keyed on
the denormalized `project_id` rather than joining through `shots`.
`runShotsPipeline` writes dialogue as one uniform batch insert; no
cleanup is needed on retry, since the `shots` delete-before-reinsert
already cascades it.
```

**[70]** **Lines:** 809–827 · "**C3 prompt 2's dialogue speaker rule.** The speaker dropdown in the"
**Verdict:** KEEP
**Why:** Four rules a session would violate: only that shot's bound characters, out-of-list values render read-only (never blanked, never reassigned), `+ Add line` disabled with the reason shown, nothing persists until both fields are filled, removal re-sequences `order_index` with a plain UPDATE loop (no RPC). Drop the "C3 prompt 2's" prefix and the "(binding is C5's job — see Current focus)" cross-reference.
**Verification:** CONFIRMED — `dialogue-section.tsx` / `dialogue-row.tsx` exist; `saveDialogueLine`/`deleteDialogueLine` exported; no `.rpc()` anywhere in `src` except two comments saying it is forbidden.

**[71]** **Lines:** 829–833 · "`elements` (character / location / prop) are deduped per project by"
**Verdict:** KEEP · **Why:** The `lower(name)` unique index drives `resolveElement`'s replay behaviour. · **Verification:** CONFIRMED — `elements` table with `type` CHECK in `20260827051112_elements_and_shot_elements.sql`.

---

## `## Phase 1: generations and the recreated usage` (lines 835–1252)

**[72]** **Lines:** 837–852 · "`generations` holds claim/lock state for every operation that fires a"
**Verdict:** REWRITE
**Why:** The "why a table, not per-step columns on `projects`" reason is load-bearing (it governs where a future Step 7 per-shot claim goes). The `jobs`-table history and the full column dump are not.
**Verification:** CONFIRMED — `generations` columns match `database.types.ts`; `20260831095602_drop_jobs_create_generations.sql`.
**Exact corrected text:**
```
`generations` holds claim/lock state for every operation that fires a paid
external API call. It is a table rather than per-step columns on
`projects` because Step 7 regenerates individual clips per shot: a
project-level column cannot express "this one shot's clip is
mid-generation while the others are idle," but a `shot_id`-scoped row can
(`shot_id` is null for a project-level operation). `payload` holds the raw
provider payload, written before any derived rows.
```

**[73]** **Lines:** 854–866 · "The table implements an **insert-to-claim** pattern: a row's mere"
**Verdict:** KEEP
**Why:** Three invariants: the row's existence *is* the lock; RLS needs an explicit UPDATE policy or settle fails silently; `NULLS NOT DISTINCT` is load-bearing and removing it defeats the guard.
**Verification:** CONFIRMED — `20260831095602_drop_jobs_create_generations.sql:49` creates `generations_identity_idx` on `(project_id, step, operation, shot_id) NULLS NOT DISTINCT`.

**[74]** **Lines:** 868–891 · "`src/lib/generations/claim.ts` is the one module that reads or writes"
**Verdict:** MOVE
**Why:** 24 lines restating `claimGeneration`'s branch table, which is in the module and in `tests/generations-claim.spec.ts`. Three things must survive: nothing writes those columns inline, 23505 is detected by **error code**, and a reclaim never touches `payload`.
**Verification:** CONFIRMED — `claim.ts` exports `claimGeneration`/`persistGenerationPayload`/`settleGeneration` and `STALE_AFTER_MS = 15 * 60 * 1000`; `isUniqueViolation` (`shot-key.ts:22`) compares `error.code === UNIQUE_VIOLATION`, never message text.
**Exact compressed replacement text:**
```
`src/lib/generations/claim.ts` is the one module that reads or writes
`state`/`payload`/`started_at`/`error` — every claimant goes through
`claimGeneration`/`persistGenerationPayload`/`settleGeneration`, and
nothing writes those columns inline. The claim is a plain `INSERT`; a
`23505` unique violation is detected by **Postgres error code**
(`isUniqueViolation`), never by string-matching the message. Every reclaim
is a conditional `UPDATE` filtered on the exact state it expects, so a
race loser is refused uniformly. A reclaim never touches `payload` — a
stale or failed row may already carry one Claude was paid for, and RECOVER
must still see it.
```

**[75]** **Lines:** 893–901 · "**The `ready` → `succeeded` rename happens in exactly one place**:"
**Verdict:** REWRITE
**Why:** The rename is dead history (nothing named `ready` exists). The payload-clearing contract inside it is a real rule.
**Verification:** CONFIRMED — `claim.ts:170` writes `state: params.success ? 'succeeded' : 'failed'`; no `'ready'` literal remains in `src`.
**Exact corrected text:**
```
`settleGeneration` always clears `payload` on success (it was only ever a
recovery aid for an in-flight or failed attempt), and clears it on failure
only when the caller explicitly asks — the `max_tokens` truncation case.
Otherwise a failed row's payload survives for RECOVER.
```

**[76]** **Lines:** 903–913 · "`generations` is used by both `/shots` (`step: 'workbench'`, `operation:"
**Verdict:** KEEP
**Why:** The two claim identities are what a new route copies from. Drop "as of Phase 1 prompt 3", the deleted-`generation-lock.ts` history (lines 908–911), and the trailing cross-reference to the provisional-attribution note (cut as item 97).
**Verification:** CONFIRMED — `generation-lock.ts` does not exist; no `generating_at` in `database.types.ts`.

**[77]** **Lines:** 915–927 · "`usage` is the model-spend ledger, one row per provider call — dropped"
**Verdict:** REWRITE
**Why:** "One row per provider call" and "`computeCost` computes it, never inline a second calculation" are rules. The full column list and the discarded-old-rows history are not.
**Verification:** CONFIRMED — `usage` shape in `database.types.ts` matches; `20260831095628_drop_and_recreate_usage.sql`.
**Exact corrected text:**
```
`usage` is the model-spend ledger: one row per provider call, provider-
neutral. `estimated_cost` is computed by `computeCost`
(`src/lib/config/pricing.ts`) — never inline a second cost calculation.
`raw_usage` is jsonb shaped `{ breakdown: <provider's own numbers>,
rates: <rates applied> }`.
```

**[78]** **Lines:** 929–940 · "`user_id` is denormalized directly onto the row on purpose: `project_id`"
**Verdict:** KEEP
**Why:** Explains why `usage` breaks the RLS pattern every other child table uses — a session "tidying" policies would join through `projects` and lock users out of orphaned billing rows. The data-integrity-not-security distinction on the INSERT policy is one short clause.
**Verification:** CONFIRMED — teardown's own comment independently confirms `usage.project_id` is `ON DELETE SET NULL`, verified against applied DDL.

**[79]** **Lines:** 942–946 · "`generation_id` and `message_id` are independent dimensions, not"
**Verdict:** KEEP · **Why:** "`message_id` must never appear in a unique constraint" is a schema prohibition. · **Verification:** CONFIRMED — both nullable in `database.types.ts`, neither in a unique index.

**[80]** **Lines:** 948–957 · "`estimated_cost` is **reserve-then-settle, not null-then-populate**:"
**Verdict:** KEEP · **Why:** Ends with an explicit "don't let this get 'simplified' to null-until-settled later." · **Verification:** CONFIRMED — `reserveUsage` writes `estimated_cost` on INSERT with `status: 'pending'`.

**[81]** **Lines:** 959–961 · "A `max_tokens` truncation is not its own status: it settles as `status:"
**Verdict:** KEEP · **Why:** "`stop_reason` is data, never a status value." · **Verification:** CONFIRMED

**[82]** **Lines:** 963–974 · "**Never discard paid output to signal that it may be wrong.**"
**Verdict:** KEEP
**Why:** Core product principle with a concrete four-part reason; a session would null a prompt column to signal staleness. Drop the closing "C3 prompt 2's per-field save actions … follow this" sentence (history).
**Verification:** CONFIRMED — no action in `workbench/actions.ts` nulls `image_prompt` or `video_prompt`.

**[83]** **Lines:** 976–980 · "**As of Phase 1 prompt 4, `logClaudeUsage` no longer exists.** `usage`"
**Verdict:** REWRITE
**Why:** The call order is the rule; the removed-function history is not.
**Verification:** CONFIRMED — `src/lib/usage/index.ts` exports exactly `estimateInputTokens`, `quoteClaudeCall`, `reserveUsage`, `settleUsage`, `isAllowanceEnabled`, `getMonthlyCeilingUsd`, `AllowanceExceededError`, `assertWithinAllowance`. No `logClaudeUsage` anywhere.
**Exact corrected text:**
```
`usage` rows are written by `src/lib/usage/`, called *around* the gateway
call, never after it:
`assertWithinAllowance` → `reserveUsage` → `gateway.createMessage` →
`settleUsage` (in a `finally`).
```

**[84]** **Lines:** 982–991 · "`reserveUsage` runs BEFORE the gateway call and writes `status: 'pending'`"
**Verdict:** KEEP · **Why:** The worst-case-quote property and "**if the INSERT fails, `reserveUsage` throws**" — half of the reserve/settle asymmetry. · **Verification:** CONFIRMED — `reserve-settle.ts:82` throws on a failed insert.

**[85]** **Lines:** 993–1006 · "**As of Phase 1 prompt 6, `estimateInputTokens` counts everything actually"
**Verdict:** MOVE
**Why:** Two rules survive: count the serialised tool schema from the same `tools` array (never hardcode a size), and `TOOL_USE_SYSTEM_OVERHEAD_TOKENS` sits outside the chars/4 math. The known-bias discussion is the argument.
**Verification:** CONFIRMED — `quote.ts` `JSON.stringify(params.tools).length` plus `TOOL_USE_SYSTEM_OVERHEAD_TOKENS` (`pricing.ts`, value 300).
**Exact compressed replacement text:**
```
`estimateInputTokens` counts everything sent to the model — system prompt,
user message, and the serialised tool schema, `JSON.stringify`'d from the
same `tools` array the call passes to the gateway so it cannot drift as a
schema grows; never hardcode a schema size. Anthropic's fixed tool-use
overhead is added separately as `TOOL_USE_SYSTEM_OVERHEAD_TOKENS`, since
it is not proportional to any text sent. The chars/4 heuristic is
deliberate — do not add a `count_tokens` round trip before every call.
```

**[86]** **Lines:** 1008–1015 · "This closes a real, measured gap: the first live shot-generation call"
**Verdict:** CUT
**Why:** A single measurement from one live call, already superseded three times by the file's own admission (item 23). Pure post-mortem.
**Verification:** UNVERIFIABLE — the figures describe a past live call; no artifact in the repo records it.

**[87]** **Lines:** 1017–1042 · "`usage.quoted_cost` is the immutable half of that pre-flight quote:"
**Verdict:** MOVE
**Why:** Two prohibitions must survive: `settleUsage` never writes `quoted_cost`, and `estimated_cost` keeps its name deliberately. The calibration-mechanics essay and the blocked-row-exclusion reasoning are the argument (the exclusion itself is stated in item 88).
**Verification:** CONFIRMED — no branch of `settleUsage`'s update object references `quoted_cost`; `20260831193237_add_usage_quoted_cost.sql` adds it nullable with no backfill; `aggregate.ts` filters blocked rows.
**Exact compressed replacement text:**
```
`usage.quoted_cost` is the immutable half of the pre-flight quote:
`reserveUsage` writes it once and `settleUsage` must never write it under
any outcome — that is what keeps `(estimated_cost - quoted_cost)` a valid
calibration delta after settle, surfaced in `/usage`'s Anomalies section
(computed only over rows that have one, and excluding blocked rows).
`estimated_cost` keeps its name after settle overwrites it, because it is
still a list-price figure from token counts, not a provider invoice — the
`/usage` copy says "estimated" throughout for exactly that reason.
```

**[88]** **Lines:** 1044–1081 · "`settleUsage` runs in a `finally`, so it runs on success, on a thrown"
**Verdict:** MOVE
**Why:** 38 lines. Four rules must survive verbatim in spirit: the blocked branch is identified by `instanceof`; unverifiable throws retain the quote (over-count is the safe direction); this is a narrow exception, not a pattern; **`settleUsage` never throws**, and a stuck-`pending` row is a deliberate signal. The four-way branch enumeration is the argument.
**Verification:** CONFIRMED — `reserve-settle.ts:120` `instanceof LiveCallsBlockedError` → `raw_usage = { blocked: true, billed: false, reason }`; `:148` `console.error` and no rethrow; `aggregate.ts` excludes blocked rows from `callCount`.
**Exact compressed replacement text:**
```
`settleUsage` runs in a `finally` — on success, on a throw, and on
`max_tokens` alike. A throw *verified* to precede the network call —
today exactly `LiveCallsBlockedError`, identified by `instanceof`, never
by message text — settles at `estimated_cost: 0` with
`raw_usage.blocked`. Every other throw with no usage data is
unverifiable and **retains the pre-flight quote**: over-counting is the
safe direction for a spend cap. **This is a single, deliberately narrow
exception, not a pattern** — do not add a second branch for a throw that
merely seems unlikely to have been billed. Blocked rows show in
`/usage`'s Anomalies but are excluded from `callCount`. **`settleUsage`
never throws**: a failed UPDATE logs the usage id and leaves the row
`'pending'`, because by then the money may be spent and failing the
request would lose the user's work too. A `usage` row stuck `'pending'`
is therefore the deliberate signal for a call that died mid-flight. This
asymmetry — reserve throws, settle never does — must not be "tidied" into
symmetry.
```

**[89]** **Lines:** 1083–1092 · "Both `/api/projects/[id]/shots` (`step: 'workbench'` / `operation:"
**Verdict:** KEEP
**Why:** "Every new provider call must go through `reserveUsage`/`settleUsage`, never a direct `usage` insert" plus the no-spend-no-row rule for RECOVER paths.
**Verification:** CONFIRMED — both routes pass `generation.id`; the camera route passes `null`.

**[90]** **Lines:** 1094–1107 · "`assertWithinAllowance` (`src/lib/usage/allowance.ts`) is called"
**Verdict:** KEEP
**Why:** The **402 not 429** rule with its one-clause reason, plus "off by default; flipping it on is a product decision, not implied." Drop the closing sentence's "not implied by this change" phrasing when applying.
**Verification:** CONFIRMED — `allowance.ts` gates on `SPEND_CAP_ENABLED === '1'`, ceiling `SPEND_CAP_MONTHLY_USD` default 100, throws `AllowanceExceededError`; all three routes map it to 402 (`shots/logic.ts:655`, `prompts/logic.ts:424`, `camera/logic.ts:230`).

**[91]** **Lines:** 1109–1114 · "With this, all four mechanisms behind the original unexplained-spend"
**Verdict:** CUT
**Why:** Past-tense incident summary, no instruction. Duplicated again in the Done log.
**Verification:** N/A

**[92]** **Lines:** 1116–1125 · "**As of Phase 1 prompt 2, `projects.shots_generation` and"
**Verdict:** CUT
**Why:** Describes columns that no longer exist and what replaced them. A session reading `database.types.ts` cannot be misled by their absence.
**Verification:** CONFIRMED gone — neither column appears in `database.types.ts`.

**[93]** **Lines:** 1127–1154 · "A `/api/projects/[id]/shots` request runs the same strict **claim →"
**Verdict:** MOVE
**Why:** The **CLAIM → RECOVER → PERSIST → SETTLE** order invariant is one of the highest-value rules in the file and must survive in full. What compresses is the "as before / now built on X instead of a bespoke Y" framing and the 409-reason enumeration.
**Verification:** CONFIRMED — `runShotGeneration` in `src/app/api/projects/[id]/shots/logic.ts`.
**Exact compressed replacement text:**
```
Every claimed route runs one strict order — **CLAIM → RECOVER → PERSIST →
SETTLE** — and it must not be rearranged.
**Claim**: `claimGeneration` is both lock and idempotency guard; a refused
claim is a 409, never a partial attempt. The project's own fields are
loaded in a separate `SELECT` *before* the claim, so a vanished or unowned
project returns 404 without interpreting an RLS/FK error off the INSERT.
**Recover**: a claimed row already carrying a non-null `payload` never
calls the gateway — the stored payload is replayed through the same
pipeline.
**Persist**: on a fresh call the raw tool_use input is written to
`payload` immediately after the call returns, **before any derived row is
inserted**.
**Settle**: a `finally` on every exit path including a throw. Success
writes `succeeded` and clears `payload`; failure writes `failed` and
leaves `payload` for recovery — except a `max_tokens` truncation, which
settles `failed`, keeps whatever shots were saved, and always clears
`payload`, since a truncated answer was never "returned successfully."
```

**[94]** **Lines:** 1156–1157 · "**A generations row with a non-null `payload` means Claude has already"
**Verdict:** KEEP · **Why:** One sentence, highest money-consequence in the file. · **Verification:** CONFIRMED

**[95]** **Lines:** 1159–1167 · "A retry or recovery run replaces the shot list wholesale: `runShotsPipeline` deletes all"
**Verdict:** KEEP
**Why:** Delete-before-insert sequencing after the payload is durable, and "`elements` are never deleted" — both violate-able and both crash-safety relevant.
**Verification:** CONFIRMED — `shots/logic.ts` has a `.delete()` on `shots` before the batch insert; `shot_elements` cascades on both FKs.

**[96]** **Lines:** 1169–1189 · "`/prompts` runs the identical claim → recover → persist → settle sequence"
**Verdict:** MOVE
**Why:** Two behavioural differences matter (claims unconditionally even with nothing to do; updates only the requested shots rather than delete-and-reinsert) plus the 422 payload-retention rule. The "deliberate behavior change from the old lock" framing is history.
**Verification:** CONFIRMED — `runPromptGeneration` in `src/app/api/projects/[id]/prompts/logic.ts`; `402`/`422` statuses present.
**Exact compressed replacement text:**
```
`/prompts` (`runPromptGeneration`, `step: 'image_prompts'`, `operation:
'write_prompts'`, `shot_id: null`) runs the identical sequence, with two
differences. It claims unconditionally, even when nothing needs
generating — so a call after `succeeded` needs `retry: true`, same as
`/shots`. And it only `.update()`s the specific shots Claude was asked
about; prompts are a field on an existing shot, so there is no wholesale
delete-and-reinsert. A non-truncation 422 (requested shot_keys came back
missing) leaves `payload` intact for recovery; a `max_tokens` truncation
clears it, identically to `/shots`.
```

**[97]** **Lines:** 1191–1209 · "**`/prompts`'s step attribution is provisional and is a blocker for Step"
**Verdict:** CUT
**Why:** Roadmap, and the most action-inviting item in the file — "**Before Step 4 ships, `/api/projects/[id]/prompts` must be split**" is a direct instruction to start unrequested work. Per the brief, roadmap and "blocker" items are CUT. **Flagged in the ambiguity section below** — a one-line factual note that Step 6 spend currently attributes to `image_prompts` may be worth keeping without the call to action.
**Verification:** CONFIRMED as accurate — one route, one `write_prompts` tool call producing both prompts, attributed to `image_prompts`; `prompts/route.ts` has no frontend caller.

**[98]** **Lines:** 1211–1232 · "The workbench shot list derives its UI phase from the `generations` row's"
**Verdict:** REWRITE
**Why:** The phase table is a verbatim restatement of a 12-line pure function (`derive-phase.ts`) that has its own spec. What must survive is the prohibition: never trigger generation off a raw `shots.length === 0`.
**Verification:** CONFIRMED — `derive-phase.ts` matches the described table exactly; `ShotsProvider` (`shots-context.tsx`) fires once via a ref guard; `RetryConfirmModal` takes `hasPendingPayload` and `estimatedCredits` props.
**Exact corrected text:**
```
The workbench shot list derives its UI phase from the `generations` row's
`state` plus `shots.length`, never `shots.length` alone — the table is
`derivePhase()` (`derive-phase.ts`), a pure function, and belongs nowhere
else. The client must **never** trigger generation off a raw
`shots.length === 0` check: the only trigger is `derivePhase()` returning
`'trigger'`, fired once through a ref guard in `ShotsProvider`, so a
project that legitimately has zero shots can never re-fire generation. A
`'failed'` row with saved shots renders as `partial` with a cut-short
banner, never as a silent success. Retry is gated behind
`RetryConfirmModal`, which states the credit cost when `payload` is null
and that resuming is free when it is present.
```

**[99]** **Lines:** 1234–1252 · "Read `src/lib/database.types.ts` for columns — don't rely on this file."
**Verdict:** KEEP
**Why:** Opens with the single most important framing sentence in the Database section, then states the `current_step` vocabulary and the `current_step`/`furthest_step` distinction — none of it derivable from the generated types (both are plain `string`/`number`). Drop the "As of Phase 3 …" / "As of Phase 2 …" migration-history clauses and the "see Open questions" pointer on line 1252.
**Verification:** CONFIRMED — `20260901125544_add_current_step_check.sql` and `20260901104929_current_step_default_workbench.sql` both exist; `projects.video_model` is a single text column.

---

## `## Phase 2` (lines 1254–1320)

**[100]** **Lines:** 1256–1262 · "These two `projects` columns have precise, distinct meanings, and conflating them was the"
**Verdict:** KEEP · **Why:** The definitions are the whole point; conflating them is the documented failure. · **Verification:** N/A

**[101]** **Lines:** 1264–1270 · "`intake` is not a tracked step and needs no runtime lower-bound guard against it:"
**Verdict:** KEEP
**Why:** Ends in an explicit prohibition ("none should be added — a `MIN_NAVIGABLE_STEP` constant would be exactly the kind of scattered second enforcement point this phase exists to avoid"), which is exactly what stops a session adding one.
**Verification:** CONFIRMED — no `MIN_NAVIGABLE_STEP` in `src`.

**[102]** **Lines:** 1272–1279 · "**`advanceStep(supabase, projectId, step)`** (`src/lib/projects/advance-step.ts`) is now"
**Verdict:** KEEP
**Why:** Sole-write-site rule plus the two-statement shape and the `.lt()` filter that makes never-decreases a database guarantee rather than an application one.
**Verification:** CONFIRMED — `advance-step.ts` runs an unconditional `current_step` update then a `.lt('furthest_step', idx)`-filtered update; no `.rpc()`, no read-then-write.

**[103]** **Lines:** 1281–1292 · "`idx` comes from `stepIndex(step)` (`src/lib/config/pipeline.ts`), which derives from the"
**Verdict:** MOVE
**Why:** The rule is "`stepIndex` derives from `STEPS`, never a parallel map" plus the storyboard gap and its handling instruction. The reasoning for why `STEPS` isn't widened is already a verbatim comment in `pipeline.ts`.
**Verification:** CONFIRMED — `stepIndex` is `STEPS.indexOf(step) + 2`; `storyboard` is absent from `STEPS`, with the same rationale in the file header.
**Exact compressed replacement text:**
```
`idx` comes from `stepIndex(step)` (`pipeline.ts`), derived from `STEPS`
rather than a parallel hand-maintained map. **Known gap**: `storyboard` is
a real `current_step` value but is deliberately not a member of `Step` —
widening `STEPS` would wrongly imply storyboard belongs in the
`generations`/`usage` CHECK constraints. Whoever builds Step 5 extends the
`current_step` vocabulary, `stepIndex`, and `advanceStep`'s parameter type
at that time.
```

**[104]** **Lines:** 1294–1299 · "`advanceStep` is called **only on an explicit step transition — never on a save**."
**Verdict:** KEEP · **Why:** "Saving is not advancing" with its one-clause consequence; directly violate-able by any save action a session writes. · **Verification:** CONFIRMED — no save action in `workbench/actions.ts` calls `advanceStep`.

**[105]** **Lines:** 1301–1303 · "**`advanceStep` ships with zero callers as of Phase 2** — the Continue buttons and step"
**Verdict:** REWRITE
**Why:** The zero-callers fact is not history — the coupling warning (item 106) is only valid *because* of it, so it must be stated as a live precondition, not as a phase note.
**Verification:** CONFIRMED — `advanceStep` is imported only by `tests/advance-step.spec.ts`; zero production callers.
**Exact corrected text:**
```
`advanceStep` currently has **zero production callers** — it exists so the
first real transition has somewhere correct to go. The coupling warning
below depends on this being true; check it before trusting that warning.
```

**[106]** **Lines:** 1305–1313 · "**COUPLING WARNING**: `workbench-step-indicator.tsx` currently derives complete/current/"
**Verdict:** KEEP
**Why:** The clearest "these two changes must land in the same slice or a user gets locked out of finished work" statement in the file. Replace "see Current focus" with nothing when applying.
**Verification:** CONFIRMED — `workbench-step-indicator.tsx:86` uses `STEPS.findIndex` on `currentStep` only; `furthest_step` is read nowhere in the component.

**[107]** **Lines:** 1315–1320 · "Prior to Phase 2, `/api/projects/[id]/prompts` wrote `current_step: 'voiceover'` directly"
**Verdict:** CUT
**Why:** Describes a write that no longer exists, in the past tense, ending in "see Done."
**Verification:** CONFIRMED removed — no `current_step` write anywhere in `prompts/logic.ts`.

---

## `## Done` (lines 1322–1800)

**[108]** **Section:** `## Done`
**Lines:** 1322–1800
**Opening words:** "- Supabase email/password auth: signup, login, sign-out, protected dashboard"
**Verdict:** CUT (entire section, 479 lines)
**Why:** Per the brief: git history holds it, and it is the file's largest monotonic grower. It is 25% of the file, entirely past tense. It also carries at least one stale claim of its own (line 1446 asserts `camera_overridden` is written `false` on every generated row — that column was dropped) and several test-count figures that go stale on the next spec added.
**Verification:** Sampled and CONFIRMED as history; **one STALE claim found at line 1446** (`camera_overridden` no longer exists in `database.types.ts`). No standing instruction was found in the section that is not already stated elsewhere, with one exception worth transplanting before deleting: line 1765's "a test must not assert on hoped-for behavior that hasn't been confirmed" is a real testing rule stated nowhere else — see GAP [124].

---

## `## Superseded` (lines 1802–1816)

**[109]** **Lines:** 1803–1808 · "The old 4-step wizard (`script`/`voiceover`/`images`/`video`, driven by a"
**Verdict:** CUT
**Why:** Describes code that was removed, and a redirect shim that was itself subsequently deleted. Nothing to do or avoid.
**Verification:** CONFIRMED — no `WizardStep` type, no `/projects/[id]/script` route in `src`.

**[110]** **Lines:** 1810–1816 · "Two loose ends left behind by the removal, both live in the codebase"
**Verdict:** CUT
**Why:** Roadmap/inventory. "It awaits new ones in Steps 4 and 6, where it will likely split" is a licence to start work.
**Verification:** `updateProjectTitle` CONFIRMED still unused (defined at `src/app/(app)/projects/[id]/actions.ts:5`, zero call sites); the stated path `projects/[id]/actions.ts` is missing the `(app)` segment. `/prompts` CONFIRMED to have no frontend caller.

---

## `## Current focus` (lines 1818–1874)

**[111]** **Section:** `## Current focus`
**Lines:** 1818–1874
**Opening words:** "- **Open bug, unreproduced**: manually overriding a camera field is"
**Verdict:** CUT (entire section, 57 lines)
**Why:** This is the single most harmful section under the file's stated purpose. Every bullet is either roadmap ("Still open: shot deletion", "Agent chat mutations", "Element upload/generation", "Step-guard navigation"), an open-bug post-mortem, or a status report on what is already done. A fresh session reads it as a work queue.
**Verification:** N/A (roadmap). Two bullets restate rules kept elsewhere: the `advanceStep`/step-indicator coupling (item 106 is canonical) and the agent-turn-has-no-claim note (subsumed by item 64's compressed `derive_camera` text). The unreproduced-camera-dropdown bug is not a standing instruction; if it is still live it belongs in an issue tracker.

---

## `## Open questions` (lines 1876–1899)

**[112]** **Section:** `## Open questions`
**Lines:** 1876–1899
**Opening words:** "- **Per-step model selection.** `projects.video_model` is a single column"
**Verdict:** CUT (entire section, 24 lines)
**Why:** Roadmap by definition ("The schema needs to reflect that before Step 3"), plus a "Resolved (moved to Done)" paragraph that is a changelog entry about a changelog.
**Verification:** CONFIRMED that `projects.video_model` is one column and the duration-bounds half is closed (item 18). The one durable fact — model choice is per-step, not per-project — is worth one clause somewhere, but not as an open question.

---

# GAP items

Items 113–136. **Do not add these to CLAUDE.md in this session.** Reported only.

**[113] AGENTS.md provenance — MISSING**
`CLAUDE.md` line 1 imports `@AGENTS.md` but never states that `AGENTS.md` is auto-generated by `next dev` (regenerated on every dev run, per `node_modules/next/dist/server/lib/generate-agent-files.js`) and must never be hand-edited, nor that `CLAUDE.md` is the hand-maintained authoritative file. A session that reads a stale line in `AGENTS.md` will "fix" it there and lose the edit on the next `next dev`.
**Verification:** CONFIRMED — `AGENTS.md` itself carries the self-describing block; `CLAUDE.md` says nothing about it.

**[114] `database.types.ts` generated — PRESENT** (item 29, lines 282–283). Correct and sufficient.

**[115] Migration sequence — PARTIAL**
Lines 280–283 cover `supabase migration new` → `db push` → `npm run types:db`, and the never-paste-into-the-dashboard rule. **Missing:** "one change per migration." Practice already follows it (C3 prompt 1 shipped three separate migrations for three changes), but the rule is stated nowhere, so a session would batch them.
**Verification:** CONFIRMED — 25 migrations, each narrowly scoped.

**[116] No Postgres functions / triggers / `.rpc()`; `updated_at` in app code — WEAKER THAN STATED**
The prohibition exists only as three scattered incidental mentions: "never a Postgres function" (line 302, about shot keys), "no `.rpc()`, no read-then-write" (line 1274, about `advanceStep`), and "a plain re-`UPDATE` loop — no RPC" (line 827, about dialogue). There is no general standing rule, and `updated_at` being set in application code is never stated at all. Two source files (`usage/aggregate.ts:133`, `usage/allowance.ts:43`) cite "CLAUDE.md's" `.rpc()` prohibition as though it were a general rule — **the code points at a rule the file does not contain.**
**Verification:** CONFIRMED — zero `CREATE TRIGGER` / `CREATE FUNCTION` across all 25 migrations; zero `.rpc(` calls in `src`; `updated_at` written explicitly in `reserve-settle.ts` (2 sites) and `claim.ts` (4 sites).

**[117] `enums.ts` source of truth + drift test — PRESENT** (item 25). Correct after the rewrite.

**[118] `ALLOW_REAL_CLAUDE` prohibition — PRESENT and strong** (items 20, 43, 44).

**[119] Haiku for mechanical work, Sonnet for creative judgement — WEAKER THAN STATED**
The policy exists only as one instance (the `camera` section's Haiku-permanent decision, lines 731–739) plus the unexplained `isProduction ? sonnet : haiku` ternary. The general principle is never stated, so a session adding a new config section has no basis for choosing and will copy the ternary by default — including for mechanical work.
**Verification:** CONFIRMED — `models.ts` has `prompts` and `shots` on the ternary, `camera` on Haiku-permanent, with the reasoning stated only for `camera`.

**[120] Design-canvas requirement — PARTIAL**
The "must be opened and read via the MCP tools, never from a prose description" rule is present and strong (item 6), as is the multiple-vintage warning. **Missing:** the requirement that design inspection be *confirmed by naming the opened frames and their contents*, never by a yes/no answer. Without it the rule is unfalsifiable — a session can assert "I read the canvas" and the failure mode the rule exists to prevent recurs undetected. This is not hypothetical: the file itself records two consecutive rebuilds caused by exactly that (sections 09 and then 10 being read late).
**Verification:** N/A (process rule)

**[121] `advanceStep()` sole write site; saving is not advancing — PRESENT** (items 102, 104). Both stated explicitly.

**[122] Step-indicator coupling warning — PRESENT** (item 106). Strongest form; keep verbatim.

**[123] Camera scope invariant — PRESENT** (item 60). Strongest form; keep verbatim.

**[124] Never discard paid output — PRESENT** (item 82).
Related sub-gap surfaced while auditing the Done log: **"a test must not assert on hoped-for behavior that hasn't been confirmed"** (line 1765) is a real standing testing rule that exists *only* inside the Done log and will be lost when item 108 is applied. Transplant it into `## Testing` before cutting.

**[125] Staleness set by user edits only — PRESENT** (item 67).

**[126] Reserve/settle asymmetry — PRESENT** (items 84, 88), including the explicit "must not be tidied into symmetry."

**[127] INSERT-to-claim; 23505 by error code — PRESENT** (items 73, 74).

**[128] CLAIM → RECOVER → PERSIST → SETTLE; payload before shot rows; max_tokens handling — PRESENT but one half implicit** (item 93).
"Payload written before shot rows" and "on max_tokens: state failed, clear payload" are both explicit. **"Keep shots"** is only implied, via the separate `derivePhase` `partial` case (item 98). Item 93's replacement text states it explicitly; verify that wording is adopted.

**[129] `UNIQUE … NULLS NOT DISTINCT` and why — PRESENT** (item 73). Includes the concrete two-concurrent-`write_prompts` failure it prevents.

**[130] PostgREST heterogeneous batch inserts — MISSING**
The behaviour (a `.insert([...])` whose rows have differing key sets sends explicit `NULL` for omitted columns, bypassing the DB default) appears nowhere as a rule. It exists only as a past-tense audit finding buried in the Done log (line 1445: "`runShotsPipeline`'s batch shot insert is clean … no heterogeneous-key PostgREST risk"), which item 108 deletes. The rule — always build batch rows with a uniform `.map()` setting every column on every row — would be lost entirely. This one silently corrupts data and is invisible in review.
**Verification:** CONFIRMED — `runShotsPipeline` currently builds rows uniformly; nothing in the file tells the next author to keep doing so.

**[131] Blocked pre-network calls by error instance — PRESENT** (items 42, 88), stated in both places, with the "never by message text" prohibition.

**[132] Spend refusal returns 402, never 429 — PRESENT** (item 90), with the reason.

**[133] Provider/model/frame names never in UI copy — PRESENT; "dollar costs only" MISSING and currently contradicted**
Lines 237–239 and 375–377 cover provider names, model names, and frame counts, and `stepOperationLabel` is named as the only sanctioned renderer. **But "users see dollar costs only" is not stated, and the code does not do it**: `RetryConfirmModal` takes and displays an `estimatedCredits` prop, while the rail shows a dollar figure under "Usage spending" (with the Done log noting "there is no credit system"). Two units are shown to users today. Adding this as a rule is a real behaviour change to `RetryConfirmModal` and `durationConfig.estimatedCredits`, not documentation — flag it as a decision for the owner, not a doc fix.
**Verification:** CONFIRMED — `retry-confirm-modal.tsx:9` `estimatedCredits`; `rail.tsx:105` "Usage spending"; `duration.ts` exports `estimatedCredits` per tier.

**[134] Test conventions — PRESENT** (items 50, 51, 53): two fixed identities, `storageState` reuse, `globalTeardown` once per run, and `usage`-by-`user_id`-before-`projects`. All four are stated and all four verified against the code. The only weakening is item 28's contradictory Conventions bullet, which the rewrite closes.

**[135] Key config and module file map — PARTIAL**
Every module is named somewhere, but only in prose scattered across ~15 Conventions bullets and the Database section; there is no consolidated map. A fresh session must read the whole file to learn that `pricing.ts`, `duration.ts`, `enums.ts`, `pipeline.ts`, `models.ts`, `claim.ts`, `reserve-settle.ts`, `quote.ts`, `allowance.ts`, `advance-step.ts`, `display-title.ts`, `shot-key.ts`, `camera-labels.ts`, `video-type-labels.ts`, and `language-labels.ts` each own a specific concern. Once the Done/Current-focus/Open-questions sections are cut, a ~15-line table would carry more per line than anything removed.
**Verification:** CONFIRMED — all fifteen modules exist at the paths implied.

**[136] Duration invalid for the active model is flagged amber, never silently corrected — PRESENT** (items 18, 37), stated twice.

---

# Summary

**Current CLAUDE.md line count:** 1898

**Projected line count if every CUT and REWRITE and MOVE is applied:** ≈ 720 (a 62% reduction)

Breakdown of the projection:
- `## Done`, `## Superseded`, `## Current focus`, `## Open questions` (lines 1322–1899): **−578**
- CUT items inside lines 1–1321 (items 23, 47, 52, 55, 56, 65, 86, 91, 92, 97, 107): **−98**
- MOVE/REWRITE compression across lines 1–1321 (30 blocks): **−503**
- Retained: ≈ 719 lines

**Count of items by verdict** (items 1–112; GAP items 113–136 counted separately):

| Verdict | Count |
|---|---|
| KEEP | 62 |
| MOVE | 21 |
| CUT | 16 |
| REWRITE | 13 |
| **Total audit items** | **112** |

Three of the 16 CUTs are whole sections (items 108, 111, 112), accounting for 560 of the ~676 cut lines.

**GAP items:** 24 entries (113–136), of which **14 are PRESENT confirmations** (the checklist item is already covered and correct) and **10 are real gaps requiring action**: 113 (AGENTS.md provenance), 115 (one change per migration), 116 (no Postgres functions/triggers/`.rpc()`; `updated_at` in app code), 119 (Haiku/Sonnet model policy), 120 (design inspection confirmed by naming frames), 124-sub (the "never assert on unconfirmed behavior" testing rule, currently only inside the Done log), 128 (the "keep shots" half of max_tokens handling is implicit only), 130 (PostgREST heterogeneous batch inserts), 133 (dollar-costs-only — decision needed, not a doc fix), 135 (consolidated config/module map).

**Verification tally:** 61 items verified against code — 55 CONFIRMED, 5 STALE, 1 UNVERIFIABLE. The 5 stale items: **14** (`src/app/projects/new/actions.ts` → `src/app/(app)/projects/new/actions.ts`), **28** (per-test `createTestSession()` is no longer the auth pattern), **34** ("credits block" → "Usage spending" block), **36** (native `<select>` → `CustomSelect`; "Revert to auto" → "Reset to auto"; the bound-elements `+` toggle does not exist), **108** (`camera_overridden` at line 1446 — column dropped).

---

## Ambiguous sections

Marked KEEP or flagged rather than guessed toward CUT, per the brief.

**A. Item 97 — `/prompts` step attribution (lines 1191–1209).**
Classified CUT because it is framed as a roadmap blocker ("Before Step 4 ships, `/prompts` **must** be split"), which is exactly the licence-to-start-work pattern the brief targets. But stripped of the call to action, one fact is a live correctness caveat rather than a plan: *Step 6 spend currently reports as zero because both prompt kinds are attributed to `image_prompts`.* A session reading `/usage` output without that caveat draws a wrong conclusion about spend.
**Question I would ask:** should a purely factual, one-line "known attribution caveat" survive when the roadmap sentence around it is cut — or does any mention of it reliably pull a session toward doing the split?

**B. Item 54 — the table list and RLS patterns (lines 546–555).**
The three RLS ownership shapes are a real rule for writing a new policy, but the sentence is also partly a schema dump, and the file says four lines later to read `database.types.ts` instead.
**Question:** is the RLS-pattern rule better relocated next to the `usage` policy discussion (item 78), leaving no table list at all?

**C. Item 31 — prompt caching inert (lines 286–293).**
"Don't pad prompts to reach the threshold" is a genuine prohibition, but the surrounding six lines are a status report that becomes wrong the moment prompts grow past the threshold, at which point nobody will notice.
**Question:** keep the prohibition alone and drop the status, accepting that a session then won't understand why the cache buckets read 0?

**D. Item 67 — the staleness table (lines 748–781).**
I kept all five which-edit-sets-what rows because each is independently violate-able, but they are also five restatements of what five server actions do. They are the longest KEEP-in-substance block in the file.
**Question:** is a two-line statement of the *principle* (narration edits invalidate project-wide; visual/camera edits invalidate that shot's prompts; duration invalidates nothing) sufficient, with the per-field mapping left to the actions and their tests?

**E. Item 133 — "users see dollar costs only."**
This gap cannot be closed by editing CLAUDE.md. The retry modal shows credits, the rail shows dollars, and `durationConfig` exports `estimatedCredits` per tier. Adding the rule mandates a code change.
**Question:** is "dollar costs only" the intended end state (retiring `estimatedCredits` from user-facing copy), or do credits remain the pre-purchase unit and dollars the post-hoc reporting unit — in which case the rule should be written as the narrower "never a provider or model name, never frame counts"?
