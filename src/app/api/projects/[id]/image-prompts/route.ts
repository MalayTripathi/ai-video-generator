import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClaudeGateway } from '@/lib/claude'
import { mintAttemptId, recordFixedSpend } from '@/lib/credits/ledger'
import { getBalance } from '@/lib/credits/balance'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { runImagePromptGeneration } from './logic'

// shotIds is the request's explicit write scope - see CLAUDE.md's "scope is never
// inferred, defaulted, or widened server-side" principle (established for camera
// fields, applied here to which shots). Required and validated before any DB read or
// AI call: missing, empty, non-array, a non-string/empty-string member, or a duplicate
// are all rejected.
function parseShotIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) return null
    seen.add(item)
    result.push(item)
  }
  return result
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const shotIds = parseShotIds((body as { shotIds?: unknown } | null)?.shotIds)
  if (!shotIds) {
    return NextResponse.json(
      { error: 'shotIds is required: a non-empty array of shot ids with no duplicates' },
      { status: 400 }
    )
  }
  const retry = (body as { retry?: unknown } | null)?.retry === true

  const result = await runImagePromptGeneration({
    gateway: createClaudeGateway(),
    supabase,
    projectId,
    userId: user.id,
    shotIds,
    retry,
    attemptId: mintAttemptId(),
    recordFixedSpend,
    getBalance,
    ensureSignupGrant,
  })

  if (result.ok) {
    return NextResponse.json(result.data, { status: result.status })
  }

  if (result.status === 422) {
    return NextResponse.json(
      {
        error: result.error,
        ...(result.missingShotKeys ? { missingShotKeys: result.missingShotKeys } : {}),
        ...(result.failedShotKeys ? { failedShotKeys: result.failedShotKeys } : {}),
        ...(result.shots ? { shots: result.shots } : {}),
      },
      { status: result.status }
    )
  }

  return NextResponse.json(
    'reason' in result ? { error: result.error, reason: result.reason } : { error: result.error },
    { status: result.status }
  )
}
