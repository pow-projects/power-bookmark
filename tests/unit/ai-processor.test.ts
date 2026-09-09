import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processAiJob } from '../../src/lib/ai/ai-processor';
import type { AiJob } from '../../src/lib/ai/queue-types';
import type { ExtractedPagePayload, FolderInfo, AiAnalysisResult } from '../../src/lib/ai/types';

const {
  mockIsAiConfigured,
  mockAnalyzeContent,
  mockUpdateBookmark,
  mockGetFolders,
  mockEnsureFolderPath,
  mockResolveSuggestedFolderWithRoot,
  mockDbBookmarksGet,
  mockBuildPagePayload,
  mockStorageSet
} = vi.hoisted(() => ({
  mockIsAiConfigured: vi.fn(),
  mockAnalyzeContent: vi.fn(),
  mockUpdateBookmark: vi.fn(),
  mockGetFolders: vi.fn(),
  mockEnsureFolderPath: vi.fn(),
  mockResolveSuggestedFolderWithRoot: vi.fn(),
  mockDbBookmarksGet: vi.fn(),
  mockBuildPagePayload: vi.fn(),
  mockStorageSet: vi.fn()
}));

vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: mockIsAiConfigured,
  analyzeContent: mockAnalyzeContent
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    updateBookmark: mockUpdateBookmark,
    getFolders: mockGetFolders,
    ensureFolderPath: mockEnsureFolderPath
  },
  resolveSuggestedFolder: vi.fn(),
  resolveSuggestedFolderWithRoot: mockResolveSuggestedFolderWithRoot
}));

vi.mock('../../src/lib/db', () => ({
  default: { bookmarks: { get: mockDbBookmarksGet } }
}));

vi.mock('../../src/lib/ai/ai-bulk-analyzer', () => ({
  buildPagePayload: mockBuildPagePayload
}));

const samplePayload: ExtractedPagePayload = {
  url: 'https://example.com/article',
  title: '예시 아티클',
  textContent: '분석할 본문 텍스트입니다.'
};

const sampleFolders: FolderInfo[] = [{ id: 'folder-1', title: '개발자료', path: '개발자료' }];

const sampleResult: AiAnalysisResult = {
  summary: '간결한 요약',
  category: '개발',
  suggestedFolderId: null,
  suggestedFolderName: '기타',
  isNewFolderRecommended: false,
  tags: ['TypeScript'],
  confidence: 0.95
};

const PLACEHOLDER = '요약할 본문 텍스트가 없습니다.';

function makeJob(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: 'job-1',
    bookmarkId: 42,
    kind: 'auto',
    status: 'queued',
    attempts: 0,
    createdAt: 1,
    ...overrides
  };
}

describe('ai-processor processAiJob', () => {
  beforeEach(() => {
    mockIsAiConfigured.mockReset();
    mockAnalyzeContent.mockReset();
    mockUpdateBookmark.mockReset();
    mockGetFolders.mockReset();
    mockEnsureFolderPath.mockReset();
    mockResolveSuggestedFolderWithRoot.mockReset();
    mockDbBookmarksGet.mockReset();
    mockBuildPagePayload.mockReset();
    mockStorageSet.mockReset();

    mockIsAiConfigured.mockResolvedValue(true);
    mockAnalyzeContent.mockResolvedValue(sampleResult);
    mockUpdateBookmark.mockResolvedValue(undefined);
    mockGetFolders.mockResolvedValue(sampleFolders);
    mockEnsureFolderPath.mockResolvedValue(null);
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'create-new',
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '기타'
    });
    mockDbBookmarksGet.mockResolvedValue({
      id: 42, bookmarkId: 'browser-42', title: '예시 아티클', url: 'https://example.com/article',
      folderPath: '', description: ''
    });
    mockBuildPagePayload.mockResolvedValue(samplePayload);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('auto: running → 커밋(요약/태그/폴더) → done 전이', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });

    const outcome = await processAiJob(makeJob({ kind: 'auto', payload: samplePayload, folders: sampleFolders }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(mockUpdateBookmark).toHaveBeenNthCalledWith(1, 42, { aiStatus: 'running' });
    // create-new + folderCandidate 'Other' -> ensureFolderPath (not created) -> folderPath not committed
    const commit = mockUpdateBookmark.mock.calls.map(([, d]) => d).find((d) => !d.aiStatus);
    expect(commit).toEqual({ description: '간결한 요약', tags: ['TypeScript'] });
    expect(mockUpdateBookmark).toHaveBeenLastCalledWith(42, { aiStatus: 'done' });
    expect(mockStorageSet).toHaveBeenCalledWith({ 'ai_analysis_last_update': expect.any(Number) });
  });

  it('auto: autoSummarize=false면 description 미커밋, autoTags=false면 tags 미커밋, autoFolder=false면 폴더 미접촉', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });

    const outcome = await processAiJob(makeJob({
      kind: 'auto', payload: samplePayload, folders: sampleFolders,
      options: { autoSummarize: false, autoTags: false, autoFolder: false }
    }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(mockResolveSuggestedFolderWithRoot).not.toHaveBeenCalled();
    const commits = mockUpdateBookmark.mock.calls.map(([, d]) => d).filter((d) => !d.aiStatus);
    expect(commits).toEqual([]); // No updateBookmark call since there are no fields to commit
  });

  it('auto: 본문 부족(placeholder)이면 요약·폴더 저장을 건너뛴다 (tags만 커밋)', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });
    mockAnalyzeContent.mockResolvedValue({ ...sampleResult, summary: PLACEHOLDER });

    const outcome = await processAiJob(makeJob({ kind: 'auto', payload: samplePayload, folders: sampleFolders }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(mockResolveSuggestedFolderWithRoot).not.toHaveBeenCalled();
    const commit = mockUpdateBookmark.mock.calls.map(([, d]) => d).find((d) => !d.aiStatus);
    expect(commit).toEqual({ tags: ['TypeScript'] });
  });

  it('payload 부족 시 buildPagePayload 폴백 호출', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });

    await processAiJob(makeJob({ kind: 'auto', folders: sampleFolders }), new AbortController().signal);

    expect(mockBuildPagePayload).toHaveBeenCalledTimes(1);
  });

  it('categorize: tags+folderPath 커밋, description 미접촉, cross-root면 outcome.crossRootReview 반환', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet } },
      bookmarks: { move: vi.fn().mockResolvedValue(undefined) }
    });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'cross-root',
      targetFolder: { id: 'folder-other', path: 'Other bookmarks/기타자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Other bookmarks',
      cleanPath: '기타자료',
      crossRoot: true
    });

    const outcome = await processAiJob(makeJob({ kind: 'categorize' }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(outcome.crossRootReview).toEqual({
      suggestedFolderId: 'folder-other',
      suggestedFolderName: '기타',
      suggestedRoot: 'Other bookmarks',
      cleanPath: '기타자료'
    });
    const commit = mockUpdateBookmark.mock.calls.map(([, d]) => d).find((d) => !d.aiStatus);
    expect(commit).toHaveProperty('tags');
    expect(commit).toHaveProperty('crossRootReview');
    expect(commit).not.toHaveProperty('description');
  });

  it('categorize: same-root면 folderPath 커밋', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet } },
      bookmarks: { move: vi.fn().mockResolvedValue(undefined) }
    });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'same-root',
      targetFolder: { id: 'folder-1', path: '개발자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '개발자료'
    });

    const outcome = await processAiJob(makeJob({ kind: 'categorize' }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    const commit = mockUpdateBookmark.mock.calls.map(([, d]) => d).find((d) => !d.aiStatus);
    expect(commit).toEqual({ tags: ['TypeScript'], folderPath: '개발자료' });
    expect(commit).not.toHaveProperty('description');
  });

  it('categorize: result.tags가 없을 때 기존 bookmark.tags가 절대 삭제되지 않고 보존된다', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet } },
      bookmarks: { move: vi.fn().mockResolvedValue(undefined) }
    });
    mockDbBookmarksGet.mockResolvedValue({
      id: 42, bookmarkId: 'browser-42', title: '예시 아티클', url: 'https://example.com/article',
      folderPath: '', description: '', tags: ['ExistingTag1', 'ExistingTag2']
    });
    mockAnalyzeContent.mockResolvedValue({
      summary: '',
      category: '개발',
      suggestedFolderId: 'folder-1',
      suggestedFolderName: '개발자료',
      isNewFolderRecommended: false
    });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'same-root',
      targetFolder: { id: 'folder-1', path: '개발자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '개발자료'
    });

    const outcome = await processAiJob(makeJob({ kind: 'categorize' }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    const commit = mockUpdateBookmark.mock.calls.map(([, d]) => d).find((d) => !d.aiStatus);
    expect(commit).not.toHaveProperty('tags');
    expect(commit).toEqual({ folderPath: '개발자료' });
  });

  it('categorize: AI가 새 태그를 생성하면 기존 태그를 새 AI 태그로 갱신한다', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet } },
      bookmarks: { move: vi.fn().mockResolvedValue(undefined) }
    });
    mockDbBookmarksGet.mockResolvedValue({
      id: 42, bookmarkId: 'browser-42', title: '예시 아티클', url: 'https://example.com/article',
      folderPath: '', description: '', tags: ['OldTag1', 'OldTag2']
    });
    mockAnalyzeContent.mockResolvedValue({
      summary: '',
      category: '개발',
      suggestedFolderId: 'folder-1',
      suggestedFolderName: '개발자료',
      isNewFolderRecommended: false,
      tags: ['AI-Tag1', 'AI-Tag2']
    });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'same-root',
      targetFolder: { id: 'folder-1', path: '개발자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '개발자료'
    });

    const outcome = await processAiJob(makeJob({ kind: 'categorize' }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    const commit = mockUpdateBookmark.mock.calls.map(([, d]) => d).find((d) => !d.aiStatus);
    expect(commit).toEqual({ tags: ['AI-Tag1', 'AI-Tag2'], folderPath: '개발자료' });
  });

  it('summarize: description만 커밋 (태그/폴더 불변)', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });

    const outcome = await processAiJob(makeJob({ kind: 'summarize' }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(outcome.skipped).toBeFalsy();
    expect(mockResolveSuggestedFolderWithRoot).not.toHaveBeenCalled();
    const commit = mockUpdateBookmark.mock.calls.map(([, d]) => d).find((d) => !d.aiStatus);
    expect(commit).toEqual({ description: '간결한 요약' });
  });

  it('summarize: 본문 부족(placeholder)이면 skipped=true + aiStatus done', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });
    mockAnalyzeContent.mockResolvedValue({ ...sampleResult, summary: PLACEHOLDER });

    const outcome = await processAiJob(makeJob({ kind: 'summarize' }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(outcome.skipped).toBe(true);
    // description not committed, transition to done executed
    expect(mockUpdateBookmark).toHaveBeenLastCalledWith(42, { aiStatus: 'done' });
  });

  it('abort: {aborted:true} + aiStatus none + 페이지 갱신 (오류 토스트 없음)', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });
    const controller = new AbortController();
    mockAnalyzeContent.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    const outcome = await processAiJob(makeJob({ kind: 'auto', payload: samplePayload, folders: sampleFolders }), controller.signal);

    expect(outcome.aborted).toBe(true);
    expect(mockUpdateBookmark.mock.calls.some(([, d]) => d.aiStatus === 'none')).toBe(true);
    expect(mockUpdateBookmark.mock.calls.some(([, d]) => d.aiStatus === 'error')).toBe(false);
    expect(mockStorageSet.mock.calls.some(([c]) => c['ai_analysis_error'])).toBe(false);
  });

  it('일반 실패: {ok:false,error} + aiStatus error + ai_analysis_error 알림', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });
    mockAnalyzeContent.mockRejectedValue(new Error('provider error'));

    const outcome = await processAiJob(makeJob({ kind: 'auto', payload: samplePayload, folders: sampleFolders }), new AbortController().signal);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('provider error');
    expect(mockUpdateBookmark.mock.calls.some(([, d]) => d.aiStatus === 'error')).toBe(true);
    expect(mockStorageSet).toHaveBeenCalledWith({ 'ai_analysis_error': expect.any(Object) });
  });

  it('AI 미설정이면 skip: {ok:true} + 알림 없음', async () => {
    mockIsAiConfigured.mockResolvedValue(false);

    const outcome = await processAiJob(makeJob({ kind: 'auto' }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(mockAnalyzeContent).not.toHaveBeenCalled();
    expect(mockUpdateBookmark).not.toHaveBeenCalled();
    expect(mockStorageSet).not.toHaveBeenCalled();
  });

  it('삭제된 북마크면 skip: {ok:true}', async () => {
    mockDbBookmarksGet.mockResolvedValue(undefined);

    const outcome = await processAiJob(makeJob({ kind: 'auto' }), new AbortController().signal);

    expect(outcome.ok).toBe(true);
    expect(mockAnalyzeContent).not.toHaveBeenCalled();
    expect(mockUpdateBookmark).not.toHaveBeenCalled();
  });
});
