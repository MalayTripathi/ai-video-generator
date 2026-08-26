import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Rail } from '@/app/dashboard/rail'
import { TopBar } from '@/app/dashboard/top-bar'
import { displayTitle } from '@/lib/display-title'
import { WorkbenchStepIndicator } from './_components/workbench-step-indicator'

export default async function WorkbenchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id, title, source_text, status, current_step')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) {
    notFound()
  }

  return (
    <div className="flex h-screen">
      <Rail />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar
          user={user}
          left={
            <span className="truncate text-body font-medium tracking-micro text-text-primary">
              {displayTitle(project)}
            </span>
          }
        />
        <WorkbenchStepIndicator currentStep={project.current_step} />
        <div className="flex flex-1 items-center justify-center px-rc-lg py-rc-2xl lg:px-rc-xl xl:px-rc-2xl">
          <div className="flex max-w-sm flex-col items-center gap-rc-sm rounded-frame border border-dashed border-border-muted bg-bg-well px-rc-xl py-rc-2xl text-center">
            <h2 className="text-section font-medium tracking-snug text-text-primary">
              Workbench is next
            </h2>
            <p className="text-ui text-text-secondary">
              Shot generation from your brief isn&rsquo;t built yet — this is just the landing spot for now.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
