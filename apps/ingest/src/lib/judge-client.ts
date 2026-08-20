import type { JudgeRevision, JudgeUsage } from '@ai-agents-observability/schemas';

/**
 * The judge's model client (P13-009).
 *
 * A deliberately tiny client over `POST /v1/messages`, in the same style as
 * `AnthropicBillingSource` — this app talks to Anthropic over `fetch` and does
 * not carry a vendor SDK.
 *
 * The important property is what it *cannot* send: there is no `tools` field
 * here and no way for a caller to add one. The judge reads untrusted transcript
 * content, so it is given no capability beyond returning text, and that
 * restriction is a property of the transport rather than a convention at the
 * call site.
 */

const ANTHROPIC_VERSION = '2023-06-01';

/** One judged call: the raw reply text plus the usage needed to price it. */
export type JudgeCompletion = {
  text: string;
  usage: JudgeUsage;
};

export type JudgeModelClient = {
  complete(args: {
    revision: JudgeRevision;
    system: string;
    user: string;
  }): Promise<JudgeCompletion>;
};

type MessagesResponse = {
  content?: { text?: string; type?: string }[];
  stop_reason?: string;
  usage?: {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
};

export type AnthropicJudgeConfig = {
  apiKey: string;
  baseUrl: string;
  /** Per-request wall clock budget. A judge that hangs must not stall the run. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;

/** Thrown when the provider declines or errors; the caller records no score. */
export class JudgeCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeCallError';
  }
}

export class AnthropicJudgeClient implements JudgeModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: AnthropicJudgeConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(args: {
    revision: JudgeRevision;
    system: string;
    user: string;
  }): Promise<JudgeCompletion> {
    const { revision, system, user } = args;

    // No `tools`, and no sampling parameters: temperature/top_p/top_k are
    // rejected outright by current models, and the rubric is a classification
    // task where variance is a defect rather than a feature.
    const body: Record<string, unknown> = {
      max_tokens: revision.params.maxOutputTokens,
      messages: [{ content: user, role: 'user' }],
      model: revision.model,
      system,
      ...(revision.params.effort ? { output_config: { effort: revision.params.effort } } : {}),
    };

    const res = await fetch(new URL('/v1/messages', this.baseUrl).toString(), {
      body: JSON.stringify(body),
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new JudgeCallError(`judge model responded ${res.status}: ${detail.slice(0, 200)}`);
    }

    const parsed = (await res.json()) as MessagesResponse;

    // A refusal is a legitimate outcome, not a crash — but it is not a verdict
    // either, so it must not become a score row.
    if (parsed.stop_reason === 'refusal') {
      throw new JudgeCallError('judge model refused the request');
    }

    const text = (parsed.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');

    return {
      text,
      usage: {
        cacheCreationInputTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: parsed.usage?.cache_read_input_tokens ?? 0,
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
      },
    };
  }
}
