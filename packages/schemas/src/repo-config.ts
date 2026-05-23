import { load as loadYaml } from 'js-yaml';
import { z } from 'zod';

const PRBotConfigSchema = z.looseObject({
  enabled: z.boolean().default(false),
  include_cost: z.boolean().default(true),
  include_tool_counts: z.boolean().default(true),
  include_contributors: z.boolean().default(true),
});

const RepoConfigSchema = z
  .looseObject({
    version: z.literal(1),
    pr_bot: PRBotConfigSchema.optional(),
  })
  .transform((data) => ({
    ...data,
    pr_bot: PRBotConfigSchema.parse(data.pr_bot ?? {}),
  }));

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export { RepoConfigSchema };

export function parseRepoConfig(yamlString: string): RepoConfig | null {
  try {
    const parsed = loadYaml(yamlString);
    const result = RepoConfigSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
