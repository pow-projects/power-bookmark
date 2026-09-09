<script lang="ts">
  /**
   * Management section shared header (pure presentation component)
   *
   * - No browser API / DB access — renders only from props. No events/dispatch.
   * - Signature: top 3px hairline + mono eyebrow + Pretendard title + right count badge / actions slot.
   * - Intended inside fixed panels (cards) — glass-panel disallowed, sits on parent's solid surface.
   *
   * Example usage:
   *   <SectionHeader title="Results" eyebrow="results" count={filteredBookmarks.length}>
   *     <svelte:fragment slot="actions"><button class="btn btn-sm">...</button></svelte:fragment>
   *   </SectionHeader>
   */
  export let title: string;
  export let eyebrow: string = '';
  export let count: number | undefined = undefined; // Hides badge if undefined
</script>

<header class="section-header">
  <div class="section-header-text">
    {#if eyebrow}
      <span class="section-eyebrow">{eyebrow}</span>
    {/if}
    <h3 class="section-title">{title}</h3>
  </div>
  <div class="section-header-side">
    {#if count !== undefined}
      <span class="section-count">{count}</span>
    {/if}
    {#if $$slots.actions}
      <div class="section-actions">
        <slot name="actions" />
      </div>
    {/if}
  </div>
</header>

<style>
  .section-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0 0.625rem;
    background: transparent; /* Sits on parent solid surface — glass prohibited */
    font-family: var(--font-primary);
  }

  .section-header-text {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .section-eyebrow {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    /* Keep lowercase (no text-transform) */
  }

  .section-title {
    margin: 0;
    font-family: var(--font-primary);
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.3;
  }

  .section-header-side {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .section-count {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-secondary);
    padding: 0.1875rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    white-space: nowrap;
  }

  .section-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  @media (max-width: 900px) {
    .section-header {
      flex-wrap: wrap;
    }
  }
</style>
