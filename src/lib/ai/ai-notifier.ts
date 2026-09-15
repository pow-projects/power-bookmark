/**
 * Update notification for management page (BookmarkList) storage.onChanged listener.
 * - Success / Progress: ai_analysis_last_update (triggers card/row re-query)
 * - Failure: ai_analysis_error (informs user of error via toast and updates error badges)
 * Harmlessly ignored in test/Node environments without browser global.
 */
export async function notifyManagementPage(info: { ok: boolean; bookmarkId?: number; error?: string }): Promise<void> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      if (info.ok) {
        await browser.storage.local.set({ 'ai_analysis_last_update': Date.now() });
      } else {
        await browser.storage.local.set({
          'ai_analysis_error': { bookmarkId: info.bookmarkId, error: info.error, at: Date.now() }
        });
      }
    }
  } catch (e) {
    console.warn('Failed to notify management page of AI analysis update:', e);
  }
}
