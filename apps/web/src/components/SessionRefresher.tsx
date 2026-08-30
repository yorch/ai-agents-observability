'use client';

import { useEffect, useRef } from 'react';

// The access token has an 8-hour TTL (packages/auth/src/tokens.ts). Without
// a client-side refresh, the user is logged out after 8 hours of inactivity
// — the refresh endpoint exists but nothing called it. This component calls
// POST /api/auth/refresh on a timer and when the tab becomes visible again,
// keeping the session alive as long as the user has the page open (or returns
// to it within the 90-day refresh-token window).
//
// It renders nothing and does nothing on the server — it's a side-effect-only
// client component mounted only in the authenticated branch of the root layout.

// Refresh 30 min before the 8-hour access token expires, so the new cookie
// is set well before the old one expires.
export const REFRESH_INTERVAL_MS = 7.5 * 60 * 60 * 1000;

// Minimum gap between visibility-triggered refreshes, to avoid hammering the
// refresh endpoint on rapid alt-tab.
const VISIBILITY_THROTTLE_MS = 60 * 1000;

export const REFRESH_PATH = '/api/auth/refresh';

// Exported for testing — the effect logic, decoupled from React.
// Returns true if the refresh succeeded (2xx), false otherwise.
export async function refreshSession(): Promise<boolean> {
  try {
    const res = await fetch(REFRESH_PATH, { credentials: 'same-origin', method: 'POST' });
    if (res.status === 401) {
      // Refresh token invalid/expired/revoked — the session is over. Redirect
      // to login so the user sees the auth screen instead of a broken dashboard.
      window.location.href = '/login';
      return false;
    }
    return res.ok;
  } catch {
    // Network error — the next interval or visibility change will retry.
    return false;
  }
}

export function SessionRefresher() {
  const lastRefresh = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    function onVisible() {
      if (document.visibilityState !== 'visible') {
        return;
      }
      // Throttle: don't refresh more than once per VISIBILITY_THROTTLE_MS,
      // even if the user rapidly switches tabs.
      if (Date.now() - lastRefresh.current < VISIBILITY_THROTTLE_MS) {
        return;
      }
      lastRefresh.current = Date.now();
      refreshSession();
    }

    // Refresh on mount — the access token may have expired during a long
    // tab-switch away, and the server render already showed logged-out state.
    // This pre-emptive refresh + the cookie re-set lets the next navigation
    // succeed without a full re-login.
    refreshSession();
    lastRefresh.current = Date.now();

    // Refresh on a fixed interval while the tab is open.
    timer = setInterval(refreshSession, REFRESH_INTERVAL_MS);

    // Also refresh when the tab becomes visible again (e.g. user returns
    // after switching away for a while).
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (timer) {
        clearInterval(timer);
      }
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}
