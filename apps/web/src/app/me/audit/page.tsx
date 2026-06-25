import { redirect } from 'next/navigation';

export default function AuditRedirect() {
  redirect('/me/settings/audit');
}
