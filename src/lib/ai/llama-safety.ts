import { isTokenSoup } from './types';

/**
 * Detects local/private endpoints — local LLMs require a max_tokens budget.
 * Returns true if hostname is localhost/127.0.0.1/0.0.0.0/::1, a private subnet (192.168.*, 10.*, 172.16-31.*),
 * or ends with .local. Returns false if endpoint is undefined.
 */
export function isLocalEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  let host = endpoint;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    host = endpoint; // Fallback to raw string if URL cannot be parsed
  }
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1') return true;
  if (h.endsWith('.local')) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

/**
 * Safe max_tokens for local LLMs: guarantees a 2048 lower bound if local (promotes to 2048 if user specified is below 2048).
 * For cloud, passes user specified value only (undefined if unspecified -> SDK default).
 */
export function getSafeMaxTokens(endpoint: string | undefined, userSpecified?: number): number | undefined {
  if (!isLocalEndpoint(endpoint)) return userSpecified;
  return Math.max(userSpecified ?? 0, 2048);
}

/** Throws if token soup — applied to both generateObject catch error.text and generateText final output */
export class TokenSoupError extends Error {
  constructor(msg?: string) {
    super(msg || 'AI response is token soup. Please check local LLM router configuration.');
    this.name = 'TokenSoupError';
  }
}

export function assertValidModelOutput(text: string): void {
  if (isTokenSoup(text)) throw new TokenSoupError();
}

export function isPermanentAiError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string; status?: number; statusCode?: number };
  if (e.name === 'TokenSoupError') return true;

  const status = e.status || e.statusCode;
  if (status === 400 || status === 401 || status === 403 || status === 404) return true;

  const msg = (typeof e.message === 'string' ? e.message : String(err)).toLowerCase();
  if (msg.includes('토큰 수프') || msg.includes('token soup')) return true;
  if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('invalid_api_key')) return true;
  if (msg.includes('model not found') || msg.includes('does not exist') || msg.includes('model_not_found')) return true;
  if (msg.includes('insufficient_quota') || msg.includes('exceeded your current quota')) return true;
  if (msg.includes('context length exceeded') || msg.includes('maximum context length')) return true;
  if (msg.includes('is not configured') || msg.includes('provider is not configured')) return true;

  return false;
}
