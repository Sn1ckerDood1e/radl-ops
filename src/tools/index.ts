/**
 * Tools Index - Register all available tools
 */

import { registerGitHubTools } from './github.js';
import { registerBriefingTools } from './briefing.js';
import { registerSocialTools } from './social.js';
import { registerMonitoringTools } from './monitoring.js';
import { toolRegistry } from './registry.js';
import { logger } from '../config/logger.js';

/**
 * Register all tools with the registry
 */
export function registerAllTools(): void {
  logger.info('Registering tools...');

  registerGitHubTools();
  registerBriefingTools();
  registerSocialTools();
  registerMonitoringTools();

  logger.info(`Registered ${toolRegistry.list().length} tools: ${toolRegistry.list().join(', ')}`);
}

export { toolRegistry };
