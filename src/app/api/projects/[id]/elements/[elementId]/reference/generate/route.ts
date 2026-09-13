import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createImageGateway } from '@/lib/images/gateway'
import { mintAttemptId, recordFixedSpend, getBalance } from '@/lib/credits/ledger'
import { runElementReferenceGeneration } from './logic'

// sharp is a native binary and cannot run on the Edge runtime.
export const runtime = 'nodejs'

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
  })

  if (result.ok) {
    return NextResponse.json(result.data, { status: result.status })
  }

  return NextResponse.json({ error: result.error }, { status: result.status })
}
