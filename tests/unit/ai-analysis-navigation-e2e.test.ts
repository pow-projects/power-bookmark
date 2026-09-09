import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enqueueAiJobs, enqueueAiJob } from '../../src/lib/ai/ai-queue';

/**
 * AI analysis navigation bug E2E integration test (t_2298f73f)
 *
 * Scenario (Bug report t_bd212531):
 *   1) When registering a bookmark, start AI auto-analysis -> popup enqueues auto job (AI_ANALYZE_BOOKMARK)
 *   2) Navigate to bookmark management page               -> auto job remains in queue even when popup closes
 *   3) Apply AI categorization to another bookmark         -> management page enqueues categorize job (AI_BULK_CATEGORIZE)
 *   4) Verify that original AI analysis ends in (a) successful completion or (b) failure after max retries
 *
 * In a situation where both entry points (auto/categorize) share a single FIFO queue,
 * verifies that even if popup (auto-analysis) is interrupted by bulk categorization from the management page,
 * the original auto analysis does not fall into infinite retries and always concludes with a terminal state (done | error).
 * Includes both success and failure cases.
 *
 * Retry logic (t_a795d6d5): Permanent errors (retryable=false) immediately become error without exhausting attempts,
 * transient errors use exponential backoff up to MAX_AI_RETRIES(3) before settling as error (dead-letter).
 */
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
    mockRetryBackoffMs: vi.fn(() => 5),
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
    bookmarks: { get: mockDbBookmarksGet, where: mockDbBookmarksWhere }
  }
}));

vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: mockIsAiConfigured,
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

async function waitUntil(fn: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 30));
}

function rowOf(bookmarkId: number): FakeRow | undefined {
  return fakeRows.find((r) => r.bookmarkId === bookmarkId && r.kind === 'auto');
}

/** Simulates enqueue operations of scenario 1 (bookmark registration -> auto analysis) and scenario 3 (batch categorize other bookmark from management page) */
async function runNavigationScenario() {
  // 1) Bookmark registration -> popup enqueues auto analysis (AI_ANALYZE_BOOKMARK)
  const auto = await enqueueAiJob({
    bookmarkId: 1,
    kind: 'auto',
    payload: { title: 'a', url: 'https://a', textContent: '본문' },
    folders: [],
    options: { autoSummarize: true, autoTags: true, autoFolder: true }
  });
  expect(auto.ok).toBe(true);

  // 2) Navigate to bookmark management page (popup closed - auto job retained in queue, no special action needed)

  // 3) Apply batch categorization to another bookmark from management page (AI_BULK_CATEGORIZE)
  const bulk = await enqueueAiJobs([{ bookmarkId: 2, kind: 'categorize' }]);
  expect(bulk[0].ok).toBe(true);
}

describe('AI analysis navigation bug E2E integration test (t_2298f73f)', () => {
  beforeEach(() => {
    fakeRows.length = 0;
    mockIsAiConfigured.mockReset();
    mockProcessAiJob.mockReset();
    mockSetTaskIndicator.mockReset();
    mockUpdateBookmark.mockReset();
    mockDbBookmarksGet.mockReset();
    mockDbBookmarksWhere.mockReset();
    mockRetryBackoffMs.mockReset();
    vi.unstubAllGlobals();

    mockIsAiConfigured.mockResolvedValue(true);
    mockSetTaskIndicator.mockResolvedValue(undefined);
    mockUpdateBookmark.mockResolvedValue(undefined);
    mockRetryBackoffMs.mockReturnValue(5);
    mockDbBookmarksGet.mockImplementation(async (id: number) => ({ id, bookmarkId: `b${id}`, title: `t${id}`, url: `https://e/${id}` }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('성공 케이스: 자동 분석 진행 중 다른 북마크 분류를 적용해도 원본 auto 분석이 정상 완료(done)된다', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { storage: { local: { set: storageSet } } });
    const order: string[] = [];
    mockProcessAiJob.mockImplementation(async (job: any) => {
      order.push(`${job.kind}:${job.bookmarkId}`);
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true };
    });

    await runNavigationScenario();

    // 4) Original auto analysis (bookmark 1) completes normally (done) & categorize (bookmark 2) also completes
    await waitUntil(() => fakeRows.every((r) => r.status === 'done'));
    expect(rowOf(1)?.status).toBe('done');
    expect(rowOf(1)?.error).toBeUndefined();
    // Both are finally done — no incomplete or infinite state
    expect(fakeRows.length).toBe(2);
    expect(fakeRows.every((r) => r.status === 'done')).toBe(true);
    // auto runs exactly once (succeeds without retries), categorize also once
    expect(mockProcessAiJob.mock.calls.filter(([j]) => j.bookmarkId === 1 && j.kind === 'auto')).toHaveLength(1);
    // Both entry points are processed sequentially FIFO in the same queue
    expect(order).toEqual(['auto:1', 'categorize:2']);
  });

  it('실패 케이스(일시 오류): 원본 auto 분석이 최대 재시도 초과 후 error로 종료된다 — 무한 재시도 금지', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { storage: { local: { set: storageSet } } });
    // Only original auto (bookmark 1) encounters continuous transient error -> categorize (bookmark 2) succeeds
    mockProcessAiJob.mockImplementation(async (job: any) => {
      await new Promise((r) => setTimeout(r, 5));
      if (job.kind === 'auto') return { ok: false, error: 'transient network', retryable: true };
      return { ok: true };
    });

    await runNavigationScenario();

    // 4) Original auto analysis finishes with error after exceeding max retries (3)
    await waitUntil(() => rowOf(1)?.status === 'error');
    const auto = rowOf(1)!;
    expect(auto.status).toBe('error');
    expect(auto.attempts).toBe(3); // Attempt only up to MAX_AI_RETRIES
    // Prevent infinite loop: auto executed exactly 3 times
    expect(mockProcessAiJob.mock.calls.filter(([j]) => j.bookmarkId === 1 && j.kind === 'auto')).toHaveLength(3);
    // 3 retry history items recorded
    expect(auto.retryHistory).toHaveLength(3);
    // Remains in error state -> no repeated execution since no re-enqueue occurs
    await new Promise((r) => setTimeout(r, 80));
    expect(mockProcessAiJob.mock.calls.filter(([j]) => j.bookmarkId === 1 && j.kind === 'auto')).toHaveLength(3);
    // Categorize on the other bookmark should have succeeded
    expect(fakeRows.find((r) => r.bookmarkId === 2)?.status).toBe('done');
  });

  it('실패 케이스(영구 오류): 원본 auto 분석이 attempts 소진 없이 즉시 error로 종료된다 — 반복 재시도 금지', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { storage: { local: { set: storageSet } } });
    // Original auto (bookmark 1) is permanent error (token soup, retryable=false) -> non-retryable
    mockProcessAiJob.mockImplementation(async (job: any) => {
      await new Promise((r) => setTimeout(r, 5));
      if (job.kind === 'auto') return { ok: false, error: 'AI 응답이 토큰 수프입니다', retryable: false };
      return { ok: true };
    });

    await runNavigationScenario();

    // 4) Permanent error is confirmed immediately without exhausting attempts
    await waitUntil(() => rowOf(1)?.status === 'error');
    const auto = rowOf(1)!;
    expect(auto.status).toBe('error');
    expect(auto.attempts).toBe(0); // Immediately without exhausting attempts
    expect(mockProcessAiJob.mock.calls.filter(([j]) => j.bookmarkId === 1 && j.kind === 'auto')).toHaveLength(1);
    expect(auto.retryHistory?.[0]?.retryable).toBe(false);
    // categorize (bookmark 2) completes normally — permanently failed auto does not block other tasks
    await waitUntil(() => fakeRows.find((r) => r.bookmarkId === 2)?.status === 'done');
    expect(fakeRows.find((r) => r.bookmarkId === 2)?.status).toBe('done');
  });

  it('dedup: 등록 시 자동 분석(auto)과 관리 일괄 분류(categorize)는 서로 다른 job으로 독립 처리된다', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { storage: { local: { set: storageSet } } });
    mockProcessAiJob.mockResolvedValue({ ok: true });

    // Both auto and categorize can coexist for the same bookmark (1) (dedup is per (bookmarkId, kind) pair)
    await enqueueAiJob({ bookmarkId: 1, kind: 'auto', payload: { title: 'a', url: 'u', textContent: 'x' } });
    const cat = await enqueueAiJob({ bookmarkId: 1, kind: 'categorize' });
    expect(cat.ok).toBe(true);

    await waitUntil(() => fakeRows.length === 2 && fakeRows.every((r) => r.status === 'done'));
    expect(fakeRows.filter((r) => r.bookmarkId === 1).length).toBe(2);
    expect(new Set(fakeRows.map((r) => r.kind))).toEqual(new Set(['auto', 'categorize']));
  });
});
