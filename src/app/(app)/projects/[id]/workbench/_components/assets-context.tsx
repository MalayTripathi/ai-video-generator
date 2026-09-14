'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import type { ElementGroup, ProjectElement } from '@/lib/elements/read'
import type { ElementType } from '@/lib/config/enums'
import { getProjectElements, resignElementReferenceImage } from '../actions'
import { useSignedUrlRefresh } from './use-signed-url-refresh'

type AssetsContextValue = {
  projectId: string
  groups: ElementGroup[]
  elementCount: number
  generateCredits: number
  hasInsufficientBalance: boolean
  addElementLocal: (element: ProjectElement) => void
  updateElementLocal: (elementId: string, patch: Partial<ProjectElement>) => void
  removeElementLocal: (elementId: string) => void
  resignImage: (path: string) => Promise<void>
}

const AssetsContext = createContext<AssetsContextValue | null>(null)

function patchGroups(
  groups: ElementGroup[],
  elementId: string,
  patch: (el: ProjectElement) => ProjectElement
): ElementGroup[] {
  return groups.map((group) => ({
    ...group,
    elements: group.elements.map((el) => (el.id === elementId ? patch(el) : el)),
  }))
}

export function AssetsProvider({
  projectId,
  initialGroups,
  initialExpiresAt,
  generateCredits,
  hasInsufficientBalance,
  children,
}: {
  projectId: string
  initialGroups: ElementGroup[]
  initialExpiresAt: string
  generateCredits: number
  hasInsufficientBalance: boolean
  children: ReactNode
}) {
  const [groups, setGroups] = useState(initialGroups)
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt)

  function addElementLocal(element: ProjectElement) {
    setGroups((prev) =>
      prev.map((group) =>
        group.type === element.type
          ? { ...group, count: group.count + 1, elements: [...group.elements, element] }
          : group
      )
    )
  }

  function updateElementLocal(elementId: string, patch: Partial<ProjectElement>) {
    setGroups((prev) => patchGroups(prev, elementId, (el) => ({ ...el, ...patch })))
  }

  function removeElementLocal(elementId: string) {
    setGroups((prev) =>
      prev.map((group) => {
        const remaining = group.elements.filter((el) => el.id !== elementId)
        return remaining.length === group.elements.length
          ? group
          : { ...group, count: group.count - 1, elements: remaining }
      })
    )
  }

  // Batch refresh, ahead of the whole set of signed URLs expiring - see
  // use-signed-url-refresh.ts. Re-running getProjectElements is the same cheap path the
  // initial load already used (workbench/actions.ts's own comment on this).
  async function refreshSignedUrls() {
    const result = await getProjectElements(projectId)
    if (result.success) {
      setGroups(result.groups)
      setExpiresAt(result.expires_at)
    }
  }

  useSignedUrlRefresh(expiresAt, refreshSignedUrls)

  // Single-path recovery for one broken <img> - never refetches the whole batch, and
  // never touches `expiresAt` (that's the batch's own countdown; one recovered URL
  // doesn't change when the rest are due).
  async function resignImage(path: string) {
    const result = await resignElementReferenceImage(projectId, path)
    if (!result.success) return
    setGroups((prev) =>
      prev.map((group) => ({
        ...group,
        elements: group.elements.map((el) =>
          el.reference_image_path === path ? { ...el, reference_image_url: result.url } : el
        ),
      }))
    )
  }

  const elementCount = groups.reduce((n, g) => n + g.count, 0)

  return (
    <AssetsContext.Provider
      value={{
        projectId,
        groups,
        elementCount,
        generateCredits,
        hasInsufficientBalance,
        addElementLocal,
        updateElementLocal,
        removeElementLocal,
        resignImage,
      }}
    >
      {children}
    </AssetsContext.Provider>
  )
}

export function useAssets() {
  const ctx = useContext(AssetsContext)
  if (!ctx) throw new Error('useAssets must be used within an AssetsProvider')
  return ctx
}

export function useElementGroup(type: ElementType): ElementGroup {
  const { groups } = useAssets()
  const group = groups.find((g) => g.type === type)
  if (!group) throw new Error(`No element group for type ${type}`)
  return group
}
