import type { AspectRatio } from '@/lib/config/enums'

// The frame plate follows the project's aspect ratio; the canvas draws 9:16 at 74x132.
export const PLATE_SIZE: Record<AspectRatio, { w: number; h: number }> = {
  '9:16': { w: 74, h: 132 },
  '16:9': { w: 132, h: 74 },
  '1:1': { w: 100, h: 100 },
}
