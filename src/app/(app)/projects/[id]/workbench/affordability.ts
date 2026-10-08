import 'server-only'
import { getCurrentUser } from '@/lib/auth/current-user'
import { creditsFor } from '@/lib/config/credits'
import { getBalance } from '@/lib/credits/balance'
import { elementReferencePriceKey } from '@/lib/images/price-key'

// Read-only affordance check for the Assets tab's Generate controls: the per-element
// price (never hardcoded - CLAUDE.md) plus whether the user's current balance covers
// it. This never reserves, spends, or writes anything - runElementReferenceGeneration
// (the actual paid call) still runs its own balance gate independently; this is purely
// so the UI can disable Generate proactively instead of only reacting to a 402. Called
// from page renders only - a plain server module, not a server action.
//
// The price follows the project's image quality, taken from the page's own project read
// (passed as a promise, so the balance read still runs alongside it - no extra query).
export async function getElementGenerateAffordability(imageQuality: PromiseLike<string | null>): Promise<{
  generateCredits: number
  hasInsufficientBalance: boolean
}> {
  // getCurrentUser is getUser() - request-memoized when a page render calls this, so the
  // page's own auth check is reused instead of paying a second auth-server round trip.
  const user = await getCurrentUser()
  const [quality, balance] = await Promise.all([imageQuality, user ? getBalance(user.id) : null])
  // A missing project 404s the page before this is shown; price it as the default meanwhile.
  const generateCredits = creditsFor({
    step: 'workbench',
    operation: 'generate_element_reference',
    quantity: 1,
    image: elementReferencePriceKey(quality ?? 'low'),
  })
  if (balance === null) return { generateCredits, hasInsufficientBalance: true }
  return { generateCredits, hasInsufficientBalance: balance < generateCredits }
}
