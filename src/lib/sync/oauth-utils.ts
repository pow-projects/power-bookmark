/**
 * Helper to determine the OAuth redirect URI across browsers and environments.
 * 
 * - In production builds with injected extension IDs:
 *   - Chrome: uses `https://${__CHROME_EXTENSION_ID__}.chromiumapp.org/`
 * - Firefox / development or when Chrome ID is not set:
 *   - Falls back to `browser.identity.getRedirectURL()` or `chrome.identity.getRedirectURL()`
 */
export function getOAuthRedirectUri(): string {
  // Check build-time injected fixed extension ID for Chrome
  const chromeExtId = typeof __CHROME_EXTENSION_ID__ !== 'undefined' ? __CHROME_EXTENSION_ID__ : '';

  // Check if we are running in Firefox (import.meta.env.FIREFOX injected by WXT)
  const isFirefox = Boolean(import.meta.env.FIREFOX);

  // Check if running in production mode
  const isProd = Boolean(import.meta.env.PROD);

  if (!isFirefox && isProd && chromeExtId) {
    return `https://${chromeExtId}.chromiumapp.org/`;
  }

  // Fallback to browser identity API for dev environment
  if (typeof browser !== 'undefined' && browser.identity?.getRedirectURL) {
    return browser.identity.getRedirectURL();
  }
  if (typeof chrome !== 'undefined' && chrome.identity?.getRedirectURL) {
    return chrome.identity.getRedirectURL();
  }

  return '';
}
