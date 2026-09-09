<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import Icon from './Icon.svelte';

  export let title: string = '';
  export let open: boolean = false;
  export let size: 'sm' | 'md' | 'lg' | 'xl' = 'md';
  export let closable: boolean = true;

  const dispatch = createEventDispatcher<{ close: void }>();

  let modalEl: HTMLElement;
  let previouslyFocused: HTMLElement | null = null;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && closable) {
      dispatchClose();
    }
    if (e.key === 'Tab' && open) {
      trapFocus(e);
    }
  }

  function trapFocus(e: KeyboardEvent) {
    const focusable = modalEl?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    ) as NodeListOf<HTMLElement>;
    if (!focusable || !focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function dispatchClose() {
    if (!closable) return;
    dispatch('close');
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget && closable) {
      dispatchClose();
    }
  }

  $: if (open && typeof document !== 'undefined') {
    if (!previouslyFocused) {
      previouslyFocused = document.activeElement as HTMLElement;
    }
    setTimeout(() => {
      if (modalEl) {
        modalEl.focus();
      }
    }, 0);
  } else if (!open && previouslyFocused) {
    previouslyFocused.focus();
    previouslyFocused = null;
  }

  onDestroy(() => {
    if (previouslyFocused) {
      previouslyFocused.focus();
      previouslyFocused = null;
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-backdrop" role="presentation" on:mousedown={handleBackdropClick}>
    <div
      class="modal modal-{size} glass-panel modal-container"
      bind:this={modalEl}
      tabindex="-1"
      on:keydown={handleKeydown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div class="modal-header">
        <slot name="header">
          <h4 id="modal-title">{title}</h4>
        </slot>
        <div class="modal-header-actions">
          <slot name="header-actions" />
          {#if closable}
            <button class="btn-icon btn-close-icon btn-close" on:click={dispatchClose} aria-label={i18n.t('common.close')}>
              <Icon name="x" size={20} />
            </button>
          {/if}
        </div>
      </div>
      <div class="modal-body">
        <slot></slot>
      </div>
      {#if $$slots.footer}
        <div class="modal-footer">
          <slot name="footer"></slot>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background-color: var(--modal-backdrop-bg);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1rem;
    box-sizing: border-box;
  }

  .modal {
    background-color: var(--bg-secondary);
    border-radius: var(--modal-radius);
    border: 1px solid var(--border-color);
    padding: 1.5rem;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 1rem;
    outline: none;
    max-height: calc(100vh - 2rem);
    box-sizing: border-box;
  }

  .modal-sm { max-width: 320px; width: 100%; }
  .modal-md { max-width: 480px; width: 100%; }
  .modal-lg { max-width: 860px; width: 90vw; }
  .modal-xl {
    max-width: 1100px;
    width: 90vw;
    height: 88vh;
    display: flex;
    flex-direction: column;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    flex-shrink: 0;
  }

  .modal-header h4 {
    margin: 0;
    font-family: var(--font-accent);
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .modal-header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .btn-close-icon {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0.375rem;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color var(--transition-fast), background-color var(--transition-fast);
  }

  .btn-close-icon:hover {
    color: var(--text-primary);
    background-color: var(--bg-tertiary);
  }

  .modal-body {
    flex-grow: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.5rem;
    flex-shrink: 0;
  }
</style>
