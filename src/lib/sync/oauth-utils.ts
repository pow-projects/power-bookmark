export type OAuthSyncProvider = 'google-drive' | 'onedrive' | 'dropbox';

/**
 * Transforms a Firefox extension redirect URI into RFC 8252 loopback redirect format.
 * Format: `http://127.0.0.1/mozoauth2/${subdomain}` (without trailing slash).
 * Non-matching or invalid inputs return rawUri unchanged.
 */
export function formatFirefoxLoopbackUri(rawUri: string): string {
  if (!rawUri || typeof rawUri !== 'string') {
    return '';
  }

  // If already formatted as loopback, normalize by removing trailing slash if present
  if (rawUri.startsWith('http://127.0.0.1/mozoauth2/')) {
    return rawUri.replace(/\/+$/, '');
  }

  const match = rawUri.match(/^https?:\/\/([^.]+)\.extensions\.allizom\.org/i);
  if (match && match[1]) {
    return `http://127.0.0.1/mozoauth2/${match[1]}`;
  }

  return rawUri;
}

/**
 * Helper to determine the OAuth redirect URI across browsers and environments.
 * 
 * - In production builds with injected extension IDs:
 *   - Chrome: uses `https://${__CHROME_EXTENSION_ID__}.chromiumapp.org/`
 * - Firefox:
 *   - For Google Drive (or unspecified provider): converts to loopback `http://127.0.0.1/mozoauth2/<subdomain>`
 *     to satisfy Google's domain ownership requirements.
 *   - For OneDrive and Dropbox: retains `https://<subdomain>.extensions.allizom.org/`
 * - Fallbacks to `browser.identity.getRedirectURL()` or `chrome.identity.getRedirectURL()`.
 */
export function getOAuthRedirectUri(provider?: OAuthSyncProvider): string {
  // Check build-time injected fixed extension ID for Chrome
  const chromeExtId = typeof __CHROME_EXTENSION_ID__ !== 'undefined' ? __CHROME_EXTENSION_ID__ : '';

  // Check if we are running in Firefox (import.meta.env.FIREFOX injected by WXT)
  const isFirefox = Boolean(import.meta.env.FIREFOX);

  // Check if running in production mode
  const isProd = Boolean(import.meta.env.PROD);

  if (!isFirefox && isProd && chromeExtId) {
    return `https://${chromeExtId}.chromiumapp.org/`;
  }

  // Obtain raw redirect URI from browser identity API
  let rawUri = '';
  if (typeof browser !== 'undefined' && browser.identity?.getRedirectURL) {
    rawUri = browser.identity.getRedirectURL();
  } else if (typeof chrome !== 'undefined' && chrome.identity?.getRedirectURL) {
    rawUri = chrome.identity.getRedirectURL();
  }

  if (!rawUri) {
    return '';
  }

  if (isFirefox && (!provider || provider === 'google-drive')) {
    return formatFirefoxLoopbackUri(rawUri);
  }

  return rawUri;
}

