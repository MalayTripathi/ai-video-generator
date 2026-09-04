import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClaudeGateway } from '@/lib/claude'
import { CAMERA_FIELD_NAMES, type CameraFieldName } from '@/lib/prompts/camera-derivation'
import { runCameraDerivation } from './logic'

function parseCameraFieldName(value: unknown): CameraFieldName | null {
  return typeof value === 'string' && (CAMERA_FIELD_NAMES as readonly string[]).includes(value)
    ? (value as CameraFieldName)
    : null
}

// `fields` is the request's write scope - see CLAUDE.md's camera-scope invariant. It is
// required and never inferred: missing, empty, non-array, an unknown member, or a
// duplicate member are all rejected here, before any DB read or AI call.
function parseFields(raw: unknown): CameraFieldName[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const seen = new Set<CameraFieldName>()
  const result: CameraFieldName[] = []
  for (const item of raw) {
    const parsed = parseCameraFieldName(item)
    if (!parsed || seen.has(parsed)) return null
    seen.add(parsed)
    result.push(parsed)
  }
  return result
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; shotId: string }> }) {
  const { id: projectId, shotId } = await params

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

  const fields = parseFields((body as { fields?: unknown } | null)?.fields)
  if (!fields) {
    return NextResponse.json(
      {
        error:
          'fields is required: a non-empty array of shot_size/camera_angle/camera_movement with no duplicates',
      },
      { status: 400 }
    )
  }

  const revertField = parseCameraFieldName((body as { revertField?: unknown } | null)?.revertField) ?? undefined
  const resetAll = (body as { resetAll?: unknown } | null)?.resetAll === true

  const result = await runCameraDerivation({
    gateway: createClaudeGateway(),
    supabase,
    projectId,
    shotId,
    userId: user.id,
    fields,
    revertField,
    resetAll,
  })

  if (result.ok) {
    return NextResponse.json(result.data, { status: result.status })
  }

  return NextResponse.json({ error: result.error }, { status: result.status })
}
