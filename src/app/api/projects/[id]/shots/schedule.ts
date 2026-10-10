import 'server-only'
import { after } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { createClaudeGateway } from '@/lib/claude'
import { recordDynamicSpend, recordFixedSpend } from '@/lib/credits/ledger'
import { readBalance } from '@/lib/credits/balance'
import { continuationSecret } from '@/lib/continuation'
import type { ShotRunLedger } from '@/lib/shots/runs'
import { createShotsContinueRun, runShotsWorker, type ShotsContinuationPayload } from './worker'

// The real wiring of the shot-generation chain, shared by the shots route (its user and
// continuation paths) and the agent route's regenerate_all_shots.

export const SHOT_RUN_LEDGER: ShotRunLedger = { recordFixedSpend, recordDynamicSpend }

/**
 * Schedules one run of the chain with the service-role client (the user's session may
 * expire long before a long shot list finishes, and closing the browser must not stop it).
 * The user and project were verified by the caller; every write is scoped by both.
 */
export function scheduleShotsWorker(origin: string, run: ShotsContinuationPayload | (Omit<ShotsContinuationPayload, 'chainDepth'> & { chainDepth: 0 })) {
  after(async () => {
    const supabase = createServiceRoleClient()
    await runShotsWorker(
      {
        supabase,
        gateway: createClaudeGateway(),
        ledger: SHOT_RUN_LEDGER,
        readBalance: async (userId) => (await readBalance(supabase, userId, { fresh: true })).balance,
        continueRun: createShotsContinueRun({ origin, secret: continuationSecret() }),
      },
      run
    )
  })
}
