import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createImageGateway } from '@/lib/images/gateway'
import { mintAttemptId, recordFixedSpend } from '@/lib/credits/ledger'
import { getBalance } from '@/lib/credits/balance'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { runElementReferenceGeneration, type GenerationFailureCode } from './logic'

// sharp is a native binary and cannot run on the Edge runtime.
export const runtime = 'nodejs'

// The one place a classified failure's user-facing copy is produced. result.error is
// always the raw diagnostic text (already settled onto generations.error/usage.error
// inside runElementReferenceGeneration, unchanged) - result.code, when present, picks
// the safe replacement sent to the client instead. No code means the error was already
// safe, hand-written copy (element not found, busy, insufficient credits) with nothing
// to map.
const GENERATION_FAILURE_MESSAGES: Record<GenerationFailureCode, string> = {
  blocked: 'Image generation is unavailable right now.',
  provider_error: "Something went wrong generating the image. Please try again.",
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; elementId: string }> }
) {
  const { id: projectId, elementId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const result = await runElementReferenceGeneration({
    gateway: createImageGateway(),
    supabase,
    projectId,
    elementId,
    userId: user.id,
    attemptId: mintAttemptId(),
    recordFixedSpend,
    getBalance,
    ensureSignupGrant,
  })

  if (result.ok) {
    return NextResponse.json({ ok: true, data: result.data }, { status: result.status })
  }

  const clientError = 'code' in result && result.code ? GENERATION_FAILURE_MESSAGES[result.code] : result.error
  return NextResponse.json({ ok: false, error: clientError }, { status: result.status })
}
