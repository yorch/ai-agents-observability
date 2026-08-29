import { ActionForm, Button, ButtonLink, Field, Input, Select, Textarea } from '@/components/ui';
import { getTranslations } from '@/i18n/server';
import { requireGrantRequester } from '@/lib/roles';
import { requestGrant } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewAccessGrantPage() {
  await requireGrantRequester();
  const { dict } = await getTranslations();

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

      <ActionForm action={requestGrant} className="space-y-4">
        <Field label={dict.admin.accessGrants.scope} htmlFor="scope">
          <Select id="scope" name="scope" defaultValue="SINGLE_SESSION">
            <option value="SINGLE_SESSION">{dict.admin.accessGrants.singleSession}</option>
            <option value="USER_SESSIONS">{dict.admin.accessGrants.userSessions}</option>
          </Select>
        </Field>

        <Field label={dict.admin.accessGrants.targetSession} htmlFor="targetSessionId">
          <Input
            id="targetSessionId"
            name="targetSessionId"
            placeholder="session UUID"
            className="font-mono"
          />
        </Field>

        <Field label={dict.admin.accessGrants.targetUser} htmlFor="targetUserId">
          <Input
            id="targetUserId"
            name="targetUserId"
            placeholder="user UUID"
            className="font-mono"
          />
        </Field>

        <Field label={dict.admin.accessGrants.justification} htmlFor="justification">
          <Textarea
            id="justification"
            name="justification"
            required
            rows={3}
            placeholder="Why is this access needed?"
          />
        </Field>

        <div className="flex gap-2">
          <Button type="submit">{dict.admin.accessGrants.submit}</Button>
          <ButtonLink variant="secondary" href="/admin/access-grants">
            Cancel
          </ButtonLink>
        </div>
      </ActionForm>
    </div>
  );
}
