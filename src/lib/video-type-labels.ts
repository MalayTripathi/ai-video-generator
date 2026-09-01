import type { VideoType } from '@/lib/config/enums'

export const VIDEO_TYPES: { value: VideoType; label: string }[] = [
  { value: 'auto', label: 'Detect from my text' },
  { value: 'narrated_story', label: 'Narrated Story' },
  { value: 'explainer', label: 'Explainer' },
  { value: 'facts_listicle', label: 'Facts & Listicle' },
  { value: 'character_drama', label: 'Character Drama' },
  { value: 'product_ad', label: 'Product Ad' },
  { value: 'trailer', label: 'Trailer' },
]

export function videoTypeLabel(value: string | null): string | null {
  if (!value) return null
  return VIDEO_TYPES.find((option) => option.value === value)?.label ?? value
}
