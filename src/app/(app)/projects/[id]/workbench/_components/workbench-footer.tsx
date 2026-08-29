'use client'

import { useShots } from './shots-context'
import { ShotsFooter } from './shots-footer'

export function WorkbenchFooter() {
  const { shots } = useShots()

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
