import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { summarizeContent, analyzeContent, getAiSettings, saveAiSettings, isAiConfigured } from '../../src/lib/ai/ai-summarizer';
import { generateObject } from 'ai';

const { mockDb } = vi.hoisted(() => {
  const db = {
    settings: {
      data: new Map<string, any>(),
      clear: async () => db.settings.data.clear(),
      get: async (key: string) => ({ value: db.settings.data.get(key) }),
      put: async (item: { key: string, value: any }) => { db.settings.data.set(item.key, item.value); }
    }
  };
  return { mockDb: db };
});

vi.mock('../../src/lib/db', () => ({
  default: mockDb
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
}));

describe('AI Summarizer', () => {
  beforeEach(async () => {
    // Initialize DB
    await mockDb.settings.clear();
    vi.mocked(generateObject).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws error if AI provider is not configured', async () => {
    await saveAiSettings({ provider: 'none', apiKey: '', autoSummarize: false });
    await expect(summarizeContent('Test text')).rejects.toThrow('AI provider is not configured');
  });

  it('throws error if AI model is not selected', async () => {
    await saveAiSettings({ provider: 'openai', apiKey: 'test-key', autoSummarize: false });
    await expect(summarizeContent('Test text')).rejects.toThrow('AI model is not selected');
  });

  it('summarizes content with OpenAI successfully', async () => {
    await saveAiSettings({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key', autoSummarize: false });
    
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        summary: 'Mock summary',
        category: '일반',
        suggestedFolderId: null,
        suggestedFolderName: '기타',
        isNewFolderRecommended: false,
        tags: [],
        confidence: 0.9
      }
    } as any);

    const result = await summarizeContent('Test text');
    expect(result).toBe('Mock summary');
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it('analyzes content with OpenAI returning structured JSON', async () => {
    await saveAiSettings({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key', autoSummarize: false });
    
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        summary: '요약 내용입니다.',
        category: '개발',
        suggestedFolderId: 'folder-1',
        suggestedFolderName: '개발자료',
        isNewFolderRecommended: false,
        tags: ['TypeScript', 'WXT'],
        confidence: 0.95
      }
    } as any);

    const payload = {
      url: 'https://example.com',
      title: '예시 페이지',
      textContent: '본문 내용입니다.'
    };
    const existingFolders = [{ id: 'folder-1', title: '개발자료' }];

    const result = await analyzeContent(payload, existingFolders);

    expect(result).toEqual({
      summary: '요약 내용입니다.',
      category: '개발',
      suggestedFolderId: 'folder-1',
      suggestedFolderName: '개발자료',
      isNewFolderRecommended: false,
      tags: ['TypeScript', 'WXT'],
      confidence: 0.95
    });
  });

  it('uses content/text fields from popup payload (regression: textContent missing)', async () => {
    await saveAiSettings({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key', autoSummarize: false });

    vi.mocked(generateObject).mockResolvedValue({
      object: {
        summary: '팝업 요약',
        category: '개발',
        suggestedFolderId: null,
        suggestedFolderName: '기타',
        isNewFolderRecommended: false,
        tags: [],
        confidence: 0.9
      }
    } as any);

    // popup extractPagePayload generates only content/text fields without textContent
    const payload = { url: 'https://example.com', title: '예시', content: '팝업에서 추출한 본문입니다.' };
    const result = await analyzeContent(payload);
    expect(result.summary).toBe('팝업 요약');
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it('returns fallback result when textContent, metaDescription, title, and url are all empty', async () => {
    await saveAiSettings({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key', autoSummarize: false });

    const result = await analyzeContent({ textContent: '', title: '', url: '' });
    expect(result.summary).toBe('No body text to summarize.');
    expect(result.category).toBe('General');
    expect(result.confidence).toBe(0);
    // generateObject should not be called
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('falls back to title and url when textContent and metaDescription are empty', async () => {
    await saveAiSettings({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key', autoSummarize: false });

    vi.mocked(generateObject).mockResolvedValue({
      object: {
        summary: '제목과 URL 기반 요약',
        category: '개발',
        suggestedFolderId: null,
        suggestedFolderName: '개발',
        isNewFolderRecommended: false,
        tags: ['GitHub'],
        confidence: 0.8
      }
    } as any);

    const result = await analyzeContent({ textContent: '', title: 'GitHub Repository', url: 'https://github.com/test/repo' });
    expect(result.summary).toBe('제목과 URL 기반 요약');
    expect(result.category).toBe('개발');
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it('handles timeout correctly', async () => {
    await saveAiSettings({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key', autoSummarize: false });
    
    vi.useFakeTimers();
    
    vi.mocked(generateObject).mockImplementation(({ abortSignal }: any) => {
      return new Promise((resolve, reject) => {
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
          if (abortSignal.aborted) {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          }
        }
      });
    });

    const promise = expect(summarizeContent('Test text')).rejects.toThrow('AI summary request timed out after 120 seconds.');
    
    await vi.advanceTimersByTimeAsync(120500);
    await promise;
    
    vi.useRealTimers();
  }, 130000);

  it('builds analysis prompt with existing folders priority and new folder guidelines', async () => {
    const { buildAnalysisPrompt } = await import('../../src/lib/ai/types');
    const prompt = buildAnalysisPrompt(
      { title: 'TypeScript Doc', url: 'https://ts.dev', textContent: 'TS docs' },
      [{ id: '10', title: '개발문서' }],
      'full',
      'Korean'
    );
    expect(prompt.systemPrompt).toContain('TARGET OUTPUT LANGUAGE');
    expect(prompt.systemPrompt).toContain('Korean');
    expect(prompt.systemPrompt).toContain('suggestedFolderId');
    expect(prompt.systemPrompt).toContain('isNewFolderRecommended');
    expect(prompt.systemPrompt).toContain('suggestedFolderName');
    expect(prompt.systemPrompt).toContain('NEVER translate existing folder names');
    expect(prompt.userPrompt).toContain('- "개발문서" (id: "10")');
    // Concise summary, single noun, hierarchical classification rules
    expect(prompt.systemPrompt).toContain('60 Korean characters');
    expect(prompt.systemPrompt).toContain('명사형 종결');
    expect(prompt.systemPrompt).toContain('NEVER combine multiple topics with conjunctions');
  });

  it('sanitizes folder names with connectors (및/와/과/and/or/& 금지 규칙)', async () => {
    const { sanitizeFolderName, sanitizeCategory } = await import('../../src/lib/ai/types');
    // Folder path: retain '/' separator, sanitize single noun per segment
    expect(sanitizeFolderName('쇼핑 및 생활 정보')).toBe('쇼핑');
    expect(sanitizeFolderName('IT와 개발')).toBe('IT');
    expect(sanitizeFolderName('금융, 쇼핑')).toBe('금융');
    expect(sanitizeFolderName('커뮤니티')).toBe('커뮤니티');
    expect(sanitizeFolderName('커뮤니티/정치')).toBe('커뮤니티/정치');
    expect(sanitizeFolderName('쇼핑 및 생활 정보/특가')).toBe('쇼핑/특가');
    expect(sanitizeFolderName('수학과')).toBe('수학과'); // Retain 'gwa' suffix when not used as a conjunction
    // English conjunctions
    expect(sanitizeFolderName('Shopping and Life')).toBe('Shopping');
    expect(sanitizeFolderName('Tech & Dev')).toBe('Tech');
    expect(sanitizeFolderName('Finance or News')).toBe('Finance');
    expect(sanitizeFolderName('Android Apps')).toBe('Android Apps');
    // Category: enforce single noun (keep only first item when joined with path/delimiter)
    expect(sanitizeCategory('개발/디자인')).toBe('개발');
    expect(sanitizeCategory('정치')).toBe('정치');
    expect(sanitizeCategory('Development / Design')).toBe('Development');
  });

  it('sanitizes category/folder name returned by model (뽐뿌 케이스)', async () => {
    await saveAiSettings({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k', autoSummarize: false });

    vi.mocked(generateObject).mockResolvedValue({
      object: {
        summary: '간결한 요약',
        category: '쇼핑 및 생활 정보',
        suggestedFolderId: null,
        suggestedFolderName: '쇼핑 및 생활 정보',
        isNewFolderRecommended: true,
        tags: [],
        confidence: 0.9
      }
    } as any);

    const result = await analyzeContent({ url: 'https://ppomppu.co.kr', title: '뽐뿌', textContent: '본문 내용' });
    expect(result.category).toBe('쇼핑');
    expect(result.suggestedFolderName).toBe('쇼핑');
  });

  it('keeps hierarchical folder path from model (damoang 커뮤니티/정치 케이스)', async () => {
    await saveAiSettings({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k', autoSummarize: false });

    vi.mocked(generateObject).mockResolvedValue({
      object: {
        summary: '간결한 요약',
        category: '정치',
        suggestedFolderId: null,
        suggestedFolderName: '커뮤니티/정치',
        isNewFolderRecommended: true,
        tags: [],
        confidence: 0.9
      }
    } as any);

    const result = await analyzeContent({ url: 'https://damoang.net/free/6955196', title: '자유게시판', textContent: '본문 내용' });
    expect(result.category).toBe('정치');
    expect(result.suggestedFolderName).toBe('커뮤니티/정치');
  });

  describe('AI 설정 분리 (ai_auto_tags / ai_auto_folder)', () => {
    beforeEach(async () => {
      await mockDb.settings.clear();
    });

    it('getAiSettings: 새 키 없음 + ai_auto_categorize=true → autoTags/autoFolder 모두 true (하위호환)', async () => {
      await mockDb.settings.put({ key: 'ai_auto_categorize', value: true });
      const settings = await getAiSettings();
      expect(settings.autoTags).toBe(true);
      expect(settings.autoFolder).toBe(true);
    });

    it('getAiSettings: 새 키 없음 + ai_auto_categorize=false → autoTags/autoFolder 모두 false (하위호환)', async () => {
      await mockDb.settings.put({ key: 'ai_auto_categorize', value: false });
      const settings = await getAiSettings();
      expect(settings.autoTags).toBe(false);
      expect(settings.autoFolder).toBe(false);
    });

    it('getAiSettings: ai_auto_tags=false만 설정 → autoTags=false, autoFolder는 legacy 폴백 값 사용', async () => {
      await mockDb.settings.put({ key: 'ai_auto_categorize', value: true });
      await mockDb.settings.put({ key: 'ai_auto_tags', value: false });
      const settings = await getAiSettings();
      expect(settings.autoTags).toBe(false);
      expect(settings.autoFolder).toBe(true);
    });

    it('getAiSettings: 새 키/legacy 키 모두 없음 → 둘 다 true (기본값)', async () => {
      const settings = await getAiSettings();
      expect(settings.autoTags).toBe(true);
      expect(settings.autoFolder).toBe(true);
    });

    it('saveAiSettings: ai_auto_tags/ai_auto_folder 키로 저장되고 ai_auto_categorize 키는 쓰지 않는다', async () => {
      await saveAiSettings({
        provider: 'none',
        apiKey: '',
        autoSummarize: false,
        autoTags: false,
        autoFolder: true
      });
      expect((await mockDb.settings.get('ai_auto_tags')).value).toBe(false);
      expect((await mockDb.settings.get('ai_auto_folder')).value).toBe(true);
      expect((await mockDb.settings.get('ai_auto_categorize')).value).toBeUndefined();
    });

    it('saveAiSettings: autoTags/autoFolder 미지정 시 새 키를 쓰지 않는다 (getAiSettings 기본값 true 폴백)', async () => {
      await saveAiSettings({ provider: 'none', apiKey: '', autoSummarize: false });
      expect((await mockDb.settings.get('ai_auto_tags')).value).toBeUndefined();
      expect((await mockDb.settings.get('ai_auto_folder')).value).toBeUndefined();
      const settings = await getAiSettings();
      expect(settings.autoTags).toBe(true);
      expect(settings.autoFolder).toBe(true);
    });
  });
  it('isAiConfigured: provider none이면 false', async () => {
    await saveAiSettings({ provider: 'none', model: 'gpt-4o', apiKey: 'x', autoSummarize: false });
    await expect(isAiConfigured()).resolves.toBe(false);
  });

  it('isAiConfigured: model이 없으면 false', async () => {
    await saveAiSettings({ provider: 'openai', model: '', apiKey: 'k', autoSummarize: false });
    await expect(isAiConfigured()).resolves.toBe(false);
  });

  it('isAiConfigured: openai + model + apiKey가 있으면 true', async () => {
    await saveAiSettings({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k', autoSummarize: false });
    await expect(isAiConfigured()).resolves.toBe(true);
  });

  it('isAiConfigured: custom + model이면 apiKey 없이도 true', async () => {
    await saveAiSettings({ provider: 'custom', model: 'llama-3', apiKey: '', customEndpoint: 'http://localhost:8080', autoSummarize: false });
    await expect(isAiConfigured()).resolves.toBe(true);
  });

  describe('모델 필드 통합 및 하위 호환성 (model / customModel)', () => {
    it('getAiSettings: ai_model이 없고 ai_custom_model만 존재할 때 model로 자동 승격된다', async () => {
      await mockDb.settings.put({ key: 'ai_provider', value: 'custom' });
      await mockDb.settings.put({ key: 'ai_custom_model', value: 'legacy-llama-3' });
      
      const settings = await getAiSettings();
      expect(settings.model).toBe('legacy-llama-3');
      expect(settings.customModel).toBe('legacy-llama-3');
    });

    it('saveAiSettings: model 저장 시 ai_model과 ai_custom_model에 모두 동기화 저장된다', async () => {
      await saveAiSettings({
        provider: 'custom',
        model: 'qwen-2.5-7b',
        apiKey: '',
        autoSummarize: false
      });

      expect((await mockDb.settings.get('ai_model')).value).toBe('qwen-2.5-7b');
      expect((await mockDb.settings.get('ai_custom_model')).value).toBe('qwen-2.5-7b');
    });

    it('provider-registry: getLanguageModel은 settings.model, settings.customModel 순으로 해석하고 없으면 에러를 던진다', async () => {
      const { getLanguageModel } = await import('../../src/lib/ai/provider-registry');
      
      // 1. Prioritize settings.model
      const m1 = getLanguageModel({
        provider: 'openai',
        apiKey: 'sk-12345678901234567890',
        model: 'gpt-4o',
        customModel: 'gpt-4o-mini',
        autoSummarize: false
      });
      expect(m1.modelId).toBe('gpt-4o');

      // 2. customModel fallback
      const m2 = getLanguageModel({
        provider: 'openai',
        apiKey: 'sk-12345678901234567890',
        customModel: 'gpt-4o-mini',
        autoSummarize: false
      });
      expect(m2.modelId).toBe('gpt-4o-mini');

      // 3. Throw error when neither exists
      expect(() => getLanguageModel({
        provider: 'openai',
        apiKey: 'sk-12345678901234567890',
        autoSummarize: false
      })).toThrow('No model specified');
    });

    it('concurrency: 기본값은 3이며 유효 범위를 벗어나면 [1, 10]로 자동 clamping된다', async () => {
      // 1. Default to 3 when unset
      const s1 = await getAiSettings();
      expect(s1.concurrency).toBe(3);

      // 2. Save and retrieve a valid value (5)
      await saveAiSettings({
        provider: 'openai',
        apiKey: 'test',
        autoSummarize: false,
        concurrency: 5
      });
      const s2 = await getAiSettings();
      expect(s2.concurrency).toBe(5);

      // 3. Above upper bound (20) -> clamp to 10
      await saveAiSettings({
        provider: 'openai',
        apiKey: 'test',
        autoSummarize: false,
        concurrency: 20
      });
      const s3 = await getAiSettings();
      expect(s3.concurrency).toBe(10);

      // 4. Below lower bound (0 or negative) -> clamp to 1
      await saveAiSettings({
        provider: 'openai',
        apiKey: 'test',
        autoSummarize: false,
        concurrency: 0
      });
      const s4 = await getAiSettings();
      expect(s4.concurrency).toBe(1);
    });
  });

  describe('Helper Functions & Prompt Builders', () => {
    it('getPayloadText extracts and trims text from textContent, content, or text', async () => {
      const { getPayloadText } = await import('../../src/lib/ai/types');
      expect(getPayloadText({ textContent: '  hello from textContent  ' })).toBe('hello from textContent');
      expect(getPayloadText({ content: '  hello from content  ' })).toBe('hello from content');
      expect(getPayloadText({ text: '  hello from text  ' })).toBe('hello from text');
      expect(getPayloadText({ textContent: 'tc', content: 'c', text: 't' })).toBe('tc');
      expect(getPayloadText({ content: 'c', text: 't' })).toBe('c');
      expect(getPayloadText(null)).toBe('');
      expect(getPayloadText(undefined)).toBe('');
      expect(getPayloadText({})).toBe('');
    });

    it('buildAnalysisPrompt preserves full text without truncation', async () => {
      const { buildAnalysisPrompt } = await import('../../src/lib/ai/types');
      const longText = 'A'.repeat(5000);
      const prompt = buildAnalysisPrompt({
        title: 'Long Doc',
        url: 'https://example.com/long',
        textContent: longText
      });
      expect(prompt.userPrompt).toContain(longText);
      expect(prompt.userPrompt).not.toContain('[truncated]');
    });

    it('buildAnalysisPrompt handles ko-KR and 한국어 target language properly', async () => {
      const { buildAnalysisPrompt } = await import('../../src/lib/ai/types');
      const promptKoKR = buildAnalysisPrompt(
        { title: 'Doc', url: 'https://ts.dev', textContent: 'TS' },
        [],
        'full',
        'ko-KR'
      );
      expect(promptKoKR.systemPrompt).toContain('Target Output Language: ko-KR');
      expect(promptKoKR.systemPrompt).toContain('60 Korean characters');
      expect(promptKoKR.systemPrompt).toContain('명사형 종결');

      const promptKoNative = buildAnalysisPrompt(
        { title: 'Doc', url: 'https://ts.dev', textContent: 'TS' },
        [],
        'full',
        '한국어'
      );
      expect(promptKoNative.systemPrompt).toContain('Target Output Language: 한국어');
      expect(promptKoNative.systemPrompt).toContain('60 Korean characters');
      expect(promptKoNative.systemPrompt).toContain('명사형 종결');
    });

    it('formatFolderListPrompt formats folders and truncates with context scoring when > 500 folders', async () => {
      const { formatFolderListPrompt, MAX_PROMPT_FOLDERS } = await import('../../src/lib/ai/types');
      expect(MAX_PROMPT_FOLDERS).toBe(500);

      // Empty folders
      expect(formatFolderListPrompt([])).toBe('None');

      // <= 500 folders
      const smallFolders = [
        { id: '1', title: 'Tech', path: 'Tech' },
        { id: '2', title: 'News', path: 'Media/News' }
      ];
      const smallRes = formatFolderListPrompt(smallFolders);
      expect(smallRes).toBe('- "Tech" (id: "1")\n- "Media/News" (id: "2")');

      // > 500 folders (505 folders)
      const largeFolders = Array.from({ length: 505 }, (_, i) => ({
        id: `id-${i}`,
        title: `Category ${i}`,
        path: `General/Category ${i}`
      }));
      // Put a highly relevant matching folder at the end of array
      largeFolders.push({
        id: 'id-react',
        title: 'React Library',
        path: 'Development/React'
      });

      const pageContext = {
        title: 'React 19 Official Documentation',
        url: 'https://react.dev/docs',
        metaDescription: 'Learn React development'
      };

      const truncatedRes = formatFolderListPrompt(largeFolders, 500, pageContext);
      expect(truncatedRes).toContain('- "Development/React" (id: "id-react")');
      expect(truncatedRes).toContain('- ... (6 additional existing folders omitted)');
      const lines = truncatedRes.split('\n');
      expect(lines.length).toBe(501); // 500 items + 1 omission line
    });
  });

  describe('parseAnalysisResult Robustness', () => {
    it('returns error fallback on unparseable rawText in catch branch', async () => {
      const { parseAnalysisResult, ERROR_CONFIDENCE } = await import('../../src/lib/ai/types');
      expect(ERROR_CONFIDENCE).toBe(0.5);

      const res = parseAnalysisResult('Not a JSON string at all');
      expect(res).toEqual({
        summary: 'Unable to generate summary.',
        category: 'General',
        suggestedFolderId: null,
        suggestedFolderName: '',
        isNewFolderRecommended: false,
        tags: [],
        confidence: 0.5
      });

      // Sentinel text preserved in catch branch
      const sentinelRes = parseAnalysisResult('No body text to summarize.');
      expect(sentinelRes.summary).toBe('No body text to summarize.');
      expect(sentinelRes.confidence).toBe(0.5);

      const koSentinelRes = parseAnalysisResult('요약할 본문 텍스트가 없습니다.');
      expect(koSentinelRes.summary).toBe('요약할 본문 텍스트가 없습니다.');
      expect(koSentinelRes.confidence).toBe(0.5);
    });

    it('sets isNewFolderRecommended to true when suggestedFolderId is missing or null', async () => {
      const { parseAnalysisResult, DEFAULT_CONFIDENCE } = await import('../../src/lib/ai/types');
      expect(DEFAULT_CONFIDENCE).toBe(0.8);

      // suggestedFolderId omitted -> null and isNewFolderRecommended: true
      const parsedMissing = parseAnalysisResult('{"summary": "Summary", "category": "Dev"}');
      expect(parsedMissing.suggestedFolderId).toBeNull();
      expect(parsedMissing.isNewFolderRecommended).toBe(true);
      expect(parsedMissing.suggestedFolderName).toBe('');
      expect(parsedMissing.confidence).toBe(0.8);

      // suggestedFolderId explicit null -> isNewFolderRecommended: true
      const parsedNull = parseAnalysisResult('{"summary": "Summary", "category": "Dev", "suggestedFolderId": null}');
      expect(parsedNull.suggestedFolderId).toBeNull();
      expect(parsedNull.isNewFolderRecommended).toBe(true);

      // suggestedFolderId provided -> isNewFolderRecommended: false
      const parsedWithId = parseAnalysisResult('{"summary": "Summary", "category": "Dev", "suggestedFolderId": "f-1", "suggestedFolderName": "Dev"}');
      expect(parsedWithId.suggestedFolderId).toBe('f-1');
      expect(parsedWithId.isNewFolderRecommended).toBe(false);
      expect(parsedWithId.suggestedFolderName).toBe('Dev');
    });

    it('sanitizes tags by eliminating all spaces from generated tags', async () => {
      const { parseAnalysisResult } = await import('../../src/lib/ai/types');
      const raw = JSON.stringify({
        summary: 'A useful summary',
        category: 'Development',
        tags: ['machine learning', '인공 지능', '  웹 개발  ', 'React Native', 'React']
      });
      const parsed = parseAnalysisResult(raw);
      expect(parsed.tags).toEqual(['machinelearning', '인공지능', '웹개발', 'ReactNative', 'React']);
    });
  });
});
