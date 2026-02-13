import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: () => ({
    radlDir: '/home/hb/radl',
    knowledgeDir: '/home/hb/radl-ops/knowledge',
  }),
}));

const mockGetRoute = vi.fn();
const mockCalculateCost = vi.fn();
const mockTrackUsage = vi.fn();
const mockGetAnthropicClient = vi.fn();

vi.mock('../../models/router.js', () => ({
  getRoute: (...args: unknown[]) => mockGetRoute(...args),
  calculateCost: (...args: unknown[]) => mockCalculateCost(...args),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: () => mockGetAnthropicClient(),
}));

// Extract handler by registering with a mock server
async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const { registerDriftDetectionTools } = await import('./drift-detection.js');
  registerDriftDetectionTools(mockServer as any);
  return handlers['verify_patterns'];
}

describe('Drift Detection Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      patterns: [
        { name: 'CSRF headers', description: 'All fetch calls must include CSRF headers' },
        { name: 'Toast notifications', description: 'User actions should show toast feedback' },
      ],
    }));

    vi.mocked(execSync)
      .mockReturnValueOnce('diff --git a/src/api.ts b/src/api.ts\n+fetch("/api/test")') // git diff
      .mockReturnValueOnce('src/api.ts\nsrc/utils.ts'); // git diff --name-only

    mockGetRoute.mockReturnValue({
      model: 'claude-3-5-haiku-20241022',
      maxTokens: 4000,
    });

    mockCalculateCost.mockReturnValue(0.002);

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'tool_use',
              name: 'drift_report',
              input: {
                findings: [],
                patternsChecked: 2,
                filesAnalyzed: 2,
                status: 'clean',
              },
            },
          ],
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
          },
        }),
      },
    };

    mockGetAnthropicClient.mockReturnValue(mockClient);
  });

  describe('pattern loading', () => {
    it('loads patterns from patterns.json', async () => {
      const handler = await getHandler();
      await handler({ base_branch: 'main' });

      expect(vi.mocked(readFileSync)).toHaveBeenCalledWith(
        '/home/hb/radl-ops/knowledge/patterns.json',
        'utf-8'
      );
    });

    it('returns early when no patterns exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const handler = await getHandler();
      const result = await handler({ base_branch: 'main' });
      const text = result.content[0].text;

      expect(text).toContain('No patterns found in knowledge base');
      expect(vi.mocked(execSync)).not.toHaveBeenCalled();
    });

    it('handles corrupted patterns.json gracefully', async () => {
      vi.mocked(readFileSync).mockReturnValue('not valid json {{{');

      const handler = await getHandler();
      const result = await handler({ base_branch: 'main' });
      const text = result.content[0].text;

      expect(text).toContain('No patterns found in knowledge base');
    });
  });

  describe('git diff execution', () => {
    it('calls git diff with correct arguments', async () => {
      const handler = await getHandler();
      await handler({ base_branch: 'develop' });

      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        "git diff develop...HEAD -- '*.ts' '*.tsx'",
        expect.objectContaining({
          encoding: 'utf-8',
          cwd: '/home/hb/radl',
          timeout: 30000,
        })
      );
    });

    it('returns early when no diff found', async () => {
      // Override the beforeEach mocks for this test
      vi.mocked(execSync)
        .mockReset()
        .mockReturnValue(''); // both calls return empty

      const handler = await getHandler();
      const result = await handler({ base_branch: 'main' });
      const text = result.content[0].text;

      expect(text).toContain('No changes found between main and HEAD');
      expect(mockGetAnthropicClient).not.toHaveBeenCalled();
    });

    it('truncates large diffs to 50KB', async () => {
      const largeDiff = 'a'.repeat(60000);
      vi.mocked(execSync)
        .mockReturnValueOnce(largeDiff)
        .mockReturnValueOnce('file.ts');

      const handler = await getHandler();
      await handler({ base_branch: 'main' });

      const client = mockGetAnthropicClient();
      const createCall = client.messages.create.mock.calls[0][0];
      const userMessage = createCall.messages[0].content;

      expect(userMessage.length).toBeLessThan(60000);
    });

    it('validates branch names to prevent injection', async () => {
      const handler = await getHandler();

      // Should throw for invalid branch names
      await expect(handler({ base_branch: 'main; rm -rf /' }))
        .rejects.toThrow('Invalid branch name');

      await expect(handler({ base_branch: '../../../etc/passwd' }))
        .rejects.toThrow('Invalid branch name');
    });

    it('allows valid branch names', async () => {
      const handler = await getHandler();

      // These should not throw
      await handler({ base_branch: 'feat/new-feature' });
      await handler({ base_branch: 'release-v1.2.3' });
      await handler({ base_branch: 'hotfix/bug_fix' });

      expect(vi.mocked(execSync)).toHaveBeenCalled();
    });
  });

  describe('Anthropic API call', () => {
    it('uses Haiku for drift detection', async () => {
      const handler = await getHandler();
      await handler({ base_branch: 'main' });

      expect(mockGetRoute).toHaveBeenCalledWith('spot_check');
    });

    it('passes patterns and diff to Anthropic', async () => {
      const handler = await getHandler();
      await handler({ base_branch: 'main' });

      const client = mockGetAnthropicClient();
      const createCall = client.messages.create.mock.calls[0][0];

      expect(createCall.messages[0].content).toContain('CSRF headers');
      expect(createCall.messages[0].content).toContain('Toast notifications');
      expect(createCall.messages[0].content).toContain('fetch("/api/test")');
    });

    it('includes focus hint when focus parameter provided', async () => {
      const handler = await getHandler();
      await handler({ base_branch: 'main', focus: 'security' });

      const client = mockGetAnthropicClient();
      const createCall = client.messages.create.mock.calls[0][0];

      expect(createCall.messages[0].content).toContain('Focus your analysis on security-related patterns');
    });

    it('uses forced tool_choice for drift_report', async () => {
      const handler = await getHandler();
      await handler({ base_branch: 'main' });

      const client = mockGetAnthropicClient();
      const createCall = client.messages.create.mock.calls[0][0];

      expect(createCall.tool_choice).toEqual({
        type: 'tool',
        name: 'drift_report',
      });
    });
  });

  describe('drift report formatting', () => {
    it('formats clean report when no violations found', async () => {
      const handler = await getHandler();
      const result = await handler({ base_branch: 'main' });
      const text = result.content[0].text;

      expect(text).toContain('# Drift Detection Report');
      expect(text).toContain('**Status:** CLEAN — no pattern drift detected');
      expect(text).toContain('No pattern violations found');
    });

    it('formats report with findings grouped by severity', async () => {
      const client = mockGetAnthropicClient();
      client.messages.create.mockResolvedValue({
        content: [
          {
            type: 'tool_use',
            name: 'drift_report',
            input: {
              findings: [
                {
                  severity: 'CRITICAL',
                  pattern: 'CSRF headers',
                  file: 'src/api.ts',
                  line: 42,
                  description: 'Missing CSRF header in fetch call',
                  suggestion: 'Add X-CSRF-Token header',
                },
                {
                  severity: 'MEDIUM',
                  pattern: 'Toast notifications',
                  file: 'src/form.tsx',
                  line: 15,
                  description: 'No toast after form submit',
                  suggestion: 'Add toast.success() call',
                },
              ],
              patternsChecked: 2,
              filesAnalyzed: 2,
              status: 'drift_detected',
            },
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 500 },
      });

      const handler = await getHandler();
      const result = await handler({ base_branch: 'main' });
      const text = result.content[0].text;

      expect(text).toContain('**Status:** DRIFT DETECTED');
      expect(text).toContain('## CRITICAL (1)');
      expect(text).toContain('## MEDIUM (1)');
      expect(text).toContain('**[CSRF headers]** src/api.ts:42');
      expect(text).toContain('Missing CSRF header in fetch call');
      expect(text).toContain('*Fix:* Add X-CSRF-Token header');
    });

    it('includes cost in footer', async () => {
      const handler = await getHandler();
      const result = await handler({ base_branch: 'main' });
      const text = result.content[0].text;

      expect(text).toContain('_Cost: $0.002 (Haiku)');
      expect(text).toContain('2 patterns checked against 2 files_');
    });

    it('handles null line numbers', async () => {
      const client = mockGetAnthropicClient();
      client.messages.create.mockResolvedValue({
        content: [
          {
            type: 'tool_use',
            name: 'drift_report',
            input: {
              findings: [
                {
                  severity: 'HIGH',
                  pattern: 'Team scope',
                  file: 'src/query.ts',
                  line: null,
                  description: 'Missing team filter',
                  suggestion: 'Add where: { teamId }',
                },
              ],
              patternsChecked: 2,
              filesAnalyzed: 1,
              status: 'drift_detected',
            },
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 500 },
      });

      const handler = await getHandler();
      const result = await handler({ base_branch: 'main' });
      const text = result.content[0].text;

      expect(text).toContain('**[Team scope]** src/query.ts');
      expect(text).not.toContain(':null');
    });
  });

  describe('cost tracking', () => {
    it('tracks usage with verify-patterns tag', async () => {
      const handler = await getHandler();
      await handler({ base_branch: 'main' });

      expect(mockTrackUsage).toHaveBeenCalledWith(
        'claude-3-5-haiku-20241022',
        1000,
        500,
        'review',
        'verify-patterns'
      );
    });

    it('calculates cost from usage', async () => {
      const handler = await getHandler();
      await handler({ base_branch: 'main' });

      expect(mockCalculateCost).toHaveBeenCalledWith(
        'claude-3-5-haiku-20241022',
        1000,
        500
      );
    });
  });

  describe('error handling', () => {
    it('handles git command failures gracefully', async () => {
      vi.mocked(execSync)
        .mockReset()
        .mockImplementation(() => {
          throw new Error('git not found');
        });

      const handler = await getHandler();
      const result = await handler({ base_branch: 'main' });
      const text = result.content[0].text;

      expect(text).toContain('No changes found');
    });

    it('handles Anthropic API failures', async () => {
      const client = mockGetAnthropicClient();
      client.messages.create.mockRejectedValue(new Error('API timeout'));

      const handler = await getHandler();

      await expect(handler({ base_branch: 'main' })).rejects.toThrow('API timeout');
    });

    it('uses fallback when tool_use block missing', async () => {
      const client = mockGetAnthropicClient();
      client.messages.create.mockResolvedValue({
        content: [{ type: 'text', text: 'No violations found' }],
        usage: { input_tokens: 1000, output_tokens: 500 },
      });

      const handler = await getHandler();
      const result = await handler({ base_branch: 'main' });
      const text = result.content[0].text;

      expect(text).toContain('**Status:** CLEAN');
    });
  });
});
