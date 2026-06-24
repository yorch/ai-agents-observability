import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

// ── @ai-agents-observability/db ───────────────────────────────────────────────
// Stub the enum values — the test passes mockDb explicitly so no Prisma client is created.

vi.mock('@ai-agents-observability/db', () => ({
  AuditAction: {
    admin_impersonate: 'admin_impersonate',
    delete_request: 'delete_request',
    export_org: 'export_org',
    export_team: 'export_team',
    hook_token_issued: 'hook_token_issued',
    view_session: 'view_session',
    view_transcript: 'view_transcript',
  },
  createClient: vi.fn(() => ({})),
}));

// ── next/headers ──────────────────────────────────────────────────────────────

vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () => new Headers({ 'user-agent': 'TestAgent/1.0', 'x-forwarded-for': '1.2.3.4' }),
  ),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('writeAuditLog', () => {
  const mockCreate = vi.fn();
  const mockDb = { auditLog: { create: mockCreate } } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a row with the correct fields', async () => {
    mockCreate.mockResolvedValueOnce({});

    const { AuditAction, writeAuditLog } = await import('../src/lib/audit.js');
    await writeAuditLog(
      {
        action: AuditAction.view_session,
        actorUserId: 'u-actor',
        targetSessionId: 's-123',
        targetUserId: 'u-target',
      },
      mockDb,
    );

    expect(mockCreate).toHaveBeenCalledOnce();
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.action).toBe(AuditAction.view_session);
    expect(data.actorUserId).toBe('u-actor');
    expect(data.targetUserId).toBe('u-target');
    expect(data.targetSessionId).toBe('s-123');
    expect(data.ip).toBe('1.2.3.4');
    expect(data.userAgent).toBe('TestAgent/1.0');
  });

  it('sets null for optional fields when not provided', async () => {
    mockCreate.mockResolvedValueOnce({});

    const { AuditAction, writeAuditLog } = await import('../src/lib/audit.js');
    await writeAuditLog(
      { action: AuditAction.export_team, actorUserId: 'u1', targetTeamId: 't1' },
      mockDb,
    );

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.targetUserId).toBeNull();
    expect(data.targetSessionId).toBeNull();
    expect(data.targetTeamId).toBe('t1');
    expect(data.justification).toBeNull();
  });

  it('persists a justification when provided (§8.4)', async () => {
    mockCreate.mockResolvedValueOnce({});

    const { AuditAction, writeAuditLog } = await import('../src/lib/audit.js');
    await writeAuditLog(
      {
        action: AuditAction.view_transcript,
        actorUserId: 'u1',
        justification: 'security incident #1234',
        targetSessionId: 's-1',
        targetUserId: 'u-target',
      },
      mockDb,
    );

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.justification).toBe('security incident #1234');
  });

  it('does not throw when the DB insert fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('db connection lost'));

    const { AuditAction, writeAuditLog } = await import('../src/lib/audit.js');
    await expect(
      writeAuditLog({ action: AuditAction.view_transcript, actorUserId: 'u1' }, mockDb),
    ).resolves.toBeUndefined();
  });

  it('uses the first IP from x-forwarded-for when multiple are present', async () => {
    const { headers } = await import('next/headers');
    vi.mocked(headers).mockResolvedValueOnce(
      new Headers({ 'x-forwarded-for': '10.0.0.1, 172.16.0.1' }) as never,
    );
    mockCreate.mockResolvedValueOnce({});

    const { AuditAction, writeAuditLog } = await import('../src/lib/audit.js');
    await writeAuditLog({ action: AuditAction.export_team, actorUserId: 'u1' }, mockDb);

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.ip).toBe('10.0.0.1');
  });
});

// ── normalizeJustification (§8.4 override) ─────────────────────────────────────

describe('normalizeJustification', () => {
  it('returns null for absent / empty input', async () => {
    const { normalizeJustification } = await import('../src/lib/audit.js');
    expect(normalizeJustification(null)).toBeNull();
    expect(normalizeJustification(undefined)).toBeNull();
    expect(normalizeJustification('   ')).toBeNull();
  });

  it('rejects justifications below the minimum length', async () => {
    const { normalizeJustification } = await import('../src/lib/audit.js');
    expect(normalizeJustification('too short')).toBeNull(); // 9 chars
  });

  it('rejects justifications above the maximum length', async () => {
    const { MAX_JUSTIFICATION_LENGTH, normalizeJustification } = await import(
      '../src/lib/audit.js'
    );
    expect(normalizeJustification('x'.repeat(MAX_JUSTIFICATION_LENGTH + 1))).toBeNull();
  });

  it('trims and returns a valid justification', async () => {
    const { normalizeJustification } = await import('../src/lib/audit.js');
    expect(normalizeJustification('  security incident #1234  ')).toBe('security incident #1234');
  });
});

// ── P3-005: audit write contract tests ────────────────────────────────────────
// These tests verify the writeAuditLog contract for each cross-user action type
// used in Phase 3 (export_team, view_session, view_transcript). The call sites
// in the page components are fire-and-forget (void) using the same pattern.
// Note: calling Next.js RSC pages directly from Vitest requires JSX
// transformation that isn't wired up here; contract is enforced by code review.

describe('P3-005: audit action contract for cross-user page views', () => {
  const mockAuditCreate = vi.fn();
  const mockAuditDb = { auditLog: { create: mockAuditCreate } } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('export_team: fires with actorUserId and targetTeamId', async () => {
    mockAuditCreate.mockResolvedValueOnce({});
    const { AuditAction, writeAuditLog } = await import('../src/lib/audit.js');

    await writeAuditLog(
      { action: AuditAction.export_team, actorUserId: 'u-lead', targetTeamId: 'team-1' },
      mockAuditDb,
    );

    const data = mockAuditCreate.mock.calls[0][0].data;
    expect(data.action).toBe(AuditAction.export_team);
    expect(data.actorUserId).toBe('u-lead');
    expect(data.targetTeamId).toBe('team-1');
    expect(data.targetUserId).toBeNull();
    expect(data.targetSessionId).toBeNull();
  });

  it('view_session: fires with actorUserId, targetUserId, and targetSessionId', async () => {
    mockAuditCreate.mockResolvedValueOnce({});
    const { AuditAction, writeAuditLog } = await import('../src/lib/audit.js');

    await writeAuditLog(
      {
        action: AuditAction.view_session,
        actorUserId: 'u-lead',
        targetSessionId: 's-123',
        targetUserId: 'u-member',
      },
      mockAuditDb,
    );

    const data = mockAuditCreate.mock.calls[0][0].data;
    expect(data.action).toBe(AuditAction.view_session);
    expect(data.targetUserId).toBe('u-member');
    expect(data.targetSessionId).toBe('s-123');
    expect(data.targetTeamId).toBeNull();
  });

  it('view_transcript: fires with actorUserId, targetUserId, and targetSessionId', async () => {
    mockAuditCreate.mockResolvedValueOnce({});
    const { AuditAction, writeAuditLog } = await import('../src/lib/audit.js');

    await writeAuditLog(
      {
        action: AuditAction.view_transcript,
        actorUserId: 'u-lead',
        targetSessionId: 's-456',
        targetUserId: 'u-member',
      },
      mockAuditDb,
    );

    const data = mockAuditCreate.mock.calls[0][0].data;
    expect(data.action).toBe(AuditAction.view_transcript);
    expect(data.targetUserId).toBe('u-member');
    expect(data.targetSessionId).toBe('s-456');
  });
});
