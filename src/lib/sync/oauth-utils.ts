/**
 * Helper to determine the OAuth redirect URI across browsers and environments.
 * 
 * - In production builds with injected extension IDs:
 *   - Firefox: uses `https://${__FIREFOX_EXTENSION_ID__}.extensions.allizom.org/`
 *   - Chrome: uses `https://${__CHROME_EXTENSION_ID__}.chromiumapp.org/`
 * - In development or when ID is not set:
 *   - Falls back to `browser.identity.getRedirectURL()` or `chrome.identity.getRedirectURL()`
 */
export function getOAuthRedirectUri(): string {
  // Check build-time injected fixed extension IDs
  const firefoxExtId = typeof __FIREFOX_EXTENSION_ID__ !== 'undefined' ? __FIREFOX_EXTENSION_ID__ : '';
  const chromeExtId = typeof __CHROME_EXTENSION_ID__ !== 'undefined' ? __CHROME_EXTENSION_ID__ : '';

  // Check if we are running in Firefox (import.meta.env.FIREFOX injected by WXT)
  const isFirefox = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.FIREFOX);

  if (isFirefox && firefoxExtId) {
    return `https://${firefoxExtId}.extensions.allizom.org/`;
  }

  if (!isFirefox && chromeExtId) {
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
