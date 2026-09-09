<script lang="ts">
  import SettingsContainer from './settings/SettingsContainer.svelte';

  export let initialSection: 'archive' | 'sync' | 'ai' = 'archive';
</script>

<SettingsContainer {initialSection} />
