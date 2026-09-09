import { generateObject, generateText } from 'ai';
import { getLanguageModel, DEFAULT_ENDPOINTS } from './provider-registry';
import { analysisResultSchema, summaryResultSchema, tagsResultSchema, folderResultSchema, AnalysisResult } from './analysis-schema';
import { AiSettings, AiTaskKind, ExtractedPagePayload, FolderInfo, buildAnalysisPrompt, parseAnalysisResult, sanitizeCategory, sanitizeFolderName, isTokenSoup, isNoBodyText } from './types';
import { getSafeMaxTokens, assertValidModelOutput, TokenSoupError } from './llama-safety';
import { sanitizeTags } from '../bookmarks/tag-utils';

const SCHEMA_BY_KIND: Record<AiTaskKind, any> = {
  full: analysisResultSchema,
  summary: summaryResultSchema,
  tags: tagsResultSchema,
  folder: folderResultSchema,
};

/**
 * Extracts and sanitizes subset result matching the given kind.
 * - 'folder': sanitizes category/suggestedFolderName with single noun/path rules, sanitizes tags
 * - 'full': same sanitization as legacy combined analysis, sanitizes tags
 * - 'summary'/'tags': extracts only the respective field
 */
function subsetForKind(kind: AiTaskKind, obj: any): any {
  if (kind === 'summary') return { summary: typeof obj?.summary === 'string' ? obj.summary.trim() : '' };
  if (kind === 'tags') return { tags: sanitizeTags(obj?.tags) };
  if (kind === 'folder') {
    return {
      category: typeof obj?.category === 'string' && obj.category.trim() ? sanitizeCategory(obj.category) : 'General',
      suggestedFolderId: typeof obj?.suggestedFolderId === 'string' ? obj.suggestedFolderId : null,
      suggestedFolderName: typeof obj?.suggestedFolderName === 'string' && obj.suggestedFolderName.trim() ? sanitizeFolderName(obj.suggestedFolderName) : '',
      isNewFolderRecommended: typeof obj?.isNewFolderRecommended === 'boolean' ? obj.isNewFolderRecommended : obj?.suggestedFolderId == null,
      tags: sanitizeTags(obj?.tags),
    };
  }
  return {
    ...obj,
    category: obj?.category ? sanitizeCategory(obj.category) : 'General',
    suggestedFolderName: obj?.suggestedFolderName ? sanitizeFolderName(obj.suggestedFolderName) : '',
    ...(obj?.tags !== undefined ? { tags: sanitizeTags(obj.tags) } : {}),
  };
}

/** Determines whether recovery candidate contains useful output for the kind (for full/summary, whether a valid summary exists) */
function hasUsefulOutput(kind: AiTaskKind, recovered: any): boolean {
  if (kind === 'tags') return Array.isArray(recovered?.tags) && recovered.tags.length > 0;
  if (kind === 'folder') return !!recovered?.category || !!recovered?.suggestedFolderName || recovered?.suggestedFolderId !== null;
  return !!recovered?.summary && !isNoBodyText(recovered.summary);
}

/**
 * Executes AI analysis — performs combined (full) or individual (summary/tags/folder) calls according to kind.
 * Each kind supports individual cancellation via independent AbortSignal.
 */
export async function analyzeWithAiKind(
  kind: AiTaskKind,
  settings: AiSettings,
  payload: ExtractedPagePayload,
  existingFolders: FolderInfo[] = [],
  signal?: AbortSignal,
  currentRoot?: string
): Promise<any> {
  const model = getLanguageModel(settings);
  const { systemPrompt, userPrompt } = buildAnalysisPrompt(
    payload,
    existingFolders,
    kind,
    undefined,
    currentRoot
  );
  const schema = SCHEMA_BY_KIND[kind];

  // Local/private endpoints require max_tokens budget — ensures 2048 lower bound to prevent token soup
  const endpoint = settings.customEndpoint || DEFAULT_ENDPOINTS[settings.provider];
  const maxOutputTokens = getSafeMaxTokens(endpoint, settings.maxTokens);

  try {
    const { object } = await generateObject({
      model,
      schema,
      system: systemPrompt,
      prompt: userPrompt,
      abortSignal: signal,
      maxOutputTokens,
    });

    return subsetForKind(kind, object);
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw error;
    }

    // Token soup (error.text is a blob of special tokens like <unusedN>) will remain soup on retry — reject immediately and block saving
    if (error?.text && isTokenSoup(error.text)) {
      throw new TokenSoupError();
    }

    // Recover when local LLM (llama.cpp, etc.) wraps output in ```json ... ``` markdown code block, causing generateObject parse failure
    if (error?.text) {
      const recovered = parseAnalysisResult(error.text);
      if (recovered && hasUsefulOutput(kind, recovered)) {
        return subsetForKind(kind, recovered);
      }
    }

    // If error.text is missing or recovery fails, retry with raw text request
    const { text } = await generateText({
      model,
      system: systemPrompt + '\nDO NOT USE MARKDOWN CODE BLOCKS. Output raw JSON only.',
      prompt: userPrompt,
      abortSignal: signal,
      maxOutputTokens,
    });
    // Also check generateText final output for soup — block before saving if soup
    assertValidModelOutput(text);
    return subsetForKind(kind, parseAnalysisResult(text));
  }
}

/** Legacy combined analysis (used for bulk categorization/summarization, etc.). Delegates to analyzeWithAiKind('full', ...) — preserves signature and behavior */
export async function analyzeWithAi(
  settings: AiSettings,
  payload: ExtractedPagePayload,
  existingFolders: FolderInfo[] = [],
  signal?: AbortSignal
): Promise<AnalysisResult> {
  return analyzeWithAiKind('full', settings, payload, existingFolders, signal) as Promise<AnalysisResult>;
}
