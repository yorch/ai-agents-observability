import { z } from 'zod';

/**
 * Zod schema for a comma-separated list env var ("a, b,c" → ['a','b','c']).
 * Unset/empty → []. Shared by app configs so every service parses list envs
 * identically (JIRA_PROJECT_KEYS, and future list envs).
 */
export const commaSeparatedList = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
  );
