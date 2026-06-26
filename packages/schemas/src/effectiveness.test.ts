import { describe, expect, it } from 'vitest';

import { classifySessionShape, computeFrictionScore } from './effectiveness';

describe('computeFrictionScore', () => {
  const lowFriction = {
    durationSeconds: 600,
    interruptCount: 0,
    permissionDenyCount: 0,
    status: 'COMPLETED',
    toolCallCount: 10,
    toolErrorCount: 0,
    userMessageCount: 4,
  };

  it('returns null for sessions with too little activity', () => {
    expect(
      computeFrictionScore({
        ...lowFriction,
        toolCallCount: 1,
        userMessageCount: 1,
      }),
    ).toBeNull();
  });

  it('scores clean sessions at zero friction', () => {
    expect(computeFrictionScore(lowFriction)).toBe(0);
  });

  it('combines capped denial, error, interrupt, and abandoned-session signals', () => {
    expect(
      computeFrictionScore({
        durationSeconds: 30,
        interruptCount: 20,
        permissionDenyCount: 20,
        status: 'ABANDONED',
        toolCallCount: 10,
        toolErrorCount: 10,
        userMessageCount: 5,
      }),
    ).toBe(1);
  });
});

describe('classifySessionShape', () => {
  it('classifies low-activity sessions as minimal', () => {
    expect(classifySessionShape([{ callCount: 1, toolName: 'Read' }], 1, 1)).toBe('minimal');
  });

  it('classifies read-heavy sessions as exploratory', () => {
    expect(classifySessionShape([{ callCount: 7, toolName: 'Read' }], 2, 7)).toBe('exploratory');
  });

  it('classifies write-heavy sessions as focused-edit', () => {
    expect(classifySessionShape([{ callCount: 6, toolName: 'Edit' }], 2, 6)).toBe('focused-edit');
  });

  it('classifies exec-heavy sessions as debugging', () => {
    expect(classifySessionShape([{ callCount: 5, toolName: 'Bash' }], 2, 5)).toBe('debugging');
  });

  it('classifies message-heavy sessions with no tools as planning', () => {
    expect(classifySessionShape([], 4, 0)).toBe('planning');
  });

  it('classifies mixed tool usage as multi-tool', () => {
    expect(
      classifySessionShape(
        [
          { callCount: 2, toolName: 'Read' },
          { callCount: 2, toolName: 'Edit' },
          { callCount: 2, toolName: 'Bash' },
        ],
        2,
        6,
      ),
    ).toBe('multi-tool');
  });
});
