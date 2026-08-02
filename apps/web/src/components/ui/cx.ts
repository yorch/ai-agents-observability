/**
 * Joins class names, dropping falsy parts.
 *
 * Exists because the alternative — `` `base${cond ? ' extra' : ''}` `` — has a
 * silent failure mode: Tailwind's scanner does not extract a class that abuts
 * `${`, so the utility vanishes from the built CSS. It goes unnoticed whenever
 * that utility also appears somewhere else, and bites the one time it doesn't.
 * Every class string in `components/ui` is built through here so the mistake
 * cannot be made.
 */
export function cx(...parts: unknown[]): string {
  // `unknown` rather than `string | false`: `cond && 'cls'` is the natural way to
  // write a conditional class, and `cond` is often a `ReactNode` whose falsy
  // values include `''`, `0` and `0n`. Only non-empty strings survive.
  return parts.filter((part) => typeof part === 'string' && part !== '').join(' ');
}
