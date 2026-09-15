// Shared glyph for every "this is read-only" affordance in the workbench - the
// read-only banner inside Shots, the locked Shots tab item, and the Assets-tab banner
// explaining the split. One SVG so the three stay pixel-identical instead of drifting.
export function LockIcon({ width = 8, height = 10 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 10 12" fill="none" aria-hidden="true">
      <rect x="0.75" y="4.9" width="8.5" height="6.35" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.75 4.9V3.3a2.25 2.25 0 0 1 4.5 0v1.6" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}
