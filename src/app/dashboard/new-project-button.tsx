'use client'

import { useFormStatus } from 'react-dom'
import type { ReactNode } from 'react'

export function NewProjectButton({
  testId,
  className,
  children,
}: {
  testId: string
  className: string
  children: ReactNode
}) {
  const { pending } = useFormStatus()

  return (
    <button
      type="submit"
      data-testid={testId}
      disabled={pending}
      className={`${className} disabled:cursor-not-allowed disabled:opacity-45`}
    >
      {children}
    </button>
  )
}
