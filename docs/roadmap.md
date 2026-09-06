# Roadmap

Open items. Nothing in this file is authorisation to start work — it is a record so items
are not lost.

## Known bugs

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

## Unbuilt product surface

- Shot deletion (C4, alongside the agent's `delete_shot` tool — `Delete shot` renders
  inert today).
- Agent chat mutations on the workbench; the composer is rendered but disabled.
- Element upload and reference-image generation from the Assets tab.
- Step-guard navigation: gate step-to-step links on `furthest_step`, not `current_step`
  position. Blocked in practice until `advanceStep()` has its first caller. The step
  indicator must switch in that same slice — see the coupling warning in CLAUDE.md.
- The Queue rail item is visual-only, pending real data.
- Whether and when to flip `SPEND_CAP_ENABLED` on is an open product decision; the
  mechanism is wired.
- `updateProjectTitle` (`src/app/(app)/projects/[id]/actions.ts`) is unused, pending a
  workbench title editor.

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

## Added items

- **C4 open:** whether token streaming ships in C4 or is deferred to C4.5.
- **C4 prerequisite:** verify Vercel's function duration limit before
  finalising agent-turn bounds.
- **Before a regenerate-all UI trigger ships:** `generate_shots` is now
  claimable from `'succeeded'` with `retry: true` (`OPERATION_POLICY`), and a
  no-retry claim against a succeeded project now returns `retry_required`
  instead of `already_ready`. Nothing in the UI reaches this path yet (the
  workbench only opens the retry confirmation from the `failed`/`partial`
  phases), so `shots/logic.ts`'s `retry_required` copy — "The last generation
  failed. Retry to try again." — is still accurate for every path a user can
  reach today. Whoever wires a real "regenerate all" trigger from the
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
