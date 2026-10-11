import 'server-only'
import { after } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { createClaudeGateway } from '@/lib/claude'
import { recordDynamicSpend, recordFixedSpend } from '@/lib/credits/ledger'
import { readBalance } from '@/lib/credits/balance'
import { continuationSecret, deploymentBypassHeaders } from '@/lib/continuation'
import type { ShotRunLedger } from '@/lib/shots/runs'
import { createShotsContinueRun, runShotsWorker, type ShotsContinuationPayload } from './worker'

// The real wiring of the shot-generation chain: scheduleShotsWorker runs a run inside the
// shots route's own invocation (its user and continuation paths); startShotsChain starts a
// chain's first run in a fresh invocation of that route, for a caller whose own invocation
// is already spending its 300s (the agent turn's regenerate_all_shots).

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
        continueRun: createShotsContinueRun({ origin, secret: continuationSecret(), headers: deploymentBypassHeaders() }),
      },
      run
    )
  })
}

/**
 * Starts a chain's first run (chainDepth 0) through the shots route's continuation path, so
 * it gets an invocation - and a 300s - of its own. Resolves true only when accepted.
 */
export function startShotsChain(origin: string): (run: Omit<ShotsContinuationPayload, 'chainDepth'> & { chainDepth: 0 }) => Promise<boolean> {
  const handOff = createShotsContinueRun({ origin, secret: continuationSecret(), headers: deploymentBypassHeaders() })
  return async (run) => {
    try {
      return await handOff(run)
    } catch (err) {
      console.error('[shots] could not start the chain in its own invocation', err)
      return false
    }
  }
}
