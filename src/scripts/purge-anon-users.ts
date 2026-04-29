import "dotenv/config"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { User } from "@supabase/supabase-js"
import * as R from "ramda"

const required = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

const isOldAnonUser = (cutoff: Date) => (user: User) =>
  user.is_anonymous === true &&
  !!user.created_at &&
  new Date(user.created_at) < cutoff

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fetchAllUsers = async (
  supabase: SupabaseClient<any>,
): Promise<User[]> => {
  const users: User[] = []
  let page = 1
  const perPage = 1000

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    })
    if (error) throw error
    users.push(...data.users)
    if (data.users.length < perPage) break
    page++
  }

  return users
}

const main = async () => {
  const supabase = createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_SECRET_KEY"),
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  )

  const cutoff = new Date(Date.now() - ONE_DAY_MS)
  console.log(`Deleting anonymous users created before ${cutoff.toISOString()}`)

  const allUsers = await fetchAllUsers(supabase)
  const targets = R.filter(isOldAnonUser(cutoff), allUsers)

  console.log(
    `Found ${allUsers.length} total users, ${targets.length} anonymous users to delete`,
  )

  if (targets.length === 0) {
    console.log("Nothing to do.")
    return
  }

  const results = await Promise.allSettled(
    targets.map((user) => supabase.auth.admin.deleteUser(user.id)),
  )

  const succeeded = results.filter(
    (r) => r.status === "fulfilled" && !r.value.error,
  ).length
  const failed = results.length - succeeded

  console.log(
    `Deleted ${succeeded} users${failed > 0 ? `, ${failed} failed` : ""}`,
  )

  if (failed > 0) {
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`  Failed to delete ${targets[i]?.id}: ${r.reason}`)
      } else if (r.value.error) {
        console.error(
          `  Failed to delete ${targets[i]?.id}: ${r.value.error.message}`,
        )
      }
    })
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
