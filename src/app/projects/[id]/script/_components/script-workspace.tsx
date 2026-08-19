'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Message, Scene } from '../../types'
import { ChatPanel } from './chat-panel'
import { ScenePanel } from './scene-panel'

function describeScenes(keys: string[], scenes: Scene[]): string {
  const numbers = keys
    .map((key) => scenes.find((s) => s.scene_key === key)?.position)
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b)

  const labels = numbers.map((n) => `Scene ${n}`)
  if (labels.length <= 1) return labels[0] ?? keys.join(', ')
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}

export function ScriptWorkspace({
  projectId,
  initialMessages,
  initialScenes,
  onTitleAutoUpdate,
}: {
  projectId: string
  initialMessages: Message[]
  initialScenes: Scene[]
  onTitleAutoUpdate: (title: string) => void
}) {
  const router = useRouter()
  const [messages, setMessages] = useState(initialMessages)
  const [scenes, setScenes] = useState(initialScenes)
  const [pending, setPending] = useState(false)
  const [justChangedKeys, setJustChangedKeys] = useState<Set<string>>(new Set())
  const [promptsPending, setPromptsPending] = useState(false)
  const [promptsError, setPromptsError] = useState<string | null>(null)

  async function handleSend(text: string): Promise<boolean> {
    const localId = `local-${Date.now()}`
    setMessages((prev) => [
      ...prev,
      { id: localId, role: 'user', content: text, created_at: new Date().toISOString() },
    ])
    setPending(true)
    setJustChangedKeys(new Set())

    try {
      const res = await fetch(`/api/projects/${projectId}/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })

      if (!res.ok) throw new Error('Request failed')

      const data: { message: string; scenes: Scene[]; title: string | null } = await res.json()

      if (data.title) {
        onTitleAutoUpdate(data.title)
      }

      const prevByKey = new Map(scenes.map((scene) => [scene.scene_key, scene.voice_over]))
      const changed = new Set<string>()
      for (const scene of data.scenes) {
        const prevVoiceOver = prevByKey.get(scene.scene_key)
        if (prevVoiceOver === undefined || prevVoiceOver !== scene.voice_over) {
          changed.add(scene.scene_key)
        }
      }

      setScenes(data.scenes)
      setJustChangedKeys(changed)

      if (data.message.trim()) {
        setMessages((prev) => [
          ...prev,
          {
            id: `local-assistant-${Date.now()}`,
            role: 'assistant',
            content: data.message,
            created_at: new Date().toISOString(),
          },
        ])
      }

      return true
    } catch {
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== localId),
        {
          id: `local-error-${Date.now()}`,
          role: 'assistant',
          content: 'Something went wrong sending that. Try again.',
          created_at: new Date().toISOString(),
        },
      ])
      return false
    } finally {
      setPending(false)
    }
  }

  async function handleContinue() {
    setPromptsError(null)
    setPromptsPending(true)

    try {
      const res = await fetch(`/api/projects/${projectId}/prompts`, { method: 'POST' })

      if (!res.ok) {
        const body: { error?: string; missingSceneKeys?: string[] } | null = await res
          .json()
          .catch(() => null)

        const missing = body?.missingSceneKeys
        if (missing && missing.length > 0) {
          const retryWord = missing.length === 1 ? 'it' : 'just those scenes'
          throw new Error(
            `Couldn't generate prompts for ${describeScenes(missing, scenes)}. Click Continue to voiceover again to retry ${retryWord}.`
          )
        }

        throw new Error(body?.error ?? 'Request failed')
      }

      router.push(`/projects/${projectId}/voiceover`)
    } catch (err) {
      setPromptsError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
    } finally {
      setPromptsPending(false)
    }
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[42fr_58fr]">
      <ChatPanel messages={messages} pending={pending} onSend={handleSend} />
      <ScenePanel
        scenes={scenes}
        pending={pending}
        justChangedKeys={justChangedKeys}
        onContinue={handleContinue}
        promptsPending={promptsPending}
        promptsError={promptsError}
      />
    </div>
  )
}
