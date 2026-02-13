import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry, TOOL_GROUPS } from './tool-registry.js';

interface MockRegisteredTool {
  enabled: boolean;
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
}

interface MockMcpServer {
  tool: ReturnType<typeof vi.fn>;
}

function createMockServer(): MockMcpServer {
  return {
    tool: vi.fn(),
  };
}

function createMockRegisteredTool(initialEnabled = true): MockRegisteredTool {
  const tool: MockRegisteredTool = {
    enabled: initialEnabled,
    enable: vi.fn(() => {
      tool.enabled = true;
    }),
    disable: vi.fn(() => {
      tool.enabled = false;
    }),
  };
  return tool;
}

describe('ToolRegistry', () => {
  describe('TOOL_GROUPS configuration', () => {
    it('has exactly 3 groups', () => {
      expect(TOOL_GROUPS).toHaveLength(3);
    });

    it('has core group enabled by default', () => {
      const core = TOOL_GROUPS.find(g => g.name === 'core');
      expect(core).toBeDefined();
      expect(core?.defaultEnabled).toBe(true);
    });

    it('has content group disabled by default', () => {
      const content = TOOL_GROUPS.find(g => g.name === 'content');
      expect(content).toBeDefined();
      expect(content?.defaultEnabled).toBe(false);
    });

    it('has advanced group disabled by default', () => {
      const advanced = TOOL_GROUPS.find(g => g.name === 'advanced');
      expect(advanced).toBeDefined();
      expect(advanced?.defaultEnabled).toBe(false);
    });

    it('all groups have required fields', () => {
      for (const group of TOOL_GROUPS) {
        expect(group.name).toBeTruthy();
        expect(group.description).toBeTruthy();
        expect(Array.isArray(group.toolNames)).toBe(true);
        expect(group.toolNames.length).toBeGreaterThan(0);
        expect(typeof group.defaultEnabled).toBe('boolean');
      }
    });

    it('core group includes expected tools', () => {
      const core = TOOL_GROUPS.find(g => g.name === 'core');
      expect(core?.toolNames).toContain('health_check');
      expect(core?.toolNames).toContain('sprint_start');
      expect(core?.toolNames).toContain('iron_laws');
      expect(core?.toolNames).toContain('cost_report');
    });

    it('content group includes expected tools', () => {
      const content = TOOL_GROUPS.find(g => g.name === 'content');
      expect(content?.toolNames).toContain('daily_briefing');
      expect(content?.toolNames).toContain('social_ideas');
    });

    it('advanced group includes expected tools', () => {
      const advanced = TOOL_GROUPS.find(g => g.name === 'advanced');
      expect(advanced?.toolNames).toContain('eval_opt_generate');
      expect(advanced?.toolNames).toContain('compound_extract');
    });
  });

  describe('install', () => {
    let registry: ToolRegistry;
    let mockServer: any;
    let originalTool: any;

    beforeEach(() => {
      registry = new ToolRegistry();
      originalTool = vi.fn().mockReturnValue({ enabled: true, enable: vi.fn(), disable: vi.fn() });
      mockServer = { tool: originalTool };
    });

    it('monkey-patches server.tool() to capture registrations', () => {
      registry.install(mockServer);

      expect(mockServer.tool).not.toBe(originalTool);
    });

    it('captures tool registrations via patched tool() method', () => {
      const mockToolResult = createMockRegisteredTool();
      originalTool.mockReturnValue(mockToolResult);

      registry.install(mockServer);

      // Simulate registering a tool
      const result = mockServer.tool('test_tool', 'description', {}, vi.fn());

      expect(registry.has('test_tool')).toBe(true);
      expect(result).toBe(mockToolResult);
    });

    it('handles tool() calls with varying argument counts', () => {
      const mockTool1 = createMockRegisteredTool();
      const mockTool2 = createMockRegisteredTool();

      originalTool
        .mockReturnValueOnce(mockTool1)
        .mockReturnValueOnce(mockTool2);

      registry.install(mockServer);

      // 2 args (name, handler)
      mockServer.tool('tool1', vi.fn());

      // 5 args (name, description, schema, annotations, handler)
      mockServer.tool('tool2', 'description', {}, {}, vi.fn());

      expect(registry.has('tool1')).toBe(true);
      expect(registry.has('tool2')).toBe(true);
    });

    it('ignores non-string tool names', () => {
      originalTool.mockReturnValue(createMockRegisteredTool());
      registry.install(mockServer);

      // Call with non-string first arg
      mockServer.tool(123, vi.fn());

      expect(registry.has('123')).toBe(false);
    });
  });

  describe('applyDefaults', () => {
    let registry: ToolRegistry;
    let mockServer: any;
    let originalTool: any;

    beforeEach(() => {
      registry = new ToolRegistry();
      originalTool = vi.fn();
      mockServer = { tool: originalTool };
      registry.install(mockServer);
    });

    it('disables content group tools by default', () => {
      const tools = {
        daily_briefing: createMockRegisteredTool(true),
        weekly_briefing: createMockRegisteredTool(true),
      };

      originalTool
        .mockReturnValueOnce(tools.daily_briefing)
        .mockReturnValueOnce(tools.weekly_briefing);

      mockServer.tool('daily_briefing', vi.fn());
      mockServer.tool('weekly_briefing', vi.fn());

      registry.applyDefaults();

      expect(tools.daily_briefing.disable).toHaveBeenCalled();
      expect(tools.weekly_briefing.disable).toHaveBeenCalled();
    });

    it('disables advanced group tools by default', () => {
      const tools = {
        eval_opt_generate: createMockRegisteredTool(true),
        compound_extract: createMockRegisteredTool(true),
      };

      originalTool
        .mockReturnValueOnce(tools.eval_opt_generate)
        .mockReturnValueOnce(tools.compound_extract);

      mockServer.tool('eval_opt_generate', vi.fn());
      mockServer.tool('compound_extract', vi.fn());

      registry.applyDefaults();

      expect(tools.eval_opt_generate.disable).toHaveBeenCalled();
      expect(tools.compound_extract.disable).toHaveBeenCalled();
    });

    it('does not disable core group tools', () => {
      const tools = {
        health_check: createMockRegisteredTool(true),
        sprint_start: createMockRegisteredTool(true),
      };

      originalTool
        .mockReturnValueOnce(tools.health_check)
        .mockReturnValueOnce(tools.sprint_start);

      mockServer.tool('health_check', vi.fn());
      mockServer.tool('sprint_start', vi.fn());

      registry.applyDefaults();

      expect(tools.health_check.disable).not.toHaveBeenCalled();
      expect(tools.sprint_start.disable).not.toHaveBeenCalled();
    });
  });

  describe('enableGroup', () => {
    let registry: ToolRegistry;
    let mockServer: any;
    let originalTool: any;

    beforeEach(() => {
      registry = new ToolRegistry();
      originalTool = vi.fn();
      mockServer = { tool: originalTool };
      registry.install(mockServer);
    });

    it('enables all tools in a disabled group', () => {
      const tools = {
        daily_briefing: createMockRegisteredTool(false),
        weekly_briefing: createMockRegisteredTool(false),
      };

      originalTool
        .mockReturnValueOnce(tools.daily_briefing)
        .mockReturnValueOnce(tools.weekly_briefing);

      mockServer.tool('daily_briefing', vi.fn());
      mockServer.tool('weekly_briefing', vi.fn());

      const enabled = registry.enableGroup('content');

      expect(enabled).toContain('daily_briefing');
      expect(enabled).toContain('weekly_briefing');
      expect(tools.daily_briefing.enable).toHaveBeenCalled();
      expect(tools.weekly_briefing.enable).toHaveBeenCalled();
    });

    it('returns empty array for nonexistent group', () => {
      const enabled = registry.enableGroup('nonexistent');
      expect(enabled).toEqual([]);
    });

    it('only enables disabled tools, skips already-enabled ones', () => {
      const tools = {
        daily_briefing: createMockRegisteredTool(true),  // already enabled
        weekly_briefing: createMockRegisteredTool(false), // disabled
      };

      originalTool
        .mockReturnValueOnce(tools.daily_briefing)
        .mockReturnValueOnce(tools.weekly_briefing);

      mockServer.tool('daily_briefing', vi.fn());
      mockServer.tool('weekly_briefing', vi.fn());

      const enabled = registry.enableGroup('content');

      expect(enabled).not.toContain('daily_briefing');
      expect(enabled).toContain('weekly_briefing');
      expect(tools.daily_briefing.enable).not.toHaveBeenCalled();
      expect(tools.weekly_briefing.enable).toHaveBeenCalled();
    });

    it('skips tools that are not registered', () => {
      // Register only one tool from content group
      const tool = createMockRegisteredTool(false);
      originalTool.mockReturnValueOnce(tool);
      mockServer.tool('daily_briefing', vi.fn());

      const enabled = registry.enableGroup('content');

      // Should only enable the one registered tool
      expect(enabled).toEqual(['daily_briefing']);
    });
  });

  describe('disableGroup', () => {
    let registry: ToolRegistry;
    let mockServer: any;
    let originalTool: any;

    beforeEach(() => {
      registry = new ToolRegistry();
      originalTool = vi.fn();
      mockServer = { tool: originalTool };
      registry.install(mockServer);
    });

    it('disables all tools in an enabled group', () => {
      const tools = {
        health_check: createMockRegisteredTool(true),
        sprint_start: createMockRegisteredTool(true),
      };

      originalTool
        .mockReturnValueOnce(tools.health_check)
        .mockReturnValueOnce(tools.sprint_start);

      mockServer.tool('health_check', vi.fn());
      mockServer.tool('sprint_start', vi.fn());

      const disabled = registry.disableGroup('core');

      expect(disabled).toContain('health_check');
      expect(disabled).toContain('sprint_start');
      expect(tools.health_check.disable).toHaveBeenCalled();
      expect(tools.sprint_start.disable).toHaveBeenCalled();
    });

    it('returns empty array for nonexistent group', () => {
      const disabled = registry.disableGroup('nonexistent');
      expect(disabled).toEqual([]);
    });

    it('only disables enabled tools, skips already-disabled ones', () => {
      const tools = {
        health_check: createMockRegisteredTool(false), // already disabled
        sprint_start: createMockRegisteredTool(true),  // enabled
      };

      originalTool
        .mockReturnValueOnce(tools.health_check)
        .mockReturnValueOnce(tools.sprint_start);

      mockServer.tool('health_check', vi.fn());
      mockServer.tool('sprint_start', vi.fn());

      const disabled = registry.disableGroup('core');

      expect(disabled).not.toContain('health_check');
      expect(disabled).toContain('sprint_start');
      expect(tools.health_check.disable).not.toHaveBeenCalled();
      expect(tools.sprint_start.disable).toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    let registry: ToolRegistry;
    let mockServer: any;
    let originalTool: any;

    beforeEach(() => {
      registry = new ToolRegistry();
      originalTool = vi.fn();
      mockServer = { tool: originalTool };
      registry.install(mockServer);
    });

    it('returns status for all groups', () => {
      const status = registry.getStatus();

      expect(status).toHaveLength(3);
      expect(status.map(s => s.group)).toEqual(['core', 'content', 'advanced']);
    });

    it('includes group descriptions', () => {
      const status = registry.getStatus();

      for (const s of status) {
        expect(s.description).toBeTruthy();
      }
    });

    it('includes tool names for each group', () => {
      const status = registry.getStatus();

      const coreStatus = status.find(s => s.group === 'core');
      expect(coreStatus?.tools).toContain('health_check');
      expect(coreStatus?.tools).toContain('sprint_start');
    });

    it('marks group as enabled if any tool is enabled', () => {
      const tools = {
        health_check: createMockRegisteredTool(true),
        sprint_start: createMockRegisteredTool(false),
      };

      originalTool
        .mockReturnValueOnce(tools.health_check)
        .mockReturnValueOnce(tools.sprint_start);

      mockServer.tool('health_check', vi.fn());
      mockServer.tool('sprint_start', vi.fn());

      const status = registry.getStatus();
      const coreStatus = status.find(s => s.group === 'core');

      expect(coreStatus?.enabled).toBe(true);
    });

    it('marks group as disabled if all tools are disabled', () => {
      const tools = {
        daily_briefing: createMockRegisteredTool(false),
        weekly_briefing: createMockRegisteredTool(false),
      };

      originalTool
        .mockReturnValueOnce(tools.daily_briefing)
        .mockReturnValueOnce(tools.weekly_briefing);

      mockServer.tool('daily_briefing', vi.fn());
      mockServer.tool('weekly_briefing', vi.fn());

      const status = registry.getStatus();
      const contentStatus = status.find(s => s.group === 'content');

      expect(contentStatus?.enabled).toBe(false);
    });

    it('marks group as disabled if no tools are registered', () => {
      const status = registry.getStatus();

      // No tools registered, all groups should be disabled
      for (const s of status) {
        expect(s.enabled).toBe(false);
      }
    });
  });

  describe('has', () => {
    let registry: ToolRegistry;
    let mockServer: any;
    let originalTool: any;

    beforeEach(() => {
      registry = new ToolRegistry();
      originalTool = vi.fn();
      mockServer = { tool: originalTool };
      registry.install(mockServer);
    });

    it('returns true for registered tools', () => {
      originalTool.mockReturnValue(createMockRegisteredTool());
      mockServer.tool('test_tool', vi.fn());

      expect(registry.has('test_tool')).toBe(true);
    });

    it('returns false for unregistered tools', () => {
      expect(registry.has('nonexistent_tool')).toBe(false);
    });

    it('handles empty string', () => {
      expect(registry.has('')).toBe(false);
    });
  });
});
