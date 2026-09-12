import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClaudeGateway } from '@/lib/claude'
import { mintAttemptId, recordDynamicSpend } from '@/lib/credits/ledger'
import { runAgentTurn, type AgentStreamEvent } from './logic'

// Covers the 180s agent_turn stale-claim window with margin; the whole request is held
// open for the turn (see docs/decisions.md).
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

  let content: string
  let clientId: string
  try {
    const body = (await request.json()) as { content?: unknown; clientId?: unknown }
    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 })
    }
    if (typeof body.clientId !== 'string' || body.clientId.trim().length === 0) {
      return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
    }
    content = body.content
    clientId = body.clientId
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  let streamClosed = false

  const stream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (event: AgentStreamEvent) => {
        if (streamClosed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
        } catch {
          // Broken pipe - stop trying to write. runAgentTurn's own settle logic is
          // entirely independent of whether these writes succeed (see logic.ts).
          streamClosed = true
        }
      }

      try {
        await runAgentTurn({
          gateway: createClaudeGateway(),
          supabase,
          projectId,
          userId: user.id,
          content,
          clientId,
          onEvent: safeEnqueue,
          attemptId: mintAttemptId(),
          recordTurnSpend: recordDynamicSpend,
        })
      } finally {
        try {
          controller.close()
        } catch {
          // Already closed by a prior enqueue failure - nothing further to do.
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
