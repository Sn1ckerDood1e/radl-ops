import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadCrystallizedSource,
  loadAntibodySource,
  loadTemplates,
  deriveToolName,
  parseGeneratedCode,
  generateToolCode,
  formatForgeOutput,
  registerToolForgeTools,
} from './tool-forge.js';
import type { ToolForgeSource, ToolForgeResult } from './tool-forge.js';

// ============================================
// Mocks
// ============================================

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock('../../models/router.js', () => ({
  getRoute: vi.fn(() => ({
    model: 'claude-sonnet-4-5-20250929',
    effort: 'high',
    maxTokens: 4096,
    inputCostPer1M: 3,
    outputCostPer1M: 15,
  })),
  calculateCost: vi.fn(() => 0.018),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/retry.js', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: (...args: unknown[]) => unknown) => handler),
}));

vi.mock('./crystallization.js', () => ({
  loadCrystallized: vi.fn(() => ({
    checks: [
      {
        id: 1,
        lessonIds: [10, 11],
        trigger: 'Missing CSRF headers in fetch calls',
        triggerKeywords: ['fetch', 'csrf', 'header', 'api'],
        check: 'Verify all fetch calls include CSRF headers',
        checkType: 'grep',
        grepPattern: 'fetch\\(.*\\)(?!.*csrf)',
        status: 'active',
        proposedAt: '2026-01-01T00:00:00Z',
        approvedAt: '2026-01-02T00:00:00Z',
        catches: 3,
        falsePositives: 0,
        demotedAt: null,
        demotionReason: null,
      },
      {
        id: 2,
        lessonIds: [12],
        trigger: 'Direct mutation of state',
        triggerKeywords: ['mutation', 'state', 'push', 'splice'],
        check: 'Check for direct array/object mutations',
        checkType: 'manual',
        grepPattern: null,
        status: 'active',
        proposedAt: '2026-01-05T00:00:00Z',
        approvedAt: '2026-01-06T00:00:00Z',
        catches: 1,
        falsePositives: 0,
        demotedAt: null,
        demotionReason: null,
      },
    ],
  })),
}));

vi.mock('./immune-system.js', () => ({
  loadAntibodies: vi.fn(() => ({
    antibodies: [
      {
        id: 1,
        trigger: 'Adding Prisma field without updating API handler',
        triggerKeywords: ['prisma', 'field', 'handler', 'route', 'api', 'schema'],
        check: 'Verify the API route handler destructures and processes the new field',
        checkType: 'manual',
        checkPattern: null,
        origin: { sprint: 'Phase 69', bug: 'setupChecklistDismissed field silently discarded' },
        catches: 2,
        falsePositives: 0,
        falsePositiveRate: 0,
        active: true,
        createdAt: '2026-02-10T00:00:00Z',
      },
    ],
  })),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn((path: string) => {
    if (path.includes('spot-check.ts')) {
      return Promise.resolve('// spot-check tool template code');
    }
    if (path.includes('spot-check.test.ts')) {
      return Promise.resolve('// spot-check test template code');
    }
    return Promise.reject(new Error(`File not found: ${path}`));
  }),
}));

import { getAnthropicClient } from '../../config/anthropic.js';
import { trackUsage } from '../../models/token-tracker.js';
import { readFile } from 'node:fs/promises';

// ============================================
// Tests
// ============================================

describe('loadCrystallizedSource', () => {
  it('returns source for existing crystallized check', () => {
    const source = loadCrystallizedSource(1);
    expect(source).not.toBeNull();
    expect(source!.type).toBe('crystallized');
    expect(source!.id).toBe(1);
    expect(source!.trigger).toBe('Missing CSRF headers in fetch calls');
    expect(source!.triggerKeywords).toEqual(['fetch', 'csrf', 'header', 'api']);
    expect(source!.checkType).toBe('grep');
    expect(source!.pattern).toBe('fetch\\(.*\\)(?!.*csrf)');
  });

  it('returns null for non-existent check id', () => {
    const source = loadCrystallizedSource(999);
    expect(source).toBeNull();
  });
});

describe('loadAntibodySource', () => {
  it('returns source for existing antibody', () => {
    const source = loadAntibodySource(1);
    expect(source).not.toBeNull();
    expect(source!.type).toBe('antibody');
    expect(source!.id).toBe(1);
    expect(source!.trigger).toBe('Adding Prisma field without updating API handler');
    expect(source!.checkType).toBe('manual');
    expect(source!.pattern).toBeNull();
  });

  it('returns null for non-existent antibody id', () => {
    const source = loadAntibodySource(999);
    expect(source).toBeNull();
  });
});

describe('loadTemplates', () => {
  it('reads both template files', async () => {
    const { toolTemplate, testTemplate } = await loadTemplates();
    expect(toolTemplate).toBe('// spot-check tool template code');
    expect(testTemplate).toBe('// spot-check test template code');
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});

describe('deriveToolName', () => {
  const baseSource: ToolForgeSource = {
    type: 'crystallized',
    id: 1,
    trigger: 'Missing CSRF headers in fetch calls',
    triggerKeywords: ['fetch', 'csrf', 'header', 'api'],
    check: 'Verify all fetch calls include CSRF headers',
    checkType: 'grep',
    pattern: null,
  };

  it('uses custom name when provided', () => {
    const name = deriveToolName(baseSource, 'my_custom_tool');
    expect(name).toBe('my_custom_tool');
  });

  it('normalizes custom name to snake_case', () => {
    const name = deriveToolName(baseSource, 'My Custom Tool!!');
    expect(name).toBe('my_custom_tool');
  });

  it('derives name from trigger when no custom name', () => {
    const name = deriveToolName(baseSource);
    expect(name).toBe('check_missing_csrf_headers_fetch');
  });

  it('limits derived name to 4 significant words', () => {
    const source: ToolForgeSource = {
      ...baseSource,
      trigger: 'Very long trigger description with many words that should be truncated',
    };
    const name = deriveToolName(source);
    expect(name).toBe('check_very_long_trigger_description');
  });

  it('filters out short words (length <= 2)', () => {
    const source: ToolForgeSource = {
      ...baseSource,
      trigger: 'A or an if no by do to field check',
    };
    const name = deriveToolName(source);
    expect(name).toBe('check_field_check');
  });
});

describe('parseGeneratedCode', () => {
  it('parses two typescript code blocks', () => {
    const response = [
      'Here is the generated code:',
      '',
      '```typescript',
      '// tool code here',
      'export function register() {}',
      '```',
      '',
      'And the test:',
      '',
      '```typescript',
      '// test code here',
      'describe("test", () => {});',
      '```',
    ].join('\n');

    const { toolCode, testCode } = parseGeneratedCode(response);
    expect(toolCode).toContain('// tool code here');
    expect(toolCode).toContain('export function register() {}');
    expect(testCode).toContain('// test code here');
    expect(testCode).toContain('describe("test", () => {});');
  });

  it('returns fallback when no code blocks found', () => {
    const { toolCode, testCode } = parseGeneratedCode('No code blocks here');
    expect(toolCode).toBe('// No tool code generated');
    expect(testCode).toBe('// No test code generated');
  });

  it('handles single code block gracefully', () => {
    const response = '```typescript\n// only one block\n```';
    const { toolCode, testCode } = parseGeneratedCode(response);
    expect(toolCode).toBe('// only one block');
    expect(testCode).toBe('// No test code generated');
  });
});

describe('generateToolCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls Sonnet API and returns parsed code with cost', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: '```typescript\n// generated tool\n```\n\n```typescript\n// generated test\n```',
      }],
      usage: { input_tokens: 5000, output_tokens: 2000 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    const source: ToolForgeSource = {
      type: 'crystallized',
      id: 1,
      trigger: 'Missing CSRF headers',
      triggerKeywords: ['fetch', 'csrf'],
      check: 'Check fetch calls',
      checkType: 'grep',
      pattern: 'fetch\\(',
    };

    const result = await generateToolCode(
      source,
      'check_csrf',
      '// tool template',
      '// test template',
    );

    expect(result.toolCode).toBe('// generated tool');
    expect(result.testCode).toBe('// generated test');
    expect(result.costUsd).toBe(0.018);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(trackUsage).toHaveBeenCalledWith(
      'claude-sonnet-4-5-20250929',
      5000,
      2000,
      'review',
      'tool-forge',
    );
  });

  it('includes source details in the prompt', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '```typescript\n// tool\n```\n```typescript\n// test\n```' }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    const source: ToolForgeSource = {
      type: 'antibody',
      id: 5,
      trigger: 'Prisma field missing from handler',
      triggerKeywords: ['prisma', 'field', 'handler'],
      check: 'Verify handler processes field',
      checkType: 'manual',
      pattern: null,
    };

    await generateToolCode(source, 'check_prisma_field', '// tpl', '// test tpl');

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;
    expect(userMessage).toContain('antibody #5');
    expect(userMessage).toContain('Prisma field missing from handler');
    expect(userMessage).toContain('prisma, field, handler');
    expect(userMessage).toContain('check_prisma_field');
  });
});

describe('formatForgeOutput', () => {
  it('formats result with all sections', () => {
    const result: ToolForgeResult = {
      source: {
        type: 'crystallized',
        id: 1,
        trigger: 'Missing CSRF headers',
        triggerKeywords: ['fetch', 'csrf'],
        check: 'Check fetch calls',
        checkType: 'grep',
        pattern: 'fetch\\(',
      },
      toolName: 'check_csrf',
      toolCode: '// generated tool code',
      testCode: '// generated test code',
      costUsd: 0.018,
    };

    const output = formatForgeOutput(result);
    expect(output).toContain('## Tool Forge Output');
    expect(output).toContain('crystallized #1');
    expect(output).toContain('Missing CSRF headers');
    expect(output).toContain('`check_csrf`');
    expect(output).toContain('$0.018');
    expect(output).toContain('### Tool Source');
    expect(output).toContain('// generated tool code');
    expect(output).toContain('### Test Source');
    expect(output).toContain('// generated test code');
    expect(output).toContain('### Registration Instructions');
    expect(output).toContain('registerCheckCsrfTools');
    expect(output).toContain('src/mcp/tools/check_csrf.ts');
  });
});

describe('registerToolForgeTools', () => {
  it('registers the tool_forge tool on the server', () => {
    const mockTool = vi.fn();
    const mockServer = { tool: mockTool } as unknown as McpServer;

    registerToolForgeTools(mockServer);

    expect(mockTool).toHaveBeenCalledTimes(1);
    expect(mockTool).toHaveBeenCalledWith(
      'tool_forge',
      expect.any(String),
      expect.objectContaining({
        source_type: expect.anything(),
        source_id: expect.anything(),
      }),
      expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
      }),
      expect.any(Function),
    );
  });

  it('handler returns error for non-existent crystallized source', async () => {
    const mockTool = vi.fn();
    const mockServer = { tool: mockTool } as unknown as McpServer;

    registerToolForgeTools(mockServer);

    // withErrorTracking mock returns the handler directly
    const handler = mockTool.mock.calls[0][4] as (params: Record<string, unknown>) => Promise<unknown>;
    const result = await handler({
      source_type: 'crystallized',
      source_id: 999,
    }) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('crystallized #999 not found');
  });

  it('handler returns error for non-existent antibody source', async () => {
    const mockTool = vi.fn();
    const mockServer = { tool: mockTool } as unknown as McpServer;

    registerToolForgeTools(mockServer);

    const handler = mockTool.mock.calls[0][4] as (params: Record<string, unknown>) => Promise<unknown>;
    const result = await handler({
      source_type: 'antibody',
      source_id: 999,
    }) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('antibody #999 not found');
  });

  it('handler generates code for valid crystallized source', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: '```typescript\n// forged tool\n```\n\n```typescript\n// forged test\n```',
      }],
      usage: { input_tokens: 3000, output_tokens: 1500 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    const mockTool = vi.fn();
    const mockServer = { tool: mockTool } as unknown as McpServer;

    registerToolForgeTools(mockServer);

    const handler = mockTool.mock.calls[0][4] as (params: Record<string, unknown>) => Promise<unknown>;
    const result = await handler({
      source_type: 'crystallized',
      source_id: 1,
    }) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain('## Tool Forge Output');
    expect(result.content[0].text).toContain('// forged tool');
    expect(result.content[0].text).toContain('// forged test');
    expect(result.content[0].text).toContain('Missing CSRF headers in fetch calls');
  });

  it('handler generates code for valid antibody source', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: '```typescript\n// antibody tool\n```\n\n```typescript\n// antibody test\n```',
      }],
      usage: { input_tokens: 4000, output_tokens: 2000 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    const mockTool = vi.fn();
    const mockServer = { tool: mockTool } as unknown as McpServer;

    registerToolForgeTools(mockServer);

    const handler = mockTool.mock.calls[0][4] as (params: Record<string, unknown>) => Promise<unknown>;
    const result = await handler({
      source_type: 'antibody',
      source_id: 1,
    }) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain('## Tool Forge Output');
    expect(result.content[0].text).toContain('// antibody tool');
    expect(result.content[0].text).toContain('Adding Prisma field without updating API handler');
  });

  it('handler uses custom tool_name when provided', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: '```typescript\n// custom named tool\n```\n\n```typescript\n// test\n```',
      }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    const mockTool = vi.fn();
    const mockServer = { tool: mockTool } as unknown as McpServer;

    registerToolForgeTools(mockServer);

    const handler = mockTool.mock.calls[0][4] as (params: Record<string, unknown>) => Promise<unknown>;
    const result = await handler({
      source_type: 'crystallized',
      source_id: 1,
      tool_name: 'my_csrf_checker',
    }) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain('`my_csrf_checker`');
    // Verify the custom name was passed to the API call
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain('my_csrf_checker');
  });

  it('handler calls trackUsage for cost tracking', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '```typescript\n// t\n```\n```typescript\n// t\n```' }],
      usage: { input_tokens: 500, output_tokens: 300 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    vi.mocked(trackUsage).mockClear();

    const mockTool = vi.fn();
    const mockServer = { tool: mockTool } as unknown as McpServer;

    registerToolForgeTools(mockServer);

    const handler = mockTool.mock.calls[0][4] as (params: Record<string, unknown>) => Promise<unknown>;
    await handler({ source_type: 'crystallized', source_id: 1 });

    expect(trackUsage).toHaveBeenCalledWith(
      'claude-sonnet-4-5-20250929',
      500,
      300,
      'review',
      'tool-forge',
    );
  });
});
