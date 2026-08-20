/**
 * The session self-label rubric (P13-005).
 *
 * The one person who knows whether a session actually worked is the person who
 * ran it. `SessionFeedback` already collected a bare sentiment from them; this
 * module turns that into a small **versioned rubric** — which shape describes the
 * session, and did it accomplish what you wanted — so the answers are a
 * first-class human label rather than a mood.
 *
 * **Why the wording lives here.** A rubric whose questions can be reworded in a
 * component is a rubric that silently redefines itself: prior labels answered a
 * different question and nothing records that they did. Question text, option
 * values, and option labels are all defined once in this module and versioned by
 * `SESSION_RUBRIC_VERSION`; changing any of them is a version bump, which writes
 * new `scores` rows rather than blending two rubrics into one line.
 *
 * **The blinding rule.** Neither question may be rendered next to the computed
 * value it exists to check — no `shape_label` beside the shape question, no
 * `friction_score` beside the outcome question. A label collected from someone
 * who has just been shown the machine's answer measures agreement with the
 * scorer, not the session. See `SessionFeedbackForm` for the enforcement.
 */

import { z } from 'zod';

/**
 * Bump when any question wording, option value, or option label below changes.
 * Written as `scorer_version` on the human `scores` rows, and stored on the
 * `session_feedback` row itself so a response always says which rubric it
 * answered. Rows captured before the rubric existed read as version 0.
 */
export const SESSION_RUBRIC_VERSION = 1;

/**
 * Version 0 is not a rubric — it is the pre-rubric `SessionFeedback` shape
 * (sentiment + note only). Named so readers do not have to know that `0` is
 * special, and so a query for "rows with a real rubric answer" is expressible.
 */
export const PRE_RUBRIC_VERSION = 0;

/**
 * Self-reported session shape.
 *
 * The values deliberately mirror `ShapeLabel` so a confusion matrix against the
 * `session_shape` classifier is possible without a translation table (P13-007).
 * Two classifier outputs are absent on purpose: `multi-tool` ("no dominant
 * pattern") and `minimal` ("too few events to classify") are things the
 * *classifier* says when it cannot decide, not states a developer would
 * recognise in their own work. A human who recognises none of the four picks
 * `other`, and calibration treats that as its own cell rather than pretending it
 * is a match for either fallback.
 */
export const RUBRIC_SHAPES = [
  'exploratory',
  'focused-edit',
  'debugging',
  'planning',
  'other',
] as const;

export type RubricShape = (typeof RUBRIC_SHAPES)[number];

/**
 * Did the session accomplish what you wanted? Three values, not five: a scale
 * with more rungs invites deliberation, and every extra rung is another thing to
 * calibrate and another reason not to answer at all.
 */
export const RUBRIC_OUTCOMES = ['yes', 'partly', 'no'] as const;

export type RubricOutcome = (typeof RUBRIC_OUTCOMES)[number];

export const RubricShapeSchema = z.enum(RUBRIC_SHAPES);
export const RubricOutcomeSchema = z.enum(RUBRIC_OUTCOMES);

/** One rubric question: prompt text plus its options, in display order. */
export type RubricQuestion<T extends string> = {
  /** Why this question is *not* allowed to show its computed counterpart. */
  readonly blindedFrom: string;
  readonly options: readonly { readonly label: string; readonly value: T }[];
  readonly prompt: string;
};

/**
 * The shape question. `blindedFrom` names the computed field that must never
 * appear beside it — the comment is load-bearing, not decorative: this is the
 * single most easily-lost design detail in a later UI refactor, and the whole
 * value of the label depends on it.
 */
export const RUBRIC_SHAPE_QUESTION: RubricQuestion<RubricShape> = {
  blindedFrom: 'shape_label',
  options: [
    { label: 'Exploring — reading around to understand something', value: 'exploratory' },
    { label: 'Making a specific change I had in mind', value: 'focused-edit' },
    { label: 'Debugging — chasing a failure', value: 'debugging' },
    { label: 'Planning or designing before writing code', value: 'planning' },
    { label: 'None of these', value: 'other' },
  ],
  prompt: 'Which best describes what you were doing?',
};

/** The outcome question, blinded from the friction score for the same reason. */
export const RUBRIC_OUTCOME_QUESTION: RubricQuestion<RubricOutcome> = {
  blindedFrom: 'friction_score',
  options: [
    { label: 'Yes', value: 'yes' },
    { label: 'Partly', value: 'partly' },
    { label: 'No', value: 'no' },
  ],
  prompt: 'Did it accomplish what you wanted?',
};

/**
 * Every computed field the rubric UI is forbidden to display. Exported so the
 * check is a shared constant rather than a string repeated in a test.
 */
export const RUBRIC_BLINDED_FIELDS = [
  RUBRIC_SHAPE_QUESTION.blindedFrom,
  RUBRIC_OUTCOME_QUESTION.blindedFrom,
] as const;

/**
 * A rubric response. Every field is optional: a bare thumbs-up is still a valid
 * `SessionFeedback` row, and a developer who answers one question and skips the
 * other has given a usable label for the one they answered.
 */
export const SessionRubricResponseSchema = z.object({
  shape: RubricShapeSchema.nullish(),
  taskOutcome: RubricOutcomeSchema.nullish(),
});

export type SessionRubricResponse = z.infer<typeof SessionRubricResponseSchema>;

/**
 * Parses one rubric answer off a form value. Returns null for anything that is
 * not a current-rubric option — an unanswered question and a stale option from a
 * previous rubric version are both "no label", and neither should be stored as
 * if it answered this version.
 */
export function parseRubricShape(value: unknown): RubricShape | null {
  const parsed = RubricShapeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseRubricOutcome(value: unknown): RubricOutcome | null {
  const parsed = RubricOutcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The rubric version a freshly-captured response answered.
 *
 * Deliberately *not* conditional on the developer having answered: a row written
 * through the v1 form was captured under v1 whether or not both questions were
 * filled in, and recording that distinguishes "declined to answer v1" from
 * "predates the rubric" — which are different facts, and only one of them is a
 * signal about the rubric.
 */
export function capturedRubricVersion(): number {
  return SESSION_RUBRIC_VERSION;
}
