/**
 * Radl Ops - Main Entry Point
 *
 * An autonomous AI assistant for managing the Radl business.
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

type RunMode = 'all' | 'cli' | 'slack' | 'scheduler';

async function main(): Promise<void> {
  const mode = (process.argv[2] as RunMode) || 'all';

  logger.info('Starting Radl Ops', {
    mode,
    env: config.app.env,
  });

  // Register all tools
  registerAllTools();

  // Initialize integrations
  initEmail();
  initSlack();

  // Register scheduled tasks
  registerDefaultTasks();

  switch (mode) {
    case 'cli':
      logger.info('Starting CLI mode');
      await startCli();
      break;

    case 'slack':
      logger.info('Starting Slack mode');
      await startSlack();
      // Keep process running
      process.on('SIGINT', () => {
        logger.info('Shutting down...');
        process.exit(0);
      });
      break;

    case 'scheduler':
      logger.info('Starting scheduler mode');
      startScheduler();
      // Keep process running
      process.on('SIGINT', () => {
        logger.info('Shutting down...');
        process.exit(0);
      });
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

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
  process.exit(1);
});

main().catch((error) => {
  logger.error('Failed to start', { error });
  process.exit(1);
});
