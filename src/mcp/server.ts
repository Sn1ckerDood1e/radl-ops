/**
 * MCP Server Entry Point (v2.0.0)
 *
 * Exposes radl-ops tools, resources, and prompts for Claude Code.
 * Communicates via stdio (JSON-RPC over stdin/stdout).
 *
 * Capabilities:
 * - Tools: 26 tools across 3 groups (core, content, advanced) with annotations
 * - Resources: sprint://current (cached), config://iron-laws, config://tool-groups
 * - Prompts: sprint-start, sprint-review, code-review
 *
 * Tool groups (dynamic loading):
 * - core: always enabled (sprint, monitoring, knowledge, iron laws, conductor, data-flow, pre-flight)
 * - content: disabled by default, enable with enable_tools (briefing, social, roadmap)
 * - advanced: disabled by default, enable with enable_tools (eval-opt, compound)
 *
 * IMPORTANT: Set RADL_OPS_MODE before any imports that use logger/tracker.
 */

process.env.RADL_OPS_MODE = 'mcp';

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

// Explicit path to .env — don't rely on CWD which may differ in MCP subprocess
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env');
dotenvConfig({ path: envPath });

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerBriefingTools } from './tools/briefing.js';
import { registerSocialTools } from './tools/social.js';
import { registerMonitoringTools } from './tools/monitoring.js';
import { registerSprintTools } from './tools/sprint.js';
import { registerCostTools } from './tools/costs.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerVerifyTools } from './tools/verify.js';
import { registerTeamTools } from './tools/teams.js';
import { registerEvalOptTools } from './tools/eval-opt.js';
import { registerCompoundTools } from './tools/compound.js';
import { registerAuditTriageTools } from './tools/audit-triage.js';
import { registerSprintAdvisorTools } from './tools/sprint-advisor.js';
import { registerReviewPipelineTools } from './tools/review-pipeline.js';
import { registerSprintDecomposeTools } from './tools/sprint-decompose.js';
import { registerDriftDetectionTools } from './tools/drift-detection.js';
import { registerSprintConductorTools } from './tools/sprint-conductor.js';
import { registerDataFlowVerifierTools } from './tools/data-flow-verifier.js';
import { registerPreFlightTools } from './tools/pre-flight.js';
import { registerSpotCheckTools } from './tools/spot-check.js';
import { registerDeferredLifecycleTools } from './tools/deferred-lifecycle.js';
import { registerRetrospectiveTools } from './tools/retrospective.js';
import { registerPrioritizeTools } from './tools/prioritize.js';
import { registerSpecVerifyTools } from './tools/spec-verify.js';
import { registerCrystallizationTools } from './tools/crystallization.js';
import { registerImmuneSystemTools } from './tools/immune-system.js';
import { registerCausalGraphTools } from './tools/causal-graph.js';
import { registerInverseBloomTools } from './tools/inverse-bloom.js';
import { registerQualityRatchetTools } from './tools/quality-ratchet.js';
import { ToolRegistry, TOOL_GROUPS } from './tool-registry.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { initTokenTracker } from '../models/token-tracker.js';
import { logger } from '../config/logger.js';

const server = new McpServer({
  name: 'radl-ops',
  version: '2.0.0',
});

// Install tool registry to capture RegisteredTool references (must be before registrations)
const registry = new ToolRegistry();
registry.install(server);

// Register all tools (registry captures references via intercepted server.tool())
registerBriefingTools(server);
registerSocialTools(server);
registerMonitoringTools(server);
registerSprintTools(server);
registerCostTools(server);
registerKnowledgeTools(server);
registerVerifyTools(server);
registerTeamTools(server);
registerEvalOptTools(server);
registerCompoundTools(server);
registerAuditTriageTools(server);
registerSprintAdvisorTools(server);
registerReviewPipelineTools(server);
registerSprintDecomposeTools(server);
registerDriftDetectionTools(server);
registerSprintConductorTools(server);
registerDataFlowVerifierTools(server);
registerPreFlightTools(server);
registerSpotCheckTools(server);
registerDeferredLifecycleTools(server);
registerRetrospectiveTools(server);
registerPrioritizeTools(server);
registerSpecVerifyTools(server);
registerCrystallizationTools(server);
registerImmuneSystemTools(server);
registerCausalGraphTools(server);
registerInverseBloomTools(server);
registerQualityRatchetTools(server);

// Register MCP prompts (workflow templates)
registerPrompts(server);

// Register MCP resources (read-only state)
registerResources(server, registry);

// Register the enable_tools meta-tool (always enabled, manages other tool groups)
const groupNames = TOOL_GROUPS.filter(g => !g.defaultEnabled).map(g => g.name);
const groupDescriptions = TOOL_GROUPS
  .filter(g => !g.defaultEnabled)
  .map(g => `${g.name}: ${g.description}`)
  .join('; ');

server.tool(
  'enable_tools',
  `Enable or disable tool groups on demand. Available groups: ${groupDescriptions}. Core tools are always enabled.`,
  {
    group: z.enum(groupNames as [string, ...string[]])
      .describe('Tool group to enable or disable'),
    action: z.enum(['enable', 'disable']).default('enable')
      .describe('Whether to enable or disable the group'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ({ group, action }) => {
    const affected = action === 'enable'
      ? registry.enableGroup(group)
      : registry.disableGroup(group);

    if (affected.length > 0) {
      server.sendToolListChanged();
    }

    const status = registry.getStatus();
    const statusLines = status.map(s =>
      `- **${s.group}**: ${s.enabled ? 'enabled' : 'disabled'} (${s.tools.join(', ')})`
    );

    return {
      content: [{
        type: 'text' as const,
        text: [
          `${action === 'enable' ? 'Enabled' : 'Disabled'} ${affected.length} tools in group "${group}"${affected.length > 0 ? `: ${affected.join(', ')}` : ' (already in desired state)'}`,
          '',
          '**Current status:**',
          ...statusLines,
        ].join('\n'),
      }],
    };
  }
);

// Apply default enabled/disabled state (content + advanced start disabled)
registry.applyDefaults();

initTokenTracker();

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const status = registry.getStatus();
  const enabledCount = status.filter(s => s.enabled).length;
  logger.info('radl-ops MCP server started', {
    version: '2.0.0',
    toolGroups: status.length,
    enabledGroups: enabledCount,
  });
}

main().catch((error) => {
  logger.error('MCP server failed to start', { error: String(error) });
  process.exit(1);
});
