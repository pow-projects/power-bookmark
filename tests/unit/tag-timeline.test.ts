import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';

const { mockCapture, mockShowToast } = vi.hoisted(() => ({
  mockCapture: vi.fn().mockResolvedValue(new Blob()),
  mockShowToast: vi.fn()
}));

vi.mock('../../src/lib/ui/element-screenshot', () => ({
  captureElementScreenshot: mockCapture
}));

vi.mock('../../src/lib/ui/toast-store', () => ({
  showToast: mockShowToast,
  toasts: { subscribe: vi.fn() }
}));

import TagTimeline from '../../src/components/management/TagTimeline.svelte';
import type { TagTimelineResult } from '../../src/lib/stats/stats-tracker';

describe('TagTimeline 컴포넌트 단위 테스트', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  const mockTimelineData: TagTimelineResult = {
    buckets: [
      {
        yearMonth: '2026.09',
        timestamp: new Date(2026, 8, 1).getTime(),
        totalBookmarks: 8,
        tags: [
          { tag: 'svelte', count: 5 },
          { tag: 'vitest', count: 3 }
        ]
      },
      {
        yearMonth: '2026.08',
        timestamp: new Date(2026, 7, 1).getTime(),
        totalBookmarks: 4,
        tags: [
          { tag: 'typescript', count: 4 }
        ]
      }
    ],
    hasOlderData: true
  };

  it('타임라인 데이터 렌더링: 월별 노드, 마커 닷, 태그 칩 표출', async () => {
    const comp = new TagTimeline({
      target: document.body,
      props: {
        timelineData: mockTimelineData,
        isLoading: false
      }
    });
    await tick();

    const card = document.querySelector('.tag-timeline-card');
    expect(card).toBeTruthy();
    expect(document.querySelector('.timeline-title-group .stamp-badge')).toBeNull();

    const nodes = document.querySelectorAll('.timeline-node');
    expect(nodes.length).toBe(2);

    const monthLabels = document.querySelectorAll('.month-label');
    expect(monthLabels[0].textContent).toBe('2026.09');
    expect(monthLabels[1].textContent).toBe('2026.08');

    const chips = document.querySelectorAll('.tag-chip');
    expect(chips.length).toBe(3); // svelte, vitest, typescript
    expect(chips[0].textContent?.trim()).toBe('svelte');
    expect(chips[0].textContent).not.toContain('#');
    expect(chips[0].querySelector('.stamp-badge')).toBeNull(); // count badge removed

    // 날짜 우측 배지 제거 확인 및 리드 카운트(숫자만) 표출 확인
    const nodeHeaders = document.querySelectorAll('.node-header');
    expect(nodeHeaders[0].querySelector('.stamp-badge')).toBeNull();
    expect(nodeHeaders[1].querySelector('.stamp-badge')).toBeNull();

    const leadCounts = document.querySelectorAll('.lead-count');
    expect(leadCounts.length).toBe(2);
    expect(leadCounts[0].textContent?.trim()).toBe('2'); // 2 unique tags ('svelte', 'vitest')
    expect(leadCounts[1].textContent?.trim()).toBe('1'); // 1 unique tag ('typescript')
  });

  it('태그 칩 클릭 시 selectTag 이벤트 디스패치', async () => {
    const comp = new TagTimeline({
      target: document.body,
      props: {
        timelineData: mockTimelineData,
        isLoading: false
      }
    });
    await tick();

    const selectHandler = vi.fn();
    comp.$on('selectTag', selectHandler);

    const firstChip = document.querySelector('.tag-chip') as HTMLButtonElement;
    firstChip.click();
    await tick();

    expect(selectHandler).toHaveBeenCalledTimes(1);
    expect(selectHandler.mock.calls[0][0].detail).toEqual({ tag: 'svelte' });
  });

  it('데이터가 없거나 buckets가 비어있을 때 .timeline-empty 표출', async () => {
    new TagTimeline({
      target: document.body,
      props: {
        timelineData: { buckets: [], hasOlderData: false },
        isLoading: false
      }
    });
    await tick();

    const empty = document.querySelector('.timeline-empty');
    expect(empty).toBeTruthy();
    expect(document.querySelector('.timeline-content-area')).toBeNull();
  });

  it('isLoading이 true일 때 스피너 표출', async () => {
    new TagTimeline({
      target: document.body,
      props: {
        timelineData: null,
        isLoading: true
      }
    });
    await tick();

    const loading = document.querySelector('.timeline-loading');
    expect(loading).toBeTruthy();
    expect(document.querySelector('.spinner')).toBeTruthy();
  });

  it('접근성(a11y) 검증: 타임라인 컨텐츠 영역 role="region", aria-label 포함', async () => {
    new TagTimeline({
      target: document.body,
      props: {
        timelineData: mockTimelineData,
        isLoading: false
      }
    });
    await tick();

    const contentArea = document.querySelector('.timeline-content-area');
    expect(contentArea?.getAttribute('role')).toBe('region');
    expect(contentArea?.getAttribute('aria-label')).toBeTruthy();
  });

  it('년도별/월별 토글 버튼 렌더링 및 changeGranularity 이벤트 디스패치', async () => {
    const comp = new TagTimeline({
      target: document.body,
      props: {
        timelineData: mockTimelineData,
        isLoading: false,
        granularity: 'month'
      }
    });
    await tick();

    const granularityHandler = vi.fn();
    comp.$on('changeGranularity', granularityHandler);

    const toggleGroup = document.querySelector('.granularity-toggle');
    expect(toggleGroup).toBeTruthy();

    const btns = document.querySelectorAll('.granularity-btn');
    expect(btns.length).toBe(2);

    // Initial state: 'month' is active
    expect(btns[0].classList.contains('active')).toBe(true);
    expect(btns[0].getAttribute('aria-pressed')).toBe('true');
    expect(btns[1].classList.contains('active')).toBe(false);

    // Click '년도별' (yearly) button
    (btns[1] as HTMLButtonElement).click();
    await tick();

    expect(granularityHandler).toHaveBeenCalledTimes(1);
    expect(granularityHandler).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { granularity: 'year' } })
    );
    expect(btns[1].classList.contains('active')).toBe(true);

    // Click '월별' (monthly) button
    (btns[0] as HTMLButtonElement).click();
    await tick();

    expect(granularityHandler).toHaveBeenCalledTimes(2);
    expect(granularityHandler).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { granularity: 'month' } })
    );
  });

  it('태그 빈도/순서에 따라 글자 크기와 투명도 점진적 적용 (최대 태그는 가장 크고 최소 태그는 희미하지만 가독성 유지)', async () => {
    const multiTagData: TagTimelineResult = {
      buckets: [
        {
          yearMonth: '2026.09',
          timestamp: new Date(2026, 8, 1).getTime(),
          totalBookmarks: 20,
          tags: [
            { tag: 'rank1', count: 10 },
            { tag: 'rank2', count: 6 },
            { tag: 'rank3', count: 3 },
            { tag: 'rank4', count: 1 }
          ]
        }
      ],
      hasOlderData: false
    };

    new TagTimeline({
      target: document.body,
      props: {
        timelineData: multiTagData,
        isLoading: false
      }
    });
    await tick();

    const chips = Array.from(document.querySelectorAll('.tag-chip')) as HTMLButtonElement[];
    expect(chips.length).toBe(4);

    const fontSizes = chips.map((c) => parseFloat(c.style.fontSize));
    const opacities = chips.map((c) => parseFloat(c.style.opacity));

    // 1위 태그는 글씨가 가장 크고(2.0rem 이상) 투명도 1 (최대)
    expect(opacities[0]).toBe(1);
    expect(fontSizes[0]).toBeGreaterThan(2.0);
    expect(fontSizes[0]).toBeGreaterThan(fontSizes[1]);

    // 다음 순서들은 점점 작아지고 투명도도 점진적으로 낮아짐
    expect(fontSizes[1]).toBeGreaterThan(fontSizes[2]);
    expect(fontSizes[2]).toBeGreaterThan(fontSizes[3]);
    expect(fontSizes[3]).toBeLessThan(1.0);

    expect(opacities[0]).toBeGreaterThan(opacities[1]);
    expect(opacities[1]).toBeGreaterThan(opacities[2]);
    expect(opacities[2]).toBeGreaterThan(opacities[3]);

    // 완전 투명이 아닌 희미하게 글자가 보일 정도의 최소치 유지 (>= 0.45)
    expect(opacities[3]).toBeGreaterThanOrEqual(0.45);
    expect(opacities[3]).toBeLessThan(0.6);
  });

  it('날짜 우측 카운트 배지 제거 및 1위 태그 옆에 대형 숫자 카운트 단독 표출', async () => {
    new TagTimeline({
      target: document.body,
      props: {
        timelineData: mockTimelineData,
        isLoading: false
      }
    });
    await tick();

    // 1. 날짜 헤더에는 날짜만 남고 배지가 없어야 함
    const nodeHeader = document.querySelector('.node-header');
    expect(nodeHeader?.querySelector('.stamp-badge')).toBeNull();
    expect(nodeHeader?.querySelector('.month-count')).toBeNull();

    // 2. 타임라인 왼쪽 위치(.node-left)에 .lead-count 요소가 렌더링되어야 함
    const nodeBody = document.querySelector('.node-body');
    expect(nodeBody).toBeTruthy();

    const nodeLeft = nodeBody?.querySelector('.node-left');
    expect(nodeLeft).toBeTruthy();

    const leadCount = nodeLeft?.querySelector('.lead-count') as HTMLElement;
    expect(leadCount).toBeTruthy();

    // 텍스트는 해당 월의 태그 총 갯수만 표시 ("2", 'svelte'와 'vitest' 총 2개)
    expect(leadCount.textContent?.trim()).toBe('2');

    // 3. 폰트 크기가 1위 태그에 맞춰진 대형 크기(2.0rem 이상)로 설정되었는지 검증
    const leadCountFontSize = parseFloat(leadCount.style.fontSize);
    expect(leadCountFontSize).toBeGreaterThan(2.0);

    // 4. 스크린 리더용 aria-label은 태그 수량 설명 보존되어 접근성 보장
    expect(leadCount.getAttribute('aria-label')).toContain('태그');
  });

  it('전체 / 2줄 토글 버튼 렌더링 (전체 왼쪽 기본값) 및 changeLineLimit 이벤트 디스패치', async () => {
    const comp = new TagTimeline({
      target: document.body,
      props: {
        timelineData: mockTimelineData,
        isLoading: false
      }
    });
    await tick();

    const limitHandler = vi.fn();
    comp.$on('changeLineLimit', limitHandler);

    const toggleGroup = document.querySelector('.line-limit-toggle');
    expect(toggleGroup).toBeTruthy();

    const btns = toggleGroup?.querySelectorAll('.limit-btn');
    expect(btns?.length).toBe(2);

    // Initial state: 'all' ('전체') on the left is active by default
    expect(btns?.[0].classList.contains('active')).toBe(true);
    expect(btns?.[0].getAttribute('aria-pressed')).toBe('true');
    expect(btns?.[0].textContent?.trim()).toBe('전체');
    expect(btns?.[1].classList.contains('active')).toBe(false);
    expect(btns?.[1].textContent?.trim()).toBe('2줄');

    // Click '2줄' button
    (btns?.[1] as HTMLButtonElement).click();
    await tick();

    expect(limitHandler).toHaveBeenCalledTimes(1);
    expect(limitHandler).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { lineLimit: '2-lines' } })
    );
    expect(btns?.[1].classList.contains('active')).toBe(true);
    expect(btns?.[0].classList.contains('active')).toBe(false);

    // Click '전체' button
    (btns?.[0] as HTMLButtonElement).click();
    await tick();

    expect(limitHandler).toHaveBeenCalledTimes(2);
    expect(limitHandler).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { lineLimit: 'all' } })
    );
    expect(btns?.[0].classList.contains('active')).toBe(true);
  });

  it('2줄 보기 모드에서 .limit-two-lines 클래스 적용 및 전체 보기 전환 시 해제', async () => {
    const comp = new TagTimeline({
      target: document.body,
      props: {
        timelineData: mockTimelineData,
        isLoading: false,
        lineLimit: '2-lines'
      }
    });
    await tick();

    const grids = document.querySelectorAll('.tag-chips-grid');
    expect(grids.length).toBe(2);
    expect(grids[0].classList.contains('limit-two-lines')).toBe(true);
    expect(grids[1].classList.contains('limit-two-lines')).toBe(true);

    // Switch to 'all' (left button, index 0)
    const btns = document.querySelectorAll('.limit-btn');
    (btns[0] as HTMLButtonElement).click();
    await tick();

    const updatedGrids = document.querySelectorAll('.tag-chips-grid');
    expect(updatedGrids[0].classList.contains('limit-two-lines')).toBe(false);
    expect(updatedGrids[1].classList.contains('limit-two-lines')).toBe(false);
  });

  it('태그가 많은 버킷에서 더보기/접기 버튼 노출 및 개별 버킷 펼치기 상호작용', async () => {
    const manyTagsData: TagTimelineResult = {
      buckets: [
        {
          yearMonth: '2026.09',
          timestamp: new Date(2026, 8, 1).getTime(),
          totalBookmarks: 25,
          tags: Array.from({ length: 12 }, (_, i) => ({
            tag: `tag-${i + 1}`,
            count: 12 - i
          }))
        }
      ],
      hasOlderData: false
    };

    new TagTimeline({
      target: document.body,
      props: {
        timelineData: manyTagsData,
        isLoading: false,
        lineLimit: '2-lines'
      }
    });
    await tick();

    // In 2-lines mode with >6 tags, overflow is detected and expand button appears
    const expandBtn = document.querySelector('.toggle-expand-btn') as HTMLButtonElement;
    expect(expandBtn).toBeTruthy();
    expect(expandBtn.textContent?.trim()).toContain('더보기');
    expect(expandBtn.getAttribute('aria-expanded')).toBe('false');

    const grid = document.querySelector('.tag-chips-grid');
    expect(grid?.classList.contains('limit-two-lines')).toBe(true);

    // Click '더보기' -> Expands that bucket
    expandBtn.click();
    await tick();

    expect(grid?.classList.contains('limit-two-lines')).toBe(false);
    expect(expandBtn.textContent?.trim()).toContain('접기');
    expect(expandBtn.getAttribute('aria-expanded')).toBe('true');

    // Click '접기' -> Collapses back to 2 lines
    expandBtn.click();
    await tick();

    expect(grid?.classList.contains('limit-two-lines')).toBe(true);
    expect(expandBtn.textContent?.trim()).toContain('더보기');
    expect(expandBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('스크린샷 캡처 버튼 렌더링 및 클릭 시 captureElementScreenshot 호출 및 성공 토스트 표출', async () => {
    new TagTimeline({
      target: document.body,
      props: {
        timelineData: mockTimelineData,
        isLoading: false
      }
    });
    await tick();

    const actions = document.querySelector('.timeline-actions');
    const captureBtn = document.querySelector('.capture-btn') as HTMLButtonElement;
    expect(captureBtn).toBeTruthy();
    expect(actions?.lastElementChild).toBe(captureBtn);
    expect(captureBtn.disabled).toBe(false);
    expect(captureBtn.textContent?.trim()).toBe('');
    expect(captureBtn.querySelector('svg')).toBeTruthy();
    expect(captureBtn.getAttribute('aria-label')).toBeTruthy();

    // Click capture button
    captureBtn.click();
    await tick();

    expect(mockCapture).toHaveBeenCalledTimes(1);
    const [capturedEl, captureOptions] = mockCapture.mock.calls[0];
    expect(capturedEl).toBe(document.querySelector('.tag-timeline-card'));
    expect(captureOptions.filename).toContain('tag-timeline-month-');
    expect(captureOptions.hideSelectorDuringCapture).toBe('.capture-btn');

    // Wait microtask for promise resolution
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    expect(mockShowToast).toHaveBeenCalledWith('타임라인 스크린샷이 다운로드되었습니다.', 'success');
  });

  it('isLoading이거나 데이터가 없을 때 캡처 버튼 비활성화', async () => {
    // 1. isLoading: true
    new TagTimeline({
      target: document.body,
      props: {
        timelineData: mockTimelineData,
        isLoading: true
      }
    });
    await tick();

    // In loading state, timeline-actions is visible in header
    const loadingBtn = document.querySelector('.capture-btn') as HTMLButtonElement;
    expect(loadingBtn.disabled).toBe(true);

    document.body.innerHTML = '';

    // 2. Empty data
    new TagTimeline({
      target: document.body,
      props: {
        timelineData: { buckets: [], hasOlderData: false },
        isLoading: false
      }
    });
    await tick();

    const emptyBtn = document.querySelector('.capture-btn') as HTMLButtonElement;
    expect(emptyBtn.disabled).toBe(true);
  });

  it('캡처 진행 시 확장기능 버튼 스피너(TASK_INDICATOR) 시작 및 종료 메시지 발송', async () => {
    const mockSendMessage = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('browser', {
      runtime: {
        sendMessage: mockSendMessage
      }
    });

    try {
      new TagTimeline({
        target: document.body,
        props: {
          timelineData: mockTimelineData,
          isLoading: false
        }
      });
      await tick();

      const captureBtn = document.querySelector('.capture-btn') as HTMLButtonElement;
      expect(captureBtn).toBeTruthy();

      captureBtn.click();
      await tick();

      expect(mockSendMessage).toHaveBeenCalledWith({
        type: 'TASK_INDICATOR',
        taskType: 'capture',
        active: true
      });

      await new Promise((r) => setTimeout(r, 0));
      await tick();

      expect(mockSendMessage).toHaveBeenCalledWith({
        type: 'TASK_INDICATOR',
        taskType: 'capture',
        active: false
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
