/**
 * Utility for detecting browser UI language and converting to standard language names for AI prompts
 */

export interface DetectedLanguage {
  code: string;        // e.g. 'ko', 'en', 'ja', 'zh'
  fullTag: string;     // e.g. 'ko-KR', 'en-US'
  displayName: string; // e.g. 'Korean', 'English', 'Japanese'
}

/**
 * Detects browser UI language tailored to the runtime environment (Service Worker, UI popup, Offscreen, Node.js)
 * and returns normalized language information.
 * Default fallback is English ('English', 'en-US').
 */
export function detectBrowserLanguage(explicitLang?: string): DetectedLanguage {
  let rawTag = explicitLang?.trim();

  if (!rawTag && typeof browser !== 'undefined' && browser.i18n?.getUILanguage) {
    try {
      rawTag = browser.i18n.getUILanguage();
    } catch {
      // Fall through to next fallback on browser.i18n access failure
    }
  }

  if (!rawTag && typeof navigator !== 'undefined' && navigator.language) {
    rawTag = navigator.language;
  }

  // Default fallback: English
  rawTag = rawTag || 'en-US';
  let baseCode = rawTag.split('-')[0].toLowerCase();

  // Alias mapping for common display names / native names
  if (baseCode === 'korean' || baseCode === '한국어') baseCode = 'ko';
  else if (baseCode === 'japanese' || baseCode === '일본어' || baseCode === '日本語') baseCode = 'ja';
  else if (baseCode === 'english' || baseCode === '영어') baseCode = 'en';
  else if (baseCode === 'chinese' || baseCode === '중국어' || baseCode === '中文') baseCode = 'zh';
  else if (baseCode === 'spanish' || baseCode === '스페인어') baseCode = 'es';
  else if (baseCode === 'french' || baseCode === '프랑스어') baseCode = 'fr';
  else if (baseCode === 'german' || baseCode === '독일어') baseCode = 'de';
  else if (baseCode === 'russian' || baseCode === '러시아어') baseCode = 'ru';
  else if (baseCode === 'italian' || baseCode === '이탈리아어') baseCode = 'it';
  else if (baseCode === 'portuguese' || baseCode === '포르투갈어') baseCode = 'pt';
  else if (baseCode === 'vietnamese' || baseCode === '베트남어') baseCode = 'vi';
  else if (baseCode === 'thai' || baseCode === '태국어') baseCode = 'th';
  else if (baseCode === 'indonesian' || baseCode === '인도네시아어') baseCode = 'id';
  else if (baseCode === 'arabic' || baseCode === '아랍어') baseCode = 'ar';
  else if (baseCode === 'hindi' || baseCode === '힌디어') baseCode = 'hi';

  // Major language standard mappings (ensuring LLM clarity)
  const canonicalNames: Record<string, string> = {
    ko: 'Korean',
    en: 'English',
    ja: 'Japanese',
    zh: rawTag.toLowerCase().includes('tw') || rawTag.toLowerCase().includes('hant')
      ? 'Traditional Chinese'
      : 'Simplified Chinese',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    pt: 'Portuguese',
    it: 'Italian',
    ru: 'Russian',
    vi: 'Vietnamese',
    th: 'Thai',
    id: 'Indonesian',
    ar: 'Arabic',
    hi: 'Hindi',
  };

  let displayName = canonicalNames[baseCode];
  if (!displayName) {
    try {
      if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
        displayName = new Intl.DisplayNames(['en'], { type: 'language' }).of(baseCode) || 'English';
      } else {
        displayName = 'English';
      }
    } catch {
      displayName = 'English';
    }
  }

  return {
    code: baseCode,
    fullTag: rawTag,
    displayName,
  };
}
