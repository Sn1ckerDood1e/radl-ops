import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../guardrails/iron-laws.js', () => ({
  getIronLaws: vi.fn(() => [
    { id: 'no-push-main', description: 'Never push to main' },
    { id: 'no-delete-prod', description: 'Never delete production data' },
  ]),
}));

interface ResourceHandler {
  (uri: URL): Promise<{
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }>;
}

async function getHandlers() {
  const handlers: Record<string, ResourceHandler> = {};
  const mockServer = {
    resource: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as ResourceHandler;
    },
  };

  const mockRegistry = {
    getStatus: vi.fn(() => [
      { group: 'core', enabled: true, tools: ['health_check', 'sprint_status'] },
      { group: 'content', enabled: false, tools: ['daily_briefing'] },
    ]),
  };

  const { registerResources } = await import('./resources.js');
  registerResources(mockServer as any, mockRegistry as any);
  return handlers;
}

describe('MCP Resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sprint://current', () => {
    it('returns sprint status and git branch', async () => {
      vi.mocked(execFileSync).mockReturnValue('Phase 70: In Progress\n');
      vi.mocked(execSync).mockReturnValue('feat/radl-ops-v2\n');

      const handlers = await getHandlers();
      const result = await handlers['sprint://current'](new URL('sprint://current'));

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe('application/json');

      const data = JSON.parse(result.contents[0].text);
      expect(data.branch).toBe('feat/radl-ops-v2');
      expect(data.sprintOutput).toBe('Phase 70: In Progress');
    });

    it('handles sprint.sh failure gracefully', async () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('sprint.sh not found');
      });
      vi.mocked(execSync).mockReturnValue('main\n');

      const handlers = await getHandlers();
      const result = await handlers['sprint://current'](new URL('sprint://current'));

      const data = JSON.parse(result.contents[0].text);
      expect(data.error).toContain('Failed to get sprint status');
      expect(data.branch).toBe('main');
    });

    it('handles git branch failure gracefully', async () => {
      vi.mocked(execFileSync).mockReturnValue('Phase 70: In Progress\n');
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('not a git repo');
      });

      const handlers = await getHandlers();
      const result = await handlers['sprint://current'](new URL('sprint://current'));

      const data = JSON.parse(result.contents[0].text);
      expect(data.error).toContain('Failed to get git branch');
      expect(data.sprintOutput).toBe('Phase 70: In Progress');
    });
  });

  describe('config://iron-laws', () => {
    it('returns iron laws as JSON', async () => {
      const handlers = await getHandlers();
      const result = await handlers['config://iron-laws'](new URL('config://iron-laws'));

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe('application/json');

      const data = JSON.parse(result.contents[0].text);
      expect(data).toHaveLength(2);
      expect(data[0].id).toBe('no-push-main');
    });
  });

  describe('config://tool-groups', () => {
    it('returns tool group status from registry', async () => {
      const handlers = await getHandlers();
      const result = await handlers['config://tool-groups'](new URL('config://tool-groups'));

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe('application/json');

      const data = JSON.parse(result.contents[0].text);
      expect(data).toHaveLength(2);
      expect(data[0].group).toBe('core');
      expect(data[0].enabled).toBe(true);
      expect(data[1].group).toBe('content');
      expect(data[1].enabled).toBe(false);
    });
  });
});
