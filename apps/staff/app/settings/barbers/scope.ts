// Branches the signed-in staff member may manage: all for an Owner, otherwise the branch ids in
// their JWT. Mirrors in_branch_scope() so pickers only offer branches a save would be allowed on.
// Throws on auth or branches load failure — callers must handle errors.
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

type Supabase = ReturnType<typeof createBrowserSupabaseClient>;

export interface ManageableBranch {
  id: string;
  name: string;
  branch_code: string;
}

export async function loadManageableBranches(supabase: Supabase): Promise<ManageableBranch[]> {
  const [
    { data: role, error: roleError },
    { data: branchIds, error: idsError },
    { data: branches, error: branchesError },
  ] = await Promise.all([
    supabase.rpc('auth_role'),
    supabase.rpc('auth_branch_ids'),
    supabase.from('branches').select('id, name, branch_code').order('name'),
  ]);
  if (roleError || idsError || branchesError) throw roleError ?? idsError ?? branchesError;
  const all = (branches ?? []) as ManageableBranch[];
  if (role === 'owner') return all;
  const allowed = new Set(branchIds ?? []);
  return all.filter((b) => allowed.has(b.id));
}
