import db, { type Bookmark } from '../db';

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
  return bookmark.httpStatus != null && (bookmark.httpStatus < 200 || bookmark.httpStatus >= 400);
}

/**
 * Clears the connection error status for a bookmark in the database, resetting httpStatus to 200 (OK).
 */
export function clearBookmarkHealth(bookmarkId: number): Promise<void> {
  return db.bookmarks.update(bookmarkId, {
    httpStatus: 200,
    lastCheckedAt: Date.now()
  }).then(() => undefined);
}

function combineSignals(timeoutSignal: AbortSignal, externalSignal?: AbortSignal): AbortSignal {
  if (!externalSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeoutSignal, externalSignal]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (timeoutSignal.aborted || externalSignal.aborted) {
    controller.abort();
    return controller.signal;
  }
  timeoutSignal.addEventListener('abort', onAbort, { once: true });
  externalSignal.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/**
 * Checks the HTTP status of a bookmark URL.
 */
export async function checkBookmarkHealth(
  bookmark: Bookmark,
  timeoutMs = 5000,
  signal?: AbortSignal,
  skipDbUpdate = false
): Promise<HealthCheckResult> {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }

  const result: HealthCheckResult = {
    bookmarkId: bookmark.id!,
    url: bookmark.url,
    status: 'error'
  };

  const tryGet = async (): Promise<boolean> => {
    const getController = new AbortController();
    const getTimeoutId = setTimeout(() => getController.abort(), timeoutMs);
    const getSignal = combineSignals(getController.signal, signal);
    try {
      const getResponse = await fetch(bookmark.url, {
        method: 'GET',
        signal: getSignal
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
      if (signal?.aborted) {
        throw getErr.name === 'AbortError' ? getErr : new DOMException('The operation was aborted', 'AbortError');
      }
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
  const headSignal = combineSignals(headController.signal, signal);

  try {
    // Phase 1: Check with HEAD request (minimizes server load and bandwidth)
    const response = await fetch(bookmark.url, {
      method: 'HEAD',
      signal: headSignal
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
    if (signal?.aborted) {
      throw error.name === 'AbortError' ? error : new DOMException('The operation was aborted', 'AbortError');
    }
    if (error.name === 'AbortError') {
      result.status = 'timeout';
    } else {
      // Phase 2: Retry with GET if CORS issue or network error occurs
      await tryGet();
    }
  } finally {
    clearTimeout(headTimeoutId);
  }

  if (signal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }

  // Update DB
  if (!skipDbUpdate && bookmark.id !== undefined && !signal?.aborted) {
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
  onProgress?: (checkedCount: number, totalCount: number) => void,
  signal?: AbortSignal
): Promise<HealthCheckResult[]> {
  const bookmarks = await db.bookmarks.toArray();
  const total = bookmarks.length;
  const results: HealthCheckResult[] = [];
  const batchSize = 10;
  
  if (total === 0) return [];

  for (let i = 0; i < total; i += batchSize) {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    const batch = bookmarks.slice(i, i + batchSize);
    
    // Process batch in parallel
    const batchPromises = batch.map(bookmark => checkBookmarkHealth(bookmark, 5000, signal, true));
    const batchResults = await Promise.all(batchPromises);
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    results.push(...batchResults);

    const now = Date.now();
    const updates = batchResults
      .filter((r) => r && r.bookmarkId !== undefined)
      .map((r) => ({
        key: r.bookmarkId,
        changes: {
          lastCheckedAt: now,
          httpStatus: r.httpStatus || 0
        }
      }));

    if (updates.length > 0) {
      if (typeof (db.bookmarks as any).bulkUpdate === 'function') {
        await (db.bookmarks as any).bulkUpdate(updates);
      } else {
        await Promise.all(updates.map(u => db.bookmarks.update(u.key, u.changes)));
      }
    }

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
  onBatchResults?: (results: HealthCheckResult[]) => void,
  signal?: AbortSignal
): Promise<HealthCheckResult[]> {
  const total = ids.length;
  const results: HealthCheckResult[] = [];
  const batchSize = 10;

  if (total === 0) return [];

  for (let i = 0; i < total; i += batchSize) {
    if (signal?.aborted || (shouldCancel && shouldCancel())) {
      throw new Error(typeof i18n !== 'undefined' ? i18n.t('health.cancelled') : 'Cancelled');
    }
    const batchIds = ids.slice(i, i + batchSize);
    const batchPromises = batchIds.map(async (id) => {
      if (signal?.aborted) return null;
      if (onItemStart) onItemStart(id);
      const bookmark = await db.bookmarks.get(id);
      if (!bookmark) return null;
      return checkBookmarkHealth(bookmark, 5000, signal, true);
    });
    const batchResults = await Promise.all(batchPromises);
    if (signal?.aborted || (shouldCancel && shouldCancel())) {
      throw new Error(typeof i18n !== 'undefined' ? i18n.t('health.cancelled') : 'Cancelled');
    }
    const validBatchResults: HealthCheckResult[] = [];
    const now = Date.now();
    const updates: { key: number; changes: { lastCheckedAt: number; httpStatus: number } }[] = [];

    for (const r of batchResults) {
      if (r) {
        results.push(r);
        validBatchResults.push(r);
        updates.push({
          key: r.bookmarkId,
          changes: {
            lastCheckedAt: now,
            httpStatus: r.httpStatus || 0
          }
        });
      }
    }

    if (updates.length > 0) {
      if (typeof (db.bookmarks as any).bulkUpdate === 'function') {
        await (db.bookmarks as any).bulkUpdate(updates);
      } else {
        await Promise.all(updates.map(u => db.bookmarks.update(u.key, u.changes)));
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
