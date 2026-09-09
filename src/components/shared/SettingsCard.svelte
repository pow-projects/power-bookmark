<script lang="ts">
  import Icon from './Icon.svelte';

  export let title: string = '';
  export let icon: string = '';
</script>

<div class="settings-card">
  <h3>
    {#if icon}
      <Icon name={icon} size={18} />
    {/if}
    {title}
  </h3>
  <hr class="divider" />
  <div class="form-container">
    <slot></slot>
  </div>
</div>

<style>
  .settings-card {
    padding: 1.5rem;
    border-radius: var(--radius-lg);
    background-color: var(--bg-secondary);
    border: 1px solid var(--border-color);
    max-width: 600px;
    margin: 0 auto;
  }

  h3 {
    margin-top: 0;
    margin-bottom: 1rem;
    font-family: var(--font-accent);
    color: var(--text-primary);
    font-size: 1.05rem;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .divider {
    border: 0;
    height: 1px;
    background-color: var(--border-color);
    margin-bottom: 1.25rem;
  }

  .form-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
