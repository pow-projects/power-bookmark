<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../shared/Icon.svelte';
  import Spinner from '../shared/Spinner.svelte';

  export let bookmarkId: number;
  export let label = '';

  let hovered = false;
  const dispatch = createEventDispatcher<{ cancel: { bookmarkId: number } }>();

  function cancel() {
    dispatch('cancel', { bookmarkId });
  }
</script>

<button
  class="ai-task-badge"
  class:cancel={hovered}
  title={i18n.t('ai.taskCancelTooltip')}
  on:mouseenter={() => (hovered = true)}
  on:mouseleave={() => (hovered = false)}
  on:click={cancel}
>
  {#if hovered}
    <Icon name="x" size={12} />
    {i18n.t('ai.taskCancel')}
  {:else}
    <Spinner size={12} variant="inline" />
    {label || i18n.t('ai.taskBadge')}
  {/if}
</button>

<style>
  .ai-task-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.45rem;
    border-radius: var(--radius-sm);
    background-color: var(--color-primary-light);
    color: var(--color-primary);
    border: none;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1.2;
    cursor: pointer;
    transition: color .15s, background .15s;
  }
  .ai-task-badge.cancel {
    color: var(--color-danger);
    background: rgba(128, 128, 128, 0.12);
  }
</style>
