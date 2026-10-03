import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { mintAttemptId } from '@/lib/credits/ledger'
import { runMusicUploadUrlRequest } from '../logic'
import { refusalResponse } from '../../voiceover/respond'

// Vercel Hobby caps a function at 300s; tests/route-max-duration.spec.ts enforces it.
export const maxDuration = 300

// Step one of a music upload: a signed URL the browser uploads the file to directly.
// Free; nothing is claimed or charged.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  let body: { mime?: unknown; bytes?: unknown } | null
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body?.mime !== 'string' || typeof body?.bytes !== 'number') {
    return NextResponse.json({ ok: false, error: 'mime and bytes are required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const result = await runMusicUploadUrlRequest({
    supabase,
    projectId,
    userId: user.id,
    mime: body.mime,
    bytes: body.bytes,
    mintAttemptId,
  })
  if (!result.ok) return refusalResponse(result)
  return NextResponse.json(result, { status: 200 })
}
