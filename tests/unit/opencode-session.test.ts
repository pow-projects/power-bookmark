import { describe, it, expect, beforeEach } from 'vitest';
import { getOpenCodeSessionId, _resetOpenCodeSessionIdForTest } from '../../src/lib/ai/opencode-session';
import { getProvider } from '../../src/lib/ai/provider-registry';

describe('OpenCode session header support', () => {
  beforeEach(() => {
    _resetOpenCodeSessionIdForTest();
  });

  it('generates and caches a stable session ID', () => {
    const id1 = getOpenCodeSessionId();
    const id2 = getOpenCodeSessionId();
    expect(id1).toBeTruthy();
    expect(id1).toBe(id2);
  });

  it('injects x-opencode-session header when creating model for custom provider', () => {
    const customProvider = getProvider('custom');
    expect(customProvider).toBeDefined();

    const model = customProvider!.createModel('my-token', 'gpt-4o', {
      customEndpoint: 'https://api.opencode.ai/v1'
    }) as any;

    expect(model).toBeDefined();
    const headers = typeof model.config?.headers === 'function' ? model.config.headers() : model.config?.headers;
    expect(headers['x-opencode-session']).toBe(getOpenCodeSessionId());
  });

  it('allows custom sessionId override in options', () => {
    const customProvider = getProvider('custom');
    expect(customProvider).toBeDefined();

    const model = customProvider!.createModel('my-token', 'gpt-4o', {
      customEndpoint: 'https://api.opencode.ai/v1',
      sessionId: 'custom-session-uuid-999'
    }) as any;

    expect(model).toBeDefined();
    const headers = typeof model.config?.headers === 'function' ? model.config.headers() : model.config?.headers;
    expect(headers['x-opencode-session']).toBe('custom-session-uuid-999');
  });

  it('provides dedicated opencode provider with defaultEndpoint and session header', () => {
    const opencodeProvider = getProvider('opencode');
    expect(opencodeProvider).toBeDefined();
    expect(opencodeProvider!.id).toBe('opencode');
    expect(opencodeProvider!.name).toBe('OpenCode Go');
    expect(opencodeProvider!.category).toBe('openai-compatible');
    expect(opencodeProvider!.defaultEndpoint).toBe('https://opencode.ai/zen/go/v1');

    const model = opencodeProvider!.createModel('my-token', 'claude-3-7-sonnet') as any;
    expect(model).toBeDefined();
    expect(model.config?.baseURL).toBe('https://opencode.ai/zen/go/v1');
    const headers = typeof model.config?.headers === 'function' ? model.config.headers() : model.config?.headers;
    expect(headers['x-opencode-session']).toBe(getOpenCodeSessionId());
  });
});
