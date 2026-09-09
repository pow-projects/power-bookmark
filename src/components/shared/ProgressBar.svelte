<script lang="ts">
  export let value: number = 0; // 0 to 100
  export let max: number = 100;
  export let variant: 'primary' | 'success' | 'danger' = 'primary';
  export let height: number = 6;
  export let showText: boolean = false;

  $: percentage = Math.min(100, Math.max(0, max > 0 ? (value / max) * 100 : 0));
</script>

<div class="progress-bar-wrapper">
  {#if showText}
    <div class="progress-bar-text">
      <slot>{Math.round(percentage)}%</slot>
    </div>
  {/if}
  <div class="progress-bar-container" style="height: {height}px;">
    <div
      class="progress-bar-fill {variant === 'success' ? 'progress-bar-success' : ''}"
      style="width: {percentage}%; {variant === 'danger' ? 'background-color: var(--color-danger);' : ''}"
    ></div>
  </div>
</div>

<style>
  .progress-bar-wrapper {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .progress-bar-text {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--text-secondary);
  }
</style>
