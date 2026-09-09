<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';

  export let open: boolean = false;
  export let align: 'left' | 'right' = 'right';

  const dispatch = createEventDispatcher<{
    toggle: boolean;
    close: void;
  }>();

  let containerEl: HTMLElement;

  function handleClickOutside(e: MouseEvent) {
    if (open && containerEl && !containerEl.contains(e.target as Node)) {
      open = false;
      dispatch('close');
      dispatch('toggle', false);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      open = false;
      dispatch('close');
      dispatch('toggle', false);
    }
  }

  onMount(() => {
    if (typeof window !== 'undefined') {
      window.addEventListener('click', handleClickOutside, true);
      window.addEventListener('keydown', handleKeydown);
    }
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('click', handleClickOutside, true);
      window.removeEventListener('keydown', handleKeydown);
    }
  });

  function toggleDropdown() {
    open = !open;
    dispatch('toggle', open);
  }
</script>

<div class="dropdown-wrapper" bind:this={containerEl}>
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="dropdown-trigger" on:click={toggleDropdown}>
    <slot name="trigger" {open} />
  </div>

  {#if open}
    <div
      class="dropdown-content {align === 'left' ? 'dropdown-align-left' : ''}"
      role="menu"
      tabindex="-1"
    >
      <slot {open} close={() => { open = false; dispatch('close'); }} />
    </div>
  {/if}
</div>

<style>
  .dropdown-trigger {
    display: inline-flex;
    align-items: center;
  }
</style>
