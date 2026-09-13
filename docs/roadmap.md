# Roadmap

Open items. Nothing in this file is authorisation to start work — it is a record so items
are not lost.

## Known bugs

- **`resolveElement` matches only on current name, so a renamed element gets duplicated on
  regeneration.** `resolveElement` (`src/app/api/projects/[id]/shots/logic.ts`) dedups
  purely by `lower(name)`. If a user renames an element (a character, or the project's
  style element) after it's created, the next shot-list regeneration no longer matches it
  by its old name and inserts a new row alongside the renamed one instead of reusing it.
  Understood, low severity (surfaced while adding style-element generation, C5), and
  deliberately not fixed here.
- **Camera field override reported to empty that field's dropdown — unreproduced.** Eight
  live-reproduction scenarios (plain override, all three overridden in sequence, override
  after a real re-derivation, rapid double-selection, keyboard-driven override, per-field
  reset immediately after overriding a sibling, overriding a `null`-valued field,
  re-selecting an already-selected override value) all rendered correctly. Working theory,
  never confirmed: the same root cause as the fixed `CustomSelect` menu/trigger width bug.
  Not fixed. Start from a real repro — ideally the original reporter's exact steps — not
  source reading, which has already been exhausted without success.
- `project-card.tsx` interpolates `/projects/${id}/${current_step}` unguarded. See **C6**
  below.
- **Shot fields still missing server-side validation, found while fixing C4's empty-
  voiceover bug but deliberately not fixed alongside it (scoped to `voice_over`, then
  `visual_description`, only):** `updateShotDuration` has no server-side bounds/NaN check
  (only a client-side display warning); `saveDialogueLine` accepts an empty `line`/
  `elementId` server-side (currently relies entirely on `dialogue-row.tsx`'s client guard
  never calling it with either blank). `visual_description` is now validated at all four
  sites that can write it - client, server action, agent's `update_shot`, and agent's
  `insert_shot` (`tools.ts`'s `handleInsertShot`, refuses via the shared
  `shot-visual-description.ts` predicate, same shape as `update_shot`).
  `write_shots` (full shot-list generation) is the one remaining path that can still
  persist an empty `visual_description` - `runShotsPipeline`'s `isUsableShot` gate is
  deliberately an OR against `voice_over`, not an AND, so a shot with narration and no
  description still gets saved rather than dropping paid-for output. The system prompt
  now states explicitly that `visual_description` must never be empty
  (`SHOT_GENERATION_SYSTEM_PROMPT_V5`), but that's an advisory nudge, not an enforced
  guarantee - the tool schema's `required` already listed the field and didn't stop this
  either. The resulting gap is made visible rather than silent:
  `visual-description-field.tsx`/`voiceover-field.tsx` now initialize their `touched`
  state from the persisted value's own validity, so a shot arriving from generation with
  an empty required field shows its error on load, with no click required first.
- **`usage.shot_id` stores the shot's id, not `shot_key`, and goes `null` when the
  shot is deleted** (e.g. a shot-list regeneration deletes and reinserts every shot
  for the project). A `derive_camera` `usage` row therefore loses any link to which
  shot it was for once that shot is gone - discovered backfilling the credit ledger,
  where one such row's `shot_id` was already null with no way to recover which shot
  it belonged to. Not fixed here.
- **Suite flakiness under parallel execution.** `agent-chat-panel.spec.ts` and
  `shot-editing.spec.ts` both fail intermittently when the full suite runs
  `fullyParallel`, and pass reliably run in isolation. Pre-existing, unrelated to
  the credit ledger. Worth recording because it means "the suite is green" is
  currently a judgement call for whoever reports it — a failure in either file
  needs a solo re-run before it's counted as a real regression.
- **Shot generation's `runShotGeneration` (`shots/logic.ts`) has no guard on
  `project.source_text` being non-empty before the paid Claude call** - found while
  auditing every `gateway.createMessage` call site for the camera-derivation empty-input
  guard (C4). The other three call sites (prompt generation, camera derivation, agent
  turn) are all guarded one way or another; this one currently is not.
- **"Router action dispatched before initialization" console error (C4) — unreproduced.**
  Five distinct reproduction attempts against the workbench route: navigating away
  immediately after mount during the fire-once shot-generation trigger; the real
  intake→workbench `redirect()` path, watched immediately; an artificially delayed
  `/api/projects/[id]/shots` response (`page.route`, no `ALLOW_REAL_CLAUDE` involved) with
  navigation away to the dashboard before it resolves; the same, navigating to a
  *different* project's workbench instead; and a hard navigation to the workbench URL
  interrupted mid-hydration (`waitUntil: 'commit'`) before the delayed response lands.
  None reproduced the error. Traced every `router.push`/`refresh`/`replace` call site in
  the workbench tree (`shots-context.tsx`'s fetch-trigger and 3s poll, `shot-card.tsx`'s
  delete confirm, `agent-panel.tsx`'s post-turn settle) - all fire from inside a
  `useEffect`, a `setInterval` it arms, or an async handler reached from a real click,
  never render body or module scope. The originally suspected mechanism (a long-running
  `fetchShots()` continuation surviving past the owning route's teardown) doesn't hold up
  either: Next's App Router keeps one `router` instance for the whole SPA session across
  client-side navigations, so there's no "torn-down router" for a stale continuation to
  race against in the scenarios tried. Not fixed - needs a real browser repro (ideally
  the original reporter's exact steps, possibly involving conditions this headless
  Playwright run doesn't recreate: HMR/Fast Refresh, React DevTools, or a slower real
  network) rather than further source reading or synthetic timing attempts.

## Unbuilt product surface

- Agent chat UI on the workbench; the composer is rendered but disabled. The server-side
  turn (C4) is built (`POST /api/projects/[id]/agent`, `runAgentTurn`) — this item is now
  purely the chat panel wiring: sending a message, rendering the SSE stream's events onto
  `AgentMessageKind`, a `client_id` per send.
- Element upload and reference-image generation from the Assets tab.
- Step-guard navigation: gate step-to-step links on `furthest_step`, not `current_step`
  position. Blocked in practice until `advanceStep()` has its first caller. The step
  indicator must switch in that same slice — see the coupling warning in CLAUDE.md.
- The Queue rail item is visual-only, pending real data.
- Whether and when to flip `SPEND_CAP_ENABLED` on is an open product decision; the
  mechanism is wired.
- `updateProjectTitle` (`src/app/(app)/projects/[id]/actions.ts`) is unused, pending a
  workbench title editor.
- **Credit gating is not implemented.** No balance check refuses any operation today —
  every priced call fires regardless of the caller's balance, and `getBalance()` has no
  caller outside `/credits`. Deferred by explicit instruction; lands with Step 4.
  **Per-iteration balance re-checking** for a multi-iteration action (an agent turn can
  make up to 8 Claude calls per user action) is part of the same deferred work — Step 4
  is the first *action* built on this pipeline whose single user action fires many paid
  calls in sequence, so it's the first place a gate checked once at the start of the
  action, rather than before every call inside it, would actually leave a real gap.
- **The dollar Usage page has no admin gate yet.** Dollars are development
  instrumentation; the page will eventually move behind an admin-only check. The credits
  page was deliberately built as a separate route (`/credits` vs `/usage`) specifically
  so that move touches nothing on the credits side.

## Deferred decisions

- **Per-step model selection.** `projects.video_model` is a single column holding one
  model string, but model choice is per-step, not per-project: OpenAI for images,
  ElevenLabs for voiceover, fal.ai for clips. The schema needs to reflect that before Step
  3 — likely a per-step model map on the project — and `models.ts` needs provider → model →
  `{ costPerUnit, … }`. The duration-bounds half is closed (`VIDEO_MODELS` carries a real
  `kind: 'continuous' | 'discrete'` union). Still open: the per-step provider model map
  itself, and per-model cost config.
- **Project-lifecycle `status` design.** `projects.status` is unconstrained text and
  `/prompts` no longer writes `'in_progress'`; no substitute vocabulary has been chosen.
- **Failed-call credit charge policy is undecided.** Today a failed call writes no
  `credit_ledger` row even when real provider cost was already incurred (see
  docs/decisions.md). Whether that stays the permanent policy, or failed calls should be
  charged (in full, partial, or at a flat penalty), has not been decided.
- **Every credit price except `generate_shots` and `derive_camera` is a placeholder.**
  `PRICE_TABLE` (`src/lib/config/credits.ts`) marks each one `// placeholder` in a
  comment: `generate_image` at both `workbench` and `storyboard`, `write_image_prompts`,
  `voiceover`, `background_music`, `write_video_prompts`, and `merge`. Recalibration
  needs real measured dollar cost from Steps 3–7, the same way `generate_shots`/
  `derive_camera` were calibrated from measured Step 2 data. `generate_clip` has no
  entry at all, deliberately — the most expensive action in the product, left absent so
  a call site fails loudly (`MissingCreditPriceError`) rather than shipping a
  placeholder number that risks anchoring the real price badly.
- **Whether to inline camera enum values into the agent's shot index.** Today the index
  (`buildShotIndexBlock`) only flags whether a camera field is overridden, never its actual
  `shot_size`/`camera_angle`/`camera_movement` value — a camera-only agent request still
  needs a `get_shot` call to read them. Inlining all three would cost ~9 tokens/shot
  (~675 tokens at 75 shots), re-paid on every turn that breaks the index's prompt cache
  (any content edit), including turns that never touch camera — not measured to be worth it
  against an unmeasured request class. Revisit only if usage rows show `get_shot` calls
  dominated by camera-only requests.

## Added items

- **Before a regenerate-all UI trigger ships:** resolved for the agent's own
  `regenerate_all_shots` tool — it never surfaces `shots/logic.ts`'s raw
  `BLOCKED_REASON_MESSAGES` copy to the user, it reports the tool's outcome
  and the agent explains it in its own reply. Still open for any future UI
  *button* that triggers a regenerate-all directly: `generate_shots` is
  claimable from `'succeeded'` with `retry: true` (`OPERATION_POLICY`), and a
  no-retry claim against a succeeded project returns `retry_required`
  instead of `already_ready`. Nothing in the UI reaches this path yet (the
  workbench only opens the retry confirmation from the `failed`/`partial`
  phases), so `shots/logic.ts`'s `retry_required` copy — "The last generation
  failed. Retry to try again." — is still accurate for every UI path a user
  can reach today. Whoever wires a real "regenerate all" UI trigger from the
  complete phase needs copy that covers both cases (or a distinct reason
  value), not this string as-is.
- **C3 carry-overs:** whether the `image_prompt`/`video_prompt` non-null
  regression assertion runs against a fixture where those columns are
  actually populated; a live-table NULL check on pre-existing
  `camera_overridden`-equivalent data. (The camera revert/reset staleness
  question is resolved — both write paths already set
  `image_prompt_stale`/`video_prompt_stale`, now consolidated in
  `src/lib/shot-staleness.ts`.)
- **Before Step 3:** split `/api/projects/[id]/prompts` into separate
  image-prompts and video-prompts routes, each with its own claim. The route's
  original defect — video prompts written before images existed or retiming
  happened — is fixed by the new step order (images at Step 3, video prompts
  at Step 5, after storyboard). The remaining reasons for the split are
  per-route claims (one `generations` row per operation, not a shared one)
  and correct step attribution — see the attribution constraint in CLAUDE.md.
- **Before C5:** add the missing DB CHECK constraint on `elements.type` if
  verification shows it absent (CLAUDE.md's own claim about this has been
  wrong in both directions historically — verify against the migration, do
  not trust prose).
- **Before C5:** the agent's `regenerate_all_shots` tool deletes every
  `shots` row for the project, and `shot_elements` has `ON DELETE CASCADE`
  on both foreign keys, so any bindings go with it. Harmless today only
  because `shot_elements` has no writer besides `runShotsPipeline` itself,
  which repopulates it from the same call. Once C5 lets a person bind
  characters to shots directly, `regenerate_all_shots` will silently
  discard those bindings along with the rest of the shot list — worth a
  sharper warning than the tool's current "destructive and expensive" line
  once that's true.
- **C6:** fix the unguarded URL interpolation in `project-card.tsx`
  (`/projects/${id}/${current_step}`) — the first `advanceStep()` call
  writing `'image_prompts'` before that step's route exists sends users to a 404.
- **Step 6 architecture:** cannot be request-response at any timeout (75 clips,
  minutes each). Needs async submit plus webhook or poll; `generations`'
  `external_id` and per-shot rows already support this.
- **Step 7:** ffmpeg needs a container service, not Vercel (binary size,
  memory, CPU).
- **Before Step 7:** finished videos must be served as Supabase signed URLs
  straight from storage, never proxied through a Next.js route. Vercel egress
  is ~$0.15/GB.
- **Per-tier `max_tokens`:** the 3–5min and 8–10min duration tiers are
  selectable today and are guaranteed to truncate at the current 4000 ceiling.
  Preferred fix is per-tier `max_tokens` in `duration.ts`.
- **Free tier:** `assertWithinAllowance` is wired but off; the free envelope is
  hard-coded config until cost data is measured.
- **`aggregateUsage()` scale ceiling:** must become a Postgres VIEW with
  `security_invoker` once a user has thousands of rows; the rail's usage item
  also fetches rows on every route load — fold into the same migration. NOTE:
  a VIEW is neither a function nor a trigger and is not covered by CLAUDE.md's
  prohibition on those.
- **Playwright:** move the remaining fresh-user specs to `storageState` reuse;
  move the suite to local Supabase (`supabase start`) for full isolation and
  zero rate limits.
- **Mobile:** one design pass after desktop Steps 1–2 are done. Only four
  screens get responsive treatment (Step 6 progress, dashboard, intake, final
  review/download); everything else shows a "needs larger screen" interstitial.
- **Steps 3 and 4, to be decided when those steps are designed:**
  - Where per-shot voiceover start/end timestamps (ElevenLabs returns these
    alongside the audio file) are stored — storage schema not yet designed.
  - Whether timeline retiming writes back to `shots.duration_sec` or to a
    separate offset column.
  - Whether retiming sets `video_prompt_stale`.
  - Whether a flag is needed for a stale generated image.
  - Whether Storyboard's three generations (image, voiceover, background
    music) are one claimed action or three independent ones.
  - Whether the still-frame video is server-rendered or a client-side
    preview.
  - Whether Step 3's N per-shot image calls need the async submit-and-poll
    architecture already flagged for Step 6.
