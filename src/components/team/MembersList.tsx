// B2a T1 — members list. Owner-only gets remove controls (I-T1-10).
// Member-removal endpoint lands in a T1 polish commit.

'use client';

import { Button } from '@/components/ui/button';

export interface MemberRow {
  membership_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  role: 'owner' | 'member';
  joined_at: string;
}

export function MembersList({ members, canManage }: { members: MemberRow[]; canManage: boolean }) {
  return (
    <ul className="mt-4 space-y-2 text-sm">
      {members.map((m) => (
        <li
          key={m.membership_id}
          className="flex items-center justify-between rounded-md border border-[color:var(--border)] px-4 py-3"
        >
          <div className="flex items-center gap-3">
            {m.avatar_url ? (
              <img src={m.avatar_url} alt="" className="h-8 w-8 rounded-full" />
            ) : (
              <div className="h-8 w-8 rounded-full bg-[color:var(--muted)]" />
            )}
            <div>
              <div className="font-medium">{m.display_name ?? m.email}</div>
              <div className="text-xs text-[color:var(--muted-foreground)]">{m.email}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-sm bg-[color:var(--muted)] px-2 py-0.5 text-xs uppercase tracking-wider">
              {m.role}
            </span>
            {canManage ? (
              <Button variant="ghost" size="sm" disabled aria-label="Remove (coming soon)">
                Remove
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
