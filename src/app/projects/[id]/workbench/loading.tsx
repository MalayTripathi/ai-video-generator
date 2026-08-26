import { Rail } from '@/app/dashboard/rail'
import { Spinner } from '@/components/spinner'

export default function WorkbenchLoading() {
  return (
    <div className="flex h-screen">
      <Rail />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center">
        <Spinner className="h-10 w-10" thickness={2.5} />
      </div>
    </div>
  )
}
