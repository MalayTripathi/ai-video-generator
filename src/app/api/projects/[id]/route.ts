import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { deleteProject } from '@/lib/projects/delete-project'

// Vercel Hobby caps a function at 300s; tests/route-max-duration.spec.ts enforces it. The
// storage sweep of a large project takes seconds, not minutes.
export const maxDuration = 300

// Project deletion - the only way a projects row is deleted (no client DELETE policy).
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })
  const result = await deleteProject({ supabase, service: createServiceRoleClient(), userId: user.id, projectId })
  if (result.ok) return NextResponse.json({ ok: true }, { status: 200 })
  return NextResponse.json({ ok: false, error: result.error, code: result.code }, { status: result.status })
}
