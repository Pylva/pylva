// B2a T1 — team settings. Lists members + pending invites; Owner-only
// sees the invite form + the remove/role buttons.

import type { Metadata } from 'next';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { withRLS } from '@/lib/db/rls';
import { invites, userBuilderMemberships, users } from '@/lib/db/schema';
import { InviteMemberForm } from '@/components/team/InviteMemberForm';
import { MembersList } from '@/components/team/MembersList';
import { COPY } from '@/lib/copy';

void COPY; // copy imports reserved for future strings on this page

export const metadata: Metadata = { title: 'Team' };

export default async function TeamPage() {
  const { builderId, role } = await readDashboardHeaders();

  const [members, pending] = await withRLS(builderId, async (tx) => {
    const m = await tx
      .select({
        membership_id: userBuilderMemberships.id,
        user_id: users.id,
        email: users.email,
        display_name: users.display_name,
        avatar_url: users.avatar_url,
        role: userBuilderMemberships.role,
        joined_at: userBuilderMemberships.created_at,
      })
      .from(userBuilderMemberships)
      .innerJoin(users, eq(users.id, userBuilderMemberships.user_id))
      .where(eq(userBuilderMemberships.builder_id, builderId))
      .orderBy(desc(userBuilderMemberships.created_at));

    const p = await tx
      .select({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        expires_at: invites.expires_at,
      })
      .from(invites)
      .where(
        and(
          eq(invites.builder_id, builderId),
          isNull(invites.accepted_at),
          gt(invites.expires_at, new Date()),
        ),
      )
      .orderBy(desc(invites.created_at));

    return [m, p];
  });

  const isOwner = role === 'owner';

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
      <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
        Owners can invite teammates and change roles. Members have read + write access to data but
        cannot remove other members or manage billing.
      </p>

      {isOwner ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Invite a teammate</h2>
          <InviteMemberForm />
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-base font-semibold">Members ({members.length})</h2>
        <MembersList
          members={members.map((m) => ({
            membership_id: m.membership_id,
            user_id: m.user_id,
            email: m.email,
            display_name: m.display_name,
            avatar_url: m.avatar_url,
            role: m.role as 'owner' | 'member',
            joined_at: m.joined_at.toISOString(),
          }))}
          canManage={isOwner}
        />
      </section>

      {pending.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Pending invites ({pending.length})</h2>
          <ul className="mt-4 space-y-2 text-sm">
            {pending.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-md border border-[color:var(--border)] px-4 py-3"
              >
                <div>
                  <div className="font-medium">{p.email}</div>
                  <div className="text-xs text-[color:var(--muted-foreground)]">
                    as {p.role} · expires {new Date(p.expires_at).toLocaleDateString()}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
