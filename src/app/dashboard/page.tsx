import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { signOut } from './actions'

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <p className="text-lg">Welcome, {user.email}</p>
      <form action={signOut}>
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">
          Sign out
        </button>
      </form>
    </div>
  )
}
