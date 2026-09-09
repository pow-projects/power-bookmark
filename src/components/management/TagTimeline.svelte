<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { TagTimelineResult, TimelineGranularity } from '../../lib/stats/stats-tracker';
  import Icon from '../shared/Icon.svelte';
  import Spinner from '../shared/Spinner.svelte';
  import { captureElementScreenshot } from '../../lib/ui/element-screenshot';
  import { showToast } from '../../lib/ui/toast-store';

  export let timelineData: TagTimelineResult | null = null;
  export let isLoading: boolean = false;
  export let granularity: TimelineGranularity = 'month';
  export let lineLimit: 'all' | '2-lines' = 'all';

  let cardElement: HTMLElement | null = null;
  let isCapturing: boolean = false;
  let expandedBuckets = new Set<string>();
  let overflowMap: Record<string, boolean> = {};

  const dispatch = createEventDispatcher<{
    selectTag: { tag: string };
    changeGranularity: { granularity: TimelineGranularity };
    changeLineLimit: { lineLimit: '2-lines' | 'all' };
  }>();

  function handleGranularityChange(next: TimelineGranularity) {
    if (granularity === next) return;
    granularity = next;
    dispatch('changeGranularity', { granularity: next });
  }

  function handleLineLimitChange(next: '2-lines' | 'all') {
    if (lineLimit === next) return;
    lineLimit = next;
    if (next === '2-lines') {
      expandedBuckets = new Set();
    }
    dispatch('changeLineLimit', { lineLimit: next });
  }

  function toggleBucketExpand(yearMonth: string) {
    const next = new Set(expandedBuckets);
    if (next.has(yearMonth)) {
      next.delete(yearMonth);
    } else {
      next.add(yearMonth);
    }
    expandedBuckets = next;
  }

  function handleOverflow(yearMonth: string, hasOverflow: boolean) {
    if (overflowMap[yearMonth] !== hasOverflow) {
      overflowMap = { ...overflowMap, [yearMonth]: hasOverflow };
    }
  }

  function handleTagClick(tag: string) {
    dispatch('selectTag', { tag });
  }

  async function handleCaptureScreenshot() {
    if (!cardElement || isCapturing) return;
    isCapturing = true;
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
      browser.runtime.sendMessage({ type: 'TASK_INDICATOR', taskType: 'capture', active: true }).catch(() => {});
    }
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `tag-timeline-${granularity}-${dateStr}.png`;
      await captureElementScreenshot(cardElement, {
        filename,
        hideSelectorDuringCapture: '.capture-btn'
      });
      showToast(i18n.t('dashboard.captureSuccess'), 'success');
    } catch (e) {
      console.error('Failed to capture timeline screenshot:', e);
      showToast(i18n.t('dashboard.captureFailed'), 'error');
    } finally {
      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        browser.runtime.sendMessage({ type: 'TASK_INDICATOR', taskType: 'capture', active: false }).catch(() => {});
      }
      isCapturing = false;
    }
  }

  export function getLeadCountStyle(tags: { tag: string; count: number }[]): string {
    const fontSize = !tags || tags.length <= 1 ? 1.85 : 2.25;
    return `font-size: ${fontSize}rem;`;
  }

  export function getTagStyle(count: number, index: number, tags: { tag: string; count: number }[]): string {
    if (!tags || tags.length <= 1) {
      return 'font-size: 1.85rem; opacity: 1; font-weight: 700;';
    }

    const maxCount = tags[0]?.count || 1;
    const minCount = tags[tags.length - 1]?.count || 1;
    const total = tags.length;

    // Rank ratio: 1.0 (first rank) down to 0.0 (last rank)
    const rankRatio = 1 - index / Math.max(1, total - 1);

    // Count ratio: 1.0 (highest count) down to 0.0 (lowest count)
    const countRatio = maxCount > minCount ? (count - minCount) / (maxCount - minCount) : rankRatio;

    // 60% count emphasis + 40% rank progression
    const score = 0.6 * countRatio + 0.4 * rankRatio;

    // Font size: 0.85rem (~13.6px) minimum to 2.25rem (~36px) maximum
    const minFontSize = 0.85;
    const maxFontSize = 2.25;
    const fontSizeRem = minFontSize + (maxFontSize - minFontSize) * score;

    // Opacity: 0.48 (faintly legible minimum) to 1.0 (solid maximum)
    const minOpacity = 0.48;
    const maxOpacity = 1.0;
    const opacity = minOpacity + (maxOpacity - minOpacity) * score;

    const fontWeight = score > 0.65 ? 700 : score > 0.35 ? 600 : 500;

    return `font-size: ${fontSizeRem.toFixed(3)}rem; opacity: ${opacity.toFixed(2)}; font-weight: ${fontWeight};`;
  }

  interface ClampOptions {
    enabled: boolean;
    isExpanded: boolean;
    onOverflowChange: (hasOverflow: boolean) => void;
  }

  function clampTwoLines(node: HTMLElement, options: ClampOptions) {
    let currentOptions = options;
    let resizeObserver: ResizeObserver | null = null;
    let lastWidth = -1;

    function evaluate() {
      const chips = Array.from(node.querySelectorAll<HTMLElement>('.tag-chip'));
      if (chips.length === 0) {
        node.style.removeProperty('--two-lines-height');
        currentOptions.onOverflowChange(false);
        return;
      }

      // In jsdom or before layout calculation:
      if (chips[0].offsetHeight === 0 && node.offsetHeight === 0) {
        const hasOverflow = chips.length > 6;
        currentOptions.onOverflowChange(hasOverflow);
        return;
      }

      // Real browser measurement
      let line = 1;
      let lineAnchorTop = chips[0].offsetTop;
      let line2Bottom = 0;
      let hasOverflow = false;

      for (let i = 0; i < chips.length; i++) {
        const chip = chips[i];
        if (chip.offsetTop - lineAnchorTop > 20) {
          line++;
          lineAnchorTop = chip.offsetTop;
        }

        if (line === 1 || line === 2) {
          const bottom = chip.offsetTop + chip.offsetHeight;
          if (bottom > line2Bottom) {
            line2Bottom = bottom;
          }
        } else {
          hasOverflow = true;
          break;
        }
      }

      currentOptions.onOverflowChange(hasOverflow);

      if (currentOptions.enabled && hasOverflow && line2Bottom > 0) {
        node.style.setProperty('--two-lines-height', `${line2Bottom + 2}px`);
      } else {
        node.style.removeProperty('--two-lines-height');
      }
    }

    evaluate();

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const width = entry.contentRect.width;
          if (width !== lastWidth) {
            lastWidth = width;
            evaluate();
          }
        }
      });
      resizeObserver.observe(node);
    }

    return {
      update(newOptions: ClampOptions) {
        currentOptions = newOptions;
        evaluate();
      },
      destroy() {
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
      }
    };
  }
</script>

<div class="tag-timeline-card" bind:this={cardElement} class:is-capturing={isCapturing}>
  <div class="timeline-header">
    <div class="timeline-title-group">
      <Icon name="tag" size={18} />
      <h3>{i18n.t('dashboard.tagTimelineTitle')}</h3>
    </div>
    <div class="timeline-actions">
      <div class="line-limit-toggle" role="group" aria-label={i18n.t('dashboard.timelineLineLimitAria')}>
        <button
          type="button"
          class="limit-btn"
          class:active={lineLimit === 'all'}
          on:click={() => handleLineLimitChange('all')}
          aria-pressed={lineLimit === 'all'}
        >
          {i18n.t('dashboard.viewAllLines')}
        </button>
        <button
          type="button"
          class="limit-btn"
          class:active={lineLimit === '2-lines'}
          on:click={() => handleLineLimitChange('2-lines')}
          aria-pressed={lineLimit === '2-lines'}
        >
          {i18n.t('dashboard.viewTwoLines')}
        </button>
      </div>

      <div class="granularity-toggle" role="group" aria-label={i18n.t('dashboard.timelineGranularityAria')}>
        <button
          type="button"
          class="granularity-btn"
          class:active={granularity === 'month'}
          on:click={() => handleGranularityChange('month')}
          aria-pressed={granularity === 'month'}
        >
          {i18n.t('dashboard.viewMonthly')}
        </button>
        <button
          type="button"
          class="granularity-btn"
          class:active={granularity === 'year'}
          on:click={() => handleGranularityChange('year')}
          aria-pressed={granularity === 'year'}
        >
          {i18n.t('dashboard.viewYearly')}
        </button>
      </div>

      <button
        type="button"
        class="capture-btn"
        on:click={handleCaptureScreenshot}
        disabled={isCapturing || isLoading || !timelineData || timelineData.buckets.length === 0}
        title={i18n.t(isCapturing ? 'dashboard.capturingTimeline' : 'dashboard.captureTimelineAria')}
        aria-label={i18n.t(isCapturing ? 'dashboard.capturingTimeline' : 'dashboard.captureTimelineAria')}
      >
        {#if isCapturing}
          <Spinner size={16} variant="inline" />
        {:else}
          <Icon name="camera" size={16} />
        {/if}
      </button>
    </div>
  </div>

  {#if isLoading}
    <div class="timeline-loading">
      <Spinner size={32} variant="default" />
    </div>
  {:else if !timelineData || timelineData.buckets.length === 0}
    <div class="timeline-empty">
      <p>{i18n.t('dashboard.noTagsInPeriod')}</p>
    </div>
  {:else}
    <div
      class="timeline-content-area"
      role="region"
      aria-label={i18n.t('dashboard.timelineScrollAria')}
    >
      <div class="timeline-spine">
        {#each timelineData.buckets as bucket (bucket.yearMonth)}
          <div class="timeline-node">
            <div class="marker-dot" aria-hidden="true"></div>
            <div class="node-header">
              <span class="month-label">{bucket.yearMonth}</span>
            </div>
            <div class="node-body">
              <div class="node-left">
                <span
                  class="lead-count"
                  style={getLeadCountStyle(bucket.tags)}
                  aria-label={i18n.t(granularity === 'year' ? 'dashboard.yearTagsCount' : 'dashboard.monthTagsCount', { count: bucket.tags?.length || 0 })}
                >
                  {bucket.tags?.length || 0}
                </span>
              </div>
              <div class="tag-chips-wrapper">
                <div
                  class="tag-chips-grid"
                  class:limit-two-lines={lineLimit === '2-lines' && !expandedBuckets.has(bucket.yearMonth)}
                  use:clampTwoLines={{
                    enabled: lineLimit === '2-lines' && !expandedBuckets.has(bucket.yearMonth),
                    isExpanded: expandedBuckets.has(bucket.yearMonth),
                    onOverflowChange: (hasOverflow) => handleOverflow(bucket.yearMonth, hasOverflow)
                  }}
                >
                  {#if !bucket.tags || bucket.tags.length === 0}
                    <span class="timeline-empty-tag">{i18n.t('dashboard.noTagsInPeriod')}</span>
                  {:else}
                    {#each bucket.tags as item, index (item.tag)}
                      <button
                        type="button"
                        class="tag-chip"
                        style={getTagStyle(item.count, index, bucket.tags)}
                        on:click={() => handleTagClick(item.tag)}
                        aria-label={i18n.t('dashboard.tagDrilldownAria', { tag: item.tag })}
                      >
                        <span class="tag-name">{item.tag}</span>
                      </button>
                    {/each}
                  {/if}
                </div>
                {#if lineLimit === '2-lines' && overflowMap[bucket.yearMonth]}
                  <button
                    type="button"
                    class="toggle-expand-btn"
                    on:click={() => toggleBucketExpand(bucket.yearMonth)}
                    aria-expanded={expandedBuckets.has(bucket.yearMonth)}
                    aria-label={i18n.t(expandedBuckets.has(bucket.yearMonth) ? 'dashboard.collapseTags' : 'dashboard.expandMoreTags')}
                  >
                    {#if expandedBuckets.has(bucket.yearMonth)}
                      <Icon name="chevron-up" size={12} />
                      <span>{i18n.t('dashboard.collapseTags')}</span>
                    {:else}
                      <Icon name="chevron-down" size={12} />
                      <span>{i18n.t('dashboard.expandMoreTags')}</span>
                    {/if}
                  </button>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .tag-timeline-card {
    position: relative;
    background-color: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-top: 3px solid var(--color-primary);
    border-radius: var(--radius-lg);
    padding: var(--card-padding-lg);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .timeline-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border-color);
  }

  .timeline-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-primary);
  }

  .timeline-title-group h3 {
    margin: 0;
    font-family: var(--font-accent);
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .timeline-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .granularity-toggle,
  .line-limit-toggle {
    display: inline-flex;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background-color: var(--bg-primary);
    overflow: hidden;
    padding: 2px;
    gap: 2px;
  }

  .granularity-btn,
  .limit-btn {
    padding: 0.25rem 0.625rem;
    font-family: var(--font-mono);
    font-size: var(--btn-font-size-sm);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: transparent;
    border: none;
    border-radius: calc(var(--radius-sm) - 2px);
    cursor: pointer;
    transition: all var(--transition-fast);
    line-height: 1.2;
  }

  .granularity-btn:hover,
  .limit-btn:hover {
    color: var(--text-primary);
  }

  .granularity-btn.active,
  .limit-btn.active {
    background-color: var(--bg-secondary);
    color: var(--color-primary);
    font-weight: 700;
    box-shadow: var(--shadow-sm);
  }

  .granularity-btn:focus-visible,
  .limit-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .capture-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    color: var(--text-muted);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color var(--transition-fast);
    line-height: 1;
  }

  .capture-btn:hover:not(:disabled) {
    color: var(--color-primary);
  }

  .capture-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .capture-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .timeline-content-area {
    width: 100%;
  }

  .timeline-spine {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding-top: 0.25rem;
    padding-bottom: 0.25rem;
  }

  .timeline-spine::before {
    content: '';
    position: absolute;
    left: 4.5rem;
    top: 0;
    bottom: 0;
    width: 2px;
    background-color: var(--border-color);
  }

  .timeline-node {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .marker-dot {
    position: absolute;
    left: 4.5rem;
    top: 0.25rem;
    transform: translateX(-50%) translateX(1px);
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background-color: var(--color-primary);
    border: 2px solid var(--bg-secondary);
    box-sizing: content-box;
  }

  .node-header {
    margin-left: calc(4.5rem + 1.25rem);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .month-label {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }

  .node-body {
    display: grid;
    grid-template-columns: 4.5rem 1fr;
    column-gap: 1.25rem;
    align-items: baseline;
  }

  .node-left {
    display: flex;
    justify-content: flex-end;
    align-items: baseline;
    text-align: right;
  }

  .lead-count {
    display: inline-flex;
    align-items: baseline;
    font-family: var(--font-mono);
    font-weight: 700;
    line-height: 1.15;
    color: var(--text-muted);
    opacity: 0.75;
    padding: 0.1em 0.25em;
    user-select: none;
  }

  .timeline-empty-tag {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .tag-chips-wrapper {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    width: 100%;
  }

  .tag-chips-grid {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 1rem;
    padding: 0.25rem 0;
    width: 100%;
  }

  .tag-chips-grid.limit-two-lines {
    max-height: var(--two-lines-height, 5.85rem);
    overflow: hidden;
    transition: max-height var(--transition-fast);
  }

  .toggle-expand-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.5rem;
    margin-top: 0.35rem;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
    line-height: 1.2;
  }

  .toggle-expand-btn:hover {
    color: var(--color-primary);
    border-color: var(--color-primary);
    background-color: var(--bg-primary);
  }

  .toggle-expand-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .tag-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.15rem;
    padding: 0.1em 0.25em;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-mono);
    line-height: 1.15;
    cursor: pointer;
    transition: all var(--transition-fast);
    text-decoration: none;
  }

  .tag-chip:hover {
    color: var(--color-primary);
    text-decoration: underline;
    text-underline-offset: 4px;
    transform: translateY(-1px);
    opacity: 1 !important;
  }

  .tag-chip:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    opacity: 1 !important;
  }

  .tag-name {
    letter-spacing: -0.01em;
  }

  .timeline-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2.5rem 1rem;
    color: var(--text-muted);
    font-size: 0.875rem;
    text-align: center;
  }

  .timeline-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3rem 1rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .tag-chip,
    .tag-chip:hover,
    .granularity-btn,
    .limit-btn,
    .capture-btn,
    .toggle-expand-btn,
    .tag-chips-grid {
      transition: none;
      transform: none;
    }
  }
</style>
