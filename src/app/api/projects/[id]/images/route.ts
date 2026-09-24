import { timingSafeEqual } from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { tryLoadRailFigures } from '@/app/(app)/rail-figures'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { createImageGateway } from '@/lib/images/gateway'
import { mintAttemptId, recordFixedSpend } from '@/lib/credits/ledger'
import { getBalance } from '@/lib/credits/balance'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import {
  parseContinuationPayload,
  runImageWorker,
  runImagesContinuation,
  runImagesRequest,
  type ContinuationPayload,
} from './logic'

// sharp is a native binary and cannot run on the Edge runtime.
export const runtime = 'nodejs'
// The background run lives inside this invocation (after()), so it gets the route's full
// duration. Must stay a literal here; mirrors IMAGES_ROUTE_MAX_DURATION_S in
// src/lib/config/storyboard.ts, whose RUN_TIME_BUDGET_MS is sized to fit inside it.
export const maxDuration = 800

// A background run calling this same route to continue itself sends this header. It
// carries no user session, so the shared secret is its only credential.
const INTERNAL_SECRET_HEADER = 'x-images-internal-secret'

function secretMatches(provided: string): boolean {
  const expected = process.env.IMAGES_INTERNAL_SECRET
  if (!expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Same shape as the image-prompts route's parser: shotIds is the request's explicit
// scope - required, non-empty, no blanks, no duplicates - never inferred server-side.
function parseShotIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) return null
    seen.add(item)
  }
  return raw as string[]
}

// Schedules the background run with the service-role client (the user's session may
// expire long before a large batch finishes). The user and project were verified by
// the caller of this function; every write inside the worker is scoped by both.
function scheduleWorker(origin: string, run: ContinuationPayload) {
  after(async () => {
    const supabase = createServiceRoleClient()
    await runImageWorker(
      {
        supabase,
        gateway: createImageGateway(),
        mintAttemptId,
        recordFixedSpend,
        continueRun: async (payload) => {
          const secret = process.env.IMAGES_INTERNAL_SECRET
          if (!secret) {
            console.error('[images] IMAGES_INTERNAL_SECRET is not set - a batch cannot continue past one run')
            return false
          }
          const res = await fetch(`${origin}/api/projects/${payload.projectId}/images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [INTERNAL_SECRET_HEADER]: secret },
            body: JSON.stringify(payload),
          })
          return res.status === 202
        },
      },
      run
    )
  })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const origin = new URL(request.url).origin

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  // Continuation path. Only a request presenting the header is considered for it; a
  // wrong or unconfigured secret is refused outright, never downgraded to the user path.
  const providedSecret = request.headers.get(INTERNAL_SECRET_HEADER)
  if (providedSecret !== null) {
    if (!secretMatches(providedSecret)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const payload = parseContinuationPayload(body, projectId)
    if (!payload) return NextResponse.json({ ok: false, error: 'Invalid continuation' }, { status: 400 })

    const resumed = await runImagesContinuation({ supabase: createServiceRoleClient(), payload })
    if (!resumed.ok) return NextResponse.json({ ok: false, error: resumed.error }, { status: resumed.status })

    if (resumed.generationIds.length > 0) {
      scheduleWorker(origin, { ...payload, generationIds: resumed.generationIds })
    }
    return NextResponse.json({ ok: true, resumed: resumed.generationIds.length }, { status: 202 })
  }

  // User path.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const shotIds = parseShotIds((body as { shotIds?: unknown } | null)?.shotIds)
  if (!shotIds) {
    return NextResponse.json(
      { ok: false, error: 'shotIds must be a non-empty array of distinct shot ids' },
      { status: 400 }
    )
  }

  const result = await runImagesRequest({
    supabase,
    projectId,
    userId: user.id,
    shotIds,
    getBalance,
    ensureSignupGrant,
  })

  if (!result.ok) {
    if (result.status === 402) {
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          requiredCredits: result.requiredCredits,
          balanceCredits: result.balanceCredits,
        },
        { status: 402 }
      )
    }
    return NextResponse.json({ ok: false, error: result.error, shotIds: result.shotIds }, { status: result.status })
  }

  const { generationIds, claimed, notGenerated, inFlight } = result.data
  if (generationIds.length > 0) {
    scheduleWorker(origin, { userId: user.id, projectId, generationIds, chainDepth: 0 })
  }
  // The charge itself lands when each shot settles (the status poll carries it); the rail
  // pair rides here too so every paid action answers with current figures.
  const rail = await tryLoadRailFigures(user.id)
  return NextResponse.json({ ok: true, claimed, notGenerated, inFlight, rail }, { status: 202 })
}
