<script lang="ts">
  export let variant: 'stamp' | 'folder' | 'health-ok' | 'health-dead' | 'health-error' | 'health-unknown' | 'stale' | 'primary' | 'success' | 'warning' | 'danger' | 'secondary' = 'secondary';
  export let size: 'sm' | 'md' = 'sm';
  export let text: string = '';
</script>

<span class="badge badge-{variant} badge-{size}">
  {text}<slot />
</span>

<style>
  .badge {
    font-family: var(--font-mono);
    font-size: var(--badge-font-size);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border-radius: var(--badge-radius);
    padding: var(--badge-padding);
    border: 1px solid transparent;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    white-space: nowrap;
  }

  .badge-sm { font-size: 0.625rem; padding: 0.125rem 0.375rem; }
  .badge-md { font-size: 0.725rem; padding: 0.25rem 0.5rem; }

  .badge-stamp {
    color: var(--text-secondary);
    background: transparent;
    border-color: var(--border-color);
  }

  .badge-folder {
    color: var(--text-secondary);
    background: transparent;
    border-color: var(--border-color);
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .badge-health-ok { color: var(--color-success); background-color: rgba(15, 118, 110, 0.12); border-color: var(--color-success); }
  .badge-health-dead { color: var(--color-danger); background-color: var(--color-primary-light); border-color: var(--color-danger); }
  .badge-health-error { color: var(--color-warning); background-color: rgba(180, 83, 9, 0.12); border-color: var(--color-warning); }
  .badge-health-unknown { color: var(--text-muted); background-color: var(--bg-tertiary); border-color: var(--border-color); }

  .badge-stale {
    color: var(--color-on-primary);
    background-color: var(--color-warning);
    border-color: var(--color-warning);
    padding: 0.1rem 0.4rem;
    font-size: 0.65rem;
  }

  .badge-primary { color: var(--color-on-primary); background-color: var(--color-primary); border-color: var(--color-primary); }
  .badge-success { color: var(--color-on-primary); background-color: var(--color-success); border-color: var(--color-success); }
  .badge-warning { color: var(--color-on-primary); background-color: var(--color-warning); border-color: var(--color-warning); }
  .badge-danger { color: var(--color-on-primary); background-color: var(--color-danger); border-color: var(--color-danger); }
  .badge-secondary { color: var(--text-secondary); background: transparent; border-color: var(--border-color); }
</style>
