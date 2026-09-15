let cachedSessionId: string | null = null;

/**
 * Returns a stable session ID for OpenCode Go / Console Go routing and prompt caching.
 * The header `x-opencode-session` is required by OpenCode Go for all API requests.
 */
export function getOpenCodeSessionId(): string {
  if (!cachedSessionId) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      cachedSessionId = crypto.randomUUID();
    } else {
      cachedSessionId = 'pb-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 11);
    }
  }
  return cachedSessionId;
}

/**
 * Test helper to reset cached session ID
 */
export function _resetOpenCodeSessionIdForTest(): void {
  cachedSessionId = null;
}
