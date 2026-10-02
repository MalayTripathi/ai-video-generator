import 'server-only'
import { getCurrentUser } from '@/lib/auth/current-user'
import { creditsFor } from '@/lib/config/credits'
import { getBalance } from '@/lib/credits/balance'

// Read-only affordance check for the Assets tab's Generate controls: the per-element
// price (never hardcoded - CLAUDE.md) plus whether the user's current balance covers
// it. This never reserves, spends, or writes anything - runElementReferenceGeneration
// (the actual paid call) still runs its own balance gate independently; this is purely
// so the UI can disable Generate proactively instead of only reacting to a 402. Called
// from page renders only - a plain server module, not a server action.
export async function getElementGenerateAffordability(): Promise<{
  generateCredits: number
  hasInsufficientBalance: boolean
}> {
  const generateCredits = creditsFor({ step: 'workbench', operation: 'generate_element_reference', quantity: 1 })

  // getCurrentUser is getUser() - request-memoized when a page render calls this, so the
  // page's own auth check is reused instead of paying a second auth-server round trip.
  const user = await getCurrentUser()
  if (!user) return { generateCredits, hasInsufficientBalance: true }

  const balance = await getBalance(user.id)
  return { generateCredits, hasInsufficientBalance: balance < generateCredits }
}
