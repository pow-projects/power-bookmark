import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureFromBackgroundTab } from '../../src/components/management/bookmarks/archive-action-handler';

describe('captureFromBackgroundTab', () => {
  let originalBrowser: any;

  beforeEach(() => {
    originalBrowser = (globalThis as any).browser;
  });

  afterEach(() => {
    (globalThis as any).browser = originalBrowser;
    vi.restoreAllMocks();
  });

  it('returns null if browser.tabs is undefined', async () => {
    (globalThis as any).browser = undefined;
    const result = await captureFromBackgroundTab('https://example.com');
    expect(result).toBeNull();
  });

  it('creates an inactive tab (active: false), waits for complete, extracts HTML, and closes the tab', async () => {
    let updateListener: ((tabId: number, changeInfo: any) => void) | null = null;
    const mockCreate = vi.fn().mockResolvedValue({ id: 999 });
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    const mockAddListener = vi.fn((fn) => {
      updateListener = fn;
      setTimeout(() => {
        if (updateListener) updateListener(999, { status: 'complete' });
      }, 10);
    });
    const mockRemoveListener = vi.fn();
    const mockSendMessage = vi.fn().mockResolvedValue({
      html: '<html><body><h1>Rendered Live DOM</h1></body></html>',
      iframeSources: { 'https://example.com/frame': '<html><body>frame</body></html>' }
    });

    (globalThis as any).browser = {
      tabs: {
        create: mockCreate,
        remove: mockRemove,
        onUpdated: {
          addListener: mockAddListener,
          removeListener: mockRemoveListener
        },
        sendMessage: mockSendMessage
      }
    };

    const result = await captureFromBackgroundTab('https://example.com/post', 2000);

    expect(mockCreate).toHaveBeenCalledWith({ url: 'https://example.com/post', active: false });
    expect(mockSendMessage).toHaveBeenCalledWith(999, { type: 'EXTRACT_HTML' });
    expect(mockRemove).toHaveBeenCalledWith(999);
    expect(mockRemoveListener).toHaveBeenCalled();
    expect(result).toEqual({
      html: '<html><body><h1>Rendered Live DOM</h1></body></html>',
      iframeSources: { 'https://example.com/frame': '<html><body>frame</body></html>' }
    });
  });

  it('removes the tab and cleans up listener even if sendMessage fails', async () => {
    let updateListener: ((tabId: number, changeInfo: any) => void) | null = null;
    const mockCreate = vi.fn().mockResolvedValue({ id: 888 });
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    const mockAddListener = vi.fn((fn) => {
      updateListener = fn;
      setTimeout(() => {
        if (updateListener) updateListener(888, { status: 'complete' });
      }, 10);
    });
    const mockRemoveListener = vi.fn();
    const mockSendMessage = vi.fn().mockRejectedValue(new Error('Connection lost'));

    (globalThis as any).browser = {
      tabs: {
        create: mockCreate,
        remove: mockRemove,
        onUpdated: {
          addListener: mockAddListener,
          removeListener: mockRemoveListener
        },
        sendMessage: mockSendMessage
      }
    };

    const result = await captureFromBackgroundTab('https://example.com/broken', 2000);

    expect(result).toBeNull();
    expect(mockRemove).toHaveBeenCalledWith(888);
    expect(mockRemoveListener).toHaveBeenCalled();
  });

  it('times out and cleans up if status complete is never fired', async () => {
    const mockCreate = vi.fn().mockResolvedValue({ id: 777 });
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    const mockAddListener = vi.fn();
    const mockRemoveListener = vi.fn();
    const mockSendMessage = vi.fn().mockResolvedValue({ html: 'fallback html' });

    (globalThis as any).browser = {
      tabs: {
        create: mockCreate,
        remove: mockRemove,
        onUpdated: {
          addListener: mockAddListener,
          removeListener: mockRemoveListener
        },
        sendMessage: mockSendMessage
      }
    };

    const result = await captureFromBackgroundTab('https://example.com/hanging', 50);

    expect(result).toEqual({
      html: 'fallback html',
      iframeSources: {}
    });
    expect(mockRemove).toHaveBeenCalledWith(777);
  });
});
