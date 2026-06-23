import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub DATABASE_URL before getPrisma() is called
beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

// ── next/navigation ───────────────────────────────────────────────────────────

const notFoundError = new Error('NOT_FOUND');
const redirectError = (url: string) => new Error(`REDIRECT:${url}`);

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw notFoundError;
  }),
  redirect: vi.fn((url: string) => {
    throw redirectError(url);
  }),
}));

// ── @ai-agents-observability/auth ────────────────────────────────────────────

vi.mock('@ai-agents-observability/auth', () => ({
  verifyAccessToken: vi.fn(),
}));

// ── next/headers ──────────────────────────────────────────────────────────────

const cookieStore = new Map<string, { value: string }>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
  }),
  headers: async () => new Headers(),
}));

// ── @ai-agents-observability/db ───────────────────────────────────────────────

const mockTeam = { findUnique: vi.fn() };
const mockTeamMember = { findUnique: vi.fn() };
const mockUser = { findUnique: vi.fn() };

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => ({ team: mockTeam, teamMember: mockTeamMember, user: mockUser })),
  OrgRole: { member: 'member', org_admin: 'org_admin', viewer_aggregate: 'viewer_aggregate' },
  TeamRole: { lead: 'lead', maintainer: 'maintainer', member: 'member' },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEAM = { githubSlug: 'eng', id: 'team-1', name: 'Engineering' };
const USER = {
  createdAt: new Date(),
  deactivatedAt: null,
  displayName: 'Jorge',
  email: 'j@x.com',
  githubId: 1n,
  githubLogin: 'jorge',
  id: 'u1',
  lastSeenAt: null,
  primaryTeamId: null,
};

function setAuthCookie() {
  cookieStore.set('cc_access', { value: 'valid-token' });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('requireTeamLead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore.clear();
  });

  it('redirects to /login when unauthenticated', async () => {
    const { requireTeamLead } = await import('../src/lib/roles.js');
    await expect(requireTeamLead('eng')).rejects.toThrow('REDIRECT:/login');
  });

  it('calls notFound() when team does not exist', async () => {
    setAuthCookie();
    const { verifyAccessToken } = await import('@ai-agents-observability/auth');
    vi.mocked(verifyAccessToken).mockResolvedValueOnce({ kind: 'access', userId: 'u1' } as never);
    mockUser.findUnique.mockResolvedValueOnce(USER);
    mockTeam.findUnique.mockResolvedValueOnce(null);

    const { requireTeamLead } = await import('../src/lib/roles.js');
    await expect(requireTeamLead('unknown')).rejects.toThrow('NOT_FOUND');
  });

  it('calls notFound() when user has only member role', async () => {
    setAuthCookie();
    const { verifyAccessToken } = await import('@ai-agents-observability/auth');
    vi.mocked(verifyAccessToken).mockResolvedValueOnce({ kind: 'access', userId: 'u1' } as never);
    mockUser.findUnique.mockResolvedValueOnce(USER);
    mockTeam.findUnique.mockResolvedValueOnce(TEAM);
    mockTeamMember.findUnique.mockResolvedValueOnce({ leftAt: null, roleInTeam: 'member' });

    const { requireTeamLead } = await import('../src/lib/roles.js');
    await expect(requireTeamLead('eng')).rejects.toThrow('NOT_FOUND');
  });

  it('calls notFound() when user has left the team', async () => {
    setAuthCookie();
    const { verifyAccessToken } = await import('@ai-agents-observability/auth');
    vi.mocked(verifyAccessToken).mockResolvedValueOnce({ kind: 'access', userId: 'u1' } as never);
    mockUser.findUnique.mockResolvedValueOnce(USER);
    mockTeam.findUnique.mockResolvedValueOnce(TEAM);
    mockTeamMember.findUnique.mockResolvedValueOnce({ leftAt: new Date(), roleInTeam: 'lead' });

    const { requireTeamLead } = await import('../src/lib/roles.js');
    await expect(requireTeamLead('eng')).rejects.toThrow('NOT_FOUND');
  });

  it('calls notFound() when user has no membership record', async () => {
    setAuthCookie();
    const { verifyAccessToken } = await import('@ai-agents-observability/auth');
    vi.mocked(verifyAccessToken).mockResolvedValueOnce({ kind: 'access', userId: 'u1' } as never);
    mockUser.findUnique.mockResolvedValueOnce(USER);
    mockTeam.findUnique.mockResolvedValueOnce(TEAM);
    mockTeamMember.findUnique.mockResolvedValueOnce(null);

    const { requireTeamLead } = await import('../src/lib/roles.js');
    await expect(requireTeamLead('eng')).rejects.toThrow('NOT_FOUND');
  });

  it('returns TeamContext for a lead', async () => {
    setAuthCookie();
    const { verifyAccessToken } = await import('@ai-agents-observability/auth');
    vi.mocked(verifyAccessToken).mockResolvedValueOnce({ kind: 'access', userId: 'u1' } as never);
    mockUser.findUnique.mockResolvedValueOnce(USER);
    mockTeam.findUnique.mockResolvedValueOnce(TEAM);
    mockTeamMember.findUnique.mockResolvedValueOnce({ leftAt: null, roleInTeam: 'lead' });

    const { requireTeamLead } = await import('../src/lib/roles.js');
    const ctx = await requireTeamLead('eng');

    expect(ctx.teamId).toBe('team-1');
    expect(ctx.teamSlug).toBe('eng');
    expect(ctx.teamName).toBe('Engineering');
    expect(ctx.role).toBe('lead');
    expect(ctx.user.id).toBe('u1');
  });

  it('returns TeamContext for a maintainer', async () => {
    setAuthCookie();
    const { verifyAccessToken } = await import('@ai-agents-observability/auth');
    vi.mocked(verifyAccessToken).mockResolvedValueOnce({ kind: 'access', userId: 'u1' } as never);
    mockUser.findUnique.mockResolvedValueOnce(USER);
    mockTeam.findUnique.mockResolvedValueOnce(TEAM);
    mockTeamMember.findUnique.mockResolvedValueOnce({ leftAt: null, roleInTeam: 'maintainer' });

    const { requireTeamLead } = await import('../src/lib/roles.js');
    const ctx = await requireTeamLead('eng');

    expect(ctx.role).toBe('maintainer');
  });
});

describe('requireTeamMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore.clear();
  });

  it('calls notFound() when user has left the team', async () => {
    setAuthCookie();
    const { verifyAccessToken } = await import('@ai-agents-observability/auth');
    vi.mocked(verifyAccessToken).mockResolvedValueOnce({ kind: 'access', userId: 'u1' } as never);
    mockUser.findUnique.mockResolvedValueOnce(USER);
    mockTeam.findUnique.mockResolvedValueOnce(TEAM);
    mockTeamMember.findUnique.mockResolvedValueOnce({ leftAt: new Date(), roleInTeam: 'member' });

    const { requireTeamMember } = await import('../src/lib/roles.js');
    await expect(requireTeamMember('eng')).rejects.toThrow('NOT_FOUND');
  });

  it('returns TeamContext for a plain member', async () => {
    setAuthCookie();
    const { verifyAccessToken } = await import('@ai-agents-observability/auth');
    vi.mocked(verifyAccessToken).mockResolvedValueOnce({ kind: 'access', userId: 'u1' } as never);
    mockUser.findUnique.mockResolvedValueOnce(USER);
    mockTeam.findUnique.mockResolvedValueOnce(TEAM);
    mockTeamMember.findUnique.mockResolvedValueOnce({ leftAt: null, roleInTeam: 'member' });

    const { requireTeamMember } = await import('../src/lib/roles.js');
    const ctx = await requireTeamMember('eng');

    expect(ctx.role).toBe('member');
  });
});

describe('getTeamRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when user is not a member', async () => {
    mockTeamMember.findUnique.mockResolvedValueOnce(null);

    const { getTeamRole } = await import('../src/lib/roles.js');
    const role = await getTeamRole('u1', 'team-1');

    expect(role).toBeNull();
  });

  it('returns null when membership leftAt is set', async () => {
    mockTeamMember.findUnique.mockResolvedValueOnce({ leftAt: new Date(), roleInTeam: 'lead' });

    const { getTeamRole } = await import('../src/lib/roles.js');
    const role = await getTeamRole('u1', 'team-1');

    expect(role).toBeNull();
  });

  it('returns the role for an active member', async () => {
    mockTeamMember.findUnique.mockResolvedValueOnce({ leftAt: null, roleInTeam: 'lead' });

    const { getTeamRole } = await import('../src/lib/roles.js');
    const role = await getTeamRole('u1', 'team-1');

    expect(role).toBe('lead');
  });
});

describe('isLeadOrAbove', () => {
  it('returns true for lead', async () => {
    const { isLeadOrAbove } = await import('../src/lib/roles.js');
    expect(isLeadOrAbove('lead' as never)).toBe(true);
  });

  it('returns true for maintainer', async () => {
    const { isLeadOrAbove } = await import('../src/lib/roles.js');
    expect(isLeadOrAbove('maintainer' as never)).toBe(true);
  });

  it('returns false for member', async () => {
    const { isLeadOrAbove } = await import('../src/lib/roles.js');
    expect(isLeadOrAbove('member' as never)).toBe(false);
  });
});
