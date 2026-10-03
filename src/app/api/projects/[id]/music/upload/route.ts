import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runMusicUploadRequest } from '../logic'
import { refusalResponse } from '../../voiceover/respond'

// Vercel Hobby caps a function at 300s; tests/route-max-duration.spec.ts enforces it.
export const maxDuration = 300

export const runtime = 'nodejs'

// Step two of a music upload: read the stored file's duration server-side and link it as
// the project's music. Free.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  let body: { attemptId?: unknown; ext?: unknown } | null
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body?.attemptId !== 'string' || typeof body?.ext !== 'string') {
    return NextResponse.json({ ok: false, error: 'attemptId and ext are required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const result = await runMusicUploadRequest({
    supabase,
    projectId,
    userId: user.id,
    attemptId: body.attemptId,
    ext: body.ext,
  })
  if (!result.ok) return refusalResponse(result)
  return NextResponse.json({ ok: true, path: result.path, durationSec: result.durationSec }, { status: 200 })
}
