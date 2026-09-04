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

export async function POST(request: Request, { params }: { params: Promise<{ id: string; shotId: string }> }) {
  const { id: projectId, shotId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let fields: CameraFieldName[] | undefined
  let revertField: CameraFieldName | undefined
  try {
    const body = await request.json()
    const rawFields = (body as { fields?: unknown } | null)?.fields
    if (Array.isArray(rawFields)) {
      const parsed = rawFields.map(parseCameraFieldName).filter((f): f is CameraFieldName => f !== null)
      if (parsed.length > 0) fields = parsed
    }
    const parsedRevert = parseCameraFieldName((body as { revertField?: unknown } | null)?.revertField)
    if (parsedRevert) revertField = parsedRevert
  } catch {
    // no/invalid body -> defaults inside runCameraDerivation (all 3 fields, no revert)
  }

  const result = await runCameraDerivation({
    gateway: createClaudeGateway(),
    supabase,
    projectId,
    shotId,
    userId: user.id,
    fields,
    revertField,
  })

  if (result.ok) {
    return NextResponse.json(result.data, { status: result.status })
  }

  return NextResponse.json({ error: result.error }, { status: result.status })
}
