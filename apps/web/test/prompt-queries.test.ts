import { describe, expect, it } from 'vitest';
import { PROMPT_INTENTS } from '../src/lib/prompt-queries';

describe('PROMPT_INTENTS (E3)', () => {
  it('has unique ids', () => {
    const ids = PROMPT_INTENTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique labels', () => {
    const labels = PROMPT_INTENTS.map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('every intent has a non-empty query', () => {
    for (const intent of PROMPT_INTENTS) {
      expect(intent.query.length).toBeGreaterThan(0);
      // Must be a valid to_tsquery OR expression — no special chars except | and spaces
      expect(intent.query).toMatch(/^[a-z |]+$/);
    }
  });

  it('covers a reasonable set of intents', () => {
    const ids = PROMPT_INTENTS.map((i) => i.id);
    expect(ids).toContain('implement');
    expect(ids).toContain('debug');
    expect(ids).toContain('refactor');
    expect(ids).toContain('test');
    expect(ids).toContain('explain');
    expect(ids.length).toBeGreaterThanOrEqual(8);
  });
});
