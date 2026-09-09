<script lang="ts">
  export let size: number = 16;
  export let variant: 'default' | 'small' | 'inline' = 'default';
</script>

{#if variant === 'inline'}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="spinner-inline"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
  </svg>
{:else}
  <div class="spinner {variant}" aria-label={i18n.t('spinner.loadingAria')}>
    <div class="spinner-track"></div>
  </div>
{/if}

<style>
  .spinner {
    display: inline-block;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  .spinner.default {
    width: 16px;
    height: 16px;
    border: 2px solid var(--text-muted);
    border-top: 2px solid var(--color-primary);
  }

  .spinner.small {
    width: 10px;
    height: 10px;
    border: 2px solid var(--text-muted);
    border-top: 2px solid var(--color-primary);
  }

  .spinner-inline {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
</style>
