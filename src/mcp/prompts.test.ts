import { describe, it, expect } from 'vitest';

interface PromptHandler {
  (args: Record<string, string>): {
    messages: Array<{
      role: string;
      content: { type: string; text: string };
    }>;
  };
}

async function getHandlers() {
  const handlers: Record<string, PromptHandler> = {};
  const mockServer = {
    prompt: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as PromptHandler;
    },
  };

  const { registerPrompts } = await import('./prompts.js');
  registerPrompts(mockServer as any);
  return handlers;
}

describe('MCP Prompts', () => {
  describe('sprint-start', () => {
    it('returns sprint start template with phase and title', async () => {
      const handlers = await getHandlers();
      const result = handlers['sprint-start']({
        phase: 'Phase 70',
        title: 'MCP v2 Upgrade',
        estimate: '2 hours',
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.type).toBe('text');
      expect(result.messages[0].content.text).toContain('Phase 70');
      expect(result.messages[0].content.text).toContain('MCP v2 Upgrade');
      expect(result.messages[0].content.text).toContain('2 hours');
      expect(result.messages[0].content.text).toContain('feat/phase-70');
    });

    it('defaults estimate to "not specified" when omitted', async () => {
      const handlers = await getHandlers();
      const result = handlers['sprint-start']({
        phase: 'Phase 71',
        title: 'Quick Fix',
      });

      expect(result.messages[0].content.text).toContain('not specified');
    });
  });

  describe('sprint-review', () => {
    it('returns review checklist with phase info', async () => {
      const handlers = await getHandlers();
      const result = handlers['sprint-review']({
        phase: 'Phase 70',
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content.text).toContain('Phase 70');
      expect(result.messages[0].content.text).toContain('typecheck');
      expect(result.messages[0].content.text).toContain('security-reviewer');
      expect(result.messages[0].content.text).toContain('compound_extract');
    });

    it('uses custom branch name when provided', async () => {
      const handlers = await getHandlers();
      const result = handlers['sprint-review']({
        phase: 'Phase 70',
        branch: 'feat/custom-branch',
      });

      expect(result.messages[0].content.text).toContain('feat/custom-branch');
    });
  });

  describe('code-review', () => {
    it('returns review prompt with files and focus', async () => {
      const handlers = await getHandlers();
      const result = handlers['code-review']({
        files: 'src/mcp/server.ts, src/mcp/tools/sprint.ts',
        focus: 'security',
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content.text).toContain('src/mcp/server.ts');
      expect(result.messages[0].content.text).toContain('security');
      expect(result.messages[0].content.text).toContain('CRITICAL');
    });

    it('defaults focus to all', async () => {
      const handlers = await getHandlers();
      const result = handlers['code-review']({
        files: 'src/mcp/server.ts',
        focus: 'all',
      });

      expect(result.messages[0].content.text).toContain('all');
    });
  });
});
