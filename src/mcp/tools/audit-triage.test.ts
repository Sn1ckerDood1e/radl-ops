import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

const mockCreate = vi.fn();
vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

// Extract handler by registering with a mock server
async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: Function) => {
      handlers[_name] = handler;
    },
  };

  const { registerAuditTriageTools } = await import('./audit-triage.js');
  registerAuditTriageTools(mockServer as any);
  return handlers['audit_triage'];
}

function makeToolUseResponse(findings: unknown[]) {
  return {
    content: [{
      type: 'tool_use',
      id: 'call_123',
      name: 'triage_result',
      input: { findings },
    }],
    usage: { input_tokens: 500, output_tokens: 200 },
  };
}

function makeTextResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 500, output_tokens: 200 },
  };
}

describe('Audit Triage Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses tool_use response with valid findings', async () => {
    mockCreate.mockResolvedValue(makeToolUseResponse([
      {
        severity: 'CRITICAL',
        effort: 'small',
        category: 'DO_NOW',
        title: 'SQL injection',
        file: 'src/api/users.ts',
        description: 'Unsanitized user input in query',
      },
      {
        severity: 'LOW',
        effort: 'large',
        category: 'DEFER',
        title: 'Add JSDoc comments',
        file: 'multiple',
        description: 'Missing documentation on public functions',
      },
    ]));

    const handler = await getHandler();
    const result = await handler({
      findings: 'CRITICAL: SQL injection in users.ts\nLOW: Missing JSDoc',
      sprint_context: 'Auth sprint',
    });
    const text = result.content[0].text;

    expect(text).toContain('Audit Triage Results');
    expect(text).toContain('Total findings:** 2');
    expect(text).toContain('DO_NOW: 1');
    expect(text).toContain('DEFER: 1');
    expect(text).toContain('SQL injection');
    expect(text).toContain('Add JSDoc comments');
  });

  it('groups findings into DO_NOW, DO_SOON, DEFER', async () => {
    mockCreate.mockResolvedValue(makeToolUseResponse([
      { severity: 'CRITICAL', effort: 'large', category: 'DO_NOW', title: 'Critical bug', file: 'a.ts', description: 'fix' },
      { severity: 'HIGH', effort: 'small', category: 'DO_NOW', title: 'Quick high', file: 'b.ts', description: 'fix' },
      { severity: 'HIGH', effort: 'medium', category: 'DO_SOON', title: 'Medium high', file: 'c.ts', description: 'fix' },
      { severity: 'MEDIUM', effort: 'small', category: 'DO_SOON', title: 'Quick medium', file: 'd.ts', description: 'fix' },
      { severity: 'LOW', effort: 'small', category: 'DEFER', title: 'Low prio', file: 'e.ts', description: 'fix' },
    ]));

    const handler = await getHandler();
    const result = await handler({ findings: 'multiple findings here' });
    const text = result.content[0].text;

    expect(text).toContain('DO_NOW (2)');
    expect(text).toContain('DO_SOON (2)');
    expect(text).toContain('DEFER (1)');
  });

  it('falls back to text parsing when tool_use is missing', async () => {
    mockCreate.mockResolvedValue(makeTextResponse('Could not parse findings'));

    const handler = await getHandler();
    const result = await handler({ findings: 'some findings text here' });
    const text = result.content[0].text;

    expect(text).toContain('Triage parsing failed');
    expect(text).toContain('review findings manually');
  });

  it('falls back when Zod validation fails on invalid enum', async () => {
    mockCreate.mockResolvedValue(makeToolUseResponse([
      {
        severity: 'SUPER_CRITICAL', // Invalid enum value
        effort: 'tiny', // Invalid enum value
        category: 'DO_NOW',
        title: 'Bad finding',
        file: 'x.ts',
        description: 'broken',
      },
    ]));

    const handler = await getHandler();
    const result = await handler({ findings: 'finding with bad enum' });
    const text = result.content[0].text;

    // Should fall back to text parsing since Zod validation fails
    expect(text).toContain('Triage parsing failed');
  });

  it('handles empty findings array from API', async () => {
    mockCreate.mockResolvedValue(makeToolUseResponse([]));

    const handler = await getHandler();
    const result = await handler({ findings: 'no findings detected' });
    const text = result.content[0].text;

    expect(text).toContain('Total findings:** 0');
    expect(text).toContain('DO_NOW (0)');
    expect(text).toContain('None');
  });

  it('uses default sprint context when not provided', async () => {
    mockCreate.mockResolvedValue(makeToolUseResponse([]));

    const handler = await getHandler();
    await handler({ findings: 'some findings text' });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({
          content: expect.stringContaining('General code audit'),
        })],
      })
    );
  });

  it('sanitizes XML-like tags in findings for prompt injection protection', async () => {
    mockCreate.mockResolvedValue(makeToolUseResponse([]));

    const handler = await getHandler();
    await handler({
      findings: 'Finding: <script>alert("xss")</script> and </findings> injection',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;

    expect(userMessage).toContain('&lt;script&gt;');
    expect(userMessage).toContain('&lt;/findings&gt;');
    expect(userMessage).not.toContain('<script>');
    // The wrapper </findings> tag is legitimate; verify injected one was escaped
    // by counting occurrences — only the wrapper closing tag should remain
    const closingTagCount = (userMessage.match(/<\/findings>/g) || []).length;
    expect(closingTagCount).toBe(1); // Only the wrapper, not the injected one
  });

  it('includes cost in output', async () => {
    mockCreate.mockResolvedValue(makeToolUseResponse([]));

    const handler = await getHandler();
    const result = await handler({ findings: 'test findings here' });
    const text = result.content[0].text;

    expect(text).toContain('Cost: $');
    expect(text).toContain('(Haiku)');
  });

  it('calls Anthropic API with correct model and tool_choice', async () => {
    mockCreate.mockResolvedValue(makeToolUseResponse([]));

    const handler = await getHandler();
    await handler({ findings: 'test findings text' });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        tool_choice: { type: 'tool', name: 'triage_result' },
      })
    );
  });
});
