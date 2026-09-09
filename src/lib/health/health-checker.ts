import db, { type Bookmark } from '../db';
import { version as appVersion } from '../../../package.json';

function getAppVersion(): string {
  try {
    return (typeof browser !== 'undefined' && browser.runtime?.getManifest?.()?.version) ||
      (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version) ||
      appVersion;
  } catch {
    return appVersion;
  }
}

export interface HealthCheckResult {
  bookmarkId: number;
  url: string;
  status: 'ok' | 'dead' | 'server_error' | 'timeout' | 'error';
  httpStatus?: number;
}

/**
 * Determines whether a bookmark is a 404 dead link.
 * Prioritizes real-time check result (healthResult) if present; otherwise determines based on bookmark's httpStatus.
 */
export function isBookmarkDead(bookmark: Bookmark, healthResult?: HealthCheckResult): boolean {
  if (healthResult) {
    return healthResult.status === 'dead' || healthResult.httpStatus === 404;
  }
  return bookmark.httpStatus === 404;
}

/**
 * Determines whether a bookmark has a connection error status (4xx, 5xx, timeout, network error, etc.).
 * Prioritizes real-time check result (healthResult) if present; otherwise determines based on bookmark's httpStatus.
 */
export function isBookmarkBroken(bookmark: Bookmark, healthResult?: HealthCheckResult): boolean {
  if (healthResult) {
    return healthResult.status !== 'ok';
  }
  return Boolean(bookmark.httpStatus && (bookmark.httpStatus < 200 || bookmark.httpStatus >= 400));
}

/**
 * Clears the connection error status for a bookmark in the database, resetting httpStatus to 200 (OK).
 */
export async function clearBookmarkHealth(bookmarkId: number): Promise<void> {
  await db.bookmarks.update(bookmarkId, {
    httpStatus: 200,
    lastCheckedAt: Date.now()
  });
}

/**
 * Checks the HTTP status of a bookmark URL.
 */
export async function checkBookmarkHealth(bookmark: Bookmark, timeoutMs = 5000): Promise<HealthCheckResult> {
  const result: HealthCheckResult = {
    bookmarkId: bookmark.id!,
    url: bookmark.url,
    status: 'error'
  };

  const tryGet = async (): Promise<boolean> => {
    const getController = new AbortController();
    const getTimeoutId = setTimeout(() => getController.abort(), timeoutMs);
    try {
      const getResponse = await fetch(bookmark.url, {
        method: 'GET',
        signal: getController.signal,
        headers: {
          'User-Agent': `PowerBookmark/${getAppVersion()}`
        }
      });
      result.httpStatus = getResponse.status;
      if (getResponse.status >= 200 && getResponse.status < 400) {
        result.status = 'ok';
      } else if (getResponse.status === 404) {
        result.status = 'dead';
      } else if (getResponse.status >= 500) {
        result.status = 'server_error';
      } else {
        result.status = 'error';
      }
      try {
        getResponse.body?.cancel();
      } catch {
        // ignore stream cancellation errors
      }
      return true;
    } catch (getErr: any) {
      if (getErr.name === 'AbortError') {
        result.status = 'timeout';
      } else {
        result.status = 'error';
      }
      return false;
    } finally {
      clearTimeout(getTimeoutId);
    }
  };

  const headController = new AbortController();
  const headTimeoutId = setTimeout(() => headController.abort(), timeoutMs);

  try {
    // Phase 1: Check with HEAD request (minimizes server load and bandwidth)
    const response = await fetch(bookmark.url, {
      method: 'HEAD',
      signal: headController.signal,
      headers: {
        'User-Agent': `PowerBookmark/${getAppVersion()}`
      }
    });

    result.httpStatus = response.status;
    if (response.status >= 200 && response.status < 400) {
      result.status = 'ok';
    } else {
      // If HEAD returns 404, 405, 403, 5xx, etc.,
      // retry with GET since some servers (CloudFront/S3/SPA, etc.) return 404 due to lack of HEAD support
      await tryGet();
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      result.status = 'timeout';
    } else {
      // Phase 2: Retry with GET if CORS issue or network error occurs
      await tryGet();
    }
  } finally {
    clearTimeout(headTimeoutId);
  }

  // Update DB
  if (bookmark.id !== undefined) {
    await db.bookmarks.update(bookmark.id, {
      lastCheckedAt: Date.now(),
      httpStatus: result.httpStatus || 0
    });
  }

  return result;
}

/**
 * Manually batches health checks for all bookmarks.
 * Fixed batch size of 10 requests in parallel at a time.
 */
export async function checkAllBookmarksHealth(
  onProgress?: (checkedCount: number, totalCount: number) => void
): Promise<HealthCheckResult[]> {
  const bookmarks = await db.bookmarks.toArray();
  const total = bookmarks.length;
  const results: HealthCheckResult[] = [];
  const batchSize = 10;
  
  if (total === 0) return [];

  for (let i = 0; i < total; i += batchSize) {
    const batch = bookmarks.slice(i, i + batchSize);
    
    // Process batch in parallel
    const batchPromises = batch.map(bookmark => checkBookmarkHealth(bookmark));
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    if (onProgress) {
      onProgress(Math.min(i + batchSize, total), total);
    }
  }

  return results;
}

/**
 * Checks only bookmarks with the specified IDs.
 */
export async function checkBookmarksHealth(
  ids: number[],
  onProgress?: (checkedCount: number, totalCount: number) => void,
  shouldCancel?: () => boolean,
  onItemStart?: (id: number) => void,
  onBatchResults?: (results: HealthCheckResult[]) => void
): Promise<HealthCheckResult[]> {
  const total = ids.length;
  const results: HealthCheckResult[] = [];
  const batchSize = 10;

  if (total === 0) return [];

  for (let i = 0; i < total; i += batchSize) {
    if (shouldCancel && shouldCancel()) throw new Error(typeof i18n !== 'undefined' ? i18n.t('health.cancelled') : 'Cancelled');
    const batchIds = ids.slice(i, i + batchSize);
    const batchPromises = batchIds.map(async (id) => {
      if (onItemStart) onItemStart(id);
      const bookmark = await db.bookmarks.get(id);
      if (!bookmark) return null;
      return checkBookmarkHealth(bookmark);
    });
    const batchResults = await Promise.all(batchPromises);
    const validBatchResults: HealthCheckResult[] = [];
    for (const r of batchResults) {
      if (r) {
        results.push(r);
        validBatchResults.push(r);
      }
    }

    if (onBatchResults && validBatchResults.length > 0) {
      onBatchResults(validBatchResults);
    }

    if (onProgress) {
      onProgress(Math.min(i + batchSize, total), total);
    }
  }

  return results;
}
