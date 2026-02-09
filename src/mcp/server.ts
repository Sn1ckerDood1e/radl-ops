/**
 * MCP Server Entry Point
 *
 * Exposes radl-ops tools as MCP tools for Claude Code.
 * Communicates via stdio (JSON-RPC over stdin/stdout).
 *
 * IMPORTANT: Set RADL_OPS_MODE before any imports that use logger/tracker.
 */

process.env.RADL_OPS_MODE = 'mcp';

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerBriefingTools } from './tools/briefing.js';
import { registerSocialTools } from './tools/social.js';
import { registerMonitoringTools } from './tools/monitoring.js';
import { registerSprintTools } from './tools/sprint.js';
import { registerCostTools } from './tools/costs.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerVerifyTools } from './tools/verify.js';
import { initTokenTracker } from '../models/token-tracker.js';
import { logger } from '../config/logger.js';

const server = new McpServer({
  name: 'radl-ops',
  version: '1.1.0',
});

registerBriefingTools(server);
registerSocialTools(server);
registerMonitoringTools(server);
registerSprintTools(server);
registerCostTools(server);
registerKnowledgeTools(server);
registerVerifyTools(server);

initTokenTracker();

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('radl-ops MCP server started');
}

main().catch((error) => {
  logger.error('MCP server failed to start', { error: String(error) });
  process.exit(1);
});
