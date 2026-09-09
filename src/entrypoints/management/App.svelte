<script lang="ts">
  import { onMount } from 'svelte';
  import ThemeToggle from '../../components/management/ThemeToggle.svelte';
  import StatsDashboard from '../../components/management/StatsDashboard.svelte';
  import BookmarkList from '../../components/management/BookmarkList.svelte';
  import SettingsContainer from '../../components/management/SettingsContainer.svelte';
  import Toast from '../../components/shared/Toast.svelte';
  import Icon from '../../components/shared/Icon.svelte';

  // Currently active tab
  let activeTab: 'stats' | 'bookmarks' | 'settings' = 'stats';
  let activeSection: 'archive' | 'sync' | 'ai' = 'archive';

  // Sidebar collapse state
  let sidebarCollapsed = false;

  // Conflict modal
  let showConflictModal = false;

  // App version from manifest
  const appVersion =
    (typeof browser !== 'undefined' && browser.runtime?.getManifest?.()?.version) ||
    (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version) ||
    '';

  import ConflictResolverModal from '../../components/management/ConflictResolverModal.svelte';
  import { hasPendingConflicts } from '../../lib/sync/sync-conflict-store';

  function syncTabFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get('tab');
    const sectionParam = urlParams.get('section');
    const archiveIdParam = urlParams.get('archiveId');
    
    if (archiveIdParam || tabParam === 'bookmarks') {
      activeTab = 'bookmarks';
    } else if (tabParam === 'sync') {
      // Legacy ?tab=sync compatibility: redirect to sync subsection in settings tab
      activeTab = 'settings';
      activeSection = 'sync';
      const newUrl = window.location.pathname + `?tab=settings&section=sync`;
      window.history.replaceState({ tab: 'settings', section: 'sync' }, '', newUrl);
    } else if (tabParam === 'settings') {
      activeTab = 'settings';
      if (sectionParam === 'sync' || sectionParam === 'ai' || sectionParam === 'archive') {
        activeSection = sectionParam as any;
      }
    } else if (tabParam && isValidTab(tabParam)) {
      activeTab = tabParam as any;
    } else {
      activeTab = 'stats';
    }
  }

  onMount(() => {
    syncTabFromUrl();
    const handlePopState = () => {
      syncTabFromUrl();
    };
    window.addEventListener('popstate', handlePopState);
    
    checkPendingConflicts();
    document.addEventListener('sync-conflicts-detected', handleConflictsDetected);
    
    return () => {
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('sync-conflicts-detected', handleConflictsDetected);
    };
  });

  async function checkPendingConflicts() {
    if (await hasPendingConflicts()) {
      showConflictModal = true;
    }
  }

  function handleConflictsDetected() {
    showConflictModal = true;
  }

  function isValidTab(tab: string): boolean {
    return ['stats', 'bookmarks', 'settings'].includes(tab);
  }

  function handleTabChange(tab: typeof activeTab) {
    activeTab = tab;
    const newUrl = window.location.pathname + `?tab=${tab}`;
    window.history.pushState({ tab }, '', newUrl);
  }
</script>

<div class="management-layout">
  <!-- Left sidebar -->
  <aside class="sidebar {sidebarCollapsed ? 'collapsed' : ''}">
    <div class="sidebar-header">
      <img src="/icons/icon-128.png" class="logo-icon" width="24" height="24" alt="PowerBookmark" />
      {#if !sidebarCollapsed}
        <h1>PowerBookmark</h1>
      {/if}
      <button class="collapse-toggle" on:click={() => sidebarCollapsed = !sidebarCollapsed}
        title={sidebarCollapsed ? i18n.t('nav.sidebarExpand') : i18n.t('nav.sidebarCollapse')}>
        <Icon name={sidebarCollapsed ? 'chevron-right' : 'chevron-left'} size={16} />
      </button>
    </div>

    <nav class="sidebar-nav">
      <button 
        class="nav-item {activeTab === 'stats' ? 'active' : ''}" 
        on:click={() => handleTabChange('stats')}
        title={sidebarCollapsed ? i18n.t('nav.dashboard') : undefined}
      >
        <Icon name="bar-chart" size={18} /> {#if !sidebarCollapsed}<span>{i18n.t('nav.dashboard')}</span>{/if}
      </button>

      <button 
        class="nav-item {activeTab === 'bookmarks' ? 'active' : ''}" 
        on:click={() => handleTabChange('bookmarks')}
        title={sidebarCollapsed ? i18n.t('nav.bookmarks') : undefined}
      >
        <Icon name="bookmark" size={18} /> {#if !sidebarCollapsed}<span>{i18n.t('nav.bookmarks')}</span>{/if}
      </button>

      <button 
        class="nav-item {activeTab === 'settings' ? 'active' : ''}" 
        on:click={() => handleTabChange('settings')}
        title={sidebarCollapsed ? i18n.t('nav.settings') : undefined}
      >
        <Icon name="settings" size={18} /> {#if !sidebarCollapsed}<span>{i18n.t('nav.settings')}</span>{/if}
      </button>
    </nav>

    <div class="sidebar-footer">
      <ThemeToggle collapsed={sidebarCollapsed} />
      {#if !sidebarCollapsed && appVersion}
        <span class="version">v{appVersion}</span>
      {/if}
    </div>
  </aside>

  <!-- Right main content area -->
  <main class="main-content">
    {#if activeTab === 'stats'}
      <StatsDashboard />
    {:else if activeTab === 'bookmarks'}
      <BookmarkList />
    {:else if activeTab === 'settings'}
      <SettingsContainer bind:initialSection={activeSection} />
    {/if}
  </main>
  <Toast />
</div>

{#if showConflictModal}
  <ConflictResolverModal on:close={() => showConflictModal = false} />
{/if}

<style>
  .management-layout {
    --sidebar-width: 260px;
    --sidebar-width-collapsed: 72px;
    display: flex;
    min-height: 100vh;
    background-color: var(--bg-primary);
    color: var(--text-primary);
  }

  /* Sidebar styles */
  .sidebar {
    width: var(--sidebar-width);
    background-color: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    padding: 1.5rem 1rem;
    box-sizing: border-box;
    position: fixed;
    height: 100vh;
    z-index: 10;
    transition: width var(--transition-fast);
  }

  .sidebar.collapsed {
    width: var(--sidebar-width-collapsed);
    padding: 1.5rem 0.5rem;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-bottom: 2rem;
    padding: 0 0.5rem;
  }

  .sidebar.collapsed .sidebar-header {
    justify-content: center;
    gap: 0;
    padding: 0;
    margin-bottom: 1.5rem;
  }

  .collapse-toggle {
    margin-left: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
    flex-shrink: 0;
  }

  .collapse-toggle:hover {
    background-color: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .sidebar.collapsed .collapse-toggle {
    margin-left: 0;
  }

  .logo-icon {
    display: block;
    width: 24px;
    height: 24px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .sidebar-header h1 {
    font-family: var(--font-display);
    font-size: 1.2rem;
    font-weight: 700;
    margin: 0;
    letter-spacing: -0.03em;
  }

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    flex-grow: 1;
  }

  .sidebar.collapsed .sidebar-nav {
    align-items: center;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: none;
    border: none;
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    transition: all var(--transition-fast);
    position: relative;
    width: 100%;
  }

  .sidebar.collapsed .nav-item {
    justify-content: center;
    padding: 0.75rem;
  }

  .nav-item:hover {
    background-color: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .nav-item.active {
    background-color: transparent;
    color: var(--color-primary);
  }

  .nav-item.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 4px;
    bottom: 4px;
    width: 4px;
    background-color: var(--color-primary);
    clip-path: polygon(0 0, 100% 0, 100% 100%, 50% calc(100% - 4px), 0 100%);
  }

  .sidebar-footer {
    margin-top: auto;
    padding-top: 1.5rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .sidebar.collapsed .sidebar-footer {
    justify-content: center;
  }

  .version {
    font-size: 0.725rem;
    color: var(--text-muted);
    font-weight: 600;
    font-family: var(--font-mono);
  }

  /* Main content area styles */
  .main-content {
    flex-grow: 1;
    margin-left: var(--sidebar-width); /* Add margin matching fixed sidebar width */
    padding: 2rem 2.5rem;
    box-sizing: border-box;
    min-height: 100vh;
    transition: margin-left var(--transition-fast);
  }

  .sidebar.collapsed ~ .main-content {
    margin-left: var(--sidebar-width-collapsed);
  }

  @media (max-width: 768px) {
    .sidebar {
      width: var(--sidebar-width-collapsed);
      padding: 1.5rem 0.5rem;
    }
    .sidebar-header {
      justify-content: center;
      padding: 0;
      margin-bottom: 1.5rem;
    }
    .collapse-toggle {
      display: none;
    }
    .sidebar h1,
    .sidebar .nav-item span,
    .sidebar .version {
      display: none;
    }
    .main-content {
      margin-left: var(--sidebar-width-collapsed);
      padding: 1.5rem;
    }
  }
</style>
