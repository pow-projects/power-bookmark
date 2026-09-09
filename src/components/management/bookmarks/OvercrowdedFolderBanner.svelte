<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../../shared/Icon.svelte';

  export let folder: string = '';
  export let count: number = 0;
  export let visible: boolean = true;

  const dispatch = createEventDispatcher<{
    dismiss: void;
  }>();
</script>

{#if visible && folder && count >= 50}
  <div class="overcrowded-folder-banner" role="status" aria-live="polite">
    <div class="banner-left">
      <span class="banner-icon">
        <Icon name="alert-circle" size={18} />
      </span>
      <span class="banner-message">
        {i18n.t('folders.overcrowdedBanner', { folder, count })}
      </span>
    </div>
    <div class="banner-actions">
      <button
        type="button"
        class="btn-dismiss"
        title={i18n.t('folders.dismissOvercrowded')}
        aria-label={i18n.t('folders.dismissOvercrowded')}
        on:click={() => dispatch('dismiss')}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  </div>
{/if}

<style>
  .overcrowded-folder-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1.25rem;
    background: var(--color-warning-light, rgba(234, 179, 8, 0.1));
    border: 1px solid var(--color-warning, #B45309);
    border-radius: var(--radius-md, 8px);
    color: var(--text-primary);
    gap: 1rem;
    animation: fadeIn var(--transition-normal, 0.2s ease);
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .banner-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .banner-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-warning, #B45309);
    flex-shrink: 0;
  }

  .banner-message {
    font-size: 0.875rem;
    line-height: 1.4;
    color: var(--text-primary);
    word-break: break-word;
  }

  .banner-actions {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .btn-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm, 4px);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color var(--transition-fast, 0.15s ease), color var(--transition-fast, 0.15s ease);
  }

  .btn-dismiss:hover {
    background: var(--bg-hover, rgba(0, 0, 0, 0.06));
    color: var(--text-primary);
  }

  .btn-dismiss:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
</style>
