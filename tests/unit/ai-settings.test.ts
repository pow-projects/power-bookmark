import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tick } from 'svelte';
import { saveAiSettings, getAiSettings } from '../../src/lib/ai/ai-summarizer';
import { getProviderList, getModelList } from '../../src/lib/ai/provider-registry';

const { mockDb } = vi.hoisted(() => {
  const db = {
    settings: {
      data: new Map<string, any>(),
      clear: async () => db.settings.data.clear(),
      get: async (key: string) => ({ value: db.settings.data.get(key) }),
      put: async (item: { key: string; value: any }) => {
        db.settings.data.set(item.key, item.value);
      }
    }
  };
  return { mockDb: db };
});

vi.mock('../../src/lib/db', () => ({
  default: mockDb
}));

vi.mock('../../src/lib/ui/toast-store', () => ({
  showToast: vi.fn()
}));

describe('SettingsContainer AI UI', () => {
  beforeEach(async () => {
    await mockDb.settings.clear();
    document.body.innerHTML = '';
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('항상 모델 선택 박스를 노출하고 API Key 미검증(미입력/형식오류) 시 disabled 처리한다', async () => {
    const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
    
    // Mount component
    const target = document.body;
    const component = new SettingsContainer({ target, props: { initialSection: 'ai' } });
    await tick();

    // Set provider to 'openai'
    const providerSelect = document.getElementById('ai-provider') as HTMLSelectElement;
    providerSelect.value = 'openai';
    providerSelect.dispatchEvent(new Event('change'));
    await tick();

    // API Key is empty by default -> model selector should be visible but disabled
    let modelEl = (document.getElementById('ai-model-select') || document.getElementById('ai-model')) as HTMLSelectElement | HTMLInputElement;
    expect(modelEl).not.toBeNull();
    expect(modelEl.disabled).toBe(true);
    
    const refreshBtn = document.querySelector('.btn-icon') as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);

    // Enter a valid API key -> model select should be enabled
    const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
    apiKeyInput.value = 'sk-123456789012345678901234567890123456789012345678';
    apiKeyInput.dispatchEvent(new Event('input'));
    await tick();

    modelEl = (document.getElementById('ai-model-select') || document.getElementById('ai-model')) as HTMLSelectElement | HTMLInputElement;
    expect(modelEl.disabled).toBe(false);
    expect(refreshBtn.disabled).toBe(false);

    // Enter an invalid API key -> model select should be disabled again
    apiKeyInput.value = 'invalid-key';
    apiKeyInput.dispatchEvent(new Event('input'));
    await tick();

    modelEl = (document.getElementById('ai-model-select') || document.getElementById('ai-model')) as HTMLSelectElement | HTMLInputElement;
    expect(modelEl.disabled).toBe(true);

    component.$destroy();
  });

  it('동적 provider-registry 카테고리 목록 및 카테고리 필터링이 정상 작동한다', async () => {
    const { getProviderCategoryList, getProvidersByCategory, getProvider } = await import('../../src/lib/ai/provider-registry');
    
    const categories = getProviderCategoryList();
    expect(categories.some(c => c.id === 'official')).toBe(true);
    expect(categories.some(c => c.id === 'openai-compatible')).toBe(true);

    const officialList = getProvidersByCategory('official');
    expect(officialList.some(p => p.id === 'openai')).toBe(true);
    expect(officialList.some(p => p.id === 'anthropic')).toBe(true);

    const localList = getProvidersByCategory('openai-compatible');
    expect(localList.some(p => p.id === 'ollama')).toBe(true);

    const searchResult = getProvidersByCategory('all', 'Ollama');
    expect(searchResult.length).toBeGreaterThan(0);
    expect(searchResult[0].id).toBe('ollama');
    expect(searchResult[0].id).toBe('ollama');

    const geminiAlias = getProvider('gemini');
    expect(geminiAlias).toBeDefined();
    expect(geminiAlias?.name).toContain('Google Gemini');
  });

  it('로컬 AI 엔진(Ollama 등) 선택 시 API Key 없이도 모델 선택이 가능하며 카드가 표시된다', async () => {
    const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
    
    const target = document.body;
    const component = new SettingsContainer({ target, props: { initialSection: 'ai' } });
    await tick();

    const providerSelect = document.getElementById('ai-provider') as HTMLSelectElement;
    providerSelect.value = 'ollama';
    providerSelect.dispatchEvent(new Event('change'));
    await tick();

    const modelInput = document.getElementById('ai-model') as HTMLInputElement;
    expect(modelInput).not.toBeNull();
    expect(modelInput.disabled).toBe(false);

    // Verify custom model separate input field was removed
    const customModelInput = document.getElementById('ai-custom-model');
    expect(customModelInput).toBeNull();

    // Dropdown can be opened via combobox arrow button or focus
    const arrowBtn = document.querySelector('.combobox-arrow-btn') as HTMLButtonElement;
    expect(arrowBtn).not.toBeNull();
    arrowBtn.click();
    await tick();

    const dropdown = document.querySelector('.combobox-dropdown');
    expect(dropdown).not.toBeNull();

    // Click model selection in list
    const options = document.querySelectorAll('.combobox-option') as NodeListOf<HTMLButtonElement>;
    expect(options.length).toBeGreaterThan(0);
    options[0].click();
    await tick();

    expect(modelInput.value).toBeTruthy();

    component.$destroy();
  });

  it('모델이 선택된 상태에서 드롭다운을 열면 전체 모델 목록이 표시되고 선택된 모델이 강조된다', async () => {
    const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
    const { getModelList } = await import('../../src/lib/ai/provider-registry');
    
    const target = document.body;
    const component = new SettingsContainer({ target, props: { initialSection: 'ai' } });
    await tick();

    const providerSelect = document.getElementById('ai-provider') as HTMLSelectElement;
    providerSelect.value = 'ollama';
    providerSelect.dispatchEvent(new Event('change'));
    await tick();

    const modelInput = document.getElementById('ai-model') as HTMLInputElement;
    const defaultOllamaModels = getModelList('ollama');
    expect(defaultOllamaModels.length).toBeGreaterThan(1);

    // Set to second model
    modelInput.value = defaultOllamaModels[1].id;
    modelInput.dispatchEvent(new Event('input'));
    await tick();

    // Close dropdown
    modelInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(document.querySelector('.combobox-dropdown')).toBeNull();

    // Open dropdown (arrow click)
    const arrowBtn = document.querySelector('.combobox-arrow-btn') as HTMLButtonElement;
    arrowBtn.click();
    await tick();

    // All models should be displayed without filtering even when selected
    const options = document.querySelectorAll('.combobox-option') as NodeListOf<HTMLButtonElement>;
    expect(options.length).toBe(defaultOllamaModels.length);

    // selected class should be applied to selected model item
    const selectedOption = document.querySelector('.combobox-option.selected') as HTMLButtonElement;
    expect(selectedOption).not.toBeNull();
    expect(selectedOption.textContent).toContain(defaultOllamaModels[1].id);

    component.$destroy();
  });

  describe('resolveDefaultModel 헬퍼', () => {
    it('1) 현재 모델이 페칭 목록에 존재하면 현재 모델 유지', async () => {
      const { resolveDefaultModel } = await import('../../src/components/management/settings/AiSettings.svelte');
      const fetched = [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'gpt-4o-mini', name: 'GPT-4o mini' }];
      const providerDef = { defaultModels: ['gpt-4o-mini'] };
      expect(resolveDefaultModel('gpt-4o', fetched, providerDef)).toBe('gpt-4o');
    });

    it('2) 현재 모델이 설정되어 있으면 유지', async () => {
      const { resolveDefaultModel } = await import('../../src/components/management/settings/AiSettings.svelte');
      const fetched = [{ id: 'other-model', name: 'Other' }, { id: 'gpt-4o-mini', name: 'GPT-4o mini' }];
      const providerDef = { defaultModels: ['non-existent', 'gpt-4o-mini'] };
      expect(resolveDefaultModel('my-saved-model', fetched, providerDef)).toBe('my-saved-model');
    });

    it('3) 현재 모델이 없으면 기본 모델을 강제 지정하지 않고 빈 문자열 반환', async () => {
      const { resolveDefaultModel } = await import('../../src/components/management/settings/AiSettings.svelte');
      const fetched = [{ id: 'first-model', name: 'First' }, { id: 'second-model', name: 'Second' }];
      const providerDef = { defaultModels: ['unmatched-1', 'unmatched-2'] };
      expect(resolveDefaultModel('', fetched, providerDef)).toBe('');
    });
  });
});
