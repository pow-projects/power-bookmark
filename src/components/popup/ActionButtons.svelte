<script lang="ts">
  /**
   * v2: Action stack for registered item cards (REGISTERED only)
   * - Removed new mode branch (pages are already auto-registered upon extension button click) — t_popup_v2
   * - [Save Archive] / [View Archive] (primary, switched based on hasArchive)
   * - [Delete] -> dashed danger ghost (filled danger removed)
   * - Global spinner/button spins removed — progress shown in top status line + toolbar badge (R5)
   * - Test contract: retain `.btn-danger` class on delete button (styled via scoped ghost override)
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '../shared/Icon.svelte';

  export let hasArchive = false;
  export let isArchiving = false;
  export let isDeleting = false;
  export let successAction: 'archive' | 'delete' | null = null;

  const dispatch = createEventDispatcher();

  // Primary button: disabled only while enqueue is in progress (button locked) or stamp is displayed — R5: unrelated to autosave/deletion
  $: isPrimaryBusy = (isArchiving && successAction === null) || successAction !== null;
</script>

<div class="actions-row">
  <button
    type="button"
    class="btn btn-primary action-primary"
    disabled={isPrimaryBusy}
    on:click={() => hasArchive ? dispatch('viewArchive') : dispatch('archive')}
  >
    {#if successAction === 'archive'}
      <Icon name="check" size={16} />
      <span>{i18n.t('popup.saved')}</span>
    {:else if hasArchive}
      <Icon name="eye" size={16} />
      <span>{i18n.t('popup.actions.viewArchive')}</span>
    {:else}
      <Icon name="archive" size={16} />
      <span>{i18n.t('popup.actions.saveArchive')}</span>
    {/if}
  </button>

  <button
    type="button"
    class="btn btn-danger btn-danger-ghost action-delete"
    disabled={isDeleting || successAction !== null}
    on:click={() => dispatch('delete')}
  >
    {#if successAction === 'delete'}
      <Icon name="check" size={16} />
      <span>{i18n.t('popup.actions.deleted')}</span>
    {:else}
      <Icon name="trash-2" size={16} />
      <span>{i18n.t('popup.actions.delete')}</span>
    {/if}
  </button>
</div>

<style>
  /* Single line layout for archive / delete */
  .actions-row {
    display: flex;
    flex-direction: row;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .action-primary,
  .action-delete {
    flex: 1;
    min-width: 0;
    justify-content: center;
  }

  /* Delete = dashed danger ghost — removed filled danger button (v2).
     Scoped specificity is higher than global .btn-danger(filled). */
  .btn-danger-ghost {
    background: transparent;
    border: 1px dashed var(--color-danger);
    color: var(--color-danger);
    font-weight: 500;
    box-shadow: none;
  }
  .btn-danger-ghost:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger) 8%, transparent);
    transform: none;
  }

  .action-primary:disabled,
  .action-delete:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
