import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cancelBulkAi, cancelSingleAi } from '../../src/lib/ai/ai-batch-controller';
import * as toastStore from '../../src/lib/ui/toast-store';

describe('ai-batch-controller.ts', () => {
  const sendMessageMock = vi.fn();
  let toastSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    toastSpy = vi.spyOn(toastStore, 'showToast').mockImplementation(() => {});
    vi.stubGlobal('browser', {
      runtime: {
        sendMessage: sendMessageMock
      }
    });
  });

  it('cancelBulkAi sends AI_ABORT_BULK and displays toast', async () => {
    sendMessageMock.mockResolvedValueOnce({ ok: true });

    await cancelBulkAi();

    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'AI_ABORT_BULK' });
    expect(toastSpy).toHaveBeenCalledWith(i18n.t('ai.analysisCancelled'), 'info');
  });

  it('cancelBulkAi handles runtime.sendMessage rejection gracefully', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendMessageMock.mockRejectedValueOnce(new Error('Extension context invalidated'));

    await cancelBulkAi();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('cancelSingleAi sends AI_ABORT_BOOKMARK and displays toast', () => {
    cancelSingleAi(42);

    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'AI_ABORT_BOOKMARK', bookmarkId: 42 });
    expect(toastSpy).toHaveBeenCalledWith(i18n.t('ai.analysisCancelled'), 'info');
  });

  it('requestBulkAiSummarize returns started: true and total count on success', async () => {
    const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
    vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(true);
    sendMessageMock.mockResolvedValueOnce({ ok: true });

    const { requestBulkAiSummarize } = await import('../../src/lib/ai/ai-batch-controller');
    const bookmarks = [
      { id: 1, title: 'Item 1', url: 'https://example.com/1' },
      { id: 2, title: 'Item 2', url: 'https://example.com/2' }
    ] as any[];

    const res = await requestBulkAiSummarize(new Set([1, 2]), bookmarks);

    expect(res).toEqual({ started: true, total: 2 });
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'AI_BULK_SUMMARIZE',
      bookmarkIds: [1, 2]
    });
    expect(toastSpy).toHaveBeenCalledWith(i18n.t('ai.bulkSummarizeStarted', { count: 2 }), 'info');
  });

  it('requestBulkAiSummarize returns started: false when AI is not configured', async () => {
    const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
    vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(false);

    const { requestBulkAiSummarize } = await import('../../src/lib/ai/ai-batch-controller');
    const res = await requestBulkAiSummarize(new Set(), []);

    expect(res).toEqual({ started: false });
    expect(toastSpy).toHaveBeenCalledWith(i18n.t('ai.configFirst'), 'info');
  });

  it('retrySingleAi blocks when isAiRunning is true', async () => {
    const { retrySingleAi } = await import('../../src/lib/ai/ai-batch-controller');
    const bookmark = { id: 10, title: 'Test', url: 'https://example.com' } as any;

    await retrySingleAi(bookmark, [], true);

    expect(toastSpy).toHaveBeenCalledWith(i18n.t('ai.bulkInProgress'), 'info');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
