import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Source-level invariant for P13-009.
 *
 * Judge output is **owner-visible only** until P13-010 has calibrated it and
 * P13-011 has taken the exposure decision with developers consulted. That is
 * the kind of rule that survives exactly as long as nobody is in a hurry: a
 * team dashboard grows a "quality" column, it looks harmless in review, and the
 * platform has quietly shipped a per-developer eval score visible to a manager
 * — the failure mode `DESIGN_DOC.md` §8.2 and the evals assessment §4 both name
 * as existential.
 *
 * So it is checked against the source rather than trusted to review: only the
 * owner's own session surface, and the query module that scopes reads to the
 * owner, may so much as name a judge scorer. A team or org surface that starts
 * reading one has to delete this test to exist, which is a visible act.
 *
 * This is a lint, not a proof, and it is the **second** line of defence. It
 * matches scorer *names*, so a query written as `where: { source: 'JUDGE' }`
 * walks straight past it — which is why the primary enforcement is now a
 * property of the read path: `readScores` in `src/lib/scores.ts` returns a
 * judge row's `label`/`rationale_ref` only against an owner id it verifies
 * itself, and gives every other caller a row type with no label on it
 * (`test/scores-access.test.ts`). This file still earns its place: it catches a
 * new module going looking in the first place, which the accessor cannot see.
 */

const SRC_DIR = join(import.meta.dirname, '../src');

/** The judge scorer names, spelled out — the point is to catch the string. */
const JUDGE_SCORER_PATTERN = /judge_task_completion|judge_plan_coherence/;

/**
 * The complete allowlist. Every entry is owner-scoped by construction:
 *  - `lib/judge-queries.ts` reads only through the owner-verifying accessor.
 *    (It no longer spells the names out — they are derived from `SCORERS` — so
 *    it is listed here for the day someone needs to name one again.)
 *  - the `/me/sessions/[id]` page and its card render for the owner alone.
 */
const ALLOWED = new Set([
  'lib/judge-queries.ts',
  'components/me/SessionJudgeCard.tsx',
  'app/me/sessions/[id]/page.tsx',
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return walk(full);
    }
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
  });
}

describe('judge output is owner-visible only', () => {
  const files = walk(SRC_DIR);

  it('is named by no module outside the owner-scoped allowlist', () => {
    const offenders = files
      .filter((file) => JUDGE_SCORER_PATTERN.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file))
      .filter((rel) => !ALLOWED.has(rel));

    expect(offenders).toEqual([]);
  });

  it('is named by the owner-scoped display module, so the scan is not vacuous', () => {
    // A scan that matches nothing anywhere would pass the assertion above while
    // testing nothing at all — so pin it to the one module that must keep the
    // literal names: the owner's card, which maps each scorer to its heading.
    const found = files
      .filter((file) => JUDGE_SCORER_PATTERN.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file));

    expect(found).toContain('components/me/SessionJudgeCard.tsx');
  });

  it('has no team or org route reading the scorers', () => {
    const crossUser = files.filter(
      (file) =>
        (file.includes('/app/team/') || file.includes('/app/org/')) &&
        JUDGE_SCORER_PATTERN.test(readFileSync(file, 'utf8')),
    );
    expect(crossUser).toEqual([]);
  });
});
