import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@x:5432/x';
});

// ── Mock @ai-agents-observability/db ────────────────────────────────────────

const mockPrisma = {
  visibilityPolicy: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
};

vi.mock('@ai-agents-observability/db', () => ({
  createClient: vi.fn(() => mockPrisma),
}));

// ── getVisibilityPolicy ──────────────────────────────────────────────────────

describe('getVisibilityPolicy', () => {
  it('returns null when no policy exists', async () => {
    mockPrisma.visibilityPolicy.findUnique.mockResolvedValueOnce(null);
    const { getVisibilityPolicy } = await import('../src/lib/visibility.js');
    const result = await getVisibilityPolicy('u1');
    expect(result).toBeNull();
  });

  it('returns existing policy', async () => {
    const policy = {
      userId: 'u1',
      shareMetadataWithTeam: true,
      shareMetadataWithOrg: false,
      shareTranscriptsWithTeam: false,
      shareTranscriptsWithOrg: false,
      updatedAt: new Date(),
    };
    mockPrisma.visibilityPolicy.findUnique.mockResolvedValueOnce(policy);
    const { getVisibilityPolicy } = await import('../src/lib/visibility.js');
    const result = await getVisibilityPolicy('u1');
    expect(result?.shareMetadataWithTeam).toBe(true);
    expect(result?.shareMetadataWithOrg).toBe(false);
  });
});

// ── updateVisibilityPolicy ───────────────────────────────────────────────────

describe('updateVisibilityPolicy', () => {
  it('upserts with provided values', async () => {
    const updatedPolicy = {
      userId: 'u1',
      shareMetadataWithTeam: false,
      shareMetadataWithOrg: false,
      shareTranscriptsWithTeam: true,
      shareTranscriptsWithOrg: false,
      updatedAt: new Date(),
    };
    mockPrisma.visibilityPolicy.upsert.mockResolvedValueOnce(updatedPolicy);

    const { updateVisibilityPolicy } = await import('../src/lib/visibility.js');
    const result = await updateVisibilityPolicy('u1', {
      shareMetadataWithTeam: false,
      shareTranscriptsWithTeam: true,
    });

    expect(mockPrisma.visibilityPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1' },
      }),
    );
    expect(result.shareTranscriptsWithTeam).toBe(true);
  });

  it('uses create defaults for new policies', async () => {
    const newPolicy = {
      userId: 'u2',
      shareMetadataWithTeam: true,
      shareMetadataWithOrg: true,
      shareTranscriptsWithTeam: false,
      shareTranscriptsWithOrg: false,
      updatedAt: new Date(),
    };
    mockPrisma.visibilityPolicy.upsert.mockResolvedValueOnce(newPolicy);

    const { updateVisibilityPolicy } = await import('../src/lib/visibility.js');
    await updateVisibilityPolicy('u2', {});

    const call = mockPrisma.visibilityPolicy.upsert.mock.calls.at(-1)![0];
    // create block should have default values
    expect(call.create.shareMetadataWithTeam).toBe(true);
    expect(call.create.shareTranscriptsWithTeam).toBe(false);
  });
});
