<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let checked: boolean = false;
  export let disabled: boolean = false;
  export let id: string | undefined = undefined;
  export let ariaLabel: string | undefined = undefined;

  const dispatch = createEventDispatcher<{ change: boolean }>();

  export function toggle() {
    if (disabled) return;
    checked = !checked;
    dispatch('change', checked);
  }

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    toggle();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (disabled) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    }
  }
</script>

<button
  type="button"
  {id}
  class="toggle-switch {checked ? 'checked' : ''} {disabled ? 'disabled' : ''}"
  role="switch"
  aria-checked={checked}
  aria-label={ariaLabel}
  {disabled}
  tabindex={disabled ? -1 : 0}
  on:click={handleClick}
  on:keydown={handleKeyDown}
>
  <span class="toggle-thumb"></span>
</button>

<style>
  .toggle-switch {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 2.75rem;
    height: 1.5rem;
    padding: 0.125rem;
    background-color: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 9999px;
    cursor: pointer;
    transition: background-color var(--transition-fast), border-color var(--transition-fast);
    flex-shrink: 0;
    box-sizing: border-box;
    outline: none;
  }

  .toggle-switch:hover:not(.disabled) {
    border-color: var(--text-muted);
  }

  .toggle-switch:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .toggle-switch.checked {
    background-color: var(--color-primary);
    border-color: var(--color-primary);
  }

  .toggle-thumb {
    display: block;
    width: 1.125rem;
    height: 1.125rem;
    background-color: var(--color-on-primary);
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    transition: transform var(--transition-fast);
    transform: translateX(0);
  }

  .toggle-switch.checked .toggle-thumb {
    transform: translateX(1.25rem);
  }

  .toggle-switch.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
