import { requireGrantRequester } from '@/lib/roles';
import { requestGrant } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewAccessGrantPage() {
  await requireGrantRequester();

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Request access grant</h1>
        <p className="text-sm text-white/50">
          Request time-boxed access to a transcript (§8.4). The request grants nothing until an
          org_admin approves it with an expiry. Every step is audited and visible to the viewed
          user.
        </p>
      </div>

      <form action={requestGrant} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="scope" className="text-xs uppercase tracking-wide text-white/50">
            Scope
          </label>
          <select
            id="scope"
            name="scope"
            defaultValue="single_session"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
          >
            <option value="single_session">A single session</option>
            <option value="user_sessions">All sessions for one user</option>
          </select>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="targetSessionId"
            className="text-xs uppercase tracking-wide text-white/50"
          >
            Target session id (for single-session scope)
          </label>
          <input
            id="targetSessionId"
            name="targetSessionId"
            placeholder="session UUID"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm font-mono"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="targetUserId" className="text-xs uppercase tracking-wide text-white/50">
            Target user id (for user-sessions scope)
          </label>
          <input
            id="targetUserId"
            name="targetUserId"
            placeholder="user UUID"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm font-mono"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="justification" className="text-xs uppercase tracking-wide text-white/50">
            Justification (required)
          </label>
          <textarea
            id="justification"
            name="justification"
            required
            rows={3}
            placeholder="Why is this access needed?"
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
          />
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium hover:bg-brand-600"
          >
            Submit request
          </button>
          <a
            href="/admin/access-grants"
            className="rounded-md border border-white/10 px-4 py-2 text-sm hover:bg-white/10"
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}
