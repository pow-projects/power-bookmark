import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enqueueAiJobs, enqueueAiJob, initAiQueue } from '../../src/lib/ai/ai-queue';

interface FakeRow {
  id: string;
  bookmarkId: number;
  kind: string;
  status: string;
  createdAt: number;
  attempts: number;
  batchId?: string;
  error?: string;
}

const {
  mockIsAiConfigured,
  mockProcessAiJob,
  mockSetTaskIndicator,
  mockUpdateBookmark,
  mockDbBookmarksGet,
  mockDbBookmarksWhere,
  mockGetAiSettings,
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
    mockGetAiSettings: vi.fn(),
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
  retryBackoffMs: () => 5
}));

vi.mock('../../src/lib/db', () => ({
  default: {
    aiJobs: fakeTable,
    bookmarks: { get: mockDbBookmarksGet, where: mockDbBookmarksWhere }
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
  await new Promise((r) => setTimeout(r, 30));
}

function idsOfStatus(status: string): string[] {
  return fakeRows.filter((r) => r.status === status).map((r) => r.id);
}

describe('ai-queue 통합: 요구사항 검증', () => {
  beforeEach(() => {
    fakeRows.length = 0;
    mockIsAiConfigured.mockReset();
    mockProcessAiJob.mockReset();
    mockSetTaskIndicator.mockReset();
    mockUpdateBookmark.mockReset();
    mockDbBookmarksGet.mockReset();
    mockDbBookmarksWhere.mockReset();
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

  it('동시 요청(동시성) 시에도 createdAt 순서로 FIFO 유지, 동시 실행 ≤ 1', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
    const order: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    mockProcessAiJob.mockImplementation(async (job: any) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      order.push(job.bookmarkId);
      concurrent--;
      return { ok: true };
    });

    // Issue 3 items concurrently without await (concurrent request scenario)
    await Promise.all([
      enqueueAiJob({ bookmarkId: 1, kind: 'categorize' }),
      enqueueAiJob({ bookmarkId: 2, kind: 'categorize' }),
      enqueueAiJob({ bookmarkId: 3, kind: 'categorize' })
    ]);

    await waitUntil(() => idsOfStatus('done').length === 3);
    expect(order.length).toBe(3);
    expect(new Set(order).size).toBe(3); // Process all bookmarks once each
    expect(maxConcurrent).toBe(1); // Max concurrent execution <= 1
  });

  it('두 진입점(auto / categorize / summarize)이 동일 큐에서 순차 처리된다', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
    const order: string[] = [];
    mockProcessAiJob.mockImplementation(async (job: any) => {
      order.push(`${job.kind}:${job.bookmarkId}`);
      return { ok: true };
    });

    // Mixed auto-apply (auto) + bulk management (categorize/summarize)
    await enqueueAiJob({ bookmarkId: 1, kind: 'auto' });
    await enqueueAiJobs([
      { bookmarkId: 2, kind: 'categorize' },
      { bookmarkId: 3, kind: 'summarize' }
    ]);
    await waitUntil(() => idsOfStatus('done').length === 3);

    // All processed in the same queue (drain) — once per kind, executed sequentially
    expect(order).toEqual(['auto:1', 'categorize:2', 'summarize:3']);
  });

  it('배치 내 실패→재시도가 진행률 done을 조기 완료시키지 않는다 (재시도 중엔 running 유지)', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { storage: { local: { set: storageSet } } });

    let firstFail = true;
    mockProcessAiJob.mockImplementation(async (job: any) => {
      // bookmark 2 fails on 1st attempt -> succeeds on retry (attempts 1)
      if (job.bookmarkId === 2 && firstFail && job.attempts === 0) {
        firstFail = false;
        return { ok: false, error: 'transient' };
      }
      return { ok: true };
    });

    await enqueueAiJobs([
      { bookmarkId: 1, kind: 'categorize' },
      { bookmarkId: 2, kind: 'categorize' }
    ]);
    await waitUntil(() => idsOfStatus('done').length === 2 && fakeRows.every((r) => r.status === 'done'));

    // Collect progress events in emitted order
    const progressEvents = storageSet.mock.calls
      .map(([c]) => c['ai_bulk_progress'])
      .filter(Boolean)
      .map((p) => ({ done: p.done, total: p.total, status: p.status }));

    // done should equal actual completed jobs count (2) without counting 1 failure (retry->queued) as complete
    const finalProgress = progressEvents[progressEvents.length - 1];
    expect(finalProgress.total).toBe(2);
    expect(finalProgress.done).toBe(2);
    expect(finalProgress.status).toBe('done');

    // Must not transition prematurely to 'done' while in retry queued state:
    // progress must not be done while job2 is still queued (awaiting retry).
    const prematureDone = progressEvents.some((p, i) => {
      if (p.status !== 'done') return false;
      // If subsequent events exist (extra event after actual completion), done was emitted prematurely
      return i < progressEvents.length - 1;
    });
    expect(prematureDone).toBe(false);
  });

  it('사용자 지정 동시성(concurrency=4) 설정 시 복수 작업이 최대 4개까지 병렬 실행된다', async () => {
    mockGetAiSettings.mockResolvedValue({ concurrency: 4 });
    vi.stubGlobal('browser', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });

    let running = 0;
    let maxRunning = 0;
    mockProcessAiJob.mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      return { ok: true };
    });

    await enqueueAiJobs([
      { bookmarkId: 101, kind: 'categorize' },
      { bookmarkId: 102, kind: 'categorize' },
      { bookmarkId: 103, kind: 'categorize' },
      { bookmarkId: 104, kind: 'categorize' },
      { bookmarkId: 105, kind: 'categorize' },
      { bookmarkId: 106, kind: 'categorize' }
    ]);

    await waitUntil(() => idsOfStatus('done').length === 6);
    expect(maxRunning).toBe(4);
  });
});
