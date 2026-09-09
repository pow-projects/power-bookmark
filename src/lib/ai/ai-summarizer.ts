import db from '../db';
import { AiSettings, AI_SETTINGS_KEYS, AI_CONCURRENCY_CONFIG, ExtractedPagePayload, AiAnalysisResult, FolderInfo, AiTaskKind, NO_BODY_TEXT, isNoBodyText, getPayloadText } from './types';
import { analyzeWithAiKind } from './ai-core';
import { AI_ANALYSIS_TIMEOUT_MS } from './queue-config';
import { getProvider } from './provider-registry';
import { isLocalEndpoint } from './llama-safety';
export * from './types';

/**
 * Loads AI-related settings from DB.
 */
export async function getAiSettings(): Promise<AiSettings> {
  const provider = (await db.settings.get(AI_SETTINGS_KEYS.PROVIDER))?.value || 'none';
  const rawApiKeysMap = (await db.settings.get(AI_SETTINGS_KEYS.API_KEYS_MAP))?.value;
  const apiKeysMap: Record<string, string> = typeof rawApiKeysMap === 'object' && rawApiKeysMap !== null ? rawApiKeysMap : {};
  
  const rawCachedModelsMap = (await db.settings.get(AI_SETTINGS_KEYS.CACHED_MODELS_MAP))?.value;
  const cachedModelsMap: Record<string, { id: string; name: string }[]> = typeof rawCachedModelsMap === 'object' && rawCachedModelsMap !== null ? rawCachedModelsMap : {};

  const rawApiKey = (await db.settings.get(AI_SETTINGS_KEYS.API_KEY))?.value || '';
  if (provider !== 'none' && rawApiKey && !apiKeysMap[provider]) {
    apiKeysMap[provider] = rawApiKey;
  }
  const apiKey = provider !== 'none' ? (apiKeysMap[provider] || '') : '';
  const customEndpoint = (await db.settings.get(AI_SETTINGS_KEYS.CUSTOM_ENDPOINT))?.value || '';
  const customModel = (await db.settings.get(AI_SETTINGS_KEYS.CUSTOM_MODEL))?.value || '';
  let model = (await db.settings.get(AI_SETTINGS_KEYS.MODEL))?.value || '';
  // If ai_model does not exist but ai_custom_model is present, auto-promote model = customModel
  if (!model && customModel) {
    model = customModel;
  }

  const autoSummarize = (await db.settings.get(AI_SETTINGS_KEYS.AUTO_SUMMARIZE))?.value === true;
  // Backward compatibility: If new keys (ai_auto_tags/ai_auto_folder) do not exist, migrate from legacy ai_auto_categorize, defaulting to true
  const legacyAutoCategorize = (await db.settings.get(AI_SETTINGS_KEYS.AUTO_CATEGORIZE))?.value;
  const autoTags = (await db.settings.get(AI_SETTINGS_KEYS.AUTO_TAGS))?.value ?? legacyAutoCategorize ?? true;
  const autoFolder = (await db.settings.get(AI_SETTINGS_KEYS.AUTO_FOLDER))?.value ?? legacyAutoCategorize ?? true;

  const rawConcurrency = (await db.settings.get(AI_SETTINGS_KEYS.CONCURRENCY))?.value;
  const parsedConcurrency = typeof rawConcurrency === 'number' ? rawConcurrency : (typeof rawConcurrency === 'string' ? parseInt(rawConcurrency, 10) : undefined);
  const concurrency = (parsedConcurrency !== undefined && Number.isFinite(parsedConcurrency))
    ? Math.max(AI_CONCURRENCY_CONFIG.MIN, Math.min(AI_CONCURRENCY_CONFIG.MAX, Math.round(parsedConcurrency)))
    : AI_CONCURRENCY_CONFIG.DEFAULT;

  return {
    provider,
    model,
    apiKey,
    apiKeysMap,
    cachedModelsMap,
    customEndpoint,
    customModel: customModel || model,
    autoSummarize,
    autoCategorize: legacyAutoCategorize ?? true,
    autoTags,
    autoFolder,
    concurrency
  };
}

/**
 * Checks whether AI analysis can be executed.
 * - provider is not 'none'
 * - model to use is specified
 * - Validates that a valid API key exists unless local/custom
 */
export async function isAiConfigured(): Promise<boolean> {
  const s = await getAiSettings();
  if (!s.provider || s.provider === 'none') return false;
  const activeModel = s.model || s.customModel;
  if (!activeModel || !activeModel.trim()) return false;

  const pDef = getProvider(s.provider);
  const isLocal = !!pDef?.isLocal || (s.provider === 'custom' && (!s.customEndpoint || isLocalEndpoint(s.customEndpoint)));

  if (!isLocal && s.provider !== 'custom') {
    return !!s.apiKey && s.apiKey.trim().length > 0;
  }
  return true;
}

/**
 * Saves AI settings to DB.
 */
export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await db.settings.put({ key: AI_SETTINGS_KEYS.PROVIDER, value: settings.provider });
  
  const targetModel = settings.model !== undefined ? settings.model : settings.customModel;
  if (targetModel !== undefined) {
    await db.settings.put({ key: AI_SETTINGS_KEYS.MODEL, value: targetModel });
    // Synchronize to ai_custom_model for backward compatibility
    await db.settings.put({ key: AI_SETTINGS_KEYS.CUSTOM_MODEL, value: targetModel });
  }

  await db.settings.put({ key: AI_SETTINGS_KEYS.API_KEY, value: settings.apiKey });
  
  const apiKeysMap = settings.apiKeysMap || {};
  if (settings.provider && settings.provider !== 'none' && settings.apiKey !== undefined) {
    apiKeysMap[settings.provider] = settings.apiKey;
  }
  await db.settings.put({ key: AI_SETTINGS_KEYS.API_KEYS_MAP, value: apiKeysMap });

  if (settings.cachedModelsMap) {
    await db.settings.put({ key: AI_SETTINGS_KEYS.CACHED_MODELS_MAP, value: settings.cachedModelsMap });
  }

  if (settings.customEndpoint !== undefined) await db.settings.put({ key: AI_SETTINGS_KEYS.CUSTOM_ENDPOINT, value: settings.customEndpoint });
  await db.settings.put({ key: AI_SETTINGS_KEYS.AUTO_SUMMARIZE, value: settings.autoSummarize });
  // Save using new keys only — legacy ai_auto_categorize key is maintained only for backward compatibility loading
  if (settings.autoTags !== undefined) await db.settings.put({ key: AI_SETTINGS_KEYS.AUTO_TAGS, value: settings.autoTags });
  if (settings.autoFolder !== undefined) await db.settings.put({ key: AI_SETTINGS_KEYS.AUTO_FOLDER, value: settings.autoFolder });
  if (settings.concurrency !== undefined) {
    const parsed = Number(settings.concurrency);
    const clamped = Number.isFinite(parsed)
      ? Math.max(AI_CONCURRENCY_CONFIG.MIN, Math.min(AI_CONCURRENCY_CONFIG.MAX, Math.round(parsed)))
      : AI_CONCURRENCY_CONFIG.DEFAULT;
    await db.settings.put({ key: AI_SETTINGS_KEYS.CONCURRENCY, value: clamped });
  }
}

/**
 * Analyzes webpage content and metadata via AI to return structured analysis results
 * including summary, category, and recommended folders.
 */
export async function analyzeContent(
  payload: ExtractedPagePayload | string,
  existingFolders: FolderInfo[] = [],
  signal?: AbortSignal,
  kind: AiTaskKind = 'full',
  currentRoot?: string
): Promise<AiAnalysisResult> {
  const settings = await getAiSettings();

  if (settings.provider === 'none') {
    throw new Error('AI provider is not configured.');
  }

  const activeModel = settings.model || settings.customModel;
  if (!activeModel || !activeModel.trim()) {
    throw new Error('AI model is not selected. Please select a model in AI settings.');
  }

  const pDef = getProvider(settings.provider);
  const isLocal = !!pDef?.isLocal || (settings.provider === 'custom' && (!settings.customEndpoint || isLocalEndpoint(settings.customEndpoint)));

  if (!isLocal && settings.provider !== 'custom' && (!settings.apiKey || !settings.apiKey.trim())) {
    throw new Error('AI provider is not configured or API key is missing.');
  }

  const normalizedPayload: ExtractedPagePayload = typeof payload === 'string'
    ? { textContent: payload }
    : { ...payload };

  // popup/content script payload uses content/text fields, external calls use textContent field
  const rawText = getPayloadText(normalizedPayload);
  let cleanText = rawText;

  // If body is empty, use metaDescription (fallback to title/url if absent to perform AI analysis)
  if (!cleanText) {
    const metaOnly = (normalizedPayload.metaDescription || '').trim();
    if (metaOnly) {
      cleanText = metaOnly;
    } else {
      const titleUrlFallback = [normalizedPayload.title, normalizedPayload.url].filter(Boolean).join(' - ').trim();
      if (titleUrlFallback) {
        cleanText = titleUrlFallback;
      } else {
        return {
          summary: NO_BODY_TEXT,
          category: 'General',
          suggestedFolderId: null,
          suggestedFolderName: '',
          isNewFolderRecommended: false,
          tags: [],
          confidence: 0
        };
      }
    }
  }

  normalizedPayload.textContent = cleanText;
  normalizedPayload.content = cleanText;
  normalizedPayload.text = cleanText;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_ANALYSIS_TIMEOUT_MS); // Timeout considering local LLM
  // Connect external (user cancellation) signal to internal timeout controller — allows caller (background analyzer) to request abort
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);

  try {
    const result = await analyzeWithAiKind(kind, settings, normalizedPayload, existingFolders, controller.signal, currentRoot);
    return result as AiAnalysisResult;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      // If aborted by external signal (user cancellation), propagate AbortError as-is — caller handles differently from timeout
      if (signal?.aborted) throw error;
      throw new Error(`AI summary request timed out after ${AI_ANALYSIS_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Summarizes specified body text via AI. (Backward compatibility wrapper)
 */
export async function summarizeContent(textContent: string): Promise<string> {
  const result = await analyzeContent({ textContent });
  return result.summary;
}


