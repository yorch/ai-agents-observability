// Classification of `Notification` hook events — the moments an agent stops to
// get the human's attention. Claude Code carries a structured `notification_type`
// in the hook payload (plus a free-text `message`); we normalize both into a
// small, stable enum so the platform can measure how often agents block on
// humans and which kind of attention they need.
//
// The three "blocking on a human" kinds — `permission`, `idle`, `elicitation` —
// are the core Human-in-the-Loop signal; `auth` and `other` are informational.
export const NOTIFICATION_KINDS = [
  'permission', // agent needs approval to proceed (permission prompt)
  'idle', // agent is waiting for the human's input
  'elicitation', // an MCP server is asking the human for structured input
  'auth', // authentication notice (informational)
  'other', // anything else
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// Notification kinds where the agent is blocked waiting on a human decision/input.
export const BLOCKING_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'permission',
  'idle',
  'elicitation',
];

export function isBlockingNotification(kind: NotificationKind): boolean {
  return BLOCKING_NOTIFICATION_KINDS.includes(kind);
}

// Classify a Notification event. Prefers the structured `notification_type` field
// (Claude Code's `permission_prompt` / `idle_prompt` / `auth_success` /
// `elicitation_*`); falls back to pattern-matching the free-text message so other
// agents (or older Claude Code versions) still classify usefully.
export function classifyNotification(
  notificationType: unknown,
  message?: unknown,
): NotificationKind {
  if (typeof notificationType === 'string' && notificationType.length > 0) {
    if (notificationType === 'permission_prompt') {
      return 'permission';
    }
    if (notificationType === 'idle_prompt') {
      return 'idle';
    }
    if (notificationType.startsWith('elicitation')) {
      return 'elicitation';
    }
    if (notificationType.startsWith('auth')) {
      return 'auth';
    }
  }

  if (typeof message === 'string' && message.length > 0) {
    const m = message.toLowerCase();
    if (/permission|needs your approval|approve/.test(m)) {
      return 'permission';
    }
    if (/waiting for (your )?input|is idle|idle/.test(m)) {
      return 'idle';
    }
  }

  return 'other';
}
