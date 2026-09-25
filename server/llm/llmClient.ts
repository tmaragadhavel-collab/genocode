import OpenAI from 'openai';
import type { ZodType, ZodTypeDef } from 'zod';
import type { LLMConfig, ProviderConfig } from './config';
import { LLMError, redact } from './errors';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type CompleteOptions = {
  maxTokens?: number;
  temperature?: number;
  /** Ask for a single JSON object (JSON mode where the provider supports it). */
  json?: boolean;
  timeoutMs?: number;
  /** Short label for logs, e.g. 'evaluation'. Never log prompt content. */
  purpose: string;
};

export type Completion = { text: string; provider: string; model: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toLLMError(err: unknown, provider: ProviderConfig, timeoutMs: number): LLMError {
  if (err instanceof LLMError) return err;
  const label = `${provider.name}:${provider.model}`;
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new LLMError('timeout', `${label} timed out after ${timeoutMs}ms`);
  if (err instanceof OpenAI.APIConnectionError) return new LLMError('network', `${label} network error: ${err.message}`);
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    const detail = `${label} HTTP ${status}: ${(err.message || '').replace(/\s+/g, ' ').slice(0, 200)}`;
    const code = (err.code || (err.error as { code?: string } | undefined)?.code || '') as string;
    if (status === 401 || status === 403) return new LLMError('auth', detail);
    if (status === 429) return new LLMError(/quota|credit|billing/i.test(`${code} ${err.message}`) ? 'quota' : 'rate_limit', detail);
    if (status === 408) return new LLMError('timeout', detail);
    if (status >= 500) return new LLMError('provider', detail);
    // 400/404/422 etc.: a request or model problem that retrying won't fix.
    return new LLMError('invalid_response', detail);
  }
  return new LLMError('provider', `${label}: ${(err as Error)?.message ?? String(err)}`);
}

/** Pulls the first top-level JSON object out of a reply (tolerates fences or prose around it). */
export function extractJSON(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch { /* fall through */ }
    }
    throw new LLMError('invalid_response', 'reply is not valid JSON');
  }
}

/**
 * The single entry point for every LLM call (evaluation, follow-ups, chat,
 * reports, live assistant). No other module talks to a provider directly.
 *
 * Per call: up to `maxRetries` retries with backoff on the primary for
 * retryable failures (429/5xx/timeout/network), then the fallback provider,
 * then an LLMError for the caller to handle.
 */
export class LLMClient {
  private readonly clients = new Map<ProviderConfig, OpenAI>();

  constructor(private readonly cfg: LLMConfig) {
    for (const p of [cfg.primary, cfg.fallback]) {
      if (p) this.clients.set(p, new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL, maxRetries: 0 }));
    }
  }

  /** No provider configured: callers use their labelled demo behaviour instead. */
  get demoMode(): boolean {
    return !this.cfg.primary;
  }

  get describe(): string {
    const p = this.cfg.primary;
    if (!p) return 'demo (no LLM configured)';
    const f = this.cfg.fallback;
    return `${p.name}:${p.model}${f ? ` (fallback ${f.name}:${f.model})` : ''}`;
  }

  get primaryModel(): string {
    return this.cfg.primary ? `${this.cfg.primary.name}:${this.cfg.primary.model}` : 'demo';
  }

  private providers(): ProviderConfig[] {
    return [this.cfg.primary, this.cfg.fallback].filter((p): p is ProviderConfig => !!p);
  }

  /** Extra request fields some models need (kept out of callers). */
  private extras(p: ProviderConfig): Record<string, unknown> {
    // Groq's gpt-oss models reason before answering; keep that short for latency.
    return p.name === 'groq' && p.model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {};
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions): Promise<Completion> {
    if (this.demoMode) throw new LLMError('not_configured', 'no LLM provider configured');
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs;
    let lastError: LLMError | null = null;

    for (const [i, provider] of this.providers().entries()) {
      const client = this.clients.get(provider)!;
      for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
        const started = Date.now();
        try {
          const res = await client.chat.completions.create({
            model: provider.model,
            messages,
            max_tokens: opts.maxTokens ?? 800,
            temperature: opts.temperature ?? 0.3,
            ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
            ...this.extras(provider),
          }, { timeout: timeoutMs });
          const text = res.choices[0]?.message?.content?.trim() ?? '';
          if (!text) throw new LLMError('empty_response', `${provider.name}:${provider.model} returned no content`);
          console.log(`[LLM] ${opts.purpose} ok via ${provider.name}:${provider.model} (${Date.now() - started}ms)${i > 0 ? ' [fallback]' : ''}`);
          return { text, provider: provider.name, model: provider.model };
        } catch (err) {
          lastError = toLLMError(err, provider, timeoutMs);
          console.warn(`[LLM] ${opts.purpose} attempt ${attempt + 1} via ${provider.name} failed (${lastError.code}): ${lastError.message}`);
          if (!lastError.retryable || attempt === this.cfg.maxRetries) break;
          await sleep(500 * 3 ** attempt); // 0.5s, 1.5s, ...
        }
      }
      if (i === 0 && this.cfg.fallback) console.warn(`[LLM] ${opts.purpose}: primary failed, trying fallback ${this.cfg.fallback.name}`);
    }
    throw lastError ?? new LLMError('provider', 'no provider available');
  }

  /**
   * JSON completion validated against a zod schema. On unparseable or invalid
   * output, one repair retry quotes the problem back to the model; a second
   * failure throws LLMError('invalid_response').
   */
  async completeJSON<T>(schema: ZodType<T, ZodTypeDef, unknown>, messages: ChatMessage[], opts: CompleteOptions): Promise<{ data: T } & Completion> {
    let convo = messages;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await this.complete(convo, { ...opts, json: true });
      let problem: string;
      try {
        const parsed = schema.safeParse(extractJSON(res.text));
        if (parsed.success) return { ...res, data: parsed.data };
        problem = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      } catch (err) {
        problem = (err as Error).message;
      }
      console.warn(`[LLM] ${opts.purpose} invalid output (attempt ${attempt}): ${redact(problem)}`);
      convo = [
        ...messages,
        { role: 'assistant', content: res.text.slice(0, 4000) },
        { role: 'user', content: `That reply was invalid (${problem}). Reply again with ONLY one JSON object in exactly the required shape.` },
      ];
    }
    throw new LLMError('invalid_response', `${opts.purpose}: output failed validation after a repair retry`);
  }

  /**
   * Streams text deltas. Falls back to the next provider only if nothing has
   * been streamed yet (a half-streamed answer can't be restarted cleanly).
   */
  async stream(messages: ChatMessage[], onDelta: (text: string) => void, opts: CompleteOptions): Promise<void> {
    if (this.demoMode) throw new LLMError('not_configured', 'no LLM provider configured');
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs;
    let lastError: LLMError | null = null;
    for (const provider of this.providers()) {
      let emitted = false;
      try {
        const stream = await this.clients.get(provider)!.chat.completions.create({
          model: provider.model,
          messages,
          max_tokens: opts.maxTokens ?? 800,
          temperature: opts.temperature ?? 0.5,
          stream: true,
          ...this.extras(provider),
        }, { timeout: timeoutMs });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            emitted = true;
            onDelta(delta);
          }
        }
        return;
      } catch (err) {
        lastError = toLLMError(err, provider, timeoutMs);
        console.warn(`[LLM] ${opts.purpose} stream via ${provider.name} failed (${lastError.code}): ${lastError.message}`);
        if (emitted) throw lastError;
      }
    }
    throw lastError ?? new LLMError('provider', 'no provider available');
  }
}
