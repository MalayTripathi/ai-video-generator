// The @smoke set's required members: for each protected operation, the spec and exact
// title of at least one test tagged @smoke that exercises it. tests/smoke-guard.spec.ts
// fails if any of these is missing from the tagged set, or if the set drifts outside
// SMOKE_SIZE. Add a new protected rule here when you add it to the smoke set.

export const SMOKE_SIZE = { min: 30, max: 45 } as const

export const PROTECTED_SMOKE: Record<string, { file: string; title: string }[]> = {
  'live-call block': [
    { file: 'provider-block.spec.ts', title: 'Anthropic: a real createMessage is refused' },
    { file: 'provider-block.spec.ts', title: 'OpenAI images: real storyboard and reference generations are refused' },
    { file: 'provider-block.spec.ts', title: 'ElevenLabs: real synthesis, alignment and music are refused' },
    { file: 'provider-block.spec.ts', title: 'an opt-out is refused while the block is set, in production and out' },
  ],
  'mock seam': [
    {
      file: 'shot-generation.spec.ts',
      title:
        'writes the shots, applies the title and video type, inserts an assistant message, and lands on succeeded with the payload cleared',
    },
  ],
  claim: [
    {
      file: 'generations-claim.spec.ts',
      title: 'two concurrent claims on a fresh identity: exactly one claims, the other is blocked as already_generating',
    },
    {
      file: 'generations-claim.spec.ts',
      title: 'two raw inserts with shot_id null for the same (project, step, operation) collide on NULLS NOT DISTINCT',
    },
  ],
  recover: [
    {
      file: 'shot-generation.spec.ts',
      title: 'recovery replays a stored outline without calling the gateway again, replacing the existing shots',
    },
  ],
  dedupe: [
    {
      file: 'messages-idempotency.spec.ts',
      title: 'a repeated (project_id, client_id) is detected as a duplicate and returns the original row untouched',
    },
    {
      file: 'ledger.spec.ts',
      title: 'calling recordFixedSpend twice with the same attemptId produces exactly one row and does not throw',
    },
  ],
  '402 before claim': [
    {
      file: 'image-prompt-generation.spec.ts',
      title: 'a refused balance check is the first gate: no generations row, no usage row, no ledger write, no provider call',
    },
    {
      file: 'fixed-price-ledger.spec.ts',
      title: 'insufficient balance returns 402, with no provider call, no ledger row, and no usage row',
    },
  ],
  'reserve/settle': [
    { file: 'usage-module.spec.ts', title: 'reserveUsage throws when the insert violates a CHECK constraint, and writes no row' },
    { file: 'usage-module.spec.ts', title: 'settleUsage does not throw when its UPDATE fails, and the row stays pending' },
    { file: 'shot-generation.spec.ts', title: 'a pre-network blocked call settles as failed with zero cost, not the quote' },
  ],
  rls: [
    { file: 'credit-ledger-schema.spec.ts', title: 'an authenticated client sees only its own rows' },
    { file: 'credit-ledger-schema.spec.ts', title: 'an authenticated client cannot insert, update, or delete' },
    { file: 'elements-read.spec.ts', title: "a user cannot read another user's project elements" },
  ],
  'wiring identity': [
    { file: 'wiring-identity.spec.ts', title: 'agent/route.ts wires the real mintAttemptId/recordDynamicSpend into runAgentTurn' },
  ],
  'enums drift': [{ file: 'enums-drift.spec.ts', title: 'accepts every STEPS member as generations.step and rejects a bogus value' }],
  'ledger immutability': [
    { file: 'ledger.spec.ts', title: 'no .update() or .delete() against credit_ledger anywhere in the module' },
  ],
  'balance gating': [
    { file: 'image-prompts-advance.spec.ts', title: 'sufficient balance advances the step and returns the required credits' },
    {
      file: 'image-prompts-advance.spec.ts',
      title: 'insufficient balance returns 402, reports the numbers, and never calls advanceStep',
    },
  ],
  'step advance': [
    { file: 'advance-step.spec.ts', title: 'forward advance sets both current_step and furthest_step' },
    {
      file: 'image-prompt-edit.spec.ts',
      title: 'saving is not advancing: current_step and furthest_step are untouched',
    },
  ],
}
