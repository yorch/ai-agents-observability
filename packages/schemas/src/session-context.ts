import { z } from 'zod';

export const GitContextSchema = z.object({
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  is_dirty: z.boolean(),
  owner: z.string().nullable(),
  pr_number: z.number().int().nullable(),
  remote_url: z.string().nullable(),
  repo: z.string().nullable(),
});

export type GitContext = z.infer<typeof GitContextSchema>;

export const SessionContextSchema = z.object({
  cwd: z.string(),
  git: GitContextSchema.nullable(),
  is_resume: z.boolean(),
  mode: z.enum(['normal', 'plan', 'accept_edits']),
});

export type SessionContext = z.infer<typeof SessionContextSchema>;
