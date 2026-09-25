export type ProviderConfig = {
  name: string; // 'groq' | 'gemini' | 'openai' | custom
  baseURL: string;
  apiKey: string;
  model: string;
};

export type LLMConfig = {
  primary: ProviderConfig | null; // null → demo mode (no AI calls)
  fallback: ProviderConfig | null;
  timeoutMs: number;
  maxRetries: number;
};

const DEFAULT_BASE_URL: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  openai: 'https://api.openai.com/v1',
};

function num(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Reads LLM settings from the environment. Never logs keys. */
export function loadLLMConfig(env: NodeJS.ProcessEnv = process.env): LLMConfig {
  let primary: ProviderConfig | null = null;
  const name = (env.LLM_PROVIDER || '').trim().toLowerCase();
  if (env.LLM_API_KEY && name) {
    primary = {
      name,
      baseURL: env.LLM_BASE_URL || DEFAULT_BASE_URL[name] || '',
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL || '',
    };
  } else if (env.AI_API_KEY) {
    // Backwards compatibility with the earlier OpenAI-only settings.
    primary = { name: 'openai', baseURL: DEFAULT_BASE_URL.openai, apiKey: env.AI_API_KEY, model: env.AI_MODEL || 'gpt-4o-mini' };
  }
  if (primary && (!primary.baseURL || !primary.model)) {
    console.warn(`[LLM] ${primary.name}: LLM_BASE_URL and LLM_MODEL are required; running in demo mode`);
    primary = null;
  }

  let fallback: ProviderConfig | null = null;
  const fb = (env.LLM_FALLBACK_PROVIDER || '').trim().toLowerCase();
  if (primary && fb === 'gemini' && env.GEMINI_API_KEY) {
    fallback = { name: 'gemini', baseURL: DEFAULT_BASE_URL.gemini, apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || 'gemini-3-flash-preview' };
  } else if (primary && fb && env.LLM_FALLBACK_API_KEY) {
    fallback = {
      name: fb,
      baseURL: env.LLM_FALLBACK_BASE_URL || DEFAULT_BASE_URL[fb] || '',
      apiKey: env.LLM_FALLBACK_API_KEY,
      model: env.LLM_FALLBACK_MODEL || '',
    };
    if (!fallback.baseURL || !fallback.model) fallback = null;
  }

  return {
    primary,
    fallback,
    timeoutMs: num(env.LLM_TIMEOUT_MS, 20_000, 1000, 120_000),
    maxRetries: num(env.LLM_MAX_RETRIES, 2, 0, 5),
  };
}
