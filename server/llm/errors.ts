export type LLMErrorCode =
  | 'timeout'
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'network'
  | 'provider'
  | 'empty_response'
  | 'invalid_response'
  | 'not_configured';

/** Provider failure with a coarse category. `message` is for server logs only (already redacted). */
export class LLMError extends Error {
  constructor(readonly code: LLMErrorCode, message: string) {
    super(redact(message));
    this.name = 'LLMError';
  }

  /** Worth retrying the same provider after a short backoff. */
  get retryable(): boolean {
    return this.code === 'timeout' || this.code === 'rate_limit' || this.code === 'network' || this.code === 'provider';
  }
}

// Provider error messages sometimes echo (partially masked) credentials.
const SECRET_PATTERNS = [/gsk_[A-Za-z0-9]{8,}/g, /sk-[A-Za-z0-9_-]{8,}/g, /AIza[0-9A-Za-z_-]{20,}/g, /AQ\.[0-9A-Za-z_.-]{16,}/g, /key=[^&\s]+/g];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[redacted]'), text);
}
