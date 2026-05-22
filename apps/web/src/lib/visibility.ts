import { getPrisma } from './prisma';

export type VisibilityPolicyUpdate = {
  shareMetadataWithOrg?: boolean;
  shareMetadataWithTeam?: boolean;
  shareTranscriptsWithOrg?: boolean;
  shareTranscriptsWithTeam?: boolean;
};

export async function getVisibilityPolicy(userId: string) {
  return getPrisma().visibilityPolicy.findUnique({ where: { userId } });
}

export async function updateVisibilityPolicy(userId: string, updates: VisibilityPolicyUpdate) {
  return getPrisma().visibilityPolicy.upsert({
    create: {
      shareMetadataWithOrg: updates.shareMetadataWithOrg ?? true,
      shareMetadataWithTeam: updates.shareMetadataWithTeam ?? true,
      shareTranscriptsWithOrg: updates.shareTranscriptsWithOrg ?? false,
      shareTranscriptsWithTeam: updates.shareTranscriptsWithTeam ?? false,
      userId,
    },
    update: updates,
    where: { userId },
  });
}
