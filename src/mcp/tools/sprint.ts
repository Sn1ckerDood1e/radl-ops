/**
 * MCP Sprint Tools - Sprint management via sprint.sh
 *
 * Wraps the sprint.sh shell script as MCP tools for conversational
 * sprint management within Claude Code sessions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import { logger } from '../../config/logger.js';

const SPRINT_SCRIPT = '/home/hb/radl-ops/scripts/sprint.sh';

function runSprint(args: string): string {
  try {
    return execSync(`${SPRINT_SCRIPT} ${args}`, {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, PATH: process.env.PATH },
    }).trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Sprint command failed';
    logger.error('Sprint command failed', { args, error: msg });
    return `Error: ${msg}`;
  }
}

export function registerSprintTools(server: McpServer): void {
  server.tool(
    'sprint_status',
    'Get current sprint status including phase, tasks completed, and blockers',
    {},
    async () => {
      const output = runSprint('status');
      return { content: [{ type: 'text' as const, text: output }] };
    }
  );

  server.tool(
    'sprint_start',
    'Start a new sprint with phase, title, and time estimate. Sends Slack notification.',
    {
      phase: z.string().min(1).max(50).describe('Sprint phase identifier (e.g., "Phase 54.1")'),
      title: z.string().min(1).max(100).describe('Sprint title (e.g., "MCP Server Migration")'),
      estimate: z.string().max(50).optional().describe('Time estimate (e.g., "3 hours")'),
    },
    async ({ phase, title, estimate }) => {
      const est = estimate ? ` "${estimate}"` : '';
      const output = runSprint(`start "${phase}" "${title}"${est}`);
      return { content: [{ type: 'text' as const, text: output }] };
    }
  );

  server.tool(
    'sprint_progress',
    'Record task completion in the current sprint',
    {
      message: z.string().min(1).max(500).describe('Description of completed task'),
      notify: z.boolean().optional().default(false).describe('Send Slack notification'),
    },
    async ({ message, notify }) => {
      const flag = notify ? ' --notify' : '';
      const output = runSprint(`progress "${message}"${flag}`);
      return { content: [{ type: 'text' as const, text: output }] };
    }
  );

  server.tool(
    'sprint_complete',
    'Complete the current sprint. Triggers compound learning extraction and Slack notification.',
    {
      commit: z.string().min(1).max(100).describe('Commit hash of the final commit'),
      actual_time: z.string().min(1).max(50).describe('Actual time taken (e.g., "1.5 hours")'),
    },
    async ({ commit, actual_time }) => {
      const output = runSprint(`complete "${commit}" "${actual_time}"`);
      return { content: [{ type: 'text' as const, text: output }] };
    }
  );
}
