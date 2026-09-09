import {
  normalizeFolderPath,
  sanitizeTechnicalSlashes,
  clampNewFolderDepth,
  KNOWN_FOLDER_TYPOS
} from '../bookmarks/folder-utils';
import { sanitizeTags } from '../bookmarks/tag-utils';
import { detectBrowserLanguage } from './language-detector';

/**
 * Default AI Provider ID list and dynamic Provider ID type
 */
export type KnownAiProviderId = 'openai' | 'gemini' | 'anthropic' | 'custom' | 'none';
export type AiProviderId = KnownAiProviderId | (string & {});

/**
 * Text extraction type
 */
export type ExtractionType = 'readability' | 'semantic' | 'basic';

/**
 * Default analysis confidence constants
 */
export const DEFAULT_CONFIDENCE = 0.8;
export const ERROR_CONFIDENCE = 0.5;
export const MAX_PROMPT_FOLDERS = 500;

/**
 * AI concurrency configuration constants (min 1, max 10, default 3)
 */
export const AI_CONCURRENCY_CONFIG = {
  DEFAULT: 3,
  MIN: 1,
  MAX: 10
} as const;

/**
 * AI Settings Interface
 * Supports flexible Provider extensions while maintaining backward compatibility with existing settings.
 */
export interface AiSettings {
  provider: AiProviderId;
  model?: string;
  apiKey: string;
  apiKeysMap?: Record<string, string>;
  cachedModelsMap?: Record<string, { id: string; name: string }[]>;
  customEndpoint?: string;
  /**
   * @deprecated Unified into 'model' property. Maintained for backward compatibility.
   */
  customModel?: string;
  autoSummarize: boolean;
  autoCategorize?: boolean;
  autoTags?: boolean;
  autoFolder?: boolean;
  temperature?: number;
  maxTokens?: number;
  organizationId?: string;
  concurrency?: number;
}

export interface ExtractedPagePayload {
  title?: string;
  url?: string;
  metaDescription?: string;
  content?: string;
  extractionType?: ExtractionType;
  text?: string;
  textContent?: string;
}

export interface FolderInfo {
  id: string;
  title: string;
  path?: string;
}

/**
 * AI analysis task kinds — splits background auto-analysis into summary/tags/folder,
 * enabling independent execution and individual cancellation for each. 'full' is legacy combined analysis (bulk, etc.).
 */
export type AiTaskKind = 'full' | 'summary' | 'tags' | 'folder';

export interface AiAnalysisResult {
  summary: string;
  category: string;
  suggestedFolderId: string | null;
  suggestedFolderName: string;
  isNewFolderRecommended: boolean;
  tags: string[];
  confidence: number;
}

export const AI_SETTINGS_KEYS = {
  PROVIDER: 'ai_provider',
  MODEL: 'ai_model',
  API_KEY: 'ai_api_key',
  API_KEYS_MAP: 'ai_api_keys_map',
  CACHED_MODELS_MAP: 'ai_cached_models_map',
  CUSTOM_ENDPOINT: 'ai_custom_endpoint',
  CUSTOM_MODEL: 'ai_custom_model',
  AUTO_SUMMARIZE: 'ai_auto_summarize',
  AUTO_CATEGORIZE: 'ai_auto_categorize',
  AUTO_TAGS: 'ai_auto_tags',
  AUTO_FOLDER: 'ai_auto_folder',
  CONCURRENCY: 'ai_concurrency'
} as const;

/**
 * Helper function to extract valid body text from payload
 */
export function getPayloadText(payload?: ExtractedPagePayload | null): string {
  if (!payload) return '';
  const text = payload.textContent || payload.content || payload.text || '';
  return text.trim();
}

/**
 * Helper function to format the folder list string to insert into prompt
 */
export function formatFolderListPrompt(
  existingFolders: FolderInfo[],
  maxFolders = MAX_PROMPT_FOLDERS,
  pageContext?: { title?: string; url?: string; metaDescription?: string }
): string {
  if (!existingFolders || existingFolders.length === 0) {
    return 'None';
  }
  let targetList = existingFolders;
  let isTruncated = false;
  if (existingFolders.length > maxFolders) {
    isTruncated = true;
    const keywords = [pageContext?.title, pageContext?.metaDescription, pageContext?.url]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length >= 2);

    const scored = existingFolders.map(f => {
      const pathLower = (f.path || f.title).toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (pathLower.includes(kw)) score += 2;
      }
      const depth = (f.path || f.title).split('/').length;
      if (depth <= 2) score += 1; // preserve top-level hierarchy
      return { folder: f, score };
    });

    scored.sort((a, b) => b.score - a.score);
    targetList = scored.slice(0, maxFolders).map(s => s.folder);
  }

  const lines = targetList
    .map(f => {
      const cleanPath = normalizeFolderPath(f.path || f.title).trim();
      if (!cleanPath) return null;
      return `- "${cleanPath}" (id: "${f.id}")`;
    })
    .filter((line): line is string => Boolean(line));

  if (isTruncated) {
    lines.push(`- ... (${existingFolders.length - maxFolders} additional existing folders omitted)`);
  }

  return lines.length > 0 ? lines.join('\n') : 'None';
}

/**
 * Special token soup signatures output by llama.cpp Content-only instances (gemma family)
 */
export const TOKEN_SOUP_RE = /<unused\d*>|<\|begin_of_turn|<\|end_of_turn|<\|start_of_turn|<\|tool|<\|assistant|<\|user|<\|system|<\|reasoning|<\|thinking|\[multimodal\]/i;
export function isTokenSoup(text: string): boolean {
  return TOKEN_SOUP_RE.test(text || '');
}

/**
 * Multilingual generic category identification set
 */
export const GENERIC_CATEGORY_NAMES = new Set<string>([
  '일반', '기타', '미분류',
  'general', 'other', 'others', 'uncategorized', 'misc', 'miscellaneous', 'default',
  '一般', 'その他', '未分類', '其他'
]);

export function isGenericCategory(category?: string | null): boolean {
  if (!category) return true;
  return GENERIC_CATEGORY_NAMES.has(category.trim().toLowerCase());
}

/**
 * Category sanitization: forces single noun.
 * If compound category names are generated with multilingual conjunctions (and/or/&/+/및/와/과/etc.) or delimiters (/ , ;), takes only the first item.
 * e.g., 'Shopping and Life' -> 'Shopping', '쇼핑 및 생활 정보' -> '쇼핑', '개발/디자인' -> '개발', '수학과' -> '수학과' (protect suffix)
 */
export function sanitizeCategory(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return '';

  const tokens = cleaned.split(
    /(?:\s+(?:and|or|und|et|y|ou|och|og)\s+|\s*(?:및|그리고|또는|及び|および|または|和|与|或)\s*|\s*(?:와|과)\s+|(?<![A-Za-z0-9])\/|\/(?![A-Za-z0-9])|[,;&+])/i
  );
  const first = (tokens[0] || '').trim();
  return first || cleaned;
}

/**
 * Folder path sanitization: preserves '/' path delimiters and sanitizes each segment using single noun rules.
 * Protects technical slashes (CDN/WAF -> CDN-WAF), clamps depth to max 2, and fixes known typos.
 * e.g., 'Community/Politics' -> 'Community/Politics', '쇼핑 및 생활 정보/특가' -> '쇼핑/특가'
 */
export function sanitizeFolderName(name: string): string {
  if (!name) return '';
  const protectedName = sanitizeTechnicalSlashes(name);
  const sanitized = protectedName
    .split('/')
    .map(seg => {
      const cleaned = sanitizeCategory(seg);
      const lower = cleaned.toLowerCase();
      return KNOWN_FOLDER_TYPOS[lower] || cleaned;
    })
    .filter(Boolean)
    .join('/');
  return clampNewFolderDepth(sanitized, 3);
}

export function buildAnalysisPrompt(
  payload: ExtractedPagePayload,
  existingFolders: FolderInfo[] = [],
  mode: AiTaskKind = 'full',
  targetLanguage?: string,
  currentRoot?: string
): { systemPrompt: string; userPrompt: string } {
  const effectiveTargetLang = targetLanguage || detectBrowserLanguage().displayName;
  const effectiveLangCode = detectBrowserLanguage(targetLanguage).code;
  const isKorean = effectiveLangCode === 'ko';

  const summaryStyleGuide = isKorean
    ? `1. Write a concise, single-sentence summary (~60 Korean characters) describing what the page is and what it provides.
2. End the sentence with a noun phrase (명사형 종결, e.g., "...플랫폼", "...가이드", "...소개"). DO NOT use polite narrative sentence endings like "~입니다" or "~합니다".
3. NEVER repeat the page or website name in the summary (e.g., do not start with the site name).`
    : `1. Write a concise, single-sentence summary (around 10 to 15 words) stating clearly what the page is and its core value.
2. Use a concise informative phrase or clause. DO NOT use conversational fillers or repeat the site/page name.`;

  const baseSystem = `You are an expert AI assistant that analyzes webpage content and metadata to organize and summarize bookmarks.

[TARGET OUTPUT LANGUAGE]
- Target Output Language: ${effectiveTargetLang}
- Regardless of the original language of the webpage content, you MUST generate the 'summary', 'category', 'tags', and any new 'suggestedFolderName' in ${effectiveTargetLang}.
- Standard technical terms, brand names, programming languages, and industry abbreviations (e.g., React, TypeScript, Kubernetes, Apple) must be preserved in their standard industry form.

[SUMMARY GUIDELINES]
${summaryStyleGuide}

[CATEGORY & FOLDER GUIDELINES]
1. 'category' MUST be a single concise noun representing the page topic (e.g., ${isKorean ? '정치, 쇼핑, 개발, 금융, IT, 여행, 게임' : 'Technology, Development, Shopping, Finance, Politics, Travel'}).
2. NEVER combine multiple topics with conjunctions (e.g., ${isKorean ? '"쇼핑 및 생활" (X) -> "쇼핑" (O)' : '"Tech and Science" (X) -> "Tech" (O)'}).
3. Determine folder hierarchy logically:
   - Distinct platforms (communities, portals, news, malls): Top folder is platform type, subfolder is topic (e.g., ${isKorean ? '"커뮤니티/정치", "커뮤니티/쇼핑"' : '"Community/Politics", "News/Economy"'}).
   - Single-topic sites (tech docs, blogs): Return a single-level folder (e.g., ${isKorean ? '"개발"' : '"Development"'}).
4. "/" MUST only be used as a folder hierarchy delimiter. Each folder name must be a single concise noun.
5. Limit folder hierarchy to a maximum of 3 levels (e.g., "Category/Subcategory/Topic"). Avoid overly deep nesting (4+ levels).

[EXISTING FOLDERS PRIORITY & IMMUTABILITY]
1. Review existing folders from [Existing Folders] first.
2. Select an existing folder ONLY IF its ENTIRE hierarchical path (including all parent folders) logically matches the webpage's core domain. NEVER select an existing folder solely because its leaf name matches generic terms like 'Tools', 'Resources', 'Utils', or 'Docs' (e.g., do NOT categorize a Web Scraper into 'AI/StableDiffusion/Tools').
3. If a suitable folder exists—EVEN IF the existing folder name is in a different language from ${effectiveTargetLang}—you MUST set 'suggestedFolderId' to that folder's ID, 'isNewFolderRecommended' to false, and 'suggestedFolderName' to that existing folder's Path. NEVER translate existing folder names.
4. If no existing folder is suitable or if the parent hierarchy is unrelated, set 'suggestedFolderId': null, 'isNewFolderRecommended': true, and generate a new folder path in ${effectiveTargetLang} ("Parent/Child" format).`;

  // Return JSON shape per mode
  const jsonShapes: Record<AiTaskKind, string> = {
    full: `{
  "summary": "Single concise sentence summary in ${effectiveTargetLang}",
  "category": "Single noun page topic in ${effectiveTargetLang}",
  "suggestedFolderId": "ID of suitable existing folder (or null)",
  "suggestedFolderName": "Suggested folder path (e.g., Community/Politics)",
  "isNewFolderRecommended": boolean,
  "tags": ["tag1", "tag2", "tag3"],
  "confidence": number between 0.0 and 1.0
}`,
    summary: `{
  "summary": "Single concise sentence summary in ${effectiveTargetLang}"
}`,
    tags: `{
  "tags": ["tag1", "tag2", "tag3"]
}`,
    folder: `{
  "category": "Single noun page topic in ${effectiveTargetLang}",
  "suggestedFolderId": "ID of suitable existing folder (or null)",
  "suggestedFolderName": "Suggested folder path",
  "isNewFolderRecommended": boolean,
  "tags": ["tag1", "tag2", "tag3"]
}`
  };

  const onlyFieldNote = mode === 'full'
    ? ''
    : '\nOutput ONLY the requested fields in a single JSON object with no extra keys.';
  const rootGuideline = currentRoot
    ? `\n\n[TARGET ROOT CONTEXT]\n- Target Root: "${currentRoot}". Favor selecting or creating folders within this root's hierarchy.`
    : '';
  const systemPrompt = baseSystem + rootGuideline + '\n\nRespond with a single valid JSON object matching the following structure. Do not include markdown code fences or explanatory text:\n' + jsonShapes[mode] + onlyFieldNote;

  const folderListStr = formatFolderListPrompt(existingFolders, MAX_PROMPT_FOLDERS, {
    title: payload.title,
    url: payload.url,
    metaDescription: payload.metaDescription
  });

  const userPrompt = `Title: ${payload.title || 'Untitled'}
URL: ${payload.url || 'No URL'}
Meta Description: ${payload.metaDescription || 'None'}

[Existing Folders]
${folderListStr}

[Webpage Content]
${getPayloadText(payload)}`;

  return { systemPrompt, userPrompt };
}

export function parseAnalysisResult(rawText: string): AiAnalysisResult {
  let cleaned = rawText.trim();
  // Remove <think> / <thought> tag blocks from Reasoning (CoT) models
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();

  // Token soup (Content-only llama.cpp instances, etc.) cannot be parsed — block with default failure values before saving
  if (isTokenSoup(cleaned)) {
    return {
      summary: 'Unable to generate summary.',
      category: 'General',
      suggestedFolderId: null,
      suggestedFolderName: '',
      isNewFolderRecommended: false,
      tags: [],
      confidence: ERROR_CONFIDENCE,
    };
  }

  let jsonStr = cleaned;
  const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match) {
    jsonStr = match[1].trim();
  } else {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = cleaned.slice(firstBrace, lastBrace + 1).trim();
    }
  }
  
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : 'Unable to generate summary.',
      category: typeof parsed.category === 'string' && parsed.category.trim() ? sanitizeCategory(parsed.category) : 'General',
      suggestedFolderId: typeof parsed.suggestedFolderId === 'string' ? parsed.suggestedFolderId : null,
      suggestedFolderName: typeof parsed.suggestedFolderName === 'string' && parsed.suggestedFolderName.trim()
        ? sanitizeFolderName(parsed.suggestedFolderName)
        : '',
      isNewFolderRecommended: typeof parsed.isNewFolderRecommended === 'boolean'
        ? parsed.isNewFolderRecommended
        : parsed.suggestedFolderId == null,
      tags: sanitizeTags(parsed.tags),
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : DEFAULT_CONFIDENCE
    };
  } catch {
    return {
      summary: NO_BODY_TEXT_SENTINELS.has(cleaned) ? cleaned : 'Unable to generate summary.',
      category: 'General',
      suggestedFolderId: null,
      suggestedFolderName: '',
      isNewFolderRecommended: false,
      tags: [],
      confidence: ERROR_CONFIDENCE
    };
  }
}

export const NO_BODY_TEXT = 'No body text to summarize.';

export const NO_BODY_TEXT_SENTINELS = new Set<string>([
  '__NO_BODY_TEXT__',
  'No body text to summarize.',
  'No body text available.',
  '요약할 본문 텍스트가 없습니다.',
  'Unable to generate summary.',
  '요약 결과를 가져올 수 없습니다.',
]);

export function isNoBodyText(summary?: string | null): boolean {
  if (!summary || !summary.trim()) return true;
  return NO_BODY_TEXT_SENTINELS.has(summary.trim());
}
