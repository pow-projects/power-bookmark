<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import Spinner from './Spinner.svelte';

  export let open: boolean = false;
  export let title: string = '';
  export let message: string = '';
  export let confirmText: string = '';
  export let cancelText: string = '';
  export let danger: boolean = false;
  export let loading: boolean = false;
  export let size: 'sm' | 'md' | 'lg' | 'xl' = 'sm';

  const dispatch = createEventDispatcher<{
    confirm: void;
    close: void;
  }>();

  function handleConfirm() {
    dispatch('confirm');
  }

  function handleClose() {
    if (loading) return;
    dispatch('close');
  }
</script>

<Modal {open} title={title || (danger ? i18n.t('modal.deleteTitle') : i18n.t('modal.confirmTitle'))} {size} closable={!loading} on:close={handleClose}>
  <div class="confirm-body">
    {#if danger}
      <div class="confirm-icon-danger">
        <Icon name="alert-triangle" size={22} />
      </div>
    {/if}
    <div class="confirm-text">
      {#if message}
        <p class="confirm-message">{message}</p>
      {/if}
      <slot></slot>
    </div>
  </div>

  <div slot="footer" class="modal-actions">
    <slot name="actions">
      <button type="button" class="btn btn-secondary" on:click={handleClose} disabled={loading}>
        {cancelText || i18n.t('common.cancel')}
      </button>
      <button
        type="button"
        class="btn {danger ? 'btn-danger' : 'btn-primary'}"
        on:click={handleConfirm}
        disabled={loading}
      >
        {#if loading}
          <Spinner size={14} variant="inline" />
        {/if}
        <span>{confirmText || (danger ? i18n.t('common.delete') : i18n.t('common.confirm'))}</span>
      </button>
    </slot>
  </div>
</Modal>

<style>
  .confirm-body {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    padding: 0.25rem 0;
  }

  .confirm-icon-danger {
    color: var(--color-danger);
    background: rgba(185, 58, 51, 0.12);
    border: 1px solid rgba(185, 58, 51, 0.25);
    padding: 0.5rem;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .confirm-text {
    flex-grow: 1;
  }

  .confirm-message {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text-primary);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }
</style>
