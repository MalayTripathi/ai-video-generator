import { Spinner } from '@/components/spinner'

export default function WorkbenchLoading() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <Spinner className="h-10 w-10" thickness={2.5} />
    </div>
  )
}
