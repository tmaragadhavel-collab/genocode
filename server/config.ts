import dotenv from 'dotenv';
import type { ServerConfig } from './types';
import type { SttProviderConfig, SttSettings } from './stt/types';

dotenv.config();

function sttProvider(name: string, env: NodeJS.ProcessEnv): SttProviderConfig | null {
  if (name === 'deepgram') {
    return env.DEEPGRAM_API_KEY
      ? { provider: 'deepgram', apiKey: env.DEEPGRAM_API_KEY, model: env.DEEPGRAM_MODEL || 'nova-3', baseURL: env.DEEPGRAM_BASE_URL || '' }
      : null;
  }
  if (name === 'groq') {
    // Groq Whisper uses the Groq LLM key unless STT_API_KEY is set.
    const apiKey = env.STT_API_KEY || (env.LLM_PROVIDER?.toLowerCase() === 'groq' ? env.LLM_API_KEY : '') || '';
    return apiKey
      ? { provider: 'groq', apiKey, model: env.STT_MODEL || 'whisper-large-v3-turbo', baseURL: env.STT_BASE_URL || 'https://api.groq.com/openai/v1' }
      : null;
  }
  return null;
}

/** STT_PROVIDER (primary) and optional STT_FALLBACK_PROVIDER: 'deepgram' | 'groq' | 'none'. */
function loadStt(env: NodeJS.ProcessEnv): SttSettings {
  const primaryName = (env.STT_PROVIDER || (env.DEEPGRAM_API_KEY ? 'deepgram' : 'none')).trim().toLowerCase();
  const fallbackName = (env.STT_FALLBACK_PROVIDER || '').trim().toLowerCase();
  const primary = sttProvider(primaryName, env);
  const fallback = fallbackName && fallbackName !== primaryName ? sttProvider(fallbackName, env) : null;
  if (primaryName !== 'none' && !primary) console.warn(`[stt] ${primaryName}: missing API key`);
  // If only the fallback is usable, use it as primary.
  return primary ? { primary, fallback } : { primary: fallback, fallback: null };
}

export function loadConfig(): ServerConfig {
  const env = process.env;
  const stt = loadStt(env);
  const hasLLM = Boolean(env.LLM_API_KEY || env.AI_API_KEY);
  const silence = Number(env.ANSWER_SILENCE_SECONDS);
  const config: ServerConfig = {
    port: Number(env.SERVER_PORT || env.PORT || 3001),
    isProduction: env.NODE_ENV === 'production',
    // Base for invite links, e.g. an HTTPS tunnel URL; defaults to the request host.
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || null,
    databaseUrl: env.DATABASE_URL || 'file:./data/interview.db',
    stt,
    // Legacy desktop-app live transcription (streaming) still uses Deepgram directly.
    deepgramKey: env.DEEPGRAM_API_KEY || null,
    answerSilenceSeconds: Number.isFinite(silence) && silence >= 2 && silence <= 60 ? silence : 5,
    demoMode: !hasLLM && !stt.primary,
    livekitUrl: env.LIVEKIT_URL || null,
    livekitApiKey: env.LIVEKIT_API_KEY || null,
    livekitApiSecret: env.LIVEKIT_API_SECRET || null,
  };

  const describe = (p: SttProviderConfig | null) => (p ? `${p.provider}:${p.model}` : 'none');
  console.log(`[stt] Provider: ${describe(stt.primary)}${stt.fallback ? ` (fallback ${describe(stt.fallback)})` : ''}`);
  if (!config.livekitUrl) console.log('[livekit] No LIVEKIT_URL — LiveKit not configured');
  return config;
}
