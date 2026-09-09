<script lang="ts">
  import Icon from './Icon.svelte';

  export let icon: string = 'archive';
  export let title: string = '';
  export let description: string = '';
  export let iconSize: number = 40;
</script>

<div class="empty-state">
  <div class="empty-state-icon">
    <slot name="icon">
      <Icon name={icon} size={iconSize} />
    </slot>
  </div>
  <h3 class="empty-state-title">{title || i18n.t('common.empty')}</h3>
  {#if description}
    <p class="empty-state-desc">{description}</p>
  {/if}
  <div class="empty-state-actions">
    <slot />
  </div>
</div>

<style>
  .empty-state-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }
</style>
