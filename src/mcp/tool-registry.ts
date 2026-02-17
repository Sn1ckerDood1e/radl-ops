/**
 * Tool Registry — captures RegisteredTool references for dynamic enable/disable.
 *
 * Wraps McpServer.tool() to capture all registered tool references,
 * then provides group-based enable/disable for on-demand tool loading.
 *
 * Groups:
 * - core: always enabled (sprint, monitoring, knowledge, iron laws)
 * - content: disabled by default (briefing, social, roadmap)
 * - advanced: disabled by default (eval-opt, compound)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** RegisteredTool type extracted from MCP SDK */
interface RegisteredTool {
  enabled: boolean;
  enable(): void;
  disable(): void;
}

export interface ToolGroup {
  name: string;
  description: string;
  toolNames: string[];
  defaultEnabled: boolean;
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    name: 'core',
    description: 'Sprint management, monitoring, knowledge, iron laws, cost reporting, team recipes, verification, conductor, data flow, pre-flight',
    toolNames: [
      'health_check', 'sprint_status', 'sprint_start', 'sprint_progress', 'sprint_complete',
      'iron_laws', 'cost_report', 'knowledge_query', 'verify', 'team_recipe', 'audit_triage',
      'sprint_advisor', 'review_pipeline', 'sprint_decompose', 'verify_patterns',
      'sprint_conductor', 'verify_data_flow', 'pre_flight_check', 'spot_check_diff', 'deferred_triage',
      'sprint_retrospective', 'auto_prioritize', 'spec_to_tests',
      'crystallize_propose', 'crystallize_approve', 'crystallize_demote', 'crystallize_list',
      'antibody_create', 'antibody_list', 'antibody_disable',
      'causal_extract', 'causal_query', 'inverse_bloom',
      'trust_report', 'trust_record',
      'speculative_validate', 'cognitive_load',
      'record_review', 'resolve_review',
    ],
    defaultEnabled: true,
  },
  {
    name: 'content',
    description: 'Briefings (daily/weekly), social media (ideas, drafts, calendar), roadmap brainstorming',
    toolNames: [
      'daily_briefing', 'weekly_briefing', 'social_ideas', 'social_draft',
      'social_calendar', 'roadmap_ideas',
    ],
    defaultEnabled: false,
  },
  {
    name: 'advanced',
    description: 'Eval-opt content generation (multi-model quality loop), compound learning extraction (Bloom pipeline)',
    toolNames: ['eval_opt_generate', 'compound_extract', 'tool_forge', 'counterfactual_analyze'],
    defaultEnabled: false,
  },
];

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  /**
   * Install the registry on a McpServer to capture all tool registrations.
   * Must be called BEFORE any registerXxxTools() calls.
   */
  install(server: McpServer): void {
    const origTool = server.tool.bind(server);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).tool = (...args: unknown[]) => {
      // All server.tool() overloads take name as first arg
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (origTool as any)(...args) as RegisteredTool;
      if (typeof args[0] === 'string') {
        this.tools.set(args[0], result);
      }
      return result;
    };
  }

  /**
   * Apply default enabled/disabled state for all groups.
   * Call AFTER all tools are registered.
   */
  applyDefaults(): void {
    for (const group of TOOL_GROUPS) {
      if (!group.defaultEnabled) {
        for (const name of group.toolNames) {
          this.tools.get(name)?.disable();
        }
      }
    }
  }

  /** Enable all tools in a group. Returns names of tools that were enabled. */
  enableGroup(groupName: string): string[] {
    const group = TOOL_GROUPS.find(g => g.name === groupName);
    if (!group) return [];

    const enabled: string[] = [];
    for (const name of group.toolNames) {
      const tool = this.tools.get(name);
      if (tool && !tool.enabled) {
        tool.enable();
        enabled.push(name);
      }
    }
    return enabled;
  }

  /** Disable all tools in a group. Returns names of tools that were disabled. */
  disableGroup(groupName: string): string[] {
    const group = TOOL_GROUPS.find(g => g.name === groupName);
    if (!group) return [];

    const disabled: string[] = [];
    for (const name of group.toolNames) {
      const tool = this.tools.get(name);
      if (tool && tool.enabled) {
        tool.disable();
        disabled.push(name);
      }
    }
    return disabled;
  }

  /** Get the current status of all groups. */
  getStatus(): Array<{ group: string; description: string; enabled: boolean; tools: string[] }> {
    return TOOL_GROUPS.map(group => ({
      group: group.name,
      description: group.description,
      enabled: group.toolNames.some(name => this.tools.get(name)?.enabled ?? false),
      tools: group.toolNames,
    }));
  }

  /** Check if a specific tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }
}
