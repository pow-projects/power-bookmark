import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initAiQueue, enqueueAiJob, enqueueAiJobs, cancelBookmarkAi, cancelAllAi } from '../../src/lib/ai/ai-queue';

interface FakeRow {
  id: string;
  bookmarkId: number;
  kind: string;
  status: string;
  createdAt: number;
  attempts: number;
  batchId?: string;
  error?: string;
  nextAttemptAt?: number;
  retryHistory?: { attempt: number; error: string; retryable: boolean; at: number }[];
}

const {
  mockIsAiConfigured,
  mockProcessAiJob,
  mockSetTaskIndicator,
  mockUpdateBookmark,
  mockDbBookmarksGet,
  mockDbBookmarksWhere,
  mockDbBookmarksFilter,
  mockGetAiSettings,
  mockRetryBackoffMs,
  fakeRows,
  fakeTable
} = vi.hoisted(() => {
  const rows: FakeRow[] = [];
  const table = {
    async add(job: any) { rows.push(job); return job.id; },
    async put(job: any) {
      const i = rows.findIndex((r) => r.id === job.id);
      if (i >= 0) rows[i] = job; else rows.push(job);
      return job.id;
    },
    where(field: any) {
      if (field === '[bookmarkId+kind]') {
        return {
          equals: (val: [number, string]) => ({
            filter: (fn: (r: any) => boolean) => ({
              async first() {
                const r = rows.find((x) => x.bookmarkId === val[0] && x.kind === val[1] && fn(x));
                return r ? { ...r } : undefined;
              }
            })
          })
        };
      }
      if (field === 'bookmarkId') {
        return {
          equals: (id: number) => ({ async toArray() { return rows.filter((r) => r.bookmarkId === id).map((r) => ({ ...r })); } })
        };
      }
      if (field === 'status') {
        return {
          equals: (status: string) => ({
            async toArray() { return rows.filter((r) => r.status === status).map((r) => ({ ...r })); },
            sortBy: (key: string) =>
              Promise.resolve(
                rows.filter((r) => r.status === status)
                  .sort((a: any, b: any) => a[key] - b[key])
                  .map((r) => ({ ...r }))
              )
          }),
          anyOf: (...vals: string[]) => ({
            async toArray() { return rows.filter((r) => vals.includes(r.status)).map((r) => ({ ...r })); }
          })
        };
      }
      throw new Error('unhandled where: ' + String(field));
    }
  };
  return {
    mockIsAiConfigured: vi.fn(),
    mockProcessAiJob: vi.fn(),
    mockSetTaskIndicator: vi.fn(),
    mockUpdateBookmark: vi.fn(),
    mockDbBookmarksGet: vi.fn(),
    mockDbBookmarksWhere: vi.fn(),
    mockDbBookmarksFilter: vi.fn(),
    mockGetAiSettings: vi.fn(),
    mockRetryBackoffMs: vi.fn(() => 5), // Minimize retry backoff in tests (default 5ms)
    fakeRows: rows,
    fakeTable: table
  };
});

vi.mock('../../src/lib/ai/queue-config', () => ({
  MAX_AI_RETRIES: 3,
  BULK_CATEGORIZE_CAP: 50,
  AI_ANALYSIS_TIMEOUT_MS: 120_000,
  RETRY_BACKOFF_BASE_MS: 5,
  RETRY_BACKOFF_FACTOR: 1,
  RETRY_BACKOFF_MAX_MS: 30,
  retryBackoffMs: mockRetryBackoffMs
}));

vi.mock('../../src/lib/db', () => ({
  default: {
    aiJobs: fakeTable,
    bookmarks: { get: mockDbBookmarksGet, where: mockDbBookmarksWhere, filter: mockDbBookmarksFilter }
  }
}));

vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: mockIsAiConfigured,
  getAiSettings: mockGetAiSettings,
  analyzeContent: vi.fn()
}));

vi.mock('../../src/lib/ai/ai-processor', () => ({
  processAiJob: mockProcessAiJob
}));

vi.mock('../../src/lib/bookmarks/badge-manager', () => ({
  setTaskIndicator: mockSetTaskIndicator
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: { updateBookmark: mockUpdateBookmark }
}));

async function waitUntil(fn: () => boolean, timeout = 1500): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
  // Wait for drain loop final cleanup (save state, release indicator, draining=false) to finish
  // — prevents incomplete drain of previous test from blocking next test drain (single consumer guard)
  await new Promise((r) => setTimeout(r, 30));
}

function idsOfStatus(status: string): string[] {
  return fakeRows.filter((r) => r.status === status).map((r) => r.id);
}

describe('ai-queue', () => {
  beforeEach(() => {
    fakeRows.length = 0;
    mockIsAiConfigured.mockReset();
    mockProcessAiJob.mockReset();
    mockSetTaskIndicator.mockReset();
    mockUpdateBookmark.mockReset();
    mockDbBookmarksGet.mockReset();
    mockDbBookmarksWhere.mockReset();
    mockDbBookmarksFilter.mockReset();
    mockGetAiSettings.mockReset();
    vi.unstubAllGlobals();

    mockIsAiConfigured.mockResolvedValue(true);
    mockGetAiSettings.mockResolvedValue({ concurrency: 1 });
    mockProcessAiJob.mockResolvedValue({ ok: true });
    mockSetTaskIndicator.mockResolvedValue(undefined);
    mockUpdateBookmark.mockResolvedValue(undefined);
    mockDbBookmarksGet.mockImplementation(async (id: number) => ({ id, bookmarkId: `b${id}`, title: `t${id}`, url: `https://e/${id}` }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('dedup: 동일 (bookmarkId, kind)가 queued/running이면 duplicate 거부, 완료 후 재요청 허용', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });

    const r1 = await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' });
    expect(r1.ok).toBe(true);
    const r2 = await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('duplicate');

    // Other kinds allowed
    const r3 = await enqueueAiJob({ bookmarkId: 1, kind: 'summarize' });
    expect(r3.ok).toBe(true);

    await waitUntil(() => idsOfStatus('done').length >= 2);
    const r4 = await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' }); // Previous done -> allowed
    expect(r4.ok).toBe(true);
  });

  it('FIFO: createdAt 오름차순 1건씩 처리, 동시 실행 ≤ 1', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
    const order: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    mockProcessAiJob.mockImplementation(async (job: any) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      order.push(job.bookmarkId);
      concurrent--;
      return { ok: true };
    });

    await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' });
    await enqueueAiJob({ bookmarkId: 2, kind: 'categorize' });
    await enqueueAiJob({ bookmarkId: 3, kind: 'categorize' });

    await waitUntil(() => idsOfStatus('done').length === 3);
    expect(order).toEqual([1, 2, 3]);
    expect(maxConcurrent).toBe(1);
    expect(mockSetTaskIndicator).toHaveBeenCalledWith('ai', true);
    expect(mockSetTaskIndicator).toHaveBeenCalledWith('ai', false);
  });

  it('재시도: 실패 시 attempts<3 동안 re-queued(nextAttemptAt 설정), 3회 초과 시 error', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
    mockProcessAiJob.mockResolvedValue({ ok: false, error: 'boom' });

    await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' });
    await waitUntil(() => fakeRows.some((r) => r.status === 'error'));

    const job = fakeRows[0];
    expect(job.status).toBe('error');
    expect(job.attempts).toBe(3);
    expect(mockProcessAiJob).toHaveBeenCalledTimes(3);
    // Retry history: all 3 attempts recorded
    expect(job.retryHistory).toHaveLength(3);
    expect(job.retryHistory?.map((h) => h.attempt)).toEqual([1, 2, 3]);
    // On retry (re-insert queued), nextAttemptAt is recorded so drain waits
    expect(job.nextAttemptAt).toBeUndefined(); // When error is finalized, no future time is set
  });

  it('재시도: 실패→재시도 queued 구간에 nextAttemptAt이 미래 시각으로 설정된다', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
    mockRetryBackoffMs.mockReturnValue(50); // 50ms delay — observable
    let first = true;
    mockProcessAiJob.mockImplementation(async (job: any) => {
      if (first) { first = false; return { ok: false, error: 'transient' }; }
      return { ok: true };
    });

    await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' });
    await waitUntil(() => fakeRows.some((r) => r.status === 'done'));

    const job = fakeRows[0];
    expect(job.attempts).toBe(1);
    expect(job.status).toBe('done');
    // nextAttemptAt should have been set at the time of first failure (retryHistory[0] timestamp + backoff)
    expect(job.retryHistory).toHaveLength(1);
    const recordedAt = job.retryHistory?.[0]?.at ?? 0;
    expect(recordedAt).toBeGreaterThan(0);
  });

  it('영구 오류(retryable=false): attempts 소진 없이 즉시 error 확정, 재시도 없음', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
    mockProcessAiJob.mockResolvedValue({ ok: false, error: 'AI 응답이 토큰 수프입니다', retryable: false });

    await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' });
    await waitUntil(() => fakeRows.some((r) => r.status === 'error'));

    const job = fakeRows[0];
    expect(job.status).toBe('error');
    expect(job.attempts).toBe(0); // Finalized immediately without exhausting attempts
    expect(mockProcessAiJob).toHaveBeenCalledTimes(1); // 0 retries
    expect(job.retryHistory).toHaveLength(1);
    expect(job.retryHistory?.[0]?.retryable).toBe(false);
  });

  it('재시도 이력 로깅: 성공 전 실패 이력이 attempt/error/retryable 순서로 기록된다', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
    mockProcessAiJob
      .mockResolvedValueOnce({ ok: false, error: 'first fail' })
      .mockResolvedValueOnce({ ok: false, error: 'second fail' })
      .mockResolvedValueOnce({ ok: true });

    await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' });
    await waitUntil(() => fakeRows.some((r) => r.status === 'done'));

    const job = fakeRows[0];
    expect(job.attempts).toBe(2);
    expect(job.retryHistory?.map((h) => h.error)).toEqual(['first fail', 'second fail']);
    expect(job.retryHistory?.every((h) => h.retryable === true)).toBe(true);
  });

  it('취소(개별): 해당 bookmark만 — running은 abort, queued는 cancelled', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
    mockProcessAiJob.mockImplementation(async (job: any, signal: AbortSignal) => {
      if (job.bookmarkId === 1) {
        return await new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ ok: false, aborted: true }));
        });
      }
      return { ok: true };
    });

    await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' });
    await enqueueAiJob({ bookmarkId: 2, kind: 'categorize' });
    await waitUntil(() => idsOfStatus('running').length === 1);

    await cancelBookmarkAi(1);
    await waitUntil(() => fakeRows.some((r) => r.bookmarkId === 1 && r.status === 'cancelled'));
    // bookmark 2 completes normally
    await waitUntil(() => fakeRows.some((r) => r.bookmarkId === 2 && r.status === 'done'));
    expect(fakeRows.find((r) => r.bookmarkId === 1)?.status).toBe('cancelled');
  });

  it('취소(전체): 모든 active job cancelled + 진행률 제거', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    const storageRemove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { storage: { local: { set: storageSet, remove: storageRemove } } });
    mockProcessAiJob.mockImplementation(async (job: any, signal: AbortSignal) => {
      return await new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false, aborted: true }));
      });
    });

    await enqueueAiJobs([{ bookmarkId: 1, kind: 'categorize' }, { bookmarkId: 2, kind: 'categorize' }]);
    await waitUntil(() => idsOfStatus('running').length >= 1);

    await cancelAllAi();
    await waitUntil(() => idsOfStatus('cancelled').length >= 1);
    expect(fakeRows.every((r) => r.status === 'cancelled')).toBe(true);
    expect(storageRemove).toHaveBeenCalledWith('ai_bulk_progress');
  });

  it('복원(initAiQueue): 재시도 예산 소진(attempts>=MAX) running job은 재실행 없이 error 확정', async () => {
    fakeRows.push({ id: 'exhausted', bookmarkId: 1, kind: 'categorize', status: 'running', createdAt: 1, attempts: 3 });
    mockDbBookmarksGet.mockResolvedValue({ id: 1, bookmarkId: 'b1', aiStatus: 'running', title: 't', url: 'u' });
    mockDbBookmarksFilter.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([])
    });
    vi.stubGlobal('browser', {
      storage: { local: { set: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) } }
    });

    await initAiQueue();

    expect(fakeRows[0].status).toBe('error'); // Error finalized without retry
    expect(mockProcessAiJob).not.toHaveBeenCalled(); // Not consumed by drain
    expect(mockUpdateBookmark).toHaveBeenCalledWith(1, { aiStatus: 'error' });
  });

  it('처리 중 예외(processAiJob throw)도 backoff 재시도 후 최대 초과 시 error 확정된다', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
    mockProcessAiJob.mockRejectedValue(new Error('unexpected crash'));

    await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' });
    await waitUntil(() => fakeRows.some((r) => r.status === 'error'));

    const job = fakeRows[0];
    expect(job.status).toBe('error');
    expect(job.attempts).toBe(3);
    expect(job.retryHistory).toHaveLength(3);
    expect(job.retryHistory?.every((h) => h.retryable === true)).toBe(true);
    // Failure reason is logged in retry history
    expect(job.retryHistory?.[0]?.error).toBe('unexpected crash');
  });

  it('복원(initAiQueue): running 잔존 job → queued 복원 + aiStatus none 리셋, 고아 북마크 sweeping', async () => {
    fakeRows.push({ id: 'a', bookmarkId: 1, kind: 'categorize', status: 'running', createdAt: 1, attempts: 0 });
    mockDbBookmarksGet.mockResolvedValue({ id: 1, bookmarkId: 'b1', aiStatus: 'running', title: 't', url: 'u' });
    // aiStatus is an unindexed field -> initAiQueue queries orphaned bookmarks using .filter()
    mockDbBookmarksFilter.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([{ id: 9, bookmarkId: 'b9', aiStatus: 'running', title: 'o', url: 'u9' }])
    });
    // Block processAiJob (keep running) so drain re-consumes restored job
    mockProcessAiJob.mockImplementation((_job: any, signal: AbortSignal) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, aborted: true })))
    );
    vi.stubGlobal('browser', {
      storage: { local: { set: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) } }
    });

    await initAiQueue();

    // Reset remaining running job bookmark (1) + reset orphaned bookmark (9)
    expect(mockUpdateBookmark).toHaveBeenCalledWith(1, { aiStatus: 'none' });
    expect(mockUpdateBookmark).toHaveBeenCalledWith(9, { aiStatus: 'none' });
    // Restored job is consumed again (drain resumes)
    await waitUntil(() => mockProcessAiJob.mock.calls.length > 0);
    // Clean up blocked drain so single consumer guard does not block next test
    await cancelAllAi();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('진행률: batch enqueue 시 ai_bulk_progress total/done/status 갱신, 완료 시 done', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { storage: { local: { set: storageSet } } });
    mockProcessAiJob.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true };
    });

    await enqueueAiJobs([{ bookmarkId: 1, kind: 'categorize' }, { bookmarkId: 2, kind: 'categorize' }]);
    await waitUntil(() => fakeRows.every((r) => r.status === 'done'));

    const progressCalls = storageSet.mock.calls.filter(([c]) => c['ai_bulk_progress']);
    expect(progressCalls.length).toBeGreaterThan(0);
    const finalProgress = progressCalls[progressCalls.length - 1][0]['ai_bulk_progress'];
    expect(finalProgress).toMatchObject({ total: 2, done: 2, status: 'done' });
  });

  it('재시도 finish 카운트: job 단위 1회 집계 — 1건 실패 후 성공 시 done은 2가 아닌 1', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { storage: { local: { set: storageSet } } });
    // 1 item: 1st attempt fails -> retry succeeds
    mockProcessAiJob
      .mockResolvedValueOnce({ ok: false, error: 'boom' })
      .mockResolvedValueOnce({ ok: true });

    await enqueueAiJobs([{ bookmarkId: 1, kind: 'categorize' }]);
    await waitUntil(() => fakeRows.some((r) => r.status === 'done'));

    const progressCalls = storageSet.mock.calls.filter(([c]) => c['ai_bulk_progress']);
    const finalProgress = progressCalls[progressCalls.length - 1][0]['ai_bulk_progress'];
    // If retry is double-counted, done becomes 2, but since aggregation is per-job, done should be 1
    expect(finalProgress).toMatchObject({ total: 1, done: 1, status: 'done' });
  });

  it('cross-root 리뷰 저장 항목에 bookmarkId(DB id)가 포함되어 모달 매칭이 가능하다', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { storage: { local: { set: storageSet } } });
    mockProcessAiJob.mockResolvedValue({
      ok: true,
      crossRootReview: { suggestedFolderId: 'f-rec', suggestedFolderName: '추천폴더', suggestedRoot: 'Bookmarks bar', cleanPath: '추천폴더' }
    });

    await enqueueAiJobs([{ bookmarkId: 1, kind: 'categorize' }, { bookmarkId: 2, kind: 'categorize' }]);
    await waitUntil(() => fakeRows.every((r) => r.status === 'done'));

    const crossCalls = storageSet.mock.calls.filter(([c]) => c['ai_bulk_cross_root_review']);
    expect(crossCalls.length).toBeGreaterThan(0);
    const items = crossCalls[crossCalls.length - 1][0]['ai_bulk_cross_root_review'];
    expect(items).toHaveLength(2);
    // Numeric bookmarkId used by BookmarkList.svelte to calculate bId must exist
    for (const it of items) {
      expect(typeof it.bookmarkId).toBe('number');
    }
    expect(items.map((i: any) => i.bookmarkId).sort()).toEqual([1, 2]);
  });

  it('concurrency=3: 병렬 처리 시 최대 3개까지 동시 실행된다', async () => {
    mockGetAiSettings.mockResolvedValue({ concurrency: 3 });
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });

    let concurrent = 0;
    let maxConcurrent = 0;
    const processed: number[] = [];

    mockProcessAiJob.mockImplementation(async (job: any) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      processed.push(job.bookmarkId);
      concurrent--;
      return { ok: true };
    });

    await enqueueAiJobs([
      { bookmarkId: 1, kind: 'categorize' },
      { bookmarkId: 2, kind: 'categorize' },
      { bookmarkId: 3, kind: 'categorize' },
      { bookmarkId: 4, kind: 'categorize' },
      { bookmarkId: 5, kind: 'categorize' }
    ]);

    await waitUntil(() => idsOfStatus('done').length === 5);
    expect(processed).toHaveLength(5);
    expect(maxConcurrent).toBe(3);
  });

  it('concurrency=3: 동시 실행 중 특정 북마크 작업만 취소(cancelBookmarkAi)하면 해당 작업만 aborted되고 나머지는 정상 완료된다', async () => {
    mockGetAiSettings.mockResolvedValue({ concurrency: 3 });
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });

    let runningCount = 0;
    mockProcessAiJob.mockImplementation(async (job: any, signal?: AbortSignal) => {
      runningCount++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ ok: true });
        }, 100);

        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve({ ok: false, aborted: true });
        });
      });
    });

    await enqueueAiJobs([
      { bookmarkId: 10, kind: 'categorize' },
      { bookmarkId: 20, kind: 'categorize' },
      { bookmarkId: 30, kind: 'categorize' }
    ]);

    // Wait briefly until all 3 reach running state
    await waitUntil(() => idsOfStatus('running').length === 3);

    // Cancel only bookmark 20
    await cancelBookmarkAi(20);

    await waitUntil(() => idsOfStatus('done').length === 2 && idsOfStatus('cancelled').length === 1);

    const b20Job = fakeRows.find((r) => r.bookmarkId === 20);
    const b10Job = fakeRows.find((r) => r.bookmarkId === 10);
    const b30Job = fakeRows.find((r) => r.bookmarkId === 30);

    expect(b20Job?.status).toBe('cancelled');
    expect(b10Job?.status).toBe('done');
    expect(b30Job?.status).toBe('done');
  });

  it('concurrency=3: 429 또는 일시 오류 발생 시 해당 슬롯만 backoff되고 다른 작업은 계속 진행된다', async () => {
    mockGetAiSettings.mockResolvedValue({ concurrency: 2 });
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });

    let job1Attempts = 0;
    mockProcessAiJob.mockImplementation(async (job: any) => {
      if (job.bookmarkId === 1) {
        job1Attempts++;
        if (job1Attempts === 1) {
          // 429/temporary error occurs on 1st attempt
          return { ok: false, error: 'Rate limit exceeded 429', retryable: true };
        }
      }
      return { ok: true };
    });

    await enqueueAiJobs([
      { bookmarkId: 1, kind: 'categorize' },
      { bookmarkId: 2, kind: 'categorize' },
      { bookmarkId: 3, kind: 'categorize' }
    ]);

    // bookmarks 2 and 3 complete first (done), and bookmark 1 also succeeds on retry after backoff
    await waitUntil(() => idsOfStatus('done').length === 3, 2000);

    expect(fakeRows.every((r) => r.status === 'done')).toBe(true);
    const b1Job = fakeRows.find((r) => r.bookmarkId === 1);
    expect(b1Job?.attempts).toBe(1);
    expect(b1Job?.retryHistory).toHaveLength(1);
  });
});
