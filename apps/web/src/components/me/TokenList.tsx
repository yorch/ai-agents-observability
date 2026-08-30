'use client';

import { useState } from 'react';

import { Card } from '@/components/ui';

type TokenInfo = {
  createdAt: string;
  expiresAt: string | null;
  id: string;
  revokedAt: string | null;
};

export function RevokeTokenButton({ token }: { token: TokenInfo }) {
  const [state, setState] = useState<'idle' | 'revoking' | 'done' | 'error'>('idle');

  async function handleRevoke() {
    setState('revoking');
    try {
      const res = await fetch('/api/auth/token/revoke', {
        body: JSON.stringify({ tokenId: token.id }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (res.ok) {
        setState('done');
        // Reload the page to show the updated token list.
        window.location.reload();
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  }

  if (state === 'done') {
    return <span className="text-sm text-text-3">Revoked</span>;
  }

  return (
    <button
      type="button"
      onClick={handleRevoke}
      disabled={state === 'revoking'}
      className="text-sm text-crit hover:text-crit-dim disabled:opacity-50"
    >
      {state === 'revoking' ? 'Revoking…' : 'Revoke'}
    </button>
  );
}

export function TokenList({ tokens }: { tokens: TokenInfo[] }) {
  if (tokens.length === 0) {
    return (
      <Card>
        <p className="text-sm text-text-2">
          No hook tokens. Generate one by running <code className="font-mono">aiot login</code> from
          your terminal.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {tokens.map((token) => {
        const isRevoked = token.revokedAt !== null;
        const isExpired = token.expiresAt !== null && new Date(token.expiresAt) < new Date();
        return (
          <Card key={token.id}>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">
                    {isRevoked ? 'Revoked' : isExpired ? 'Expired' : 'Active'}
                  </span>
                  {isRevoked && token.revokedAt && (
                    <span className="text-xs text-text-3">
                      {new Date(token.revokedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <div className="text-xs text-text-3">
                  Created {new Date(token.createdAt).toLocaleDateString()}
                  {token.expiresAt && (
                    <>
                      {' · '}
                      Expires {new Date(token.expiresAt).toLocaleDateString()}
                    </>
                  )}
                </div>
              </div>
              {!isRevoked && <RevokeTokenButton token={token} />}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
