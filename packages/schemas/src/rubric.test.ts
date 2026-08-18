import { describe, expect, it } from 'vitest';

import type { ShapeLabel } from './effectiveness';
import {
  capturedRubricVersion,
  PRE_RUBRIC_VERSION,
  parseRubricOutcome,
  parseRubricShape,
  RUBRIC_BLINDED_FIELDS,
  RUBRIC_OUTCOME_QUESTION,
  RUBRIC_OUTCOMES,
  RUBRIC_SHAPE_QUESTION,
  RUBRIC_SHAPES,
  SESSION_RUBRIC_VERSION,
  SessionRubricResponseSchema,
} from './rubric';
import { SCORERS } from './scores';

describe('rubric definition', () => {
  it('keeps the rubric to two questions', () => {
    // Every added dimension is another thing to calibrate and another reason a
    // developer skips the form. Growing the rubric should be a deliberate act
    // that fails this test first.
    expect([RUBRIC_SHAPE_QUESTION, RUBRIC_OUTCOME_QUESTION]).toHaveLength(2);
    expect(RUBRIC_SHAPE_QUESTION.prompt.length).toBeGreaterThan(0);
    expect(RUBRIC_OUTCOME_QUESTION.prompt.length).toBeGreaterThan(0);
  });

  it('offers every shape value as an option, and nothing else', () => {
    expect(RUBRIC_SHAPE_QUESTION.options.map((o) => o.value)).toEqual([...RUBRIC_SHAPES]);
    expect(RUBRIC_OUTCOME_QUESTION.options.map((o) => o.value)).toEqual([...RUBRIC_OUTCOMES]);
  });

  it('shares its shape vocabulary with the classifier it will be compared against', () => {
    // Calibration (P13-007) builds a confusion matrix from these two label sets.
    // Any self-reportable shape must be a value the classifier can also emit, or
    // the matrix needs a translation table nobody will maintain.
    const classifierShapes: ShapeLabel[] = [
      'exploratory',
      'focused-edit',
      'debugging',
      'planning',
      'multi-tool',
      'minimal',
    ];
    for (const shape of RUBRIC_SHAPES) {
      if (shape === 'other') {
        continue;
      }
      expect(classifierShapes).toContain(shape);
    }
  });

  it('excludes the classifier fallbacks a human would not self-report', () => {
    expect(RUBRIC_SHAPES).not.toContain('multi-tool');
    expect(RUBRIC_SHAPES).not.toContain('minimal');
    expect(RUBRIC_SHAPES).toContain('other');
  });

  it('names the computed fields each question must stay blinded from', () => {
    expect(RUBRIC_SHAPE_QUESTION.blindedFrom).toBe('shape_label');
    expect(RUBRIC_OUTCOME_QUESTION.blindedFrom).toBe('friction_score');
    expect([...RUBRIC_BLINDED_FIELDS]).toEqual(['shape_label', 'friction_score']);
  });

  it('never shows a computed value in its own prompt or option copy', () => {
    // The blinding rule applies to the wording too — a prompt reading "we think
    // this was debugging; do you agree?" would leak the classifier's answer
    // without the UI ever rendering the field.
    const copy = [
      RUBRIC_SHAPE_QUESTION.prompt,
      RUBRIC_OUTCOME_QUESTION.prompt,
      ...RUBRIC_SHAPE_QUESTION.options.map((o) => o.label),
      ...RUBRIC_OUTCOME_QUESTION.options.map((o) => o.label),
    ].join(' ');
    for (const field of RUBRIC_BLINDED_FIELDS) {
      expect(copy).not.toContain(field);
    }
    expect(copy.toLowerCase()).not.toContain('friction');
  });
});

describe('rubric versioning', () => {
  it('separates "answered version 1" from "predates the rubric"', () => {
    expect(PRE_RUBRIC_VERSION).toBe(0);
    expect(SESSION_RUBRIC_VERSION).toBeGreaterThan(PRE_RUBRIC_VERSION);
    expect(capturedRubricVersion()).toBe(SESSION_RUBRIC_VERSION);
  });

  it('is the version both human scorers write', () => {
    // The rubric version and the scorer version are the same number by
    // construction; a second constant would drift from the wording it describes.
    expect(SCORERS.human_session_shape.version).toBe(SESSION_RUBRIC_VERSION);
    expect(SCORERS.human_task_outcome.version).toBe(SESSION_RUBRIC_VERSION);
    expect(SCORERS.human_session_shape.source).toBe('HUMAN');
    expect(SCORERS.human_task_outcome.source).toBe('HUMAN');
  });
});

describe('parsing rubric answers', () => {
  it('accepts every current option', () => {
    for (const shape of RUBRIC_SHAPES) {
      expect(parseRubricShape(shape)).toBe(shape);
    }
    for (const outcome of RUBRIC_OUTCOMES) {
      expect(parseRubricOutcome(outcome)).toBe(outcome);
    }
  });

  it('treats an unanswered question as no label rather than an error', () => {
    expect(parseRubricShape('')).toBeNull();
    expect(parseRubricShape(undefined)).toBeNull();
    expect(parseRubricOutcome('')).toBeNull();
    expect(parseRubricOutcome(null)).toBeNull();
  });

  it('rejects an option that is not part of this rubric version', () => {
    // A stale value from a previous rubric must not be stored as if it answered
    // this one — that is exactly the silent redefinition versioning prevents.
    expect(parseRubricShape('multi-tool')).toBeNull();
    expect(parseRubricShape('EXPLORATORY')).toBeNull();
    expect(parseRubricOutcome('maybe')).toBeNull();
  });

  it('accepts a response that answers only one question', () => {
    expect(SessionRubricResponseSchema.parse({ shape: 'debugging' })).toMatchObject({
      shape: 'debugging',
    });
    expect(SessionRubricResponseSchema.parse({ taskOutcome: 'partly' })).toMatchObject({
      taskOutcome: 'partly',
    });
    expect(SessionRubricResponseSchema.parse({})).toEqual({});
  });
});
