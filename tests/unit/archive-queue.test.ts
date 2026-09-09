import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enqueueArchiveJob,
  getArchiveQueueLength,
  getActiveArchiveCount,
  _resetArchiveQueueForTest,
  ensureOffscreenDocument,
  closeOffscreenDocument
} from '../../src/lib/archive/archive-queue';
import { setTaskIndicator, getActiveTaskCounts, _resetTaskIndicatorsForTest } from '../../src/lib/bookmarks/badge-manager';

const mocks = vi.hoisted(() => {
  return {
    archiveBookmark: vi.fn().mockResolvedValue(100),
    fetchHtmlWithCharset: vi.fn().mockResolvedValue('<html><body>Sample</body></html>'),
    syncArchiveToCloudByBookmarkId: vi.fn().mockResolvedValue(undefined),
    notifyArchiveCaptureUpdate: vi.fn().mockResolvedValue(undefined),
    notifyArchiveCaptureError: vi.fn().mockResolvedValue(undefined),
    setArchiveCaptureState: vi.fn().mockResolvedValue(true),
    clearArchiveCaptureState: vi.fn().mockResolvedValue(undefined),
    mockSendMessage: vi.fn(),
    mockCreateDocument: vi.fn().mockResolvedValue(undefined),
    mockCloseDocument: vi.fn().mockResolvedValue(undefined),
    mockHasDocument: vi.fn().mockResolvedValue(false)
  };
});

vi.mock('../../src/lib/archive/page-capture', () => ({
  archiveBookmark: mocks.archiveBookmark
}));

vi.mock('../../src/lib/archive/fetch-with-charset', () => ({
  fetchHtmlWithCharset: mocks.fetchHtmlWithCharset
}));

vi.mock('../../src/lib/archive/archive-cloud', () => ({
  syncArchiveToCloudByBookmarkId: mocks.syncArchiveToCloudByBookmarkId
}));

vi.mock('../../src/lib/archive/archive-capture-state', () => ({
  setArchiveCaptureState: mocks.setArchiveCaptureState,
  clearArchiveCaptureState: mocks.clearArchiveCaptureState,
  notifyArchiveCaptureUpdate: mocks.notifyArchiveCaptureUpdate,
  notifyArchiveCaptureError: mocks.notifyArchiveCaptureError
}));

vi.mock('../../src/lib/db', () => {
  const mockDb = {
    bookmarks: {
      get: vi.fn().mockImplementation(async (id: number) => ({ id, url: 'https://example.com' }))
    }
  };
  return { db: mockDb, default: mockDb };
});

function setupGlobals() {
  vi.stubGlobal('browser', {
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      setIcon: vi.fn().mockResolvedValue(undefined)
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined)
    },
    runtime: {
      sendMessage: mocks.mockSendMessage,
      getURL: vi.fn((path: string) => `chrome-extension://dummy-id/${path}`)
    }
  });

  vi.stubGlobal('chrome', {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://dummy-id/${path}`),
      getContexts: vi.fn().mockResolvedValue([])
    },
    offscreen: {
      createDocument: mocks.mockCreateDocument,
      closeDocument: mocks.mockCloseDocument,
      hasDocument: mocks.mockHasDocument
    }
  });
}

describe('Archive Queue (lib/archive/archive-queue.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupGlobals();
    _resetArchiveQueueForTest();
    _resetTaskIndicatorsForTest();
  });

  afterEach(() => {
    _resetArchiveQueueForTest();
    _resetTaskIndicatorsForTest();
  });

  it('rejects invalid parameters', async () => {
    const res1 = await enqueueArchiveJob({ bookmarkId: 'not-number' as any, pageUrl: 'https://example.com', pageTitle: 'Test' });
    expect(res1.ok).toBe(false);
    expect(res1.reason).toBe('missing-params');

    const res2 = await enqueueArchiveJob({ bookmarkId: 1, pageUrl: '', pageTitle: 'Test' });
    expect(res2.ok).toBe(false);
    expect(res2.reason).toBe('missing-params');
  });

  it('enqueues job and sets task indicator for active tasks', async () => {
    mocks.mockSendMessage.mockResolvedValue({ ok: true, savedId: 10 });

    const res = await enqueueArchiveJob({
      bookmarkId: 1,
      htmlSource: '<html>Test</html>',
      pageUrl: 'https://example.com',
      pageTitle: 'Test Page'
    });

    expect(res.ok).toBe(true);

    // Wait for queue processing
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.setArchiveCaptureState).toHaveBeenCalledWith({ bookmarkId: 1, startedAt: expect.any(Number) });
    expect(mocks.clearArchiveCaptureState).toHaveBeenCalledWith(1);
    expect(mocks.notifyArchiveCaptureUpdate).toHaveBeenCalled();
    expect(mocks.syncArchiveToCloudByBookmarkId).toHaveBeenCalledWith(1);
    expect(getActiveTaskCounts().archive).toBe(0);
  });

  it('prevents duplicate enqueue for the same bookmarkId while in-flight', async () => {
    let resolver: (val: any) => void = () => {};
    mocks.mockSendMessage.mockReturnValue(new Promise((r) => { resolver = r; }));

    const res1 = await enqueueArchiveJob({
      bookmarkId: 2,
      htmlSource: '<html>Test 2</html>',
      pageUrl: 'https://example.com/2',
      pageTitle: 'Test 2'
    });
    expect(res1.ok).toBe(true);

    const res2 = await enqueueArchiveJob({
      bookmarkId: 2,
      htmlSource: '<html>Test 2 dup</html>',
      pageUrl: 'https://example.com/2',
      pageTitle: 'Test 2'
    });
    expect(res2.ok).toBe(false);
    expect(res2.reason).toBe('duplicate');

    resolver({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(getActiveArchiveCount()).toBe(0);
  });

  it('handles job failure, notifies error, and reliably releases indicator in finally', async () => {
    mocks.mockSendMessage.mockRejectedValue(new Error('Offscreen capture error'));

    const res = await enqueueArchiveJob({
      bookmarkId: 3,
      htmlSource: '<html>Fail</html>',
      pageUrl: 'https://example.com/3',
      pageTitle: 'Fail Page'
    });
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.notifyArchiveCaptureError).toHaveBeenCalledWith(3, expect.stringContaining('Offscreen capture error'));
    expect(mocks.clearArchiveCaptureState).toHaveBeenCalledWith(3);
    expect(getActiveTaskCounts().archive).toBe(0);
  });

  it('falls back to direct archiveBookmark when chrome.offscreen is unavailable (e.g., Firefox)', async () => {
    vi.stubGlobal('chrome', undefined);

    const res = await enqueueArchiveJob({
      bookmarkId: 4,
      htmlSource: '<html>Direct</html>',
      pageUrl: 'https://example.com/4',
      pageTitle: 'Direct Page'
    });
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.archiveBookmark).toHaveBeenCalledWith(
      4,
      '<html>Direct</html>',
      'https://example.com/4',
      'Direct Page',
      '',
      {},
      true
    );
    expect(mocks.notifyArchiveCaptureUpdate).toHaveBeenCalled();
  });
});
