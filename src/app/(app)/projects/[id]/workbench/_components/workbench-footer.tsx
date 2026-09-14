'use client'

import { useShots } from './shots-context'
import { ShotsFooter } from './shots-footer'

// Shared across all three Workbench tabs (Shots, Assets, Script) - one implementation.
// Only elements attached to at least one shot count: an unbound element's missing
// reference can't affect any output, so counting it would be a warning nobody can act on.
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
