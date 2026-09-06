# Decisions

Why things are the way they are. Rules live in CLAUDE.md; this file holds the argument
behind them, so CLAUDE.md can state a rule in one clause.

---

# Part 1 — rationale compressed out of CLAUDE.md

Each heading names the CLAUDE.md rule it supports. Audit item numbers refer to
`docs/claude-md-audit.md`.

## Video-model duration registry: why a discriminated union
*Supports: the `VIDEO_MODELS` bullet in `## Code conventions`. (Audit item 18.)*

The registry began as `durationMin`/`durationMax` only. `'Kling 2.1'` was recorded as
`durationMin: 5, durationMax: 10` from fal.ai's docs for `fal-ai/kling-video/v2.1`
(standard/pro/master all agree), but Kling's real API is a **two-value enum (5s or 10s)**,
not a continuous range. With min/max only, the stepper's 0.1s increments could produce a
value like 7.3s that the real API rejects — and that failure would not surface until Step
7, the most expensive step, after the user had already paid for everything upstream. A
correctness bug, not a gap.

The fix is `kind: 'continuous' | 'discrete'` as a discriminated union, so a model cannot be
defined without picking which kind it is; there is no optional field that silently defaults
to continuous. The stepper branches on `kind`: continuous steps by 0.1s and clamps at the
nearer bound; discrete steps to the nearest-neighbour *allowed* value in the direction of
travel, so a click from an out-of-range 7.3s lands exactly on 10.0s rather than an
intermediate. Helper copy for a discrete model states the allowed values ("5s or 10s")
rather than a range, which would be actively false.

Existing `'Kling 2.1'` projects holding now-invalid durations are **not** migrated or
rewritten. They render amber (the existing out-of-range warning covers both kinds uniformly
via `isDurationAllowed`) and the user resolves them manually — the same principle as every
other "never silently rewrite a locked duration" case.

The registry key is the literal `'Kling 2.1'` string (Title Case, with a space), not a
kebab-case slug, because it must match what old rows were backfilled with and there is no
normalization layer between a stored `video_model` value and the lookup.

`resolveVideoModel` never falls back to another model's bounds: that would be exactly the
silent-truncation risk the registry exists to prevent. `ProjectHeader`'s chip-label lookup
uses the opposite fallback (raw stored value, never a blank chip) because a project created
before the registry existed must still render a label. Two different failure costs, two
different fallbacks, both correct for their own call site.

## `targetShots`: why intake warns instead of blocking, and why the server never truncates
*Supports: the `targetShots` hard-ceiling bullet in `## Code conventions`. (Audit item 22.)*

The intake check is a light client-side regex — a number immediately before
"shot(s)"/"scene(s)" — with no semantic understanding, and it false-positives readily: a
pasted screenplay's own prose describing its scene count, or a mention of a reference
video's shot count. Blocking a legitimate submission on a regex match would cost the user
more than the warning is meant to save. It renders amber (`status-active`, never
`status-failed`) and never touches `BuildButton`'s `disabled` state.

Server-side, `runShotsPipeline` never silently truncates an over-count result even if the
schema constraint is somehow exceeded (e.g. a payload recovered from before the constraint
existed). The call is already paid for at that point, and dropping trailing shots would
leave a story missing its ending — worse than a slightly long shot list. It persists the
full array and logs `[shots] over_count …` with the project id, generation id, target, and
actual count.

## Per-field save: why no Save button, and why status has two tiers
*Supports: the per-field save model in `## Code conventions`. (Audit item 36.)*

A batched "save the card" action couples fields that have nothing to do with each other: a
failure in one would force a retry of all of them, and a card with several fields mid-edit
could not report which one actually failed. Field attribution exists so a retry targets
exactly the failed field.

No `revalidatePath` is used, consistent with the rest of the repo, which uses none — the
client already holds the value it just sent, so a successful save updates local state
directly (`ShotsProvider`'s `updateShotLocal`) instead of re-fetching.

The two tiers exist because per-field status alone is invisible on a collapsed or scrolled
card, and a card-level rollup alone cannot say *which* field failed. Precedence is failed >
saving > saved > quiet; a single failure names the field, several collapse to "N fields
didn't save" + "Retry all". Each field subcomponent is `React.memo`'d so one field's status
change re-renders the card's status map without forcing siblings to re-render.

Camera fields stayed read-only through the prompt that introduced this model, deliberately:
setting `'override'` and triggering a `'derived'` re-check landed together, so the three
origins were never partially wired. Override with no re-derivation, or vice versa, would
have been a half-built feature.

## Duration: why an over-target overrun is not painted on every locked shot
*Supports: the two-independent-conditions duration bullet in `## UI and design`. (Audit item 37.)*

A saved duration outside the current model's range is a per-shot, deterministic fact, so it
belongs on that shot's own stepper. An aggregate over-target overrun is a project-level
fact. Repeating it on every locked shot's stepper would dilute the signal: a locked duration
is an independent, deliberate choice, and the header's existing aggregate lock count already
makes the cost of manual durations visible. `ProjectHeader` computes both `totalSeconds` and
`isOverTarget` from the `shots` array it already receives; no new fetch.

## Test auth: the rate-limit arithmetic behind `storageState`
*Supports: the `storageState`-first auth rule in `## Testing`. (Audit item 50.)*

Supabase's hosted auth rate-limits magic-link `verifyOtp` per project at roughly 30/hour.
The old pattern — every test minting its own throwaway user — made a full suite run consume
~45 of those in one go, so the suite exhausted the limit on its own and every retry pushed
the reset further out. Two fixed identities plus the handful of specs that genuinely need a
fresh user cuts that to 8 per run.

The `test.use({ storageState: SECONDARY_STORAGE_STATE })` opt-in exists for a future spec
that needs `secondary`'s *browser* identity. None currently does — the one multi-user spec
builds its own scoped Supabase client instead of a browser context.

Moving to a local Supabase instance (`supabase start`) is the eventual answer for full
isolation and zero shared rate limits; it would let even the fresh-user specs reuse a fixed
identity. Deliberately not done — see `docs/roadmap.md`.

## Test teardown: why `globalTeardown`, and why failures are swallowed
*Supports: the teardown rule in `## Testing`. (Audit item 53.)*

The fixed users are persistent and accumulate `projects`/`shots`/`generations`/`usage` rows
across every run forever. No global truncate-between-runs step was added, since that would
eventually run against real data; instead every spec scopes its assertions to the specific
`project_id`/`generation_id`/row id it just created, never to "all of this user's rows."

Cleanup must be a single pass after every test has finished. The suite runs `fullyParallel`,
so per-test cleanup of the *shared* fixed users' data would delete rows another in-flight
test is still asserting against.

A teardown failure is `console.error`'d and swallowed, never rethrown: a cleanup failure
must not turn a green suite red, and by the time teardown runs the suite's actual pass/fail
result is already determined.

The fresh-user specs are unaffected — they clean up their own `createTestSession()` user via
`deleteTestUser()` in their own `finally` block. Teardown has no way to know their ids and
does not need to: each is unique to its own test and cannot collide with another in-flight
test under parallelism the way the shared fixed users could.

## Camera saves: why a select's change is its commit
*Supports: the camera-field save paragraph in `## Database`. (Audit item 59.)*

A select has no blur moment the way a text field has — the change *is* the commit — so
camera fields save on `onChange` rather than on blur, while still following the same
`loadOwnedShot` ownership join, the same field-attributed `ShotFieldSaveResult` shape, and
the same `useFieldSave`/`SaveStatusIndicator` pair as every other field.

## Camera re-derivation: why revert and reset are one combined call
*Supports: the `POST …/camera` trigger description in `## Database`. (Audit item 61.)*

A two-step alternative — flip the origin away from `'override'`, then call the route — leaves
a failed revert stuck with a flipped origin and a stale value. The combined call force-applies
the write-back regardless of what Claude answers, and nothing is written to `shots` until a
successful response, so a failed revert or reset leaves every touched field completely
untouched: still its old origin and its old value.

"Reset all to auto" force-applies Claude's answer for every field, landing each independently
on `'auto'` or `'derived'` — both legitimate, neither coerced to the other.

## Why there is no all-override skip guard
*Supports: the "do not re-add one" clause in `## Database`. (Audit item 62.)*

An earlier version refused (client-side skip, then a server-side `400`) to re-derive on a
description edit when all three fields were already `'override'`, on the theory that nothing
was left to re-derive. This was wrong on the merits: if a user edits the description to
explicitly name a camera choice, that is real evidence and deserves a real check, even when
every field happens to be a manual choice already. The guard blocked exactly the case where
the user's intent is most deliberate.

No replacement guard exists inside `runCameraDerivation`, because there is nothing left to
guard — the route already refuses an empty or missing `fields` before that function is called.

## Why Claude is asked about override fields at all
*Supports: the write-back rule in `## Database`. (Audit item 63.)*

The resolved design, over dynamically filtering the tool schema per call: Claude cannot judge
whether new description text names a camera choice for a field it is never told about, so a
per-call-filtered schema cannot implement "description wins" at all. The model has to see
every field's enum options to answer any of them. Code alone then decides, per field, whether
to apply the answer.

A camera term the user just typed into the description is a stronger, more recent signal than
a dropdown they set earlier — but only when Claude found real textual evidence for that
specific field.

## Why `derive_camera` has no claim row, and why the guard coalesces rather than drops
*Supports: the `derive_camera` paragraph in `## Generations and usage`. (Audit item 64.)*

`generations`' insert-to-claim contract exists for expensive, resumable work. This is a
sub-second Haiku call answering 1–3 enum questions, and a claim row would be actively harmful:
`'succeeded'` is terminal, so a claim row would block every *subsequent* edit of the same
shot's description forever after the first successful derivation. There is no real "job" to
resume.

This is the same problem a future `agent_turn` claim would hit. A proper fix needs a policy
for which operations are claim-worthy at all — see `OPERATION_POLICY` below.

Dropping a mid-flight trigger was considered and rejected: a dropped "Reset to auto" click
would leave that field on `'override'` with no feedback at all. That is worse than the
accepted cost of allowing up to 2 billed calls for 2 rapid *distinct* edits to the same shot
— never more than 2, regardless of how many times a trigger re-fires while one is running,
since repeated re-fires just keep replacing the single queued slot.

## Why the camera model is Haiku permanently and its ceiling is 128
*Supports: the `modelsConfig.camera` note in `## Code conventions`. (Audit item 66.)*

Deriving 1–3 enum values from a sentence is mechanical work that never benefits from Sonnet's
extra quality, and this call fires on nearly every visual-description blur, so the cost delta
compounds across every edit of every shot in a way the other, rarer pipeline calls do not.
Still overridable via env for ops flexibility, but the code default is Haiku in both
environments.

`reserveUsage` reserves the *full* `max_tokens` as its worst-case pre-flight quote, so reusing
the shots/prompts ~8192-scale ceiling here would reserve roughly 25× the real cost of a 1–3
enum-field answer, on every description edit. A representative 3-field call quotes at
input ≈ 768 / output = 128 tokens ≈ **$0.0014** against Haiku's rates.

## Why duration edits set nothing stale
*Supports: the staleness table in `## Database`. (Audit item 67.)*

Audio is derived from narration text; duration does not change what is spoken. The mismatch
between a locked duration and actual narration length is resolved at Step 4 by retiming
visuals against the narration, which costs nothing.

Dialogue is on-camera speech, not narration, so it does not touch the voiceover — hence
`video_prompt_stale` only.

## Why dialogue is a table, not a jsonb column
*Supports: the `shot_dialogue` paragraph in `## Database`. (Audit item 69.)*

A shared array cannot support independent per-row saves without a read-modify-write race. The
UI saves each dialogue row independently, and C4's agent-mutation tools will write dialogue
concurrently with the UI — two concurrent writers sharing one array would silently clobber
each other.

No explicit cleanup is needed on retry or recovery: the pipeline's existing `shots`
delete-before-reinsert already cascades `shot_dialogue` rows via `shot_id ON DELETE CASCADE`,
the same way it already cascades `shot_elements`.

## The claim branch table
*Supports: the `claim.ts` paragraph in `## Generations and usage`. (Audit item 74.)*

`claimGeneration` branches on the existing row's `state`: `'succeeded'` refuses with
`already_ready`; `'failed'` without `retry` refuses with `retry_required`; `'generating'`
refuses with `already_generating` unless `started_at` is older than `STALE_AFTER_MS`.
`'failed'` with `retry`, a stale `'generating'`, and a `'pending'` row (only possible via
backfill, for a project never attempted) are all reclaimable.

Every reclaim is a conditional `UPDATE` filtered on the exact state it expects, plus a
staleness bound for the `'generating'` case. If it affects zero rows, another caller reclaimed
first, and the loser is refused with `already_generating` uniformly regardless of which state
it was racing from — this reproduces the old single-atomic-UPDATE claim's behaviour exactly,
since any race loser's follow-up read would always see the winner's `'generating'` write.

`STALE_AFTER_MS` is 15 minutes, tied to the real gateway's 600s SDK timeout plus margin, so a
crashed or killed request self-heals rather than wedging the project.

## The chars/4 estimate bias
*Supports: the `estimateInputTokens` paragraph in `## Generations and usage`. (Audit item 85.)*

JSON is punctuation-dense and likely tokenises at fewer than 4 chars/token, so the schema
portion of the estimate may run a little low. This is a known remaining bias to check with
more data points, not a reason to add a network round trip to `count_tokens` before every
call. `TOOL_USE_SYSTEM_OVERHEAD_TOKENS` (currently 300) is an approximation, not a
measurement, to be refined against more data.

The tool schema has changed size several times (enum consolidation, camera fields, the three
origin fields), so any recorded calibration ratio is stale. The next live run is the new
baseline, not a regression to chase.

## Why `quoted_cost` is immutable and `estimated_cost` keeps its name
*Supports: the `quoted_cost` paragraph in `## Generations and usage`. (Audit item 87.)*

Because `quoted_cost` never moves, `(estimated_cost - quoted_cost)` stays a valid calibration
delta after settle. That delta is the evidence behind the `estimateInputTokens` fix and behind
wherever `SPEND_CAP_MONTHLY_USD` should actually be set, rather than that ceiling staying a
guess indefinitely. A comment on `settleUsage` says explicitly that it must not write the
column, so a future edit does not add it by habit next to `estimated_cost`.

`quoted_cost` is nullable with no backfill (added after `estimated_cost` already existed in
production), so calibration is computed only over rows that have one. Blocked rows are
excluded too: a blocked row settles at `estimated_cost: 0` by design, so its ratio against a
nonzero `quoted_cost` is always 0 and would drag the calibration mean toward zero for a call
that was never actually measured.

## The four settle branches
*Supports: the `settleUsage` paragraph in `## Generations and usage`. (Audit item 88.)*

On success it overwrites `estimated_cost` with the measured cost and writes
`quantity`/`unit`/`raw_usage`/`stop_reason`. On `max_tokens` it settles `failed` with a cost
measured from the real (truncated) usage — truncation is billed in full, so the measured
number is the true one. On a throw with partial usage data available (Claude responded but a
later step failed) it settles `failed` with the cost measured from what is known. On a throw
with no usage data at all, the branch depends on *when* the throw happened, not merely that it
happened.

A network failure, stream error, or timeout after the request has already left the process is
unverifiable, not provably harmless — hence retaining the quote.

## Why the claim sequence is ordered this way
*Supports: CLAIM → RECOVER → PERSIST → SETTLE in `## Generations and usage`. (Audit item 93.)*

The project's own fields are loaded in a separate `SELECT` before the claim so a vanished or
unowned project returns 404 without needing to interpret an RLS/FK error off the claim INSERT.
A refused claim returns 409 with a reason (`already_ready` / `already_generating` /
`retry_required`), never a partial attempt.

Persisting the payload before any derived row is inserted means a crash between the two still
leaves the payload intact for the next retry to recover from. This is the same
persist-before-writing discipline the retired `projects.pending_shots_payload` used to enforce.

`elements` are never deleted on a replay because they are project-level and deduped by name, so
`resolveElement` re-matches existing rows — including any reference image already generated —
instead of creating duplicates. This is what makes the confirmation modal's "existing shots
will be replaced" copy true rather than aspirational.

## Why `/prompts` claims even when there is nothing to do
*Supports: the `/prompts` differences paragraph in `## Generations and usage`. (Audit item 96.)*

A deliberate behaviour change from the old CAS lock, which was freely re-callable forever. A
`/prompts` call after `succeeded` now needs `retry: true`, same as `/shots`. The
422-on-partial-failure guarantee is enforced by the claim/recover contract, not a lock: a
non-truncation 422 leaves `payload` intact for recovery, mirroring `runShotsPipeline`'s own
"nothing usable" 422.

## Staleness mapping: consolidation, and the camera flags were already correct
*Supports: `src/lib/shot-staleness.ts` and the staleness table in `## Database`.*

Six call sites (five in `workbench/actions.ts`, one in `camera/logic.ts`'s
`runCameraDerivation`) each independently decided which `*_stale` flags a field edit
sets. The mapping itself had not drifted — every site already set identical flags for
the same field-change category — but it was duplicated: a manual camera dropdown and an
AI camera re-derivation each spelled out `{ image_prompt_stale: true, video_prompt_stale:
true }` in their own code, kept in sync only by comment discipline. `stalenessFor`
consolidates the field→flags decision into one function; each call site still owns its
own no-op/diff-before-write check, since that check is field-specific (a value diff for
most fields, an origin-state gate for AI re-derivation) and out of the mapping's concern.

This corrects a stale premise from C4 planning: both camera-write paths (the dropdown
and the AI re-derivation) were already setting `image_prompt_stale`/`video_prompt_stale`
before this consolidation, including the revert-to-auto and reset-all-to-auto trigger
shapes. There was no open behavior gap here to close — only the duplication to remove.

## Why `client_id` exists alongside the `generations` mutex
*Supports: `messages.client_id` and `src/lib/messages-idempotency.ts`.*

The `generations` mutex guards *concurrency*: two tabs, a double-clicked send, a second
turn firing while one is already running. It does not guard *sequential* retry: a turn
completes and settles to `succeeded`, the response is lost in transit (a dropped
connection, a client crash), and the client resends the same message. The mutex row is
by then claimable again — its job is done — so the resend would bill Claude a second
time for an identical message. `client_id`, minted by the browser once per send and
enforced by `UNIQUE (project_id, client_id)`, converts that paid duplicate into a free
no-op: the insert of the user message is itself the idempotency claim, and a `23505` on
it (detected by error code, never by matching a message string) means this exact message
was already accepted.

## Why voiceover merged into storyboard, and `STEPS` now includes it

The pipeline dropped from 8 steps to 7: voiceover is no longer a step of its own. Three
reasons drove the merge, not just tidiness:

- Voiceover timings were produced one step away from the timeline that actually consumes
  them. Landing voiceover generation, retiming, and the still-frame storyboard in the same
  step means the timing data and its consumer are never separated by a navigation boundary.
- Video prompts were previously written *before* images existed and before retiming — a
  real ordering defect, since a prompt described a shot whose visual and duration were not
  yet settled. Under the new order (images at Step 3, storyboard — voiceover + retiming —
  at Step 4, video prompts at Step 5), prompts are always written against real images and
  final durations.
- A useful side effect: Steps 1–4 alone now produce a complete narrated still-frame video,
  with no clip-provider spend, before Step 5 (video prompts) is ever reached.

Storyboard absorbed `voiceover` and `background_music` and gained `generate_image`, so it
is now a spending step — unlike the old assumption (see the superseded note this replaces)
that it "generates nothing of its own." `Step`/`STEPS` therefore includes `storyboard`
directly, rather than carving out an exception the way `stepIndex` once did.

---

# Part 2 — settled decisions

- **C4 agent turns — settled.** `agent_turn` gets one reusable row per
  project in `generations`, overwritten indefinitely (a mutex, not a job
  record). Conversation persistence uses the existing `messages` table. Chat
  is excluded from `generations` cost accounting — agent turns write `usage`
  rows only; the accepted consequence is that a browser refresh mid-turn can
  double-bill one turn (cents, versus dollars for a double-fired Step 6 clip).
- **`OPERATION_POLICY` — why it exists.** `STALE_AFTER_MS` is currently one
  global constant of 15 minutes, correct for a long paid shot-generation job
  and catastrophic for a chat turn: a wedged turn would lock the agent for
  15 minutes. Operations need per-operation stale windows. The module lands
  in C4.
- **Agent-turn stale window — 180s, not 60s.** 60s was considered and
  rejected: it was derived from UI patience rather than worst-case turn
  duration, and an 8-iteration Sonnet turn routinely exceeds it, leaving a
  live turn reclaimable mid-flight. The window is derived from
  `iteration_cap × per-call ceiling + margin`, landing near 180s. Open to
  revision with measured data.
- **C4 mutation tools — settled.** Targeted tools only
  (`update_shot`/`insert_shot`/`delete_shot`/`get_shot`); never a rewrite-all
  tool once shots exist (~200 output tokens versus ~15,000 on a 75-shot
  project). Default agent context is a compact shot index (~<2k tokens) with
  `get_shot` for detail, not the full list (~20k). Cache breakpoints after
  system prompt + tool schemas, and after the shot index, before message
  history. Hard 8-iteration cap, gated behind the existing live-calls env
  variable, with a test seam via an injectable model client. Agent writes are
  treated identically to user edits for staleness. Agent-permitted shot
  regeneration is constrained to projects with no paid artifacts beyond
  `generate_shots`. Free shot deletion while no paid artifacts exist, with
  server-side `order_index` maintenance. Last-write-wins concurrency, with
  refetch-and-replace on turn completion, exempting the focused field.
- **Credits and dollars — settled.** Dollars are development and future-admin
  instrumentation. Credits are the user currency, purchased via subscription;
  per-step credit prices will be derived from measured dollar data. Both units
  are correct in their own surfaces. NOTE: `estimatedCredits` in `duration.ts`
  is provisional — hand-picked, with no stated relationship to measured cost.
  Do not treat those numbers as calibrated.
- **Cost policy — settled.** One reference image per element, reused across
  every shot it appears in. Pre-flight quotes are deliberately worst-case
  (estimated input plus the full `max_tokens` at the output rate) so a
  reservation can never be overrun by concurrent calls. Rates live in
  git-versioned config, never env and never the DB; applied rates are stamped
  per row so historical accuracy never depends on the config file.
  `RATE_VERSION` is bumped on change and nothing is ever backfilled.
