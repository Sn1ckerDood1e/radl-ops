/**
 * MCP Resources - Read-only data exposed as resources
 *
 * Provides read-only access to radl-ops state without calling tools,
 * reducing context pollution and enabling efficient state inspection.
 *
 * Resources:
 * - sprint://current - Current sprint state + git branch
 * - config://iron-laws - Non-negotiable constraints
 * - config://tool-groups - Tool group enable/disable status
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execFileSync, execSync } from 'child_process';
import { getIronLaws } from '../guardrails/iron-laws.js';
import type { ToolRegistry } from './tool-registry.js';
import { logger } from '../config/logger.js';

/**
 * Register all MCP resources on the server
 */
export function registerResources(server: McpServer, registry: ToolRegistry): void {
  // Resource 1: Current sprint state + git branch
  server.resource(
    'sprint://current',
    'sprint://current',
    {
      title: 'Current Sprint State',
      description: 'Current sprint status from sprint.sh and active git branch from radl repo',
      mimeType: 'application/json',
    },
    async (uri) => {
      let sprintOutput = '';
      let branch = '';
      let error = null;

      // Get sprint status
      try {
        sprintOutput = execFileSync(
          '/home/hb/radl-ops/scripts/sprint.sh',
          ['status'],
          { encoding: 'utf-8', timeout: 10000 }
        ).trim();
      } catch (err) {
        error = `Failed to get sprint status: ${err instanceof Error ? err.message : String(err)}`;
        logger.error('Resource sprint://current: sprint.sh failed', { error });
      }

      // Get current git branch from radl repo
      try {
        branch = execSync('git branch --show-current', {
          encoding: 'utf-8',
          cwd: '/home/hb/radl',
          timeout: 5000,
        }).trim();
      } catch (err) {
        error = error
          ? `${error}; Failed to get git branch: ${err instanceof Error ? err.message : String(err)}`
          : `Failed to get git branch: ${err instanceof Error ? err.message : String(err)}`;
        logger.error('Resource sprint://current: git branch failed', { error: err });
      }

      const data = error
        ? { error, branch: branch || null, sprintOutput: sprintOutput || null }
        : { branch, sprintOutput };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  // Resource 2: Iron laws
  server.resource(
    'config://iron-laws',
    'config://iron-laws',
    {
      title: 'Iron Laws',
      description: 'Non-negotiable constraints that agents cannot override (no-push-main, no-commit-secrets, etc.)',
      mimeType: 'application/json',
    },
    async (uri) => {
      const laws = getIronLaws();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(laws, null, 2),
          },
        ],
      };
    }
  );

  // Resource 3: Tool groups status
  server.resource(
    'config://tool-groups',
    'config://tool-groups',
    {
      title: 'Tool Groups Status',
      description: 'Dynamic tool loading groups (core, content, advanced) with enabled/disabled state',
      mimeType: 'application/json',
    },
    async (uri) => {
      const status = registry.getStatus();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    }
  );

  logger.info('MCP resources registered', {
    resources: ['sprint://current', 'config://iron-laws', 'config://tool-groups'],
  });
}
