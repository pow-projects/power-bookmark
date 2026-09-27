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

  describe('requestBulkAi', () => {
    it('returns started: false when AI is not configured', async () => {
      const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
      vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(false);

      const { requestBulkAi } = await import('../../src/lib/ai/ai-batch-controller');
      const res = await requestBulkAi(new Set([1]), [], [], { autoSummarize: true });

      expect(res).toEqual({ started: false });
      expect(toastSpy).toHaveBeenCalledWith(i18n.t('ai.configFirst'), 'info');
    });

    it('returns started: false when all options are false', async () => {
      const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
      vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(true);

      const { requestBulkAi } = await import('../../src/lib/ai/ai-batch-controller');
      const res = await requestBulkAi(new Set([1]), [], [], { autoSummarize: false, autoTags: false, autoFolder: false });

      expect(res).toEqual({ started: false });
      expect(toastSpy).toHaveBeenCalledWith(i18n.t('ai.selectAtLeastOneOption'), 'info');
    });

    it('sends AI_BULK_PROCESS message for selected IDs with chosen options', async () => {
      const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
      vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(true);
      sendMessageMock.mockResolvedValueOnce({ ok: true });

      const { requestBulkAi } = await import('../../src/lib/ai/ai-batch-controller');
      const bookmarks = [
        { id: 1, title: 'B1', url: 'https://b1.com' },
        { id: 2, title: 'B2', url: 'https://b2.com' }
      ] as any[];
      const folders = [{ id: 'f1', title: 'F1', path: 'F1' }] as any[];
      const options = { autoSummarize: true, autoTags: true, autoFolder: true };

      const res = await requestBulkAi(new Set([1, 2]), bookmarks, folders, options);

      expect(res).toEqual({ started: true, total: 2 });
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: 'AI_BULK_PROCESS',
        bookmarkIds: [1, 2],
        options,
        folders
      });
      expect(toastSpy).toHaveBeenCalledWith(i18n.t('ai.bulkStarted', { count: 2 }), 'info');
    });

    it('filters to uncategorized bookmarks when only autoFolder is selected and selectedIds is empty', async () => {
      const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
      vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(true);
      sendMessageMock.mockResolvedValueOnce({ ok: true });

      const { requestBulkAi } = await import('../../src/lib/ai/ai-batch-controller');
      const bookmarks = [
        { id: 1, title: 'B1', url: 'https://b1.com', folderPath: '' },
        { id: 2, title: 'B2', url: 'https://b2.com', folderPath: '기타' },
        { id: 3, title: 'B3', url: 'https://b3.com', folderPath: 'Work/Projects' }
      ] as any[];

      const res = await requestBulkAi(new Set(), bookmarks, [], { autoFolder: true, autoSummarize: false, autoTags: false });

      expect(res).toEqual({ started: true, total: 2 });
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: 'AI_BULK_PROCESS',
        bookmarkIds: [1, 2],
        options: { autoFolder: true, autoSummarize: false, autoTags: false },
        folders: []
      });
    });

    it('targets all bookmarks when autoSummarize is true and selectedIds is empty', async () => {
      const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
      vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(true);
      sendMessageMock.mockResolvedValueOnce({ ok: true });

      const { requestBulkAi } = await import('../../src/lib/ai/ai-batch-controller');
      const bookmarks = [
        { id: 1, title: 'B1', url: 'https://b1.com', folderPath: 'A' },
        { id: 2, title: 'B2', url: 'https://b2.com', folderPath: 'B' }
      ] as any[];

      const res = await requestBulkAi(new Set(), bookmarks, [], { autoSummarize: true, autoTags: false, autoFolder: false });

      expect(res).toEqual({ started: true, total: 2 });
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: 'AI_BULK_PROCESS',
        bookmarkIds: [1, 2],
        options: { autoSummarize: true, autoTags: false, autoFolder: false },
        folders: []
      });
    });
  });
});
