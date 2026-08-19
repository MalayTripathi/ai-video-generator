export function Spinner({
  className = 'h-3 w-3',
  thickness = 1.5,
}: {
  className?: string
  thickness?: number
}) {
  return (
    <span
      className={`block flex-none rounded-full border-border-muted border-t-accent ${className}`}
      style={{ animation: 'rc-spin 0.7s linear infinite', borderWidth: thickness }}
      aria-hidden
    />
  )
}
