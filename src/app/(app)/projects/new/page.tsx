import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TopBar } from '@/app/(app)/dashboard/top-bar'
import { IntakeForm } from './_components/intake-form'
import { PreviewPane } from './_components/preview-pane'
import type { TemplateProject } from './types'

export default async function NewProjectPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: recentProjects } = await supabase
    .from('projects')
    .select(
      'id, title, source_text, video_type, aspect_ratio, duration_target, language, video_model, created_at'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(8)

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
          <IntakeForm recentProjects={(recentProjects ?? []) as TemplateProject[]} />
        </div>
        <div className="w-px flex-none bg-border-subtle" />
        <PreviewPane />
      </div>
    </>
  )
}
