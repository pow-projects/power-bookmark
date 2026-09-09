<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../../shared/Icon.svelte';

  export let count: number = 0;

  const dispatch = createEventDispatcher<{ review: void }>();
</script>

{#if count > 0}
  <div class="cross-root-banner">
    <div class="banner-left">
      <Icon name="alert-circle" size={18} />
      <div class="banner-message">
        {i18n.t('folders.crossRootBanner', { count })}
      </div>
    </div>
    <button type="button" class="btn btn-primary btn-sm banner-action-btn" on:click={() => dispatch('review')}>
      <Icon name="folder-plus" size={14} /> {i18n.t('folders.reviewAndApply')}
    </button>
  </div>
{/if}

<style>
  .cross-root-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1.25rem;
    background: var(--color-warning-light, rgba(234, 179, 8, 0.1));
    border: 1px solid var(--color-warning);
    border-radius: var(--radius-md);
    color: var(--text-primary);
  }

  .banner-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--color-warning-text);
  }

  .banner-message {
    font-size: 0.875rem;
  }
</style>
