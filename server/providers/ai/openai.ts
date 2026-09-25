import { LLMError, type AIProvider, type ChatOptions, type LLMMessage } from './types';
import type { ContextWindow, StreamChunk } from '../../types';

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(messages: LLMMessage[], options: ChatOptions): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: options.maxTokens ?? 400,
          temperature: options.temperature ?? 0.7,
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
          messages,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new LLMError('timeout', `OpenAI request timed out after ${options.timeoutMs}ms`);
      }
      throw new LLMError('network', `OpenAI network error: ${(err as Error).message}`);
    }

    try {
      if (!response.ok) {
        // Log only OpenAI's error code and a short one-line message.
        const body = await response.json().catch(() => null) as
          { error?: { code?: string; type?: string; message?: string } } | null;
        const reason = body?.error?.code || body?.error?.type || 'unknown';
        const detail = (body?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 160);
        const code = response.status === 401 || response.status === 403 ? 'auth'
          : reason === 'insufficient_quota' || reason === 'credit_balance_exhausted' ? 'quota'
          : response.status === 429 ? 'rate_limit'
          : 'provider';
        throw new LLMError(code, `OpenAI HTTP ${response.status} ${reason}: ${detail}`);
      }

      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new LLMError('empty_response', 'OpenAI returned no content');
      return text;
    } catch (err) {
      if (err instanceof LLMError) throw err;
      if (controller.signal.aborted) {
        throw new LLMError('timeout', `OpenAI response timed out after ${options.timeoutMs}ms`);
      }
      throw new LLMError('provider', `OpenAI response error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async generateStream(
    context: ContextWindow,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<void> {
    const systemPrompt = `You are an AI interview assistant helping a candidate during a live technical interview.
Your job is to analyze the interviewer's question and provide concise, useful guidance the candidate can quickly glance at.

IMPORTANT RULES:
- Keep responses SHORT. The candidate is in a live conversation.
- Be direct and practical.
- Format your response in exactly these sections:

### ANSWER
A 2-3 sentence answer direction. Explain what approach to take, not a word-for-word script.

### KEY_POINTS
- Point 1
- Point 2
- Point 3
- Point 4

### CONTEXT
One sentence about what the interviewer is evaluating.

### FOLLOW_UP
One likely follow-up question the interviewer might ask.`;

    const conversationContext = context.transcript
      .slice(-8)
      .map(t => `${t.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
      .join('\n');

    const userMessage = context.currentQuestion
      ? `Current question: "${context.currentQuestion.question}"

Recent conversation:
${conversationContext}

Topic area: ${context.topic}

Provide interview guidance for this question.`
      : `Conversation so far:
${conversationContext}

Provide guidance based on the conversation context.`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          max_tokens: 500,
          temperature: 0.7,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${err}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      let currentSection: 'ANSWER' | 'KEY_POINTS' | 'CONTEXT' | 'FOLLOW_UP' | null = null;
      let buffer = '';

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (!delta) continue;

            const sectionMatch = delta.match(/###\s*(ANSWER|KEY_POINTS|CONTEXT|FOLLOW_UP)/);
            if (sectionMatch) {
              if (currentSection) {
                onChunk({ type: 'section_end', section: currentSection });
              }
              currentSection = sectionMatch[1] as typeof currentSection;
              onChunk({ type: 'section_start', section: currentSection! });
              const afterHeader = delta.replace(/###\s*(ANSWER|KEY_POINTS|CONTEXT|FOLLOW_UP)\s*\n?/, '');
              if (afterHeader.trim()) {
                onChunk({ type: 'content', section: currentSection!, content: afterHeader });
              }
            } else if (currentSection) {
              onChunk({ type: 'content', section: currentSection, content: delta });
            }
          } catch {}
        }
      }

      if (currentSection) {
        onChunk({ type: 'section_end', section: currentSection });
      }
      onChunk({ type: 'done' });
    } catch (err) {
      console.error('[openai] Stream error:', err);
      onChunk({ type: 'error', content: String(err) });
    }
  }
}
