<script context="module" lang="ts">
  import type { ModelDefinition } from '../../../lib/ai/provider-registry';

  export function resolveDefaultModel(
    currentModel: string,
    fetchedModels: ModelDefinition[],
    providerDef?: { defaultModels?: string[]; models?: ModelDefinition[] }
  ): string {
    if (currentModel && fetchedModels.some((m) => m.id === currentModel)) {
      return currentModel;
    }
    if (currentModel) return currentModel;
    return '';
  }
</script>

<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { getAiSettings, saveAiSettings } from '../../../lib/ai/ai-summarizer';
  import { AI_CONCURRENCY_CONFIG } from '../../../lib/ai/types';
  import {
    getProviderList,
    getProvider,
    getModelList,
    DEFAULT_ENDPOINTS
  } from '../../../lib/ai/provider-registry';
  import { fetchAvailableModelsWithValidation, validateApiKeyFormat } from '../../../lib/ai/fetch-models';
  import { showToast } from '../../../lib/ui/toast-store';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';
  import ToggleSwitch from '../../shared/ToggleSwitch.svelte';

  let aiProvider: string = 'none';
  let aiModel: string = '';
  let aiApiKey: string = '';
  let apiKeysMap: Record<string, string> = {};
  let cachedModelsMap: Record<string, ModelDefinition[]> = {};
  let aiCustomEndpoint: string = '';
  let autoSummarize: boolean = false;
  let autoTags: boolean = true;
  let autoFolder: boolean = true;
  let aiConcurrency: number = AI_CONCURRENCY_CONFIG.DEFAULT;

  function decrementConcurrency() {
    if (aiConcurrency > AI_CONCURRENCY_CONFIG.MIN) {
      aiConcurrency -= 1;
      triggerSave();
    }
  }

  function incrementConcurrency() {
    if (aiConcurrency < AI_CONCURRENCY_CONFIG.MAX) {
      aiConcurrency += 1;
      triggerSave();
    }
  }

  function handleConcurrencyInput(e: Event) {
    const target = e.target as HTMLInputElement;
    const val = parseInt(target.value, 10);
    if (!isNaN(val)) {
      aiConcurrency = val;
      triggerSave();
    }
  }

  function handleConcurrencyBlur() {
    if (!aiConcurrency || isNaN(aiConcurrency) || aiConcurrency < AI_CONCURRENCY_CONFIG.MIN) {
      aiConcurrency = AI_CONCURRENCY_CONFIG.MIN;
    } else if (aiConcurrency > AI_CONCURRENCY_CONFIG.MAX) {
      aiConcurrency = AI_CONCURRENCY_CONFIG.MAX;
    }
    triggerSave();
  }

  let isFetchingModels: boolean = false;
  let fetchErrorMessage: string = '';
  let modelsList: ModelDefinition[] = [];
  let isComboboxOpen: boolean = false;
  let isTypingQuery: boolean = false;
  let comboboxContainerEl: HTMLElement | null = null;
  let comboboxDropdownEl: HTMLElement | null = null;
  let highlightedIndex: number = -1;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let fetchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  $: providers = getProviderList();
  $: selectedProviderDef = getProvider(aiProvider);
  $: isLocalOrCustom = selectedProviderDef?.isLocal || selectedProviderDef?.id === 'custom';
  $: isCustomOrLocalEndpoint =
    isLocalOrCustom ||
    (!!aiCustomEndpoint && (
      aiCustomEndpoint.includes('localhost') ||
      aiCustomEndpoint.includes('127.0.0.1') ||
      aiCustomEndpoint.includes('0.0.0.0') ||
      aiCustomEndpoint.includes(':8080') ||
      aiCustomEndpoint.includes(':11434') ||
      aiCustomEndpoint.includes(':1234') ||
      aiCustomEndpoint.includes(':8000')
    ));
  $: isApiKeyValid = isCustomOrLocalEndpoint || validateApiKeyFormat(aiProvider, aiApiKey, aiCustomEndpoint);
  $: isModelEnabled = aiProvider !== 'none' && isApiKeyValid;
  $: hasEndpointField = selectedProviderDef?.isLocal || selectedProviderDef?.id === 'custom' || !!selectedProviderDef?.defaultEndpoint;

  $: filteredModels = isTypingQuery && aiModel.trim()
    ? modelsList.filter((m) => {
        const q = aiModel.toLowerCase();
        return m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q));
      })
    : modelsList;

  async function openCombobox(fromInput = false) {
    if (modelsList.length === 0 || !isModelEnabled) return;
    if (!fromInput) {
      isTypingQuery = false;
    }
    isComboboxOpen = true;

    const currentIdx = filteredModels.findIndex((m) => m.id === aiModel);
    highlightedIndex = currentIdx >= 0 ? currentIdx : 0;

    await tick();
    scrollToActiveOption();
  }

  function toggleCombobox() {
    if (isComboboxOpen) {
      isComboboxOpen = false;
      isTypingQuery = false;
    } else {
      openCombobox(false);
    }
  }

  function getProviderDisplayName(p: { id: string; name: string } | undefined): string {
    if (!p) return 'AI';
    if (p.id === 'ollama') return `Ollama (${i18n.t('aiSettings.local')})`;
    if (p.id === 'lmstudio') return `LM Studio (${i18n.t('aiSettings.local')})`;
    if (p.id === 'custom') return i18n.t('aiSettings.customApi');
    return p.name;
  }

  function scrollToActiveOption() {
    if (!comboboxDropdownEl) return;
    const activeEl =
      (comboboxDropdownEl.querySelector('.combobox-option.selected') as HTMLElement) ||
      (comboboxDropdownEl.querySelector('.combobox-option.highlighted') as HTMLElement);
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function selectModel(modelId: string) {
    aiModel = modelId;
    isComboboxOpen = false;
    isTypingQuery = false;
    highlightedIndex = -1;
    triggerSave();
  }

  async function handleComboboxKeydown(e: KeyboardEvent) {
    if (!isComboboxOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        await openCombobox(false);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredModels.length > 0) {
        highlightedIndex = (highlightedIndex + 1) % filteredModels.length;
        await tick();
        scrollToActiveOption();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filteredModels.length > 0) {
        highlightedIndex = (highlightedIndex - 1 + filteredModels.length) % filteredModels.length;
        await tick();
        scrollToActiveOption();
      }
    } else if (e.key === 'Enter') {
      if (highlightedIndex >= 0 && highlightedIndex < filteredModels.length) {
        e.preventDefault();
        selectModel(filteredModels[highlightedIndex].id);
      } else {
        isComboboxOpen = false;
        isTypingQuery = false;
      }
    } else if (e.key === 'Escape') {
      isComboboxOpen = false;
      isTypingQuery = false;
      highlightedIndex = -1;
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (isComboboxOpen && comboboxContainerEl && !comboboxContainerEl.contains(e.target as Node)) {
      isComboboxOpen = false;
      isTypingQuery = false;
      highlightedIndex = -1;
    }
  }

  onMount(async () => {
    if (typeof window !== 'undefined') {
      window.addEventListener('click', handleClickOutside);
    }
    try {
      const s = await getAiSettings();
      apiKeysMap = { ...(s.apiKeysMap || {}) };
      cachedModelsMap = { ...(s.cachedModelsMap || {}) };
      aiProvider = s.provider || 'none';
      aiModel = s.model || '';
      aiApiKey = s.apiKey || apiKeysMap[aiProvider] || '';
      aiCustomEndpoint = s.customEndpoint || '';
      autoSummarize = s.autoSummarize ?? false;
      autoTags = s.autoTags ?? true;
      autoFolder = s.autoFolder ?? true;
      aiConcurrency = s.concurrency ?? 2;

      if (aiProvider !== 'none') {
        const cached = cachedModelsMap[aiProvider];
        if (cached && Array.isArray(cached) && cached.length > 0) {
          modelsList = cached;
        } else {
          modelsList = getModelList(aiProvider);
        }
        if (isApiKeyValid && (aiApiKey || isLocalOrCustom)) {
          autoFetchModels(true);
        }
      }
    } catch (e) {
      // ignore
    }
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('click', handleClickOutside);
    }
  });

  function handleProviderChange() {
    aiModel = '';
    fetchErrorMessage = '';
    isComboboxOpen = false;
    highlightedIndex = -1;
    if (aiProvider !== 'none') {
      aiApiKey = apiKeysMap[aiProvider] || '';
      const cached = cachedModelsMap[aiProvider];
      if (cached && Array.isArray(cached) && cached.length > 0) {
        modelsList = cached;
      } else {
        modelsList = getModelList(aiProvider);
      }
      if (isApiKeyValid && (aiApiKey || isLocalOrCustom)) {
        autoFetchModels(false);
      }
    } else {
      aiApiKey = '';
      modelsList = [];
    }
    triggerSave();
  }

  async function autoFetchModels(silent = false) {
    if (aiProvider === 'none') return;
    if (!isModelEnabled) return;

    isFetchingModels = true;
    fetchErrorMessage = '';
    try {
      const res = await fetchAvailableModelsWithValidation(aiProvider, aiApiKey, aiCustomEndpoint);
      if (res.success && res.models && res.models.length > 0) {
        modelsList = res.models;
        cachedModelsMap[aiProvider] = res.models;
        if (!silent) {
          showToast(i18n.t('aiSettings.modelsLoadedToast', { count: res.models.length }), 'success');
        }
      } else if (!res.success && res.error) {
        if (modelsList.length === 0) {
          modelsList = getModelList(aiProvider);
        }
        if (!silent) {
          fetchErrorMessage = res.error || i18n.t('aiSettings.fetchFailed');
        }
      }
    } catch (e: any) {
      if (!silent) {
        fetchErrorMessage = e.message || i18n.t('aiSettings.fetchFailed');
      }
    } finally {
      isFetchingModels = false;
      triggerSave();
    }
  }

  function handleKeyOrEndpointInput() {
    if (aiProvider !== 'none') {
      apiKeysMap[aiProvider] = aiApiKey;
    }
    triggerSave();
    if (fetchDebounceTimer) clearTimeout(fetchDebounceTimer);
    fetchDebounceTimer = setTimeout(() => {
      if (isApiKeyValid) {
        autoFetchModels(false);
      }
    }, 400);
  }

  async function saveSettings() {
    try {
      if (aiProvider !== 'none') {
        apiKeysMap[aiProvider] = aiApiKey;
      }
      await saveAiSettings({
        provider: aiProvider,
        model: aiModel,
        apiKey: aiApiKey,
        apiKeysMap,
        cachedModelsMap,
        customEndpoint: aiCustomEndpoint,
        autoSummarize,
        autoTags,
        autoFolder,
        concurrency: aiConcurrency
      });
      showToast(i18n.t('aiSettings.saved'), 'success');
    } catch (e: any) {
      showToast(i18n.t('aiSettings.saveFailed', { error: e.message }), 'error');
    }
  }

  function triggerSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettings, 400);
  }
</script>

<div class="settings-section" id="ai-settings-section">
  <div class="section-header">
    <div class="section-header-left">
      <div class="section-icon">
        <Icon name="sparkles" size={18} />
      </div>
      <div>
        <h3 class="section-title">{i18n.t('aiSettings.title')}</h3>
      </div>
    </div>
  </div>

  <div class="settings-card">
    <div class="form-group">
      <label for="ai-provider">{i18n.t('aiSettings.providerLabel')}</label>
      <select id="ai-provider" class="form-select" bind:value={aiProvider} on:change={handleProviderChange}>
        <option value="none">{i18n.t('aiSettings.providerNone')}</option>
        {#each providers as p}
          <option value={p.id}>{getProviderDisplayName(p)}</option>
        {/each}
      </select>
    </div>

    {#if aiProvider !== 'none'}
      {#if !isLocalOrCustom}
        <div class="form-group">
          <label for="api-key">{i18n.t('aiSettings.apiKeyLabel')}</label>
          <div class="input-with-action">
            <input
              type="password"
              id="api-key"
              class="form-input"
              bind:value={aiApiKey}
              on:input={handleKeyOrEndpointInput}
              placeholder={i18n.t('aiSettings.apiKeyPlaceholder', { provider: getProviderDisplayName(selectedProviderDef) })}
            />
            <button
              type="button"
              class="btn-icon"
              on:click={() => autoFetchModels(false)}
              disabled={!isApiKeyValid || isFetchingModels}
              title={i18n.t('aiSettings.fetchModelsTooltip')}
            >
              {#if isFetchingModels}
                <Spinner size={14} variant="inline" />
              {:else}
                <Icon name="refresh-cw" size={14} />
              {/if}
            </button>
          </div>
          {#if fetchErrorMessage}
            <span class="form-error">{fetchErrorMessage}</span>
          {/if}
        </div>
      {/if}

      {#if hasEndpointField}
        <div class="form-group">
          <label for="ai-endpoint">{i18n.t('aiSettings.endpointLabel')}</label>
          <input
            type="text"
            id="ai-endpoint"
            class="form-input"
            bind:value={aiCustomEndpoint}
            on:input={handleKeyOrEndpointInput}
            placeholder={selectedProviderDef?.defaultEndpoint || DEFAULT_ENDPOINTS[aiProvider] || 'http://localhost:11434/v1'}
          />
          {#if isLocalOrCustom && fetchErrorMessage}
            <span class="form-error">{fetchErrorMessage}</span>
          {/if}
        </div>
      {/if}

      <div class="form-group" bind:this={comboboxContainerEl}>
        <label for="ai-model">{i18n.t('aiSettings.modelLabel')}</label>
        <div class="combobox-wrapper">
          <div class="combobox-input-group">
            <input
              type="text"
              id="ai-model"
              class="form-input combobox-input"
              bind:value={aiModel}
              on:input={() => {
                isTypingQuery = true;
                isComboboxOpen = true;
                triggerSave();
              }}
              on:focus={() => openCombobox(false)}
              on:click={() => openCombobox(false)}
              on:keydown={handleComboboxKeydown}
              placeholder={isModelEnabled ? (modelsList.length > 0 ? i18n.t('aiSettings.modelSelectPlaceholder') : i18n.t('aiSettings.modelCustomPlaceholder')) : i18n.t('aiSettings.modelDisabledPlaceholder')}
              disabled={!isModelEnabled}
              autocomplete="off"
            />
            {#if modelsList.length > 0 && isModelEnabled}
              <button
                type="button"
                class="combobox-arrow-btn"
                on:click={(e) => {
                  e.stopPropagation();
                  toggleCombobox();
                }}
                tabindex="-1"
                aria-label={i18n.t('aiSettings.openModelList')}
              >
                <Icon name={isComboboxOpen ? "chevron-up" : "chevron-down"} size={14} />
              </button>
            {/if}
          </div>

          <button
            type="button"
            class="btn-icon"
            on:click={() => autoFetchModels(false)}
            disabled={!isModelEnabled || isFetchingModels}
            title={i18n.t('aiSettings.refreshModelsTooltip')}
          >
            {#if isFetchingModels}
              <Spinner size={14} variant="inline" />
            {:else}
              <Icon name="refresh-cw" size={14} />
            {/if}
          </button>

          {#if isComboboxOpen && modelsList.length > 0}
            <div class="combobox-dropdown" bind:this={comboboxDropdownEl} role="listbox">
              {#each filteredModels as m, idx (m.id)}
                <button
                  type="button"
                  class="combobox-option {m.id === aiModel ? 'selected' : ''} {idx === highlightedIndex ? 'highlighted' : ''}"
                  on:click={() => selectModel(m.id)}
                  role="option"
                  aria-selected={m.id === aiModel}
                >
                  <span class="option-name">{m.name || m.id}</span>
                  {#if m.name && m.name !== m.id}
                    <span class="option-id font-mono">{m.id}</span>
                  {/if}
                </button>
              {/each}
              {#if filteredModels.length === 0}
                <div class="combobox-empty">
                  <span>{i18n.t('aiSettings.modelNoMatch', { model: aiModel })}</span>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        {#if modelsList.length > 0}
          <span class="helper-text">
            {i18n.t('aiSettings.modelsLoaded', { count: modelsList.length })}
          </span>
        {:else if isModelEnabled}
          <span class="helper-text">
            {i18n.t('aiSettings.modelsLoading')}
          </span>
        {/if}
      </div>


      <div class="setting-divider"></div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-title">{i18n.t('aiSettings.autoSummarizeTitle')}</span>
          <span class="setting-description">{i18n.t('aiSettings.autoSummarizeDesc')}</span>
        </div>
        <ToggleSwitch bind:checked={autoSummarize} on:change={triggerSave} />
      </div>

      <div class="setting-divider"></div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-title">{i18n.t('aiSettings.autoTagsTitle')}</span>
          <span class="setting-description">{i18n.t('aiSettings.autoTagsDesc')}</span>
        </div>
        <ToggleSwitch bind:checked={autoTags} on:change={triggerSave} />
      </div>

      <div class="setting-divider"></div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-title">{i18n.t('aiSettings.autoFolderTitle')}</span>
          <span class="setting-description">{i18n.t('aiSettings.autoFolderDesc')}</span>
        </div>
        <ToggleSwitch bind:checked={autoFolder} on:change={triggerSave} />
      </div>

      <div class="setting-divider"></div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-title">{i18n.t('aiSettings.concurrencyTitle')}</span>
          <span class="setting-description">{i18n.t('aiSettings.concurrencyDesc')}</span>
          <span class="helper-text">{i18n.t('aiSettings.concurrencyTip')}</span>
        </div>
        <div class="concurrency-stepper">
          <button
            type="button"
            class="stepper-btn"
            on:click={decrementConcurrency}
            disabled={aiConcurrency <= AI_CONCURRENCY_CONFIG.MIN}
            aria-label="Decrease concurrency"
          >
            <Icon name="minus" size={14} />
          </button>
          <input
            type="number"
            id="ai-concurrency"
            class="form-input stepper-input font-mono"
            min={AI_CONCURRENCY_CONFIG.MIN}
            max={AI_CONCURRENCY_CONFIG.MAX}
            step="1"
            bind:value={aiConcurrency}
            on:input={handleConcurrencyInput}
            on:blur={handleConcurrencyBlur}
          />
          <button
            type="button"
            class="stepper-btn"
            on:click={incrementConcurrency}
            disabled={aiConcurrency >= AI_CONCURRENCY_CONFIG.MAX}
            aria-label="Increase concurrency"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .settings-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .section-header-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .section-icon {
    color: var(--color-primary);
    background: var(--color-primary-light);
    padding: 0.5rem;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .section-title {
    margin: 0;
    font-family: var(--font-accent);
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .settings-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: 1.25rem 1.5rem;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-group label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .form-input,
  .form-select {
    width: 100%;
    box-sizing: border-box;
    background-color: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.625rem 0.875rem;
    font-size: 0.875rem;
    font-family: var(--font-primary);
    outline: none;
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }

  .form-input:focus,
  .form-select:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--color-primary-light);
  }

  .form-input:disabled,
  .form-select:disabled {
    background-color: var(--bg-tertiary);
    color: var(--text-muted);
    cursor: not-allowed;
    opacity: 0.7;
  }

  .form-input::placeholder {
    color: var(--text-muted);
  }

  .helper-text {
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.3;
  }

  .form-error {
    font-size: 0.75rem;
    color: var(--color-danger);
    line-height: 1.3;
  }

  .input-with-action {
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
    width: 100%;
  }

  .input-with-action .form-input {
    flex-grow: 1;
  }

  .btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.375rem;
    padding: 0;
    box-sizing: border-box;
    background-color: var(--bg-primary);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    cursor: pointer;
    flex-shrink: 0;
    transition: border-color var(--transition-fast), background-color var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast);
  }

  .btn-icon:hover:not(:disabled) {
    background-color: var(--bg-tertiary);
    color: var(--text-primary);
    border-color: var(--border-focus);
  }

  .btn-icon:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .btn-icon:disabled {
    background-color: var(--bg-tertiary);
    color: var(--text-muted);
    opacity: 0.5;
    cursor: not-allowed;
  }

  .combobox-wrapper {
    position: relative;
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
    width: 100%;
  }

  .combobox-input-group {
    position: relative;
    display: flex;
    align-items: center;
    flex-grow: 1;
  }

  .combobox-input {
    width: 100%;
    padding-right: 2.25rem !important;
  }

  .combobox-arrow-btn {
    position: absolute;
    right: 0.625rem;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    transition: color var(--transition-fast);
  }

  .combobox-arrow-btn:hover {
    color: var(--text-primary);
  }

  .combobox-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 2.875rem;
    max-height: 220px;
    overflow-y: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    z-index: 50;
    padding: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .combobox-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: none;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.8125rem;
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .combobox-option:hover,
  .combobox-option.highlighted {
    background: var(--bg-tertiary);
  }

  .combobox-option.selected {
    background: var(--color-primary-light);
    color: var(--color-primary);
    font-weight: 600;
  }

  .option-name {
    flex-grow: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .option-id {
    font-size: 0.7rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .combobox-empty {
    padding: 0.625rem 0.75rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
  }

  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1.5rem;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .setting-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .setting-description {
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .setting-divider {
    height: 1px;
    background-color: var(--border-color);
    margin: 0.25rem 0;
  }

  .concurrency-stepper {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  .stepper-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-primary);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: border-color var(--transition-fast), background-color var(--transition-fast), color var(--transition-fast);
  }

  .stepper-btn:hover:not(:disabled) {
    background: var(--bg-tertiary);
    border-color: var(--border-focus);
    color: var(--color-primary);
  }

  .stepper-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .stepper-input {
    width: 3.5rem;
    text-align: center;
    padding: 0.5rem 0.25rem;
    font-size: 0.875rem;
    font-weight: 600;
    -moz-appearance: textfield;
  }

  .stepper-input::-webkit-outer-spin-button,
  .stepper-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
</style>
