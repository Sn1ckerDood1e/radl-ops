/**
 * Radl Ops - Main Entry Point
 *
 * An autonomous AI assistant for managing the Radl business.
 *
 * Security-first design based on research of OpenClaw, Leon, and OVOS.
 *
 * Usage:
 *   npm start          - Start all services (CLI + Slack + Scheduler)
 *   npm run cli        - Start CLI only
 *   npm run slack      - Start Slack bot only
 *   npm run scheduler  - Start scheduler only
 */

import { config } from './config/index.js';
import { logger } from './config/logger.js';
import { registerAllTools } from './tools/index.js';
import { startCli } from './cli/index.js';
import { startSlack, initSlack } from './integrations/slack.js';
import { initEmail } from './integrations/email.js';
import { startScheduler, registerDefaultTasks } from './scheduler/index.js';
import { initMemory, cleanupExpired, saveMarkdownExport } from './memory/index.js';
import { cleanupOldLogs } from './audit/index.js';
import { toolRegistry } from './tools/registry.js';
import { initTokenTracker, getAllRoutes, cleanupOldUsageLogs } from './models/index.js';
import { getIronLaws } from './guardrails/index.js';

type RunMode = 'all' | 'cli' | 'slack' | 'scheduler';

async function main(): Promise<void> {
  const mode = (process.argv[2] as RunMode) || 'all';

  logger.info('Starting Radl Ops', {
    mode,
    env: config.app.env,
    version: '0.3.0', // Model routing, token tracking, generator/critic
  });

  // Initialize core systems
  logger.info('Initializing core systems...');

  // Configure guardrails based on environment
  toolRegistry.configure({
    approvalRequiredTiers: ['delete', 'external', 'dangerous'],
    globalRateLimit: config.app.isDev ? 1000 : 100,
    approvalTimeoutSeconds: 300,
    auditAllActions: true,
  });

  // Initialize memory system
  initMemory();

  // Initialize token tracker for cost analytics
  initTokenTracker();

  // Register all tools
  registerAllTools();

  // Initialize integrations
  initEmail();
  initSlack();

  // Register scheduled tasks
  registerDefaultTasks();

  // Run cleanup tasks
  cleanupExpired(); // Clean expired memories
  cleanupOldLogs(); // Clean old audit logs
  cleanupOldUsageLogs(); // Clean old usage logs (90-day retention)

  // Log system status with model routing info
  const tools = toolRegistry.getToolInfo();
  const routes = getAllRoutes();
  logger.info('System initialized', {
    totalTools: tools.length,
    toolsByCategory: tools.reduce((acc, t) => {
      acc[t.category] = (acc[t.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    modelRouting: Object.entries(routes).reduce((acc, [task, route]) => {
      acc[task] = `${route.model.split('-')[1]}/${route.effort}`;
      return acc;
    }, {} as Record<string, string>),
    ironLaws: getIronLaws().map(l => l.id),
  });

  switch (mode) {
    case 'cli':
      logger.info('Starting CLI mode');
      await startCli();
      break;

    case 'slack':
      logger.info('Starting Slack mode');
      await startSlack();
      // Keep process running
      setupGracefulShutdown();
      break;

    case 'scheduler':
      logger.info('Starting scheduler mode');
      startScheduler();
      // Keep process running
      setupGracefulShutdown();
      break;

    case 'all':
    default:
      logger.info('Starting all services');

      // Start scheduler in background
      startScheduler();

      // Start Slack in background (if configured)
      startSlack().catch(err => {
        logger.warn('Slack failed to start', { error: err.message });
      });

      // Start CLI (blocking)
      await startCli();
      break;
  }
}

/**
 * Setup graceful shutdown handlers
 */
function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    // Save memory state before exit
    try {
      saveMarkdownExport();
      logger.info('Memory state saved');
    } catch (error) {
      logger.error('Failed to save memory state', { error });
    }

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
  process.exit(1);
});

main().catch((error) => {
  logger.error('Failed to start', { error: error.message });
  process.exit(1);
});
