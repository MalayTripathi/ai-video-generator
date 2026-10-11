import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth/current-user'
import { readBalance } from '@/lib/credits/balance'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { TopBar } from '@/app/(app)/dashboard/top-bar'
import { IntakeForm } from './_components/intake-form'
import { PreviewPane } from './_components/preview-pane'
import type { TemplateProject } from './types'

export default async function NewProjectPage() {
  const supabase = await createClient()
  const user = await getCurrentUser()

  if (!user) {
    redirect('/login')
  }

  // The layout renders in parallel and may not have granted a new user's signup credits
  // yet, so the page grants first (idempotent), then reads the balance fresh - a brand-new
  // user never sees a shortfall that isn't real.
  const [{ data: recentProjects }, balance] = await Promise.all([
    supabase
      .from('projects')
      .select(
        'id, title, source_text, video_type, aspect_ratio, duration_target, language, quality_preset, video_model, video_resolution, image_quality, image_model, created_at'
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(8),
    ensureSignupGrant(user.id)
      .then(() => readBalance(supabase, user.id, { fresh: true }))
      .catch(() => null),
  ])

  return (
    <>
      <TopBar left={<span />} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-[420px] flex-none flex-col gap-rc-lg overflow-y-auto px-rc-xl py-rc-xl">
          <div className="flex flex-col gap-rc-2xs">
            <h1 className="text-display font-medium tracking-tight text-text-primary">
              What do you want to make?
            </h1>
            <p className="text-body text-text-secondary">
              An idea, a script, a screenplay. Anything works.
            </p>
          </div>
          <IntakeForm
            recentProjects={(recentProjects ?? []) as TemplateProject[]}
            balance={balance?.balance ?? null}
          />
        </div>
        <div className="w-px flex-none bg-border-subtle" />
        <PreviewPane />
      </div>
    </>
  )
}
