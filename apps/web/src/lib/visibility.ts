import { getPrisma } from './prisma';

export type VisibilityPolicyUpdate = {
  /**
   * P13-009: consent for the LLM-as-judge runner to read this user's
   * transcripts. Its own flag, not a consequence of the sharing flags — "my org
   * admin may read this" and "a model may grade this" are different questions.
   */
  allowJudgeAnalysis?: boolean;
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
      allowJudgeAnalysis: updates.allowJudgeAnalysis ?? false,
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
