<script lang="ts">
  import { onMount } from 'svelte';
  import db from '../../lib/db';
  import Icon from '../shared/Icon.svelte';

  // Whether sidebar is in collapsed (icons-only) state
  export let collapsed: boolean = false;

  let theme: 'light' | 'dark' = 'light';

  onMount(async () => {
    // 1. Load saved theme
    const savedTheme = (await db.settings.get('theme'))?.value;
    if (savedTheme === 'light' || savedTheme === 'dark') {
      theme = savedTheme;
    } else {
      // 2. Detect OS preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      theme = prefersDark ? 'dark' : 'light';
    }
    
    applyTheme();
  });

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', theme);
  }

  async function toggleTheme() {
    theme = theme === 'light' ? 'dark' : 'light';
    applyTheme();
    await db.settings.put({ key: 'theme', value: theme });
  }
</script>

<button
  class="theme-btn {collapsed ? 'collapsed' : ''}"
  class:collapsed
  on:click={toggleTheme}
  aria-label={i18n.t('theme.toggleAria')}
  title={collapsed ? (theme === 'light' ? i18n.t('theme.switchToDark') : i18n.t('theme.switchToLight')) : undefined}
>
  {#if theme === 'light'}
    <Icon name="moon" size={18} />
    <span class="btn-text">{i18n.t('theme.darkMode')}</span>
  {:else}
    <Icon name="sun" size={18} />
    <span class="btn-text">{i18n.t('theme.lightMode')}</span>
  {/if}
</button>

<style>
  .theme-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.875rem;
    font-size: 0.825rem;
    font-weight: 600;
    color: var(--text-primary);
    cursor: pointer;
    transition: all var(--transition-fast);
    box-sizing: border-box;
    white-space: nowrap;
  }

  .theme-btn:hover {
    border-color: var(--border-focus);
    background-color: var(--bg-tertiary);
    transform: translateY(-1px);
  }

  .theme-btn:active {
    transform: translateY(0);
  }

  /* Collapsed sidebar: square button with icon only, provides tooltip */
  .theme-btn.collapsed {
    width: 38px;
    height: 38px;
    padding: 0;
    flex-shrink: 0;
  }

  .theme-btn.collapsed .btn-text {
    display: none;
  }

  /* Narrow screen: sidebar automatically collapses via CSS, keep icon only */
  @media (max-width: 768px) {
    .theme-btn {
      width: 38px;
      height: 38px;
      padding: 0;
      flex-shrink: 0;
    }
    .theme-btn .btn-text {
      display: none;
    }
  }
</style>
