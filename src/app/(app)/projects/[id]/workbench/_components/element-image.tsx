'use client'

import { useEffect, useRef, useState } from 'react'
import { useAssets } from './assets-context'

// The reference-set image area. A load failure (an expired or otherwise broken signed
// URL) triggers exactly one resignImage() call for this element's path - never a retry
// loop. If the resign itself doesn't produce a working image, the striped placeholder
// stays rather than the browser's broken-image icon. A new `url` (from a successful
// resign, or a batch refresh) always gets a fresh attempt - `broken` resets whenever
// the url itself changes, not only on a successful load of the current one.
export function ElementImage({ path, url, alt }: { path: string; url: string | null; alt: string }) {
  const { resignImage } = useAssets()
  const [broken, setBroken] = useState(false)
  const resignAttemptedRef = useRef(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBroken(false)
    resignAttemptedRef.current = false
  }, [url])

  function handleError() {
    setBroken(true)
    if (resignAttemptedRef.current) return
    resignAttemptedRef.current = true
    void resignImage(path)
  }

  if (!url || broken) {
    return (
      <div
        className="h-full w-full"
        style={{
          backgroundImage: 'repeating-linear-gradient(135deg, var(--stripe-a) 0 7px, var(--stripe-b) 7px 14px)',
        }}
        aria-hidden={!!url}
      />
    )
  }

  // A signed URL is opaque and short-lived; next/image's remote-pattern allowlist and
  // its own caching would fight the resign-on-error recovery this component exists to do.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt} className="h-full w-full object-cover" onError={handleError} />
  )
}
