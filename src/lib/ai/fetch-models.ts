import { ModelDefinition, getModelList, getProvider, DEFAULT_ENDPOINTS } from './provider-registry';
import { isLocalEndpoint } from './llama-safety';

export function validateApiKeyFormat(provider: string, apiKey: string, customEndpoint?: string): boolean {
  if (provider === 'none') return true;
  
  const pDef = getProvider(provider);
  if (pDef?.isLocal) return true;
  if (provider === 'custom') return true; // Supports local/unauthenticated servers (llama.cpp, etc.) for custom API
  if (isLocalEndpoint(customEndpoint)) {
    return true;
  }

  if (!apiKey) return false;
  
  switch (provider) {
    case 'openai':
      return apiKey.startsWith('sk-') && apiKey.length >= 20;
    case 'gemini':
    case 'google':
      return apiKey.length >= 20;
    case 'anthropic':
      return apiKey.startsWith('sk-ant-');
    default:
      return apiKey.length >= 1;
  }
}

export async function fetchAvailableModels(
  provider: string,
  apiKey: string,
  customEndpoint?: string
): Promise<ModelDefinition[]> {
  try {
    const { success, models } = await fetchAvailableModelsWithValidation(provider, apiKey, customEndpoint);
    return models;
  } catch (error) {
    console.error(`Failed to fetch models for ${provider}:`, error);
    return getModelList(provider);
  }
}

export async function fetchAvailableModelsWithValidation(
  provider: string,
  apiKey: string,
  customEndpoint?: string
): Promise<{ success: boolean; models: ModelDefinition[]; error?: string }> {
  if (!validateApiKeyFormat(provider, apiKey, customEndpoint)) {
    return { success: false, models: getModelList(provider), error: 'Invalid API key format' };
  }

  try {
    if (provider === 'openai' && (!customEndpoint || (!customEndpoint.includes('localhost') && !customEndpoint.includes('127.0.0.1')))) {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json();
      const rawList = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
      const models = rawList
        .filter((model: any) => 
          model.id && (
            model.id.includes('gpt') || 
            model.id.includes('o1') || 
            model.id.includes('o3')
          )
        )
        .map((model: any) => ({
          id: model.id,
          name: model.id,
        }))
        .sort((a: ModelDefinition, b: ModelDefinition) => b.id.localeCompare(a.id));
        
      const finalModels = models.length > 0 ? models : getModelList(provider);
      return { success: true, models: finalModels };
    }

    if (provider === 'gemini') {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      
      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json();
      const rawList = Array.isArray(data.models) ? data.models : [];
      const models = rawList
        .filter((model: any) => 
          model.name && 
          model.name.includes('gemini') && 
          model.supportedGenerationMethods?.includes('generateContent')
        )
        .map((model: any) => ({
          id: model.name.replace('models/', ''),
          name: model.displayName || model.name.replace('models/', ''),
        }));

      const finalModels = models.length > 0 ? models : getModelList(provider);
      return { success: true, models: finalModels };
    }

    if (provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status}`);
      }

      const data = await response.json();
      const rawList = Array.isArray(data.data) ? data.data : [];
      const models = rawList.map((model: any) => ({
        id: model.id,
        name: model.display_name || model.name || model.id,
      }));

      const finalModels = models.length > 0 ? models : getModelList(provider);
      return { success: true, models: finalModels };
    }

    // Fetch model list for local providers (Ollama, LM Studio, etc.), custom endpoints, and OpenAI-compatible providers
    const endpoint = (customEndpoint || DEFAULT_ENDPOINTS[provider] || '').trim().replace(/\/+$/, '');
    if (!endpoint) {
      return { success: true, models: getModelList(provider) };
    }

    let modelsUrl: string;
    if (endpoint.endsWith('/models')) {
      modelsUrl = endpoint;
    } else if (
      provider === 'perplexity' ||
      endpoint.endsWith('/v1') ||
      endpoint.endsWith('/openai') ||
      endpoint.endsWith('/v4') ||
      endpoint.endsWith('/api/v1')
    ) {
      modelsUrl = `${endpoint}/models`;
    } else {
      modelsUrl = `${endpoint}/v1/models`;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKey && apiKey.trim()) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    let response: Response;
    try {
      response = await fetch(modelsUrl, { headers });
      if (!response.ok && modelsUrl.endsWith('/v1/models')) {
        const altUrl = modelsUrl.replace(/\/v1\/models$/, '/models');
        try {
          const altResp = await fetch(altUrl, { headers });
          if (altResp.ok) {
            response = altResp;
          }
        } catch {}
      }
    } catch (e: any) {
      if (modelsUrl.endsWith('/v1/models')) {
        const altUrl = modelsUrl.replace(/\/v1\/models$/, '/models');
        response = await fetch(altUrl, { headers });
      } else {
        throw e;
      }
    }

    if (!response.ok) {
      throw new Error(`${provider} API error: ${response.status} (${response.statusText})`);
    }

    const data = await response.json();
    let rawModelsList: any[] = [];
    if (Array.isArray(data)) {
      rawModelsList = data;
    } else if (Array.isArray(data.data)) {
      rawModelsList = data.data;
    } else if (Array.isArray(data.models)) {
      rawModelsList = data.models;
    } else if (Array.isArray(data.result)) {
      rawModelsList = data.result;
    }

    const models = rawModelsList.map((model: any) => ({
      id: typeof model === 'string' ? model : (model.id || model.name || model.model || ''),
      name: typeof model === 'string' ? model : (model.display_name || model.name || model.id || model.model || '')
    })).filter((m) => m.id);

    const finalModels = models.length > 0 ? models : getModelList(provider);
    return { success: true, models: finalModels };
  } catch (error: any) {
    console.error(`Validation failed for ${provider}:`, error);
    return { success: false, models: getModelList(provider), error: error.message || 'Validation failed' };
  }
}
