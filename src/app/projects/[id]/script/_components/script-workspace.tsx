'use client'

import { useState } from 'react'
import type { Message, Scene } from '../../types'
import { ChatPanel } from './chat-panel'
import { ScenePanel } from './scene-panel'

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
  const [messages, setMessages] = useState(initialMessages)
  const [scenes, setScenes] = useState(initialScenes)
  const [pending, setPending] = useState(false)
  const [justChangedKeys, setJustChangedKeys] = useState<Set<string>>(new Set())

  async function handleSend(text: string) {
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'user', content: text, created_at: new Date().toISOString() },
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
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `local-error-${Date.now()}`,
          role: 'assistant',
          content: 'Something went wrong sending that. Try again.',
          created_at: new Date().toISOString(),
        },
      ])
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[42fr_58fr]">
      <ChatPanel messages={messages} pending={pending} onSend={handleSend} />
      <ScenePanel projectId={projectId} scenes={scenes} pending={pending} justChangedKeys={justChangedKeys} />
    </div>
  )
}
