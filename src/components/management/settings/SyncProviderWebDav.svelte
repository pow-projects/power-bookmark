<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';
  import { normalizeWebdavAuth } from '../../../lib/sync/webdav-settings';

  export let webdavUrl: string = '';
  export let webdavUsername: string = '';
  export let webdavPassword: string = '';
  export let isProcessing: boolean = false;

  const dispatch = createEventDispatcher<{
    connect: void;
  }>();

  let autoConnectTimer: ReturnType<typeof setTimeout> | null = null;

  function clearAutoConnectTimer() {
    if (autoConnectTimer) {
      clearTimeout(autoConnectTimer);
      autoConnectTimer = null;
    }
  }

  function triggerDebouncedConnect(delayMs = 1200) {
    clearAutoConnectTimer();
    autoConnectTimer = setTimeout(() => {
      dispatch('connect');
    }, delayMs);
  }

  function triggerImmediateConnect() {
    clearAutoConnectTimer();
    dispatch('connect');
  }

  function handleUrlInput() {
    const normalized = normalizeWebdavAuth(webdavUrl, webdavUsername, webdavPassword);
    // Trigger debounced connect only if auth info (user:pass@) is in URL or password already exists
    if (normalized.password || webdavPassword) {
      triggerDebouncedConnect();
    } else {
      clearAutoConnectTimer();
    }
  }

  function handleUsernameInput() {
    // Trigger debounced connect only if password is already populated (e.g., preserved password state)
    if (webdavPassword) {
      triggerDebouncedConnect();
    } else {
      clearAutoConnectTimer();
    }
  }

  function handlePasswordInput() {
    // Execute debounced connect when password is entered (if URL exists)
    if (webdavUrl.trim() && webdavPassword) {
      triggerDebouncedConnect();
    } else {
      clearAutoConnectTimer();
    }
  }
</script>

<div class="webdav-form-container">
  <div class="form-group">
    <label for="webdav-url">{i18n.t('syncWebDav.urlLabel')}</label>
    <input 
      type="text" 
      id="webdav-url" 
      class="form-input"
      bind:value={webdavUrl} 
      on:input={handleUrlInput}
      on:keydown={(e) => e.key === 'Enter' && triggerImmediateConnect()}
      placeholder="http://localhost:8085/" 
    />
    <span class="helper-text">{i18n.t('syncWebDav.urlHelper')}</span>
  </div>

  <div class="form-group">
    <label for="webdav-username">{i18n.t('syncWebDav.usernameLabel')}</label>
    <input 
      type="text" 
      id="webdav-username" 
      class="form-input"
      bind:value={webdavUsername} 
      autocomplete="username"
      on:input={handleUsernameInput}
      on:keydown={(e) => e.key === 'Enter' && triggerImmediateConnect()}
      placeholder="admin" 
    />
  </div>

  <div class="form-group">
    <label for="webdav-password">{i18n.t('syncWebDav.passwordLabel')}</label>
    <input 
      type="password" 
      id="webdav-password" 
      class="form-input"
      bind:value={webdavPassword} 
      autocomplete="current-password"
      on:focus={() => {
        if (webdavPassword === '****') {
          webdavPassword = '';
        }
      }}
      on:input={handlePasswordInput}
      on:keydown={(e) => e.key === 'Enter' && triggerImmediateConnect()}
      placeholder={i18n.t('syncWebDav.passwordPlaceholder')} 
    />
    <span class="helper-text">{i18n.t('syncWebDav.passwordHelper')}</span>
  </div>

  {#if isProcessing}
    <div class="status-badge processing">
      <Spinner size={14} variant="small" />
      <span>{i18n.t('syncWebDav.verifying')}</span>
    </div>
  {/if}
</div>

<style>
  .webdav-form-container {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .form-input {
    width: 100%;
    box-sizing: border-box;
    background-color: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.625rem 0.875rem;
    font-size: 0.875rem;
    font-family: var(--font-primary);
    outline: none;
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }

  .form-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--color-primary-light);
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.625rem;
    border-radius: var(--radius-md);
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
    align-self: flex-start;
  }

  .status-badge.processing {
    background-color: var(--bg-tertiary);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
  }

  .helper-text {
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.3;
  }
</style>
