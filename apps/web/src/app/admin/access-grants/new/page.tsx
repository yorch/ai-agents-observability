import { Button, ButtonLink, Input, Select } from '@/components/ui';
import { requireGrantRequester } from '@/lib/roles';
import { requestGrant } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewAccessGrantPage() {
  await requireGrantRequester();

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">
          Request access grant
        </h1>
        <p className="text-sm text-text-2">
          Request time-boxed access to a transcript (§8.4). The request grants nothing until an
          org_admin approves it with an expiry. Every step is audited and visible to the viewed
          user.
        </p>
      </div>

      <form action={requestGrant} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="scope" className="text-xs uppercase tracking-wide text-text-2">
            Scope
          </label>
          <Select id="scope" name="scope" defaultValue="SINGLE_SESSION">
            <option value="SINGLE_SESSION">A single session</option>
            <option value="USER_SESSIONS">All sessions for one user</option>
          </Select>
        </div>

        <div className="space-y-1">
          <label htmlFor="targetSessionId" className="text-xs uppercase tracking-wide text-text-2">
            Target session id (for single-session scope)
          </label>
          <Input
            id="targetSessionId"
            name="targetSessionId"
            placeholder="session UUID"
            className="font-mono"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="targetUserId" className="text-xs uppercase tracking-wide text-text-2">
            Target user id (for user-sessions scope)
          </label>
          <Input
            id="targetUserId"
            name="targetUserId"
            placeholder="user UUID"
            className="font-mono"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="justification" className="text-xs uppercase tracking-wide text-text-2">
            Justification (required)
          </label>
          <textarea
            id="justification"
            name="justification"
            required
            rows={3}
            placeholder="Why is this access needed?"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
          />
        </div>

        <div className="flex gap-2">
          <Button type="submit">Submit request</Button>
          <ButtonLink variant="secondary" href="/admin/access-grants">
            Cancel
          </ButtonLink>
        </div>
      </form>
    </div>
  );
}
