'use client'

import type { WorkbenchTab } from './workbench-tabs'
import { useShots } from './shots-context'
import { ShotsFooter } from './shots-footer'
import { AssetsFooter } from './assets-footer'

export function WorkbenchFooter({ activeTab }: { activeTab: WorkbenchTab }) {
  const { shots } = useShots()

  if (activeTab === 'assets') return <AssetsFooter />
  if (activeTab === 'script') return null

  const namesWithoutReference = new Map<string, string>()
  for (const shot of shots) {
    for (const el of shot.elements) {
      if (!el.reference_image_path && !namesWithoutReference.has(el.id)) {
        namesWithoutReference.set(el.id, el.name)
      }
    }
  }

  return <ShotsFooter elementNamesWithoutReference={[...namesWithoutReference.values()]} />
}
