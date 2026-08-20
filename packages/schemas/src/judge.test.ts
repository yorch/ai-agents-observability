import { describe, expect, it } from 'vitest';

import {
  buildJudgeUserMessage,
  excerptTranscript,
  JUDGE_BASE_SCORER_VERSION,
  JUDGE_MAX_RATIONALE_CHARS,
  JUDGE_MAX_TRANSCRIPT_CHARS,
  JUDGE_REVISIONS,
  judgeCostUsd,
  judgeScoreMetadata,
  judgeSystemPrompt,
  parseJudgeVerdict,
  resolveJudgeRevision,
} from './judge';
import { buildScoreRow, SCORERS } from './scores';

const VALID = JSON.stringify({
  plan_coherence: { label: 'mixed', rationale: 'Two approaches were tried before one stuck.' },
  task_completion: { label: 'partly', rationale: 'The migration ran; the tests were never run.' },
});

describe('parseJudgeVerdict', () => {
  it('accepts a well-formed verdict', () => {
    const verdict = parseJudgeVerdict(VALID);
    expect(verdict?.task_completion.label).toBe('partly');
    expect(verdict?.plan_coherence.label).toBe('mixed');
  });

  it('tolerates surrounding prose but not surrounding structure', () => {
    expect(parseJudgeVerdict(`Here is my answer:\n${VALID}\nHope that helps.`)).not.toBeNull();
    expect(parseJudgeVerdict('no json at all')).toBeNull();
    expect(parseJudgeVerdict('')).toBeNull();
    expect(parseJudgeVerdict('{ not json ')).toBeNull();
  });

  it('rejects labels outside the closed rubric', () => {
    const raw = VALID.replace('"partly"', '"excellent"');
    expect(parseJudgeVerdict(raw)).toBeNull();
  });

  it('rejects extra keys — a judge that freelanced is a judge that was steered', () => {
    const raw = JSON.stringify({
      ...JSON.parse(VALID),
      shell_command: 'rm -rf /',
    });
    expect(parseJudgeVerdict(raw)).toBeNull();
  });

  it('rejects a rationale past the stored cap', () => {
    const raw = JSON.stringify({
      plan_coherence: { label: 'coherent', rationale: 'x'.repeat(JUDGE_MAX_RATIONALE_CHARS + 1) },
      task_completion: { label: 'yes', rationale: 'fine' },
    });
    expect(parseJudgeVerdict(raw)).toBeNull();
  });

  it('rejects a missing dimension rather than scoring half a rubric', () => {
    const raw = JSON.stringify({ task_completion: { label: 'yes', rationale: 'done' } });
    expect(parseJudgeVerdict(raw)).toBeNull();
  });
});

describe('JUDGE_REVISIONS registry', () => {
  it('assigns a unique scorerVersion to every (prompt, model, params) triple', () => {
    const versions = JUDGE_REVISIONS.map((r) => r.scorerVersion);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('registers exactly one triple per model+prompt pair', () => {
    const keys = JUDGE_REVISIONS.map((r) => `${r.promptVersion}:${r.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('resolves a configured model to its revision, and refuses an unregistered one', () => {
    expect(resolveJudgeRevision('claude-opus-5')?.scorerVersion).toBe(1);
    expect(resolveJudgeRevision('some-unregistered-model')).toBeUndefined();
  });

  it('has a prompt for every registered prompt version', () => {
    for (const revision of JUDGE_REVISIONS) {
      expect(judgeSystemPrompt(revision).length).toBeGreaterThan(200);
    }
  });

  it('reports the triple as score metadata without leaking content', () => {
    const revision = JUDGE_REVISIONS[0] as (typeof JUDGE_REVISIONS)[number];
    expect(judgeScoreMetadata(revision)).toEqual({
      judgeModel: revision.model,
      judgeParams: { ...revision.params },
      judgePromptVersion: revision.promptVersion,
    });
  });

  it('keeps SCORERS pinned to the first registered revision', () => {
    expect(SCORERS.judge_task_completion.version).toBe(JUDGE_BASE_SCORER_VERSION);
    expect(SCORERS.judge_plan_coherence.version).toBe(JUDGE_BASE_SCORER_VERSION);
    const lowest = Math.min(...JUDGE_REVISIONS.map((r) => r.scorerVersion));
    expect(JUDGE_BASE_SCORER_VERSION).toBe(lowest);
  });

  it('writes the resolved version on the row, not the registry floor', () => {
    const revision = resolveJudgeRevision('claude-sonnet-5');
    if (!revision) {
      throw new Error('claude-sonnet-5 must be registered');
    }
    const row = buildScoreRow({
      label: 'yes',
      scorerName: 'judge_task_completion',
      scorerVersion: revision.scorerVersion,
      subjectId: '11111111-1111-1111-1111-111111111111',
    });
    expect(row.scorerVersion).toBe(2);
    expect(row.source).toBe('JUDGE');
  });
});

describe('the judge prompt', () => {
  const prompt = judgeSystemPrompt(JUDGE_REVISIONS[0] as (typeof JUDGE_REVISIONS)[number]);

  it('declares the transcript untrusted', () => {
    expect(prompt.toLowerCase()).toContain('untrusted');
    expect(prompt.toLowerCase()).toContain('never follow');
  });

  it('offers the judge no capability beyond answering', () => {
    // The runner sends no `tools`; the prompt must not imply otherwise, or the
    // model will narrate tool calls it cannot make into its rationale.
    expect(prompt).not.toMatch(/\btool_use\b|\bfunction call\b/i);
  });

  it('frames the transcript as data in the user turn too', () => {
    const message = buildJudgeUserMessage('Claude Code', 'user: hi');
    expect(message).toContain('<<<BEGIN TRANSCRIPT>>>');
    expect(message).toContain('untrusted data');
  });
});

describe('excerptTranscript', () => {
  it('renders role-tagged lines and drops empty ones', () => {
    const excerpt = excerptTranscript([
      { role: 'user', text: 'fix the build' },
      { role: 'assistant', text: '   ' },
      { role: 'assistant', text: 'done' },
    ]);
    expect(excerpt).toBe('user: fix the build\nassistant: done');
  });

  it('bounds the excerpt and keeps both ends', () => {
    const messages = Array.from({ length: 400 }, (_, i) => ({
      role: 'assistant',
      text: `line ${i} ${'z'.repeat(500)}`,
    }));
    const excerpt = excerptTranscript(messages, 5_000);
    expect(excerpt.length).toBeLessThanOrEqual(5_000 + 64);
    expect(excerpt).toContain('line 0');
    expect(excerpt).toContain('transcript elided');
    expect(excerpt).toContain('line 399');
  });

  it('is deterministic, so re-judging at one version has the same input', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ role: 'user', text: `m${i}` }));
    expect(excerptTranscript(messages)).toBe(excerptTranscript(messages));
    expect(JUDGE_MAX_TRANSCRIPT_CHARS).toBeGreaterThan(1_000);
  });
});

describe('judgeCostUsd', () => {
  it('prices input, output, and cache traffic at the revision’s list rates', () => {
    const revision = JUDGE_REVISIONS[0] as (typeof JUDGE_REVISIONS)[number];
    const cost = judgeCostUsd(revision, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(30, 6);

    const cached = judgeCostUsd(revision, {
      cacheReadInputTokens: 1_000_000,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(cached).toBeCloseTo(0.5, 6);
  });

  it('is never zero for a real call — eval spend must show up', () => {
    for (const revision of JUDGE_REVISIONS) {
      expect(judgeCostUsd(revision, { inputTokens: 1_000, outputTokens: 100 })).toBeGreaterThan(0);
    }
  });
});
