/**
 * MCP Server Entry Point
 *
 * Exposes radl-ops tools as MCP tools for Claude Code.
 * Communicates via stdio (JSON-RPC over stdin/stdout).
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
import { initTokenTracker } from '../models/token-tracker.js';
import { logger } from '../config/logger.js';

const server = new McpServer({
  name: 'radl-ops',
  version: '1.2.0',
});

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
