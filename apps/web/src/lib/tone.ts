/**
 * Semantic tone vocabulary, shared by `lib/` and `components/`.
 *
 * Lives here rather than beside `Badge` so data modules can classify something
 * as good/warn/crit without importing a component — the tone is a design-token
 * concept, not a Badge concept.
 */
export type Tone = 'good' | 'warn' | 'crit' | 'neutral' | 'accent';
