import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClaudeGateway } from '@/lib/claude'
import { runShotGeneration } from './logic'

export const maxDuration = 300

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  let retry = false
  try {
    const body = await request.json()
    retry = (body as { retry?: unknown } | null)?.retry === true
  } catch {
    retry = false // no body (the plain auto-trigger POST) throws SyntaxError - expected
  }

  const result = await runShotGeneration({
    gateway: createClaudeGateway(),
    supabase,
    projectId,
    userId: user.id,
    retry,
  })

  if (result.ok) {
    return NextResponse.json(result.data, { status: result.status })
  }

  return NextResponse.json(
    'reason' in result ? { error: result.error, reason: result.reason } : { error: result.error },
    { status: result.status }
  )
}
