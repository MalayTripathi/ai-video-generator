import { NextResponse } from 'next/server'

type Refusal =
  | { ok: false; status: number; error: string; code?: string; credits?: number; shotId?: string }
  | { ok: false; status: 402; error: string; requiredCredits: number; balanceCredits: number }

// One JSON shape for every voiceover refusal: the error, plus whatever the page needs to
// act on it (the new price, the credit figures, the shot that is too long).
export function refusalResponse(result: Refusal) {
  const { ok, status, ...rest } = result
  return NextResponse.json({ ok, ...rest }, { status })
}
