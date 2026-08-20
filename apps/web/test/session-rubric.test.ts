import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { RUBRIC_BLINDED_FIELDS } from '@ai-agents-observability/schemas';
import { describe, expect, it } from 'vitest';

/**
 * Source-level invariant for P13-005 — the blinding rule.
 *
 * The rubric asks the session owner which shape their session was and whether it
 * accomplished what they wanted. Those are precisely the two things
 * `shape_label` and `friction_score` compute. If the capture UI shows the
 * computed answer next to the question, the developer anchors on it and what is
 * stored is agreement with the scorer, not an independent account of the
 * session — which would let the label "validate" the scorer by construction and
 * produce a confident accuracy figure that measures nothing.
 *
 * The acceptance criterion says this is "verified in the UI, not just intended",
 * so it is checked against the source: the capture card may not name either
 * computed field, and the page may not hand it the session row those fields live
 * on. A refactor that reintroduces either fails here rather than quietly
 * poisoning every label collected afterwards.
 *
 * This is a lint, not a behavioural test. It cannot prove the rendered pixels
 * are blinded — only that the values are not in scope to render.
 */

const WEB_SRC = join(import.meta.dirname, '../src');
const FORM = join(WEB_SRC, 'components/me/SessionFeedbackForm.tsx');
const PAGE = join(WEB_SRC, 'app/me/sessions/[id]/page.tsx');

/**
 * Strips comments so the *documentation* of the rule — which necessarily names
 * the fields it forbids — does not read as a violation of it.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The camelCase identifier for a snake_case column, as the query layer spells it. */
function camel(field: string): string {
  return field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

describe('rubric capture is blinded from the scorers it checks', () => {
  const form = stripComments(readFileSync(FORM, 'utf8'));

  it('never names a computed field in the capture card', () => {
    for (const field of RUBRIC_BLINDED_FIELDS) {
      expect(form).not.toContain(field);
      expect(form).not.toContain(camel(field));
    }
  });

  it('takes no session row as a prop, so the computed values are not in scope', () => {
    // The props destructure is the whole surface the component can render from.
    const props = form.slice(form.indexOf('export function SessionFeedbackForm'));
    const signature = props.slice(0, props.indexOf('{\n  const'));
    expect(signature).not.toMatch(/\bsession\b/);
    expect(signature).toContain('sessionId');
  });

  it('is mounted without the session row', () => {
    const page = stripComments(readFileSync(PAGE, 'utf8'));
    const start = page.indexOf('<SessionFeedbackForm');
    expect(start).toBeGreaterThan(-1);
    const element = page.slice(start, page.indexOf('/>', start));
    // `sessionId` is fine — the id carries no computed signal. The `session`
    // object is not, because that is where frictionScore and shapeLabel live.
    expect(element).not.toMatch(/\bsession\b/);
    // Nothing named after a computed field may be handed to the card at all.
    // The developer's own prior answers are prefilled, but they now come from
    // their `scores` rows (`priorAnswer(...)`), so there is no longer any
    // legitimate `.shapeLabel` / `.frictionScore` read at this call site.
    expect(element).not.toMatch(/\.(?:shapeLabel|frictionScore)/);
  });

  it('renders its prompts from the versioned rubric rather than inline copy', () => {
    // Wording is part of the rubric version. Hand-written copy here would let a
    // question change meaning without a version bump, silently invalidating
    // every answer already collected.
    expect(form).toContain('RUBRIC_SHAPE_QUESTION.prompt');
    expect(form).toContain('RUBRIC_OUTCOME_QUESTION.prompt');
    expect(form).toContain('RUBRIC_SHAPE_QUESTION.options');
    expect(form).toContain('RUBRIC_OUTCOME_QUESTION.options');
  });
});

describe('rubric responses stay with their owner', () => {
  it('is captured only from the owner-scoped session page', () => {
    // No team or org surface may mount the capture card, and nothing outside the
    // owner's own action may write the rubric columns. P13-007/P13-008 decide
    // what, if anything, is ever aggregated; this task ships capture only.
    const offenders: string[] = [];
    const roots = ['app/team', 'app/org', 'app/admin', 'components/team-org'];
    for (const root of roots) {
      const dir = join(WEB_SRC, root);
      const hits = grepTree(dir, /SessionFeedbackForm|rubricShape|rubricOutcome|taskOutcome/);
      offenders.push(...hits);
    }
    expect(offenders).toEqual([]);
  });
});

function grepTree(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...grepTree(full, pattern));
    } else if (/\.tsx?$/.test(entry) && pattern.test(readFileSync(full, 'utf8'))) {
      out.push(full);
    }
  }
  return out;
}
