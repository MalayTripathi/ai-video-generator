'use client'

import type { User } from '@supabase/supabase-js'
import { useState } from 'react'
import { TopBar } from '@/app/dashboard/top-bar'
import { StepIndicator } from '../../_components/step-indicator'
import type { Message, ProjectStatus, Scene, WizardStep } from '../../types'
import { ScriptHeader } from './script-header'
import { ScriptWorkspace } from './script-workspace'

export function ScriptShell({
  user,
  projectId,
  initialTitle,
  status,
  currentStep,
  initialMessages,
  initialScenes,
}: {
  user: User
  projectId: string
  initialTitle: string
  status: ProjectStatus
  currentStep: WizardStep
  initialMessages: Message[]
  initialScenes: Scene[]
}) {
  const [title, setTitle] = useState(initialTitle)

  return (
    <>
      <TopBar
        user={user}
        left={<ScriptHeader projectId={projectId} title={title} onTitleChange={setTitle} status={status} />}
        right={<span className="text-meta text-text-tertiary">Saved</span>}
      />
      <StepIndicator currentStep={currentStep} />
      <ScriptWorkspace
        projectId={projectId}
        initialMessages={initialMessages}
        initialScenes={initialScenes}
        onTitleAutoUpdate={setTitle}
      />
    </>
  )
}
