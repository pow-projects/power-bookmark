import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAvailableModels } from '../../src/lib/ai/fetch-models';
import { getModelList } from '../../src/lib/ai/provider-registry';

describe('fetchAvailableModels', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches OpenAI models and filters correctly', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-4' },
          { id: 'dall-e-3' },
          { id: 'o1-preview' },
          { id: 'gpt-3.5-turbo' }
        ]
      })
    } as any);

    const models = await fetchAvailableModels('openai', 'sk-12345678901234567890');
    
    expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer sk-12345678901234567890' }
    }));
    
    // dall-e-3 should be filtered out. o1, gpt should remain. Sorted by ID descending.
    expect(models.length).toBe(3);
    expect(models.map(m => m.id)).toEqual(['o1-preview', 'gpt-4', 'gpt-3.5-turbo']);
  });

  it('fetches Gemini models and filters correctly', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-pro', supportedGenerationMethods: ['generateContent'] }
        ]
      })
    } as any);

    const models = await fetchAvailableModels('gemini', 'fake-key-123456789012345');
    
    expect(fetch).toHaveBeenCalledWith('https://generativelanguage.googleapis.com/v1beta/models?key=fake-key-123456789012345');
    
    expect(models.length).toBe(2);
    expect(models[0].id).toBe('gemini-1.5-pro');
    expect(models[0].name).toBe('Gemini 1.5 Pro');
    expect(models[1].id).toBe('gemini-pro');
    expect(models[1].name).toBe('gemini-pro');
  });

  it('fetches Anthropic models correctly', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-3-opus-20240229', display_name: 'Claude 3 Opus' },
          { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' }
        ]
      })
    } as any);

    const models = await fetchAvailableModels('anthropic', 'sk-ant-1234567890123456');
    
    expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': 'sk-ant-1234567890123456' })
    }));
    
    expect(models.length).toBe(2);
    expect(models[0].id).toBe('claude-3-opus-20240229');
    expect(models[0].name).toBe('Claude 3 Opus');
    expect(models[1].name).toBe('Claude 3 Sonnet');
  });

  it('fetches Custom models with endpoint formatting', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'custom-model-1' },
          { id: 'custom-model-2' }
        ]
      })
    } as any);

    const models = await fetchAvailableModels('custom', 'fake-key', 'https://custom.api.com/');
    
    expect(fetch).toHaveBeenCalledWith('https://custom.api.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer fake-key' })
    }));
    
    expect(models.length).toBe(2);
    expect(models[0].id).toBe('custom-model-1');
  });

  it('returns fallback models on API error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network Error'));

    const models = await fetchAvailableModels('openai', 'sk-12345678901234567890');
    
    expect(models).toEqual(getModelList('openai'));
  });

  it('returns fallback models on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401
    } as any);

    const models = await fetchAvailableModels('openai', 'sk-12345678901234567890');
    
    expect(models).toEqual(getModelList('openai'));
  });

  it('fetches OpenAI-compatible provider models (groq) with default endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'llama-3.3-70b-versatile' },
          { id: 'llama-3.1-8b-instant' }
        ]
      })
    } as any);

    const models = await fetchAvailableModels('groq', 'gsk-test-key-123456');
    
    expect(fetch).toHaveBeenCalledWith('https://api.groq.com/openai/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer gsk-test-key-123456' })
    }));
    
    expect(models.length).toBe(2);
    expect(models[0].id).toBe('llama-3.3-70b-versatile');
  });

  it('fetches Perplexity models without /v1 path', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { id: 'sonar' },
          { id: 'sonar-pro' }
        ]
      })
    } as any);

    const models = await fetchAvailableModels('perplexity', 'pplx-test-key');
    
    expect(fetch).toHaveBeenCalledWith('https://api.perplexity.ai/models', expect.anything());
    expect(models.length).toBe(2);
    expect(models[0].id).toBe('sonar');
  });

  it('falls back to defaultModels when compatible provider fetch fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network Error'));

    const models = await fetchAvailableModels('deepseek', 'sk-test-key');
    
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id === 'deepseek-chat')).toBe(true);
  });

  it('uses customEndpoint override for openai-compatible providers', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'custom-llm-1' }
        ]
      })
    } as any);

    const models = await fetchAvailableModels('groq', 'gsk-test-key', 'http://my-proxy.local:9999');
    
    expect(fetch).toHaveBeenCalledWith('http://my-proxy.local:9999/v1/models', expect.anything());
    expect(models.length).toBe(1);
    expect(models[0].id).toBe('custom-llm-1');
  });

  it('fetches Ollama models with default endpoint fallback without API key', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3.2:latest' },
          { name: 'qwen2.5:7b' }
        ]
      })
    } as any);

    const models = await fetchAvailableModels('ollama', '');
    expect(fetch).toHaveBeenCalledWith('http://localhost:11434/v1/models', expect.objectContaining({
      headers: { 'Content-Type': 'application/json' }
    }));
    expect(models.length).toBe(2);
    expect(models[0].id).toBe('llama3.2:latest');
    expect(models[1].id).toBe('qwen2.5:7b');
  });

  it('fetches LM Studio models with default endpoint fallback', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'mistral-7b-instruct-v0.3' }
        ]
      })
    } as any);

    const models = await fetchAvailableModels('lmstudio', '');
    expect(fetch).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.anything());
    expect(models.length).toBe(1);
    expect(models[0].id).toBe('mistral-7b-instruct-v0.3');
  });

  it('fetches Custom provider models with default fallback or custom endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gemma-4-E4B-it-Q6_K' }
        ]
      })
    } as any);

    const models = await fetchAvailableModels('custom', '');
    expect(fetch).toHaveBeenCalledWith('http://localhost:8080/v1/models', expect.anything());
    expect(models.length).toBe(1);
    expect(models[0].id).toBe('gemma-4-E4B-it-Q6_K');
  });
});
