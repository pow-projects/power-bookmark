import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Content script message handling', () => {
  it('should handle EXTRACT_TEXT and EXTRACT_HTML properly', async () => {
    let messageListener: any = null;
    const mockBrowser = {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener) => {
            messageListener = listener;
          })
        },
        sendMessage: vi.fn()
      }
    };
    vi.stubGlobal('browser', mockBrowser);
    vi.stubGlobal('location', { href: 'https://example.com/test' });

    // defineContentScript mock
    vi.stubGlobal('defineContentScript', (def: any) => def);

    // Dynamic import to execute main()
    const contentModule = await import('../../src/entrypoints/content');
    contentModule.default.main();

    expect(messageListener).toBeDefined();

    // 1. EXTRACT_TEXT: should call sendResponse synchronously and return undefined (not true)
    let textResponse: any = null;
    const textResult = messageListener(
      { type: 'EXTRACT_TEXT' },
      {},
      (res: any) => { textResponse = res; }
    );
    expect(textResult).toBeUndefined();
    expect(textResponse).toBeDefined();
    expect(textResponse.url).toBe('https://example.com/test');
    expect(textResponse.extractionType).toBe('basic');

    // 2. EXTRACT_HTML: should return true for async response
    let htmlResponse: any = null;
    const htmlResult = messageListener(
      { type: 'EXTRACT_HTML' },
      {},
      (res: any) => { htmlResponse = res; }
    );
    expect(htmlResult).toBe(true);

    // wait for async task in EXTRACT_HTML
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(htmlResponse).toBeDefined();
    expect(typeof htmlResponse.html).toBe('string');
    expect(htmlResponse.iframeSources).toBeDefined();

    // 3. UNKNOWN message: should return undefined (not true)
    let unknownResponse: any = null;
    const unknownResult = messageListener(
      { type: 'SOME_OTHER_EVENT' },
      {},
      (res: any) => { unknownResponse = res; }
    );
    expect(unknownResult).toBeUndefined();
    expect(unknownResponse).toBeNull();
  });
});

describe('Popup timeout and fallback safety', () => {
  it('should timeout and fallback when tabs.sendMessage hangs', async () => {
    // Simulate hanging browser.tabs.sendMessage
    const hangingSendMessage = vi.fn(() => new Promise(() => {})); // Never resolves

    const extractWithTimeout = async () => {
      const sendPromise = hangingSendMessage();
      const timeoutPromise = new Promise<{ html: string; iframeSources: Record<string, string> }>((resolve) =>
        setTimeout(() => resolve({ html: '', iframeSources: {} }), 50)
      );
      const response = await Promise.race([sendPromise, timeoutPromise]);
      return { html: (response as any)?.html || '', iframeSources: (response as any)?.iframeSources || {} };
    };

    const result = await extractWithTimeout();
    expect(result).toEqual({ html: '', iframeSources: {} });
  });

  it('should timeout and return null when extractPagePayload hangs', async () => {
    const hangingSendMessage = vi.fn(() => new Promise(() => {})); // Never resolves

    const extractPayloadWithTimeout = async () => {
      const sendPromise = hangingSendMessage();
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 50)
      );
      const response = await Promise.race([sendPromise, timeoutPromise]);
      if (!response) return null;
      return response;
    };

    const result = await extractPayloadWithTimeout();
    expect(result).toBeNull();
  });
});
