import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { LanguageModel } from 'ai';
import { AiSettings } from './types';
import aiProvidersData from './ai-providers.json';

export interface ModelDefinition {
  id: string;
  name: string;
  description?: string;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  category: string;
  npmPackage?: string;
  description?: string;
  features?: string[];
  defaultModels?: string[];
  docsUrl?: string;
  isLocal?: boolean;
  models: ModelDefinition[];
  createModel: (apiKey: string, modelId: string, options?: any) => LanguageModel;
}

export const CATEGORY_LABEL_KEYS: Record<string, string> = {
  all: 'ai.categoryAll',
  official: 'ai.categoryOfficial',
  'openai-compatible': 'ai.categoryOpenAI',
  community: 'ai.categoryCommunity',
  custom: 'ai.categoryCustom'
};

export const DEFAULT_ENDPOINTS: Record<string, string> = {
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  vllm: 'http://localhost:8000/v1',
  localai: 'http://localhost:8080/v1',
  jan: 'http://localhost:1337/v1',
  'text-generation-webui': 'http://localhost:5000/v1',
  anythingllm: 'http://localhost:3001/api/v1',
  custom: 'http://localhost:8080/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  perplexity: 'https://api.perplexity.ai',
  deepseek: 'https://api.deepseek.com',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  cohere: 'https://api.cohere.com/v1',
  togetherai: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  xai: 'https://api.x.ai/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  novita: 'https://api.novita.ai/v3/openai',
  hyperbolic: 'https://api.hyperbolic.xyz/v1',
  upstage: 'https://api.upstage.ai/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4'
};

function createModelForProvider(
  providerId: string,
  apiKey: string,
  modelId: string,
  options?: any
): LanguageModel {
  const customEndpoint = options?.customEndpoint && options.customEndpoint.trim() !== '' 
    ? options.customEndpoint 
    : undefined;

  if (providerId === 'openai') {
    const openai = createOpenAI({ 
      apiKey, 
      ...(customEndpoint ? { baseURL: customEndpoint } : {})
    });
    return openai(modelId);
  }
  if (providerId === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey,
      headers: {
        'anthropic-dangerous-direct-browser-access': 'true'
      }
    });
    return anthropic(modelId);
  }
  if (providerId === 'google' || providerId === 'gemini') {
    const google = createGoogleGenerativeAI({ apiKey });
    return google(modelId);
  }

  // Standard OpenAI compatible model creation for other providers
  const baseURL = customEndpoint || DEFAULT_ENDPOINTS[providerId];
  const openai = createOpenAI({
    apiKey: apiKey || 'empty',
    ...(baseURL ? { baseURL } : {})
  });
  return openai(modelId);
}

const buildProvidersMap = (): Record<string, ProviderDefinition> => {
  const map: Record<string, ProviderDefinition> = {};

  const providerList = (aiProvidersData.providers || aiProvidersData) as any[];
  for (const item of providerList) {
    const models: ModelDefinition[] = (item.defaultModels || []).map((mId: string) => ({
      id: mId,
      name: mId
    }));

    map[item.id] = {
      id: item.id,
      name: item.name,
      category: item.category,
      npmPackage: item.npmPackage,
      description: item.description,
      features: item.features,
      defaultModels: item.defaultModels,
      docsUrl: item.docsUrl,
      isLocal: item.isLocal,
      models,
      createModel: (apiKey: string, modelId: string, options?: any) =>
        createModelForProvider(item.id, apiKey, modelId, options)
    };
  }

  // Add custom provider definition
  map['custom'] = {
    id: 'custom',
    name: i18n.t('aiSettings.customApi'),
    category: 'custom',
    description: i18n.t('aiSettings.customApiDesc'),
    isLocal: false,
    models: [],
    createModel: (apiKey: string, modelId: string, options?: any) =>
      createModelForProvider('custom', apiKey, modelId, options)
  };

  // Alias gemini to google for backwards compatibility
  if (map['google']) {
    map['gemini'] = {
      ...map['google'],
      id: 'gemini'
    };
  }

  return map;
};

export const providers: Record<string, ProviderDefinition> = buildProvidersMap();

// Providers without actual SDK support (Azure/Bedrock/Chrome AI) are excluded from the UI list.
// If createModel falls back to openai-compatible it malfunctions, so re-enable once SDK support is added.
const UNSUPPORTED_PROVIDERS = new Set(['azure', 'amazon-bedrock', 'chrome-ai']);

export function getProviderList(): ProviderDefinition[] {
  // Exclude gemini alias from the general provider list to avoid duplicates in UI
  return Object.values(providers).filter(
    p => !(p.id === 'gemini' && providers['google']) && !UNSUPPORTED_PROVIDERS.has(p.id)
  );
}

export function getProvider(id: string): ProviderDefinition | undefined {
  if (id === 'gemini') return providers['gemini'] || providers['google'];
  return providers[id];
}

export function getModelList(providerId: string): ModelDefinition[] {
  const provider = getProvider(providerId);
  return provider ? provider.models : [];
}

export function getProviderCategoryList(): { id: string; name: string }[] {
  const categories = new Set<string>();
  categories.add('all');
  for (const p of Object.values(providers)) {
    if (p.id === 'gemini') continue;
    categories.add(p.category || 'official');
  }
  return Array.from(categories).map(catId => ({
    id: catId,
    name: CATEGORY_LABEL_KEYS[catId] ? i18n.t(CATEGORY_LABEL_KEYS[catId]) : catId
  }));
}

export function getProvidersByCategory(category: string, searchQuery = ''): ProviderDefinition[] {
  let list = getProviderList();
  if (category && category !== 'all') {
    list = list.filter(p => p.category === category);
  }
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    list = list.filter(
      p =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.npmPackage && p.npmPackage.toLowerCase().includes(q))
    );
  }
  return list;
}

export function getLanguageModel(settings: AiSettings): LanguageModel {
  const providerId = settings.provider === 'gemini' ? 'google' : settings.provider;
  const provider = getProvider(providerId) || getProvider(settings.provider);
  if (!provider) {
    throw new Error(`Unsupported provider: ${settings.provider}`);
  }

  const modelId = settings.model || settings.customModel;

  if (!modelId || !modelId.trim()) {
    throw new Error(`No model specified for provider: ${settings.provider}. Please select a model in AI settings.`);
  }

  return provider.createModel(settings.apiKey, modelId.trim(), {
    customEndpoint: settings.customEndpoint,
  });
}

export { fetchAvailableModels } from './fetch-models';

