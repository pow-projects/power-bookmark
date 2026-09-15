/**
 * Converts raw AI error messages or exception objects into a concise,
 * user-friendly approximate error message for UI badges, toasts, and tooltips.
 */
export function formatApproximateAiError(error: unknown): string {
  if (!error) return i18n.t('ai.analysisError');

  const rawMsg = typeof error === 'string'
    ? error
    : (error as any)?.message || String(error);

  const lower = rawMsg.toLowerCase();

  // 1. Quota / Rate limit (429)
  if (
    lower.includes('quota') ||
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('insufficient_quota')
  ) {
    return i18n.t('ai.errorQuota');
  }

  // 2. Authentication (401 / 403 / API Key)
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('api key') ||
    lower.includes('api_key') ||
    lower.includes('invalid_api_key')
  ) {
    return i18n.t('ai.errorAuth');
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return i18n.t('ai.errorAuth');
  }

  // 3. Model not found (404)
  if (
    lower.includes('404') ||
    lower.includes('model not found') ||
    lower.includes('model_not_found') ||
    lower.includes('does not exist')
  ) {
    return i18n.t('ai.errorModelNotFound');
  }

  // 4. Request Timeout / Aborted
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborterror') ||
    lower.includes('deadline')
  ) {
    return i18n.t('ai.errorTimeout');
  }

  // 5. Network / Connection Refused
  if (
    lower.includes('failed to fetch') ||
    lower.includes('econnrefused') ||
    lower.includes('connection refused') ||
    lower.includes('net::err') ||
    lower.includes('networkerror')
  ) {
    return i18n.t('ai.errorNetwork');
  }

  // 6. Token Soup / Context Limit
  if (
    lower.includes('token soup') ||
    lower.includes('tokensoup') ||
    lower.includes('토큰 수프') ||
    lower.includes('context length')
  ) {
    return i18n.t('ai.errorTokenSoup');
  }

  // 7. AI Not Configured
  if (
    lower.includes('is not configured') ||
    lower.includes('provider is not configured') ||
    lower.includes('ai unconfigured')
  ) {
    return i18n.t('ai.errorNotConfigured');
  }

  // 8. 5xx Server Error
  if (
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('server error') ||
    lower.includes('internal error')
  ) {
    return i18n.t('ai.errorServerError');
  }

  // 9. Generic fallback (clean up whitespaces and truncate if excessively long)
  const cleaned = rawMsg.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (cleaned.length <= 40) return cleaned;
  return `${cleaned.slice(0, 37)}...`;
}
