<script lang="ts">
  import { onDestroy } from 'svelte';
  import { toasts, dismissToast, pauseToast, resumeToast } from '../../lib/ui/toast-store';
  import { slide } from 'svelte/transition';
  import Icon from './Icon.svelte';

  let copiedId: string | null = null;
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function handleCopy(message: string, id: string): Promise<void> {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message);
      }
      copiedId = id;
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => {
        copiedId = null;
      }, 1500);
    } catch (e) {
      console.error('Failed to copy toast message', e);
    }
  }

  onDestroy(() => {
    if (copyTimeout) {
      clearTimeout(copyTimeout);
    }
  });
</script>

<div class="toast-container" aria-live="polite" aria-atomic="true">
  {#each $toasts as toast (toast.id)}
    <div
      class="toast-item {toast.type}"
      role={toast.type === 'error' || toast.type === 'warning' ? 'alert' : 'status'}
      on:mouseenter={() => pauseToast(toast.id)}
      on:mouseleave={() => resumeToast(toast.id)}
      transition:slide={{ duration: prefersReducedMotion ? 0 : 200 }}
    >
      <div class="toast-content">
        {#if toast.type === 'success'}
          <span class="icon success-icon"><Icon name="check" size={16} /></span>
        {:else if toast.type === 'error'}
          <span class="icon error-icon"><Icon name="alert-circle" size={16} /></span>
        {:else if toast.type === 'warning'}
          <span class="icon warning-icon"><Icon name="alert-triangle" size={16} /></span>
        {:else}
          <span class="icon info-icon"><Icon name="info" size={16} /></span>
        {/if}

        <div class="message-wrapper">
          <span class="message">{toast.message}</span>
          {#if toast.count && toast.count > 1}
            <span class="count-badge">x{toast.count}</span>
          {/if}
        </div>

        <div class="toast-actions">
          {#if toast.type === 'error' && toast.message.length > 40}
            <button
              type="button"
              class="action-btn copy-btn"
              title="Copy error message"
              aria-label="Copy error message"
              on:click|stopPropagation={() => handleCopy(toast.message, toast.id)}
            >
              <Icon name={copiedId === toast.id ? 'check' : 'copy'} size={14} />
            </button>
          {/if}
          <button
            type="button"
            class="action-btn dismiss-btn"
            title="Dismiss notification"
            aria-label="Dismiss notification"
            on:click|stopPropagation={() => dismissToast(toast.id)}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>
      <div class="progress-bar" style="animation-duration: {toast.duration}ms"></div>
    </div>
  {/each}
</div>

<style>
  .toast-container {
    position: fixed;
    top: 1rem;
    right: 1rem;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none;
    max-width: 340px;
    width: calc(100% - 2rem);
  }

  .toast-item {
    pointer-events: auto;
    position: relative;
    background: var(--toast-bg);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid var(--toast-border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .toast-item.warning {
    border-color: var(--color-warning);
  }

  .toast-content {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .icon {
    flex-shrink: 0;
    margin-top: 2px;
  }

  .success-icon {
    color: var(--color-success);
  }

  .error-icon {
    color: var(--color-danger);
  }

  .warning-icon {
    color: var(--color-warning);
  }

  .info-icon {
    color: var(--color-warning);
  }

  .message-wrapper {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .message {
    color: var(--text-primary);
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.25rem;
    overflow-wrap: anywhere;
    word-break: normal;
  }

  .count-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.375rem;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1rem;
    border-radius: 9999px;
    background: var(--bg-tertiary, rgba(255, 255, 255, 0.12));
    color: var(--text-primary);
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  }

  .toast-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
    flex-shrink: 0;
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    padding: 0.25rem;
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease;
  }

  .action-btn:hover {
    color: var(--text-primary);
    background: rgba(128, 128, 128, 0.15);
  }

  .action-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .progress-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    height: 3px;
    background: currentColor;
    width: 100%;
    animation: shrink linear forwards;
  }

  .toast-item:hover .progress-bar {
    animation-play-state: paused;
  }

  .toast-item.success .progress-bar {
    background: var(--color-success);
  }

  .toast-item.error .progress-bar {
    background: var(--color-danger);
  }

  .toast-item.warning .progress-bar {
    background: var(--color-warning);
  }

  .toast-item.info .progress-bar {
    background: var(--color-warning);
  }

  @keyframes shrink {
    from {
      width: 100%;
    }
    to {
      width: 0%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast-item {
      transition: none !important;
      animation: none !important;
    }

    .progress-bar {
      display: none !important;
    }
  }
</style>
