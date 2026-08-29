import { oauthErrorDetails } from '@/lib/oauth-errors';

export function OAuthErrorNotice({
  errorCode,
  requestId,
}: {
  errorCode: string | string[] | undefined;
  requestId: string | string[] | undefined;
}) {
  const details = oauthErrorDetails(errorCode, requestId);
  if (!details) {
    return null;
  }

  return (
    <div role="alert" className="rounded-lg border border-crit-line bg-crit-soft px-4 py-3">
      <p className="text-sm text-crit">{details.message}</p>
      {details.requestId ? (
        <p className="mt-2 text-xs text-text-3">
          Support reference: <code className="font-mono">{details.requestId}</code>
        </p>
      ) : null}
    </div>
  );
}
