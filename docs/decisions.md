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

Server-side, `runShotsPipeline` never silently truncates an over-count result. This is not
a rare edge case: the tool-use API has no way to structurally cap an array's length (only
`minItems` of 0 or 1 is supported, never a `maxItems`), so `buildWriteShotsTool` carries no
enforceable count constraint at all — the system prompt's "hard maximum" wording and the
tool's own description are the only enforcement, and the model exceeding them is an
expected, accept-and-logged outcome, not a defensive fallback for a stale replayed payload.
The call is already paid for regardless of how many rows get persisted — the `usage` row is
priced off the actual response's tokens the moment it lands — and dropping trailing shots
would leave a story missing its ending, worse than a slightly long shot list. It persists
the full array and logs `[shots] over_count …` with the project id, generation id, target,
and actual count; `ProjectHeader` surfaces the overshoot to the person, amber and
non-blocking (same treatment as the duration-overrun figure it sits beside), with cost-
framed copy — the person can trim the extra shots themselves, with judgment about which
ones matter that a server-side truncation doesn't have.

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

## Shot deletion: why spend never blocks, and why the modal shows no figure
*Supports: the delete-shot control and its confirmation in the Step 2 Workbench.*

Deleting a shot is a creative decision, and the app does not get a vote on it regardless
of what has already been spent generating that shot's prompts, image, or voiceover. The
confirmation states what goes with the shot — its voiceover, visual description, and
bound elements — but never argues, disables, or double-confirms on top of that; the
primary action stays at full destructive strength (`--status-failed-fg` outline, not
greyed) either way. This is a different case from "never discard paid output to signal
it may be stale" elsewhere in this doc: that rule protects a person from an accidental
silent loss of work they didn't ask to lose; here the person explicitly asked to remove
the row, and the confirmation's whole job is to make sure they know what goes with it
before they do.

**The modal used to show a per-shot dollar figure and no longer does.** It was sourced
from `usage` rows filtered by that shot's `shot_id` — accurate for a `derive_camera` row,
which always names exactly one shot, but the agent (`get_shot`, `update_shot`,
`insert_shot`, `regenerate_all_shots`, `finish`) writes every one of its `usage` rows
with `shot_id: null`, on purpose: one agent-turn call can mutate several shots in one
response, and `get_shot`/`finish` mutate none at all, so there is no single shot to
attribute a row to. **`shot_id` is null for agent-turn usage by design, not a gap to
backfill** — a future session finding every agent-turn row `shot_id`-less should read
this paragraph, not "fix" it by guessing an attribution.

That gap made the figure actively misleading rather than merely incomplete: a shot with
one `derive_camera` call showed a number, while a shot reshaped entirely through the
agent — routinely a larger spend — showed nothing, and a user reads "$0" as "nothing was
spent," not "attribution doesn't reach this row." Inconsistent attribution is worse than
no attribution, so the line was removed rather than patched, and the query and state
that fed it were deleted along with it (no dead `getShotSpend` action, no unused
`ShotSpend` type). The figure was never actionable either way — the spend can't be
recovered, and the delete decision is creative, not financial — which is what made
removal the right call rather than a workaround.

Once Steps 4 and 6 exist, image and clip generation cost is `shot_id`-attributed and
complete — every such call names exactly one shot, with no analogue to the agent's
zero-or-several-shots problem — so a spend line can be reinstated then, on data that
actually supports it.

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

## The five settle branches
*Supports: the `settleUsage` paragraph in `## Generations and usage`. (Audit item 88.)*

On success it overwrites `estimated_cost` with the measured cost and writes
`quantity`/`unit`/`raw_usage`/`stop_reason`. On `max_tokens` it settles `failed` with a cost
measured from the real (truncated) usage — truncation is billed in full, so the measured
number is the true one. On a throw with partial usage data available (Claude responded but a
later step failed) it settles `failed` with the cost measured from what is known. On a throw
with no usage data at all, the branch depends on *when* the throw happened, not merely that it
happened.

Two of those "no usage data" throws are *verified* to precede any generation, and both settle
at zero: `LiveCallsBlockedError` (never left the process) and an SDK `APIError` with
`status < 500` (a 4xx — Anthropic's own request-validation rejection, e.g. a tool schema
using an unsupported JSON Schema keyword, returned synchronously before the model ever runs).
Neither is detected by message text; both are `instanceof` checks, the same rigor. A 5xx
(`InternalServerError`) or a status-less network/timeout error (`APIConnectionError`,
`APIConnectionTimeoutError`) is not provably harmless — it can occur after the request already
left the process and generation began — hence retaining the quote for those, unchanged.

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
- **`agent_turn` has no PERSIST/RECOVER — accepted gap, not an oversight.**
  Every other claimed operation follows CLAIM → RECOVER → PERSIST → SETTLE;
  `runAgentTurn` never calls `persistGenerationPayload` and never checks for
  a recoverable payload, so `payload` stays `null` for the whole lifecycle
  of every `agent_turn` claim. This is deliberate: PERSIST/RECOVER protects
  one big paid call's *not-yet-applied* output between "Claude answered" and
  "the derived rows were written" — `write_shots`' one batched tool_use
  input sitting between paid-for and applied. A turn has no equivalent:
  it's a loop of up to 8 independent Claude calls, and each tool call's DB
  write is already durable the instant that iteration dispatches it — there
  is no batched, not-yet-written payload to protect. **Accepted
  consequence**: if execution is interrupted after one iteration's call has
  been paid for but before that iteration's tool writes and the turn's
  final SETTLE land, that iteration's cost and whatever it was about to
  apply are both lost — there is nothing to replay, only the mutex to
  release (`OPERATION_POLICY`'s `agent_turn` entry is reclaimable
  unconditionally from any terminal state for exactly this reason: the next
  turn is never blocked by it). **Do not read this as license to drop
  PERSIST/RECOVER elsewhere.** `generate_shots` keeps its payload-based
  PERSIST/RECOVER completely unchanged, including when claimed by the
  agent's own `regenerate_all_shots` tool — that tool calls
  `runShotGeneration` directly, the same function `/shots/route.ts` calls,
  so it PERSISTs the payload before writing shots and RECOVERs from it on a
  reclaimed row exactly as it always has. That operation really does have
  one big paid call and one batched not-yet-written result to protect;
  `agent_turn` structurally does not.
- **`insertAssistantReply` is unconditional on every path that has already
  inserted a user message.** The `client_id` idempotency guard
  (`insertUserMessage`) only works if a duplicate resend can always find a
  persisted reply; a path that inserts the user row but returns without
  ever persisting a reply leaves that row permanently unanswerable — a
  resend loops the identical refusal forever instead of ever resolving.
  This includes `claimGeneration` returning `'error'` or `'blocked'`
  (`already_generating`): both now persist a terminal, canned explanation
  for that specific attempt before returning, the same way the read-only
  lock and a thrown mid-turn exception already did. A dropped client
  connection does not risk this on its own — `runAgentTurn`'s `finally`
  block (claim settle, usage settle, the reply insert) runs independently
  of `onEvent`/the SSE stream, which is wrapped in its own try/catch
  specifically so a broken pipe can never skip it.
- **C4 mutation tools — settled.** Four tools, exactly:
  `get_shot`/`update_shot`/`insert_shot`/`regenerate_all_shots`. **No delete
  tool, structurally** — not filtered out, never defined — because deleting
  is a user-only action through a shot's own delete button; no phrasing of a
  chat request can make the agent delete a shot, since no tool exists that
  could. `insert_shot` maintains `order_index` server-side, shifting sibling
  rows itself rather than asking the model to compute indices.
  `regenerate_all_shots` reuses the existing `generate_shots` claim
  (`retry: true`) rather than being a separate operation, and is gated to
  exactly `furthest_step === workbench` — tighter than the general read-only
  lock below, since paid Step 3+ output must never be silently destroyed by
  a wholesale replacement. `update_shot`'s `dialogue` field replaces a
  shot's entire line list in one call: the agent may rewrite an existing
  bound-character line's text, remove a line, or add a line for a
  character already bound to that shot. **A speaker not already bound to
  that shot is refused, not auto-resolved — considered and explicitly
  rejected.** Auto-creating (or reusing project-wide by name) a character
  and binding it was tried and reverted: it would make the agent a second
  production writer of `elements`/`shot_elements` alongside
  `runShotsPipeline` (currently the only one, and worth keeping that way
  until C5 — see the next point), risks silent unmergeable duplicates
  ("Sarah"/"sarah"/"Sarah J." as three separate rows a future C5 asset
  picker would inherit), and implies an unrequested future paid reference-
  image render — "one reference image per element, reused across shots" is
  a standing money rule (see this doc's Cost policy entry). A refusal here
  is a `refusal` stream event, not an `error`, and states which characters
  ARE bound so the user has something actionable. `insert_shot` still has
  no dialogue field, purely as a scope decision — add a line via a
  follow-up `update_shot` call in the same turn once the shot exists, not
  because binding is gated. Default
  agent context is a compact shot index (~<2k tokens) with `get_shot` for
  detail, not the full list (~20k). Cache breakpoints after system prompt +
  tool schemas, and after the shot index, before message history. Hard
  8-iteration cap, gated behind the existing live-calls env variable, with a
  test seam via an injectable model client. Agent writes are treated
  identically to user edits for staleness. Last-write-wins concurrency, with
  refetch-and-replace on turn completion, exempting the focused field.
- **C4 streaming — settled.** Ships in C4, not deferred. One SSE stream
  carries both token-level text deltas (the model's own prose, forwarded as
  the SDK produces it) and a small, purpose-built set of structured progress
  events (`turn_started`, `tool_completed`, `refusal`, `error`, `settled`) —
  never raw SDK events or a tool's raw arguments, which would leak
  implementation detail and mean nothing to a user. The structured half
  exists because a tool-loop turn can go many seconds between any text at
  all; text deltas alone would leave that stretch looking broken.
  `tool_completed`/`refusal` additionally carry an optional `shot_key` — the
  same stable identifier the agent's tools already address shots by, never
  a display number, since a turn can insert a shot and shift the tail
  mid-stream. Present whenever the event concerns one specific shot (for
  card locking and targeted refetch on settle); omitted when it doesn't
  (`regenerate_all_shots`; a lock refusal before any shot was resolved).
  `label` stays free-text display copy, kept free to reword — the client
  must never parse it to recover this, the same class of mistake as
  detecting an error by matching a message string.
- **C4 chat panel — per-tool-call lock, not a whole-workbench lock.**
  Considered and rejected: disabling the entire shot list for the duration
  of a turn. The agent discovers its targets as the turn runs rather than
  declaring them up front, so a whole-workbench lock would freeze cards the
  turn never touches for as long as the slowest one takes, and a user
  mid-edit on an unrelated shot would be interrupted by a change that has
  nothing to do with them. Instead, a card locks the moment a
  `tool_completed`/`refusal` event names its `shot_key`, and every locked
  card releases together when the turn settles — never per tool call, since
  `settled` is the only point a turn is fully done writing. `get_shot`
  (read-only) and `regenerate_all_shots` (whole-list, and its own tool
  already gates on `furthest_step === workbench`) carry no `shot_key` and
  so lock nothing; `regenerate_all_shots` needs no lock regardless, since
  it deletes and reinserts every shot, and the resulting `router.refresh()`
  remounts those cards outright rather than updating any in place.
- **C4 chat panel — the focused-field exemption.** On settle, the panel
  refetches only the shots named during the turn (`ShotsProvider`'s
  `touchedShotKeys`) and force-resyncs their field components' local drafts
  from the refreshed value — necessary because a field never resyncs from a
  plain prop change on its own (see `use-field-save.ts`; that's what
  already protects a field mid-edit from an unrelated background
  `router.refresh()`). The one exception: a field currently focused is
  skipped, unconditionally. Rewriting text under someone's cursor
  mid-sentence is the one case a user will always notice, and there is no
  way to merge an agent edit with a still-in-progress keystroke that reads
  as correct either way. The field simply keeps showing what the user is
  typing until they leave it; their own blur-save then wins last-write,
  identically to any other concurrent edit — no new conflict resolution
  needed for this case. A second flag (`ShotsProvider.refreshPending`,
  true from the moment a turn settles until its `router.refresh()` has
  actually landed new props) gates the same resync: `touchedShotKeys`
  flips true well before the refreshed value arrives, and applying
  immediately would consume the touch against the still-stale prop,
  permanently missing the real value — keep the two flags distinct rather
  than collapsing them.
- **C4 chat panel — paced discrete events, unpaced text.** `use-agent-
  turn.ts` awaits a short real delay (150ms) before dispatching every SSE
  event except `text_delta`. Several discrete events (`tool_completed`,
  `refusal`, `settled`) routinely arrive in the same network chunk —
  without a real event-loop turn between them, React batches them into one
  commit, and a card would lock and unlock in the same paint the user never
  sees. `text_delta` is deliberately exempt: the canvas states prose
  streams as fast as tokens arrive with no artificial pacing ("the words
  are the progress"), and delaying it would work against that. This delay
  is load-bearing for `tests/agent-chat-panel.spec.ts`'s per-card lock
  test, which asserts a card is visibly locked before it unlocks - removing
  the delay as an apparent no-op won't fail `tsc`/lint/build, it will make
  that assertion flake (the lock and unlock racing into one commit) and,
  in production, make progress lines and lock/unlock flash in as one
  invisible batch instead of a legible sequence.
- **C4 dev caching note.** Prompt caching on the agent call is wired the
  same way as every other Claude call site (breakpoints on the stable
  prefix), but it will not activate in development: Haiku's minimum
  cacheable prefix is 2048 tokens, and the agent's stable prefix (system
  prompt + tool schemas) doesn't clear it. Zero saving in the dev usage
  table is expected, not a bug — it only becomes observable in production
  on Sonnet, whose minimum is 1024.
- **The shot index is not part of a stable cached prefix across turns.**
  `buildShotIndexBlock`'s output is rebuilt fresh from the DB every turn and
  carries its own `cache_control` breakpoint, separate from the system
  prompt's. Within a turn, later tool-loop iterations resend the identical
  index string and hit a cache read. Across turns it's a different story:
  editing a shot's `voice_over`/`visual_description` is exactly what changes
  the index text, so any content-editing turn — the common case — breaks the
  cache and rewrites the whole index at full price, for every shot, not just
  the one touched. This is why free-text fields (full `voice_over`, full
  `visual_description`, bound characters) stay behind `get_shot` rather than
  being inlined into the index: their per-shot cost would be re-paid on
  nearly every turn, scaling with project size, whereas a `get_shot` call
  only costs once, scoped to the shot(s) actually needed. Easy to get
  backwards — the cache breakpoint makes the index *look* free to grow.
- **The `finish` tool's savings are a model-behaviour bet, and v5's wording lost
  that bet.** `finish` only avoids the trailing reply-only call when the model
  bundles it into the same response as its last mutating call - i.e. declares
  completion before seeing that call's result. Nothing in the tool-use API forces
  this; a model that plays it safe and waits for the tool result before calling
  `finish` reproduces today's call count exactly, just with `finish` standing in
  for the old text-only reply. A live trial of v5's wording confirmed exactly that:
  a single-shot edit ran `get_shot`, then `update_shot`, then `finish` alone in a
  third response - the model waited for every result, including the last one,
  so the saving this tool exists to produce was zero. v5 had only ever said
  bundling was *permitted*; v6 rewrites both the prompt's closing paragraph and
  the tool's own description to state it as the *default* whenever the model is
  confident, so waiting needs a reason rather than being the unmarked case (see
  `src/lib/prompts/agent.ts`'s v6 comment). Whether v6's stronger wording actually
  changes model behaviour still can't be verified without a live call, which this
  repo's tests never make (see `## Provider calls`) - the next live trial is the
  real test. If it still runs as separate calls after this change, per the
  standing instruction the answer is to remove `finish` rather than try a third
  wording - don't spend a fourth session re-litigating phrasing on a call that
  clearly won't bundle. The failure path costs nothing extra either way and this
  part is unaffected by any of the above: when a bundled mutation is refused or
  errors, the model's `finish` message is discarded and the turn falls through to
  the same round trip a refusal already requires today - that path was never the
  one being optimized.
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
- **C4 persisted tool activity and per-turn cost — settled.** `messages`
  gains `kind` (`text`/`tool_done`/`refusal`, default `'text'`, `role` stays
  untouched), `shot_key` (no FK — a tool_done/refusal row must still name a
  shot after it's later deleted, which an FK can't survive), and `tool_name`
  (`tool_done` only, the four dispatchable tool names — `finish` never
  reaches `dispatchAgentTool`). A tool_done row's display text is never
  stored rendered: only `tool_name`/`shot_key` are, and the current shot
  number is resolved live at render time from the shots list, for both a
  live turn and a reload, so a later renumbering can never leave a stale
  number on screen (`src/lib/agent-activity-display.ts`, shared by
  `agent-panel.tsx` and `build-agent-messages.ts`). Refusals persist the
  same way — the same reload-fidelity reasoning applies; they're something
  the agent did, not something it said.

  Cost is never a `messages` row and never sourced from the model's own
  prose (the old `regenerate_all_shots` cost-in-label regex is gone). It's
  `SUM(usage.estimated_cost)` grouped by the turn's own user-message id
  (`sumTurnCost`, `src/lib/usage/turn-cost.ts`), excluding `pending` rows,
  computed live right before `runAgentTurn`'s terminal `settled` SSE event —
  after the turn's own usage rows are already forced to a terminal state —
  so cost and turn-completion always arrive atomically; the canvas has no
  frame for a separate pending-cost state because none is needed. Shown
  only when the sum is greater than zero. This also fixes a real
  under-count: the old figure only reflected the `generate_shots` operation,
  silently missing the surrounding `agent_turn` iterations' own spend for
  the same turn.

  A turn whose process died mid-flight (no closing text reply ever
  persisted, so `build-agent-messages.ts`'s turn-boundary scan finds no
  `client_id`-matched closing row) renders using the existing `error`
  kind — "This turn never finished, so nothing was changed." plus Retry,
  wired to resend the original content/client_id — with **no cost line at
  all**, regardless of what its stuck-`pending` reservations would sum to;
  a pending figure was never confirmed spent. The turn-boundary scan
  matches a closing reply by `client_id`, not "first `role:'assistant',
  kind:'text'` row seen" — `regenerate_all_shots`'s nested
  `runShotGeneration` call can itself insert an unrelated `client_id`-less
  text row earlier in the same turn, and a naive first-row rule would
  mistake that for the turn's end and drop the real closing reply.
