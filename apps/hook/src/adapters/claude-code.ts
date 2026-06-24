import { type HookKind, isHookKind, toEvent } from '../lib/payload';
import type { AdapterInstallConfig, ConformantEvent, HookAdapter, TranscriptTarget } from './index';

// Claude Code adapter — the first HookAdapter implementation. It delegates to the
// existing payload mapping (lib/payload.ts) so behavior is byte-for-byte identical
// to before the seam was introduced; the seam just routes the Claude-specific
// logic through the interface the transport depends on.

const HOOK_KINDS = [
  'session-start',
  'pre-tool-use',
  'post-tool-use',
  'stop',
  'user-prompt-submit',
  'pre-compact',
  'subagent-stop',
  'notification',
] as const;

function renderSnippet(bin: string): string {
  const hooks: Record<string, string> = {};
  for (const kind of HOOK_KINDS) {
    hooks[kind] = `${bin} hook ${kind}`;
  }
  return JSON.stringify({ hooks }, null, 2);
}

export const claudeCodeAdapter: HookAdapter = {
  agentType: 'claude-code',

  installConfig(): AdapterInstallConfig {
    return {
      agentName: 'Claude Code',
      hookKinds: HOOK_KINDS,
      renderSnippet,
      settingsHint: 'Add to ~/.claude/settings.json:',
    };
  },

  isHookKind(value: string): boolean {
    return isHookKind(value);
  },

  mapPayload(kind: string, raw: Record<string, unknown>): ConformantEvent {
    return toEvent(kind as HookKind, raw);
  },

  transcriptTarget(kind: string, raw: Record<string, unknown>): TranscriptTarget | null {
    // Claude Code ships the transcript at Stop. The path + session id come from
    // the hook payload (transcript_path / session_id), not a computed location.
    if (kind !== 'stop') {
      return null;
    }
    const transcriptPath = raw.transcript_path;
    const sessionId = raw.session_id;
    if (
      typeof transcriptPath === 'string' &&
      transcriptPath.length > 0 &&
      typeof sessionId === 'string' &&
      sessionId.length > 0
    ) {
      return { sessionId, transcriptPath };
    }
    return null;
  },
};
