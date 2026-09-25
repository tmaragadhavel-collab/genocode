import dotenv from 'dotenv';
import type { ServerConfig } from './types';

dotenv.config();

export function loadConfig(): ServerConfig {
  const deepgramKey = process.env.DEEPGRAM_API_KEY || null;
  const aiApiKey = process.env.AI_API_KEY || null;
  const aiModel = process.env.AI_MODEL || 'gpt-4o-mini';
  const timeout = Number(process.env.AI_TIMEOUT_MS);
  const aiTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 30000;
  const isProduction = process.env.NODE_ENV === 'production';
  // Base for invite links, e.g. an HTTPS tunnel URL; defaults to the request host.
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || null;
  const port = Number(process.env.SERVER_PORT || process.env.PORT || 3001);
  const livekitUrl = process.env.LIVEKIT_URL || null;
  const livekitApiKey = process.env.LIVEKIT_API_KEY || null;
  const livekitApiSecret = process.env.LIVEKIT_API_SECRET || null;
  const demoMode = !deepgramKey && !aiApiKey;

  if (deepgramKey) console.log('[stt] Deepgram API key configured');
  else console.log('[stt] No DEEPGRAM_API_KEY — STT will not work');

  if (aiApiKey) console.log(`[ai] AI API key configured (model: ${aiModel})`);
  else console.log('[ai] No AI_API_KEY — using mock AI (demo mode)');

  if (livekitUrl) console.log(`[livekit] URL: ${livekitUrl}`);
  else console.log('[livekit] No LIVEKIT_URL — LiveKit not configured');

  return { port, deepgramKey, aiApiKey, aiModel, aiTimeoutMs, isProduction, publicBaseUrl, demoMode, livekitUrl, livekitApiKey, livekitApiSecret };
}
