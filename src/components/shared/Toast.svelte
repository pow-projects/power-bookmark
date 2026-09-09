<script lang="ts">
  import { toasts } from '../../lib/ui/toast-store';
  import { slide } from 'svelte/transition';
  import Icon from './Icon.svelte';
</script>

<div class="toast-container">
  {#each $toasts as toast (toast.id)}
    <div class="toast-item {toast.type}" transition:slide={{ duration: 200 }}>
      <div class="toast-content">
        {#if toast.type === 'success'}
          <span class="icon success-icon"><Icon name="check" size={16} /></span>
        {:else if toast.type === 'error'}
          <span class="icon error-icon"><Icon name="alert-circle" size={16} /></span>
        {:else}
          <span class="icon info-icon"><Icon name="info" size={16} /></span>
        {/if}
        <span class="message">{toast.message}</span>
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
    max-width: 320px;
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

  .toast-content {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .icon {
    flex-shrink: 0;
  }

  .success-icon {
    color: var(--color-success);
  }

  .error-icon {
    color: var(--color-danger);
  }

  .info-icon {
    color: var(--color-warning);
  }

  .message {
    color: var(--text-primary);
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.25rem;
    word-break: break-all;
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

  .toast-item.success .progress-bar {
    background: var(--color-success);
  }

  .toast-item.error .progress-bar {
    background: var(--color-danger);
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
</style>
