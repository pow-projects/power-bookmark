<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    getSummaryStats,
    getHostStats,
    getFolderDistribution,
    getCategoryVisitStats,
    getRevisitStats,
    getTagTimeline,
    type TagTimelineResult,
    type TimelineGranularity
  } from '../../lib/stats/stats-tracker';
  import { getLeafFolderName } from '../../lib/bookmarks/folder-utils';
  import { CHART_PALETTE, CHART_HEALTH_COLORS } from '../../lib/ui/chart-palette';
  import { buildDrilldownUrl, type Drilldown } from '../../lib/stats/dashboard-drilldown';
  import ChartCard from '../shared/ChartCard.svelte';
  import TagTimeline from './TagTimeline.svelte';
  import Icon from '../shared/Icon.svelte';
  import Spinner from '../shared/Spinner.svelte';

  // Metric card state
  let totalBookmarks = 0;
  let archivedCount = 0;
  let totalArchiveSize = 0;
  let revisitRate = 0;

  // Tag timeline state
  let tagTimelineData: TagTimelineResult | null = null;
  let timelineLoading = false;
  let timelineGranularity: TimelineGranularity = 'month';
  let timelineLineLimit: 'all' | '2-lines' = 'all';

  // Loading state
  let loaded = false;

  // Ranking data state
  let topHosts: { host: string; count: number }[] = [];
  let topFolders: { folder: string; count: number }[] = [];

  // Category visit chart state
  let categoryLabels: string[] = [];
  let categoryDatasets: any[] = [];

  // Revisit rate chart state
  let revisitLabels: string[] = [];
  let revisitDatasets: any[] = [];

  // File size formatting helper
  function formatBytes(bytes: number, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  async function loadTagTimeline(granularity: TimelineGranularity = timelineGranularity) {
    timelineLoading = true;
    try {
      tagTimelineData = await getTagTimeline(granularity);
    } catch (e) {
      console.error('Failed to load tag timeline:', e);
    } finally {
      timelineLoading = false;
    }
  }

  async function loadDashboardStats() {
    try {
      loadTagTimeline(timelineGranularity);

      // 1. Load summary stats
      const summary = await getSummaryStats();
      totalBookmarks = summary.totalBookmarks;
      archivedCount = summary.archivedCount;
      totalArchiveSize = summary.totalArchiveSize;

      // 2. Load Top 10 hosts
      const hostStats = await getHostStats();
      topHosts = hostStats.slice(0, 10);

      // 3. Load Top 10 folder distribution (sorted by bookmark count descending)
      const folderStats = await getFolderDistribution();
      topFolders = folderStats.sort((a, b) => b.count - a.count).slice(0, 10);

      // 4. Load most visited category (folder) chart
      const categoryStats = await getCategoryVisitStats();
      const topCategoryStats = categoryStats.slice(0, 10);
      categoryLabels = topCategoryStats.map(s => {
        if (s.folder === '기타') return i18n.t('dashboard.other');
        return getLeafFolderName(s.folder) || s.folder;
      });
      categoryDatasets = [
        {
          label: i18n.t('dashboard.visitCount'),
          data: topCategoryStats.map(s => s.count),
          backgroundColor: [...CHART_PALETTE],
          borderRadius: 6
        }
      ];

      // 5. Load revisit stats and chart data
      const revisitInfo = await getRevisitStats();
      revisitRate = revisitInfo.revisitRate;
      const revisitLabelMap: Record<number, string> = {
        0: i18n.t('dashboard.unvisited'),
        1: i18n.t('dashboard.visited1'),
        2: i18n.t('dashboard.visited2to5'),
        3: i18n.t('dashboard.visited6plus'),
      };
      revisitLabels = revisitInfo.distribution.map((d, index) => revisitLabelMap[index] || d.label);
      revisitDatasets = [
        {
          data: revisitInfo.distribution.map(d => d.count),
          backgroundColor: [...CHART_HEALTH_COLORS]
        }
      ];

      loaded = true;
    } catch (e) {
      console.error('Failed to load dashboard stats:', e);
    }
  }

  const handleStatsUpdate = () => {
    loadDashboardStats();
  };

  // Dashboard row quick-select -> bookmark management deep link transition.
  // After URL pushState, dispatch a synthetic PopStateEvent so App's existing popstate listener (syncTabFromUrl)
  // handles tab switching + remounting. Missing/invalid data returns null from buildDrilldownUrl -> no-op.
  function handleDrilldown(d: Drilldown) {
    if (typeof window === 'undefined' || typeof window.location === 'undefined') return;
    const url = buildDrilldownUrl(window.location.pathname, d);
    if (!url) return;
    window.history.pushState({ tab: 'bookmarks' }, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  // Folder row display label: replace '기타' sentinel with localized 'Other' (preserves existing behavior)
  function folderLabel(folder: string): string {
    return folder === '기타' ? i18n.t('dashboard.other') : folder;
  }

  onMount(() => {
    loadDashboardStats();
    if (typeof document !== 'undefined') {
      document.addEventListener('bookmarks-updated', handleStatsUpdate);
      document.addEventListener('sync-resolved', handleStatsUpdate);
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('bookmarks-updated', handleStatsUpdate);
      document.removeEventListener('sync-resolved', handleStatsUpdate);
    }
  });
</script>

<div class="dashboard-container">
  <h2><Icon name="bar-chart" size={22} /> {i18n.t('dashboard.title')}</h2>

  <!-- Summary card grid -->
  <div class="stats-grid">
    <div class="stat-card accent-ribbon">
      <div class="stat-content">
        <span class="stat-label">{i18n.t('dashboard.totalBookmarks')}</span>
        <span class="stat-value">{totalBookmarks}</span>
      </div>
      <div class="stat-icon"><Icon name="bookmark" size={20} /></div>
    </div>

    <div class="stat-card accent-teal">
      <div class="stat-content">
        <span class="stat-label">{i18n.t('dashboard.revisitRate')}</span>
        <span class="stat-value">{revisitRate}%</span>
      </div>
      <div class="stat-icon"><Icon name="refresh-cw" size={20} /></div>
    </div>

    <div class="stat-card accent-amber">
      <div class="stat-content">
        <span class="stat-label">{i18n.t('dashboard.archiveFiles')}</span>
        <span class="stat-value">{archivedCount}</span>
      </div>
      <div class="stat-icon"><Icon name="archive" size={20} /></div>
    </div>

    <div class="stat-card accent-ink">
      <div class="stat-content">
        <span class="stat-label">{i18n.t('dashboard.archiveSize')}</span>
        <span class="stat-value">{formatBytes(totalArchiveSize)}</span>
      </div>
      <div class="stat-icon"><Icon name="database" size={20} /></div>
    </div>
  </div>

  <!-- Chart dashboard grid -->
  {#if loaded}
    <div class="charts-grid">
      <!-- Most visited category (folder) chart -->
      <div class="chart-wrapper">
        <ChartCard
          title={i18n.t('dashboard.categoryChartTitle')}
          type="bar"
          labels={categoryLabels}
          datasets={categoryDatasets}
        />
      </div>

      <!-- Bookmark revisit distribution chart -->
      <div class="chart-wrapper">
        <ChartCard
          title="{i18n.t('dashboard.revisitChartTitle')} ({i18n.t('dashboard.revisitRate')} {revisitRate}%)"
          type="doughnut"
          labels={revisitLabels}
          datasets={revisitDatasets}
          showLegend={true}
        />
      </div>
    </div>

    <div class="rankings-grid">
      <!-- Frequently added hosts -->
      <div class="ranking-card">
        <div class="ranking-header">
          <div class="ranking-title-group">
            <Icon name="link" size={18} />
            <h3>{i18n.t('dashboard.topHosts')}</h3>
          </div>
          <span class="ranking-badge">HOSTS TOP 10</span>
        </div>

        {#if topHosts.length > 0}
          <ol class="ranking-list">
            {#each topHosts as item, index}
              <li>
                <button
                  type="button"
                  class="ranking-item ranking-item--link"
                  aria-label={i18n.t('dashboard.hostDrilldownAria', { host: item.host })}
                  title={item.host}
                  on:click={() => handleDrilldown({ kind: 'host', host: item.host })}
                >
                  <span class="rank-number">{index + 1}</span>
                  <span class="item-name">{item.host}</span>
                  <span class="stamp-badge">{item.count}</span>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          <div class="empty-state">
            <p>{i18n.t('dashboard.emptyData')}</p>
          </div>
        {/if}
      </div>

      <!-- Frequently added folders -->
      <div class="ranking-card">
        <div class="ranking-header">
          <div class="ranking-title-group">
            <Icon name="folder" size={18} />
            <h3>{i18n.t('dashboard.topFolders')}</h3>
          </div>
          <span class="ranking-badge">FOLDERS TOP 10</span>
        </div>

        {#if topFolders.length > 0}
          <ol class="ranking-list">
            {#each topFolders as item, index}
              <li>
                <button
                  type="button"
                  class="ranking-item ranking-item--link"
                  aria-label={i18n.t('dashboard.folderDrilldownAria', { folder: folderLabel(item.folder) })}
                  title={item.folder}
                  on:click={() => handleDrilldown({ kind: 'folder', folder: item.folder })}
                >
                  <span class="rank-number">{index + 1}</span>
                  <span class="item-name">{folderLabel(item.folder)}</span>
                  <span class="stamp-badge">{item.count}</span>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          <div class="empty-state">
            <p>{i18n.t('dashboard.emptyData')}</p>
          </div>
        {/if}
      </div>
    </div>

    <TagTimeline
      timelineData={tagTimelineData}
      isLoading={timelineLoading}
      granularity={timelineGranularity}
      lineLimit={timelineLineLimit}
      on:selectTag={(e) => handleDrilldown({ kind: 'tag', tag: e.detail.tag })}
      on:changeGranularity={(e) => {
        timelineGranularity = e.detail.granularity;
        loadTagTimeline(timelineGranularity);
      }}
      on:changeLineLimit={(e) => {
        timelineLineLimit = e.detail.lineLimit;
      }}
    />
  {:else}
    <div class="loading-state">
      <Spinner size={40} variant="default" />
      <p>{i18n.t('dashboard.loadingStats')}</p>
    </div>
  {/if}
</div>

<style>
  .dashboard-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding-bottom: 2rem;
  }

  h2 {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--font-display);
    font-size: 1.35rem;
    font-weight: 700;
    margin: 0;
    letter-spacing: -0.025em;
    color: var(--text-primary);
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
  }

  .charts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 1.25rem;
    align-items: stretch;
  }

  .chart-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-height: 340px;
  }

  .stat-card {
    position: relative;
    overflow: hidden;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.25rem 1.5rem;
    border-radius: var(--radius-lg);
    background-color: var(--bg-secondary);
    border: 1px solid var(--border-color);
    transition: transform var(--transition-fast);
  }

  .stat-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background-color: var(--text-muted);
  }

  .stat-card.accent-ribbon::before { background-color: var(--color-primary); }
  .stat-card.accent-amber::before  { background-color: var(--color-warning); }
  .stat-card.accent-ink::before    { background-color: var(--text-muted); }

  .stat-card:hover {
    transform: translateY(-2px);
  }

  .stat-content {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .stat-label {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .stat-value {
    font-family: var(--font-mono);
    font-size: 1.625rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .stat-icon {
    color: var(--text-muted);
  }

  .rankings-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1.5rem;
  }

  .ranking-card {
    background-color: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: var(--card-padding-lg);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .ranking-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border-color);
  }

  .ranking-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-primary);
  }

  .ranking-title-group h3 {
    margin: 0;
    font-family: var(--font-accent);
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .ranking-badge {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .ranking-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .ranking-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 38px;
    padding: 0.375rem 0.75rem;
    border: none;
    border-radius: var(--radius-md);
    background-color: var(--bg-primary);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: none;
  }

  .ranking-item:hover,
  .ranking-item:focus-visible {
    background-color: var(--bg-tertiary);
    transform: translateX(2px);
    transition: background-color 80ms ease, transform 80ms ease;
  }

  /* Dashboard quick-select deep-link row — keyboard/focus visibility */
  .ranking-item--link:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .ranking-item,
    .ranking-item:hover,
    .ranking-item:focus-visible {
      transition: none;
      transform: none;
    }
  }

  .rank-number {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    font-weight: 700;
    min-width: 1.5rem;
    color: var(--color-primary);
  }

  .item-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.875rem;
    color: var(--text-primary);
  }

  .empty-state {
    padding: 2rem 0;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem 0;
    color: var(--text-secondary);
    gap: 1rem;
  }

  @media (max-width: 1024px) {
    .rankings-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
