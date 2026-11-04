/**
 * Pass rate over decided outcomes only: success / (success + failure), pending
 * excluded - the same definition as `subject-quality-queries`. `null` when
 * nothing has resolved yet. Expects the lowercase statuses `getSkillRoi` emits.
 */
export function ciPassRate(rows: { ciStatus: string; sessionCount: number }[]): number | null {
  const success = rows.find((r) => r.ciStatus === 'success')?.sessionCount ?? 0;
  const failure = rows.find((r) => r.ciStatus === 'failure')?.sessionCount ?? 0;
  const decided = success + failure;
  return decided > 0 ? success / decided : null;
}
