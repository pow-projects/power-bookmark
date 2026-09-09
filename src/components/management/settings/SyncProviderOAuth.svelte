<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';
  import { showToast } from '../../../lib/ui/toast-store';

  export let provider: 'google-drive' | 'onedrive' | 'dropbox';
  export let clientId: string = '';
  export let clientSecret: string = '';
  export let isProcessing: boolean = false;
  export let redirectUri: string = '';

  const dispatch = createEventDispatcher<{
    connect: void;
  }>();

  let isCopied = false;
  let autoConnectTimer: ReturnType<typeof setTimeout> | null = null;

  function clearAutoConnectTimer() {
    if (autoConnectTimer) {
      clearTimeout(autoConnectTimer);
      autoConnectTimer = null;
    }
  }

  function canConnect(): boolean {
    const rawId = clientId.trim();
    const rawSecret = clientSecret.trim();
    if (provider === 'google-drive') {
      return !!(rawId && rawSecret);
    }
    return !!rawId;
  }

  function triggerDebouncedConnect(delayMs = 1200) {
    clearAutoConnectTimer();
    if (!canConnect()) return;
    autoConnectTimer = setTimeout(() => {
      dispatch('connect');
    }, delayMs);
  }

  function triggerImmediateConnect() {
    clearAutoConnectTimer();
    if (!canConnect()) return;
    dispatch('connect');
  }

  function selectRedirectInput(e: MouseEvent) {
    (e.target as HTMLInputElement).select();
  }

  async function copyRedirectUri() {
    if (!redirectUri) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      isCopied = true;
      showToast(i18n.t('syncOAuth.clipboardCopied'), 'success');
      setTimeout(() => { isCopied = false; }, 2000);
    } catch {
      showToast(i18n.t('syncOAuth.clipboardCopyFailed'), 'error');
    }
  }

  $: config = getProviderConfig(provider);

  function getProviderConfig(p: 'google-drive' | 'onedrive' | 'dropbox') {
    switch (p) {
      case 'google-drive':
        return {
          id: 'gdrive-client-id',
          label: 'Google OAuth2 Client ID',
          placeholder: i18n.t('syncOAuth.google.placeholder'),
          guideTitle: i18n.t('syncOAuth.google.guideTitle'),
          guideDesc: i18n.t('syncOAuth.google.guideDesc'),
          providerName: 'Google Drive',
          helperText: i18n.t('syncOAuth.google.helperText')
        };
      case 'onedrive':
        return {
          id: 'onedrive-client-id',
          label: 'OneDrive Application Client ID',
          placeholder: i18n.t('syncOAuth.onedrive.placeholder'),
          guideTitle: i18n.t('syncOAuth.onedrive.guideTitle'),
          guideDesc: i18n.t('syncOAuth.onedrive.guideDesc'),
          providerName: 'OneDrive',
          helperText: i18n.t('syncOAuth.helperText')
        };
      case 'dropbox':
        return {
          id: 'dropbox-client-id',
          label: 'Dropbox App Key / Client ID',
          placeholder: i18n.t('syncOAuth.dropbox.placeholder'),
          guideTitle: i18n.t('syncOAuth.dropbox.guideTitle'),
          guideDesc: i18n.t('syncOAuth.dropbox.guideDesc'),
          providerName: 'Dropbox',
          helperText: i18n.t('syncOAuth.helperText')
        };
    }
  }
</script>

{#if redirectUri}
  <div class="redirect-uri-card">
    <div class="redirect-uri-header">
      <div class="redirect-title-group">
        <Icon name="link" size={15} />
        <span class="redirect-title">{config.guideTitle}</span>
      </div>
      <span class="stamp-badge">{i18n.t('syncOAuth.requiredAddress')}</span>
    </div>
    <p class="redirect-desc">{config.guideDesc}</p>
    <div class="uri-copy-row">
      <input type="text" readonly value={redirectUri} class="form-input uri-input" on:click={selectRedirectInput} />
      <button type="button" class="btn btn-secondary btn-sm copy-btn" on:click={copyRedirectUri} title={i18n.t('syncOAuth.copyAddress')}>
        {#if isCopied}
          <Icon name="check" size={14} /> <span>{i18n.t('syncOAuth.copied')}</span>
        {:else}
          <Icon name="copy" size={14} /> <span>{i18n.t('syncOAuth.copyAddress')}</span>
        {/if}
      </button>
    </div>
  </div>
{/if}

<div class="form-group">
  <label for={config.id}>{config.label}</label>
  <div class="input-with-status">
    <input 
      type="text" 
      id={config.id} 
      class="form-input"
      bind:value={clientId} 
      on:input={() => triggerDebouncedConnect()}
      on:blur={triggerImmediateConnect}
      on:keydown={(e) => e.key === 'Enter' && triggerImmediateConnect()}
      placeholder={config.placeholder} 
    />
    {#if isProcessing}
      <div class="status-badge processing">
        <Spinner size={14} variant="small" />
        <span>{i18n.t('syncOAuth.verifying')}</span>
      </div>
    {/if}
  </div>
  <span class="helper-text">{config.helperText}</span>
</div>

<div class="form-group">
  <label for="{config.id}-secret">{i18n.t('syncOAuth.secretLabel')}</label>
  <input 
    type="password" 
    id="{config.id}-secret" 
    class="form-input"
    bind:value={clientSecret} 
    on:input={() => triggerDebouncedConnect()}
    on:blur={triggerImmediateConnect}
    on:keydown={(e) => e.key === 'Enter' && triggerImmediateConnect()}
    placeholder={i18n.t('syncOAuth.secretPlaceholder')} 
  />
  <span class="helper-text">{i18n.t('syncOAuth.secretHelper')}</span>
</div>

<style>
  .redirect-uri-card {
    background-color: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.875rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .redirect-uri-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .redirect-title-group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--text-primary);
  }

  .redirect-title {
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .redirect-desc {
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.4;
  }

  .uri-copy-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.25rem;
  }

  .uri-input {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    padding: 0.4rem 0.625rem;
    background-color: var(--bg-tertiary);
    cursor: text;
    user-select: all;
    flex-grow: 1;
  }

  .copy-btn {
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4rem 0.75rem;
    font-size: 0.75rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-group label {
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

  .input-with-status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .input-with-status .form-input {
    flex-grow: 1;
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
