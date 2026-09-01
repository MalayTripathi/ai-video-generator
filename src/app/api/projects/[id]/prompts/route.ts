import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClaudeGateway } from '@/lib/claude'
import { runPromptGeneration } from './logic'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let retry = false
  try {
    const body = await request.json()
    retry = (body as { retry?: unknown } | null)?.retry === true
  } catch {
    retry = false // no body (the plain auto-trigger POST) throws SyntaxError - expected
  }

  const result = await runPromptGeneration({
    gateway: createClaudeGateway(),
    supabase,
    projectId,
    userId: user.id,
    retry,
  })

  if (result.ok) {
    return NextResponse.json(result.data, { status: result.status })
  }

  if (result.status === 422) {
    return NextResponse.json(
      {
        error: result.error,
        ...(result.missingShotKeys ? { missingShotKeys: result.missingShotKeys } : {}),
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
