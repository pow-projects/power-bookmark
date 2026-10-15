/**
 * Utility helpers to detect Incognito / Private Browsing context.
 */

/**
 * Returns true if the current execution context (e.g. Popup, Options, Content Script)
 * is running inside an Incognito window/profile.
 */
export function isIncognitoContext(): boolean {
  try {
    if (typeof chrome !== 'undefined' && chrome.extension?.inIncognitoContext) {
      return true;
    }
    if (typeof browser !== 'undefined' && (browser.extension as any)?.inIncognitoContext) {
      return true;
    }
  } catch {
    // Ignore errors in environments where API is absent
  }
  return false;
}

/**
 * Returns true if the provided tab is an Incognito / Private browsing tab.
 */
export function isIncognitoTab(tab?: chrome.tabs.Tab | null): boolean {
  return !!tab?.incognito;
}
