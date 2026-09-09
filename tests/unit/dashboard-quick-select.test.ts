import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';

// ── stats-tracker mock ─────────────────────────────────────────────
const { mockData } = vi.hoisted(() => {
  return {
    mockData: {
      hostStats: [] as { host: string; count: number }[],
      folderStats: [] as { folder: string; count: number }[],
      tagTimeline: {
        buckets: [
          {
            yearMonth: '2026.09',
            timestamp: new Date(2026, 8, 1).getTime(),
            totalBookmarks: 5,
            tags: [{ tag: 'svelte', count: 3 }]
          }
        ],
        hasOlderData: false
      }
    }
  };
});

vi.mock('chart.js', () => {
  class Chart {
    static register = vi.fn();
    data: { labels: any[]; datasets: any[] };
    constructor() {
      this.data = { labels: [], datasets: [] };
    }
    update() {}
    destroy() {}
  }
  return { Chart, registerables: [], register: vi.fn() };
});

vi.mock('../../src/lib/stats/stats-tracker', () => ({
  getSummaryStats: vi.fn(async () => ({
    totalBookmarks: 100,
    archivedCount: 10,
    totalArchiveSize: 2048
  })),
  getHostStats: vi.fn(async () => mockData.hostStats),
  getFolderDistribution: vi.fn(async () => mockData.folderStats),
  getCategoryVisitStats: vi.fn(async () => []),
  getRevisitStats: vi.fn(async () => ({ revisitRate: 42, distribution: [] })),
  getTagTimeline: vi.fn(async () => mockData.tagTimeline)
}));

import StatsDashboard from '../../src/components/management/StatsDashboard.svelte';

// Default jsdom URL (http://localhost/management.html) pathname
const BASE_PATH = '/management.html';

function flush(): Promise<void> {
  // onMount->loadDashboardStats is async, so ensure loading completes via microtasks + multiple ticks.
  return new Promise((r) => setTimeout(r, 0)).then(async () => {
    await tick();
    await tick();
  });
}

function mountDashboard() {
  document.body.innerHTML = '';
  const comp: any = new StatsDashboard({ target: document.body });
  return comp;
}

describe('StatsDashboard quick-select 드릴다운 통합 테스트', () => {
  let pushSpy: ReturnType<typeof vi.fn>;
  let popHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockData.hostStats = [];
    mockData.folderStats = [];
    mockData.tagTimeline = {
      buckets: [
        {
          yearMonth: '2026.09',
          timestamp: new Date(2026, 8, 1).getTime(),
          totalBookmarks: 5,
          tags: [{ tag: 'svelte', count: 3 }]
        }
      ],
      hasOlderData: false
    };
    pushSpy = vi.fn();
    vi.spyOn(window.history, 'pushState').mockImplementation(pushSpy);
    popHandler = vi.fn();
    window.addEventListener('popstate', popHandler);
    document.body.innerHTML = '';
  });

  it('자주 접속한 host 행 클릭 → ?tab=bookmarks&host=... pushState + popstate 디스패치(검색 딥링크)', async () => {
    mockData.hostStats = [{ host: 'github.com', count: 5 }];
    mountDashboard();
    await flush();

    const hostCard = document.querySelectorAll('.ranking-card')[0] as HTMLElement;
    const btn = hostCard.querySelector('.ranking-item--link') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await tick();

    expect(pushSpy).toHaveBeenCalledWith(
      { tab: 'bookmarks' },
      '',
      `${BASE_PATH}?tab=bookmarks&host=github.com`
    );
    // popstate must be dispatched so App's syncTabFromUrl can perform tab transition.
    expect(popHandler).toHaveBeenCalledTimes(1);
  });

  it('자주 등록한 folder 행 클릭 → ?tab=bookmarks&folder=<원본 인코딩> pushState', async () => {
    mockData.folderStats = [{ folder: 'Bookmarks Bar/개발/실전 프로젝트', count: 3 }];
    mountDashboard();
    await flush();

    const folderCard = document.querySelectorAll('.ranking-card')[1] as HTMLElement;
    const btn = folderCard.querySelector('.ranking-item--link') as HTMLButtonElement;
    btn.click();
    await tick();

    expect(pushSpy).toHaveBeenCalledWith(
      { tab: 'bookmarks' },
      '',
      `${BASE_PATH}?tab=bookmarks&folder=${encodeURIComponent('Bookmarks Bar/개발/실전 프로젝트')}`
    );
  });

  it(`folder='기타'(UNCATEGORIZED_SENTINEL) 행 클릭 → ?tab=bookmarks&filter=uncategorized (0건 오동작 방지)`, async () => {
    mockData.folderStats = [{ folder: '기타', count: 2 }];
    mountDashboard();
    await flush();

    const folderCard = document.querySelectorAll('.ranking-card')[1] as HTMLElement;
    const btn = folderCard.querySelector('.ranking-item--link') as HTMLButtonElement;
    btn.click();
    await tick();

    expect(pushSpy).toHaveBeenCalledWith(
      { tab: 'bookmarks' },
      '',
      `${BASE_PATH}?tab=bookmarks&filter=uncategorized`
    );
  });

  it('빈/공백 host 데이터 → 내비게이션 no-op(충돌 없이 무시, pushState 미호출)', async () => {
    mockData.hostStats = [{ host: '   ', count: 1 }];
    mountDashboard();
    await flush();

    const hostCard = document.querySelectorAll('.ranking-card')[0] as HTMLElement;
    const btn = hostCard.querySelector('.ranking-item--link') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await tick();

    expect(pushSpy).not.toHaveBeenCalled();
    expect(popHandler).not.toHaveBeenCalled();
  });

  it('빈 folder 데이터 → 내비게이션 no-op(pushState 미호출)', async () => {
    mockData.folderStats = [{ folder: '', count: 1 }];
    mountDashboard();
    await flush();

    const folderCard = document.querySelectorAll('.ranking-card')[1] as HTMLElement;
    const btn = folderCard.querySelector('.ranking-item--link') as HTMLButtonElement;
    if (btn) {
      btn.click();
      await tick();
    }
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('기존 동작 유지: 폴더 행 라벨은 센티널을 다국어로 치환(기타→Other) 표시', async () => {
    mockData.folderStats = [{ folder: '기타', count: 4 }];
    mountDashboard();
    await flush();

    const folderCard = document.querySelectorAll('.ranking-card')[1] as HTMLElement;
    const nameEl = folderCard.querySelector('.item-name') as HTMLElement;
    // dashboard.other = 'Other' in ko locale default dict
    expect(nameEl?.textContent).toBe('기타');
  });

  it('태그 칩 클릭 → ?tab=bookmarks&tag=svelte pushState + popstate 디스패치(태그 딥링크)', async () => {
    mountDashboard();
    await flush();

    const tagTimelineCard = document.querySelector('.tag-timeline-card') as HTMLElement;
    expect(tagTimelineCard).toBeTruthy();
    const tagBtn = tagTimelineCard.querySelector('.tag-chip') as HTMLButtonElement;
    expect(tagBtn).toBeTruthy();
    tagBtn.click();
    await tick();

    expect(pushSpy).toHaveBeenCalledWith(
      { tab: 'bookmarks' },
      '',
      `${BASE_PATH}?tab=bookmarks&tag=svelte`
    );
    expect(popHandler).toHaveBeenCalledTimes(1);
  });

  it('태그 데이터 없음 → .timeline-empty 빈 상태 메시지 표시', async () => {
    mockData.tagTimeline = {
      buckets: [],
      hasOlderData: false
    };
    mountDashboard();
    await flush();

    const tagTimelineCard = document.querySelector('.tag-timeline-card') as HTMLElement;
    expect(tagTimelineCard).toBeTruthy();
    const emptyEl = tagTimelineCard.querySelector('.timeline-empty');
    expect(emptyEl).toBeTruthy();
  });

  it('대시보드 태그 타임라인 년도별/월별 단위 전환 시 getTagTimeline 호출', async () => {
    const { getTagTimeline } = await import('../../src/lib/stats/stats-tracker');
    mountDashboard();
    await flush();

    const btns = document.querySelectorAll('.granularity-btn');
    expect(btns.length).toBe(2);

    // Initial load was called with default 'month'
    expect(getTagTimeline).toHaveBeenCalledWith('month');

    // Click '년도별' (yearly) button
    (btns[1] as HTMLButtonElement).click();
    await flush();

    expect(getTagTimeline).toHaveBeenCalledWith('year');
  });
});