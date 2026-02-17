import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock('../../models/router.js', () => ({
  getRoute: vi.fn(() => ({ model: 'claude-haiku-4-5-20251001', maxTokens: 1024 })),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

vi.mock('../../utils/retry.js', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { getAnthropicClient } from '../../config/anthropic.js';
import { trackUsage } from '../../models/token-tracker.js';
import { withRetry } from '../../utils/retry.js';

type ToolHandler = (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>;

async function getHandlers() {
  const handlers: Record<string, ToolHandler> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as ToolHandler;
    },
  };

  const { registerSocialTools } = await import('./social.js');
  registerSocialTools(mockServer as any);
  return handlers;
}

function mockApiResponse(text: string) {
  const mockCreate = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 200 },
  });
  vi.mocked(getAnthropicClient).mockReturnValue({
    messages: { create: mockCreate },
  } as any);
  return mockCreate;
}

describe('social tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('social_ideas', () => {
    it('generates ideas and tracks usage', async () => {
      const handlers = await getHandlers();
      mockApiResponse('Here are 5 content ideas for Radl...');

      const result = await handlers.social_ideas({ count: 5 });
      expect(result.content[0].text).toContain('5 content ideas');
      expect(trackUsage).toHaveBeenCalledWith(
        'claude-haiku-4-5-20251001', 100, 200, 'social_generation', 'social_tool',
      );
    });

    it('includes focus in prompt when provided', async () => {
      const handlers = await getHandlers();
      const mockCreate = mockApiResponse('Ideas...');

      await handlers.social_ideas({ count: 3, focus: 'launch announcement' });
      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain('launch announcement');
    });

    it('uses withRetry for API calls', async () => {
      const handlers = await getHandlers();
      mockApiResponse('Ideas...');

      await handlers.social_ideas({ count: 3 });
      expect(withRetry).toHaveBeenCalled();
    });
  });

  describe('social_draft', () => {
    it('creates twitter-specific draft', async () => {
      const handlers = await getHandlers();
      const mockCreate = mockApiResponse('Check out @radl_app...');

      await handlers.social_draft({
        platform: 'twitter',
        topic: 'Feature launch',
        tone: 'exciting',
      });

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain('280 characters');
      expect(prompt).toContain('exciting');
    });

    it('creates linkedin-specific draft', async () => {
      const handlers = await getHandlers();
      const mockCreate = mockApiResponse('At Radl, we believe...');

      await handlers.social_draft({
        platform: 'linkedin',
        topic: 'Team update',
        tone: 'professional',
      });

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain('150-300 words');
    });
  });

  describe('social_calendar', () => {
    it('generates weekly calendar', async () => {
      const handlers = await getHandlers();
      mockApiResponse('Monday: Product update...');

      const result = await handlers.social_calendar({});
      expect(result.content[0].text).toContain('Monday');
    });

    it('includes themes when provided', async () => {
      const handlers = await getHandlers();
      const mockCreate = mockApiResponse('Calendar...');

      await handlers.social_calendar({ themes: ['rowing tips', 'team culture'] });
      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain('rowing tips');
      expect(prompt).toContain('team culture');
    });
  });
});
