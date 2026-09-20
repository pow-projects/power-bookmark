import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tick } from 'svelte';
import { createI18nMock } from '../helpers/i18n-mock';
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
    (globalThis as any).i18n = createI18nMock();
    await mockDb.settings.clear();
    document.body.innerHTML = '';
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('사용자 정의 API(Custom API) 선택 시 API Key 필드가 노출되며, API Key가 비어있어도(llama.cpp 등) 모델 설정이 가능하고 키 입력(OpenCode 등)도 지원한다', async () => {
    const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
    
    const target = document.body;
    const component = new SettingsContainer({ target, props: { initialSection: 'ai' } });
    await tick();

    const providerSelect = document.getElementById('ai-provider') as HTMLSelectElement;
    providerSelect.value = 'custom';
    providerSelect.dispatchEvent(new Event('change'));
    await tick();

    // 1. API Key input should be rendered for custom provider
    const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
    expect(apiKeyInput).not.toBeNull();
    expect(apiKeyInput.placeholder).toContain('llama.cpp');

    // 2. Model input should be enabled even without API Key (for llama.cpp)
    const modelInput = document.getElementById('ai-model') as HTMLInputElement;
    expect(modelInput).not.toBeNull();
    expect(modelInput.disabled).toBe(false);

    // 3. User can input API Key (for OpenCode / remote proxies)
    apiKeyInput.value = 'sk-custom-opencode-token-12345';
    apiKeyInput.dispatchEvent(new Event('input'));
    await tick();

    expect(apiKeyInput.value).toBe('sk-custom-opencode-token-12345');
    expect(modelInput.disabled).toBe(false);

    // 4. Custom headers textarea should be rendered for custom provider
    const headersTextarea = document.getElementById('ai-custom-headers') as HTMLTextAreaElement;
    expect(headersTextarea).not.toBeNull();
    headersTextarea.value = 'X-Custom-Header: value123';
    headersTextarea.dispatchEvent(new Event('input'));
    await tick();
    expect(headersTextarea.value).toBe('X-Custom-Header: value123');

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

  describe('에러 분류 헬퍼 및 Custom API 에러 노출 위치', () => {
    it('네트워크/엔드포인트 에러와 인증/키 에러를 정확하게 분류한다', async () => {
      const { isNetworkOrEndpointError, isAuthOrKeyError } = await import('../../src/components/management/settings/AiSettings.svelte');

      expect(isNetworkOrEndpointError('Failed to fetch')).toBe(true);
      expect(isNetworkOrEndpointError('NetworkError when attempting to fetch resource.')).toBe(true);
      expect(isNetworkOrEndpointError('ECONNREFUSED 127.0.0.1:8080')).toBe(true);
      expect(isNetworkOrEndpointError('custom API error: 404 (Not Found)')).toBe(true);
      expect(isNetworkOrEndpointError('custom API error: 500 (Internal Server Error)')).toBe(true);
      expect(isNetworkOrEndpointError('Invalid API key format')).toBe(false);
      expect(isNetworkOrEndpointError('custom API error: 401 (Unauthorized)')).toBe(false);

      expect(isAuthOrKeyError('Invalid API key format')).toBe(true);
      expect(isAuthOrKeyError('custom API error: 401 (Unauthorized)')).toBe(true);
      expect(isAuthOrKeyError('custom API error: 403 (Forbidden)')).toBe(true);
      expect(isAuthOrKeyError('Failed to fetch')).toBe(false);
      expect(isAuthOrKeyError('ECONNREFUSED')).toBe(false);
    });

    it('Custom API(llama.cpp 등)에서 서버 미구동으로 Failed to fetch 발생 시, 에러가 API Key가 아닌 Endpoint 아래에 노출된다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

      const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
      const target = document.body;
      const component = new SettingsContainer({ target, props: { initialSection: 'ai' } });
      await tick();
      await new Promise((r) => setTimeout(r, 20));
      await tick();

      const providerSelect = document.getElementById('ai-provider') as HTMLSelectElement;
      providerSelect.value = 'custom';
      providerSelect.dispatchEvent(new Event('change'));
      await tick();
      await new Promise((r) => setTimeout(r, 50));
      await tick();

      // 1. Error MUST appear under Endpoint
      const endpointInput = document.getElementById('ai-endpoint');
      expect(endpointInput).not.toBeNull();
      const endpointGroup = endpointInput?.closest('.form-group');
      expect(endpointGroup).not.toBeNull();
      const endpointError = endpointGroup?.querySelector('.form-error');
      expect(endpointError).not.toBeNull();
      expect(endpointError?.textContent).toContain('서버에 연결할 수 없습니다');

      // 2. Error MUST NOT appear under API Key
      const apiKeyInput = document.getElementById('api-key');
      expect(apiKeyInput).not.toBeNull();
      const apiKeyGroup = apiKeyInput?.closest('.form-group');
      const apiKeyError = apiKeyGroup?.querySelector('.form-error');
      expect(apiKeyError).toBeNull();

      component.$destroy();
    });

    it('Custom API에서 401 Unauthorized 발생 시, 에러가 Endpoint가 아닌 API Key 아래에 노출된다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      }));

      const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
      const target = document.body;
      const component = new SettingsContainer({ target, props: { initialSection: 'ai' } });
      await tick();
      await new Promise((r) => setTimeout(r, 20));
      await tick();

      const providerSelect = document.getElementById('ai-provider') as HTMLSelectElement;
      providerSelect.value = 'custom';
      providerSelect.dispatchEvent(new Event('change'));
      await tick();
      await new Promise((r) => setTimeout(r, 50));
      await tick();

      // 1. Error MUST NOT appear under Endpoint
      const endpointInput = document.getElementById('ai-endpoint');
      expect(endpointInput).not.toBeNull();
      const endpointGroup = endpointInput?.closest('.form-group');
      const endpointError = endpointGroup?.querySelector('.form-error');
      expect(endpointError).toBeNull();

      // 2. Error MUST appear under API Key
      const apiKeyInput = document.getElementById('api-key');
      expect(apiKeyInput).not.toBeNull();
      const apiKeyGroup = apiKeyInput?.closest('.form-group');
      const apiKeyError = apiKeyGroup?.querySelector('.form-error');
      expect(apiKeyError).not.toBeNull();
      expect(apiKeyError?.textContent).toContain('401');

      component.$destroy();
    });
  });
});
