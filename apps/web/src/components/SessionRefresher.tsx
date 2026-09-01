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

// How long to wait before re-testing a 401 (see refreshSession). Long enough
// for a concurrent refresh's Set-Cookie to land, short enough that a genuinely
// dead session reaches /login promptly.
const ROTATION_RACE_RETRY_MS = 750;

/** One in-flight refresh, shared by every concurrent caller. */
let inFlight: Promise<boolean> | null = null;

function post(): Promise<Response> {
  return fetch(REFRESH_PATH, { credentials: 'same-origin', method: 'POST' });
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await post();
    if (res.status !== 401) {
      return res.ok;
    }

    // A 401 does NOT prove the session is over. Refresh tokens are single-use,
    // so when two refreshes race, the winner rotates the token and the loser
    // presents one that is already spent — indistinguishable, here, from a
    // genuinely dead session. Treating that as fatal logged people out mid-work
    // (two open tabs was enough) and, because /login used to render inside the
    // authenticated shell, it could loop forever.
    //
    // Re-testing settles it without weakening the server's reuse detection: the
    // winner has by now installed a *fresh* refresh cookie, so a second attempt
    // sends a valid token and succeeds. If the session really is over, the
    // retry sees the same 401 and we redirect.
    await new Promise((resolve) => setTimeout(resolve, ROTATION_RACE_RETRY_MS));
    const retry = await post();
    if (retry.ok) {
      return true;
    }
    if (retry.status === 401) {
      window.location.href = '/login';
    }
    return false;
  } catch {
    // Network error — the next interval or visibility change will retry.
    return false;
  }
}

// Exported for testing — the effect logic, decoupled from React.
// Returns true if the refresh succeeded (2xx), false otherwise.
//
// Single-flighted: concurrent callers share one request. React's StrictMode
// double-invokes effects in development, so without this the component raced
// *itself* on every mount and produced the logout above on every page load.
export function refreshSession(): Promise<boolean> {
  inFlight ??= doRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
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
