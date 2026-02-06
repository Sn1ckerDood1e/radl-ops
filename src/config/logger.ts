/**
 * Simple logger for Radl Ops
 *
 * In MCP mode (RADL_OPS_MODE=mcp), ALL output goes to stderr.
 * stdout is reserved for JSON-RPC protocol messages.
 */

import type { LogLevel, LogEntry } from '../types/index.js';

function isMcpMode(): boolean {
  return process.env.RADL_OPS_MODE === 'mcp';
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatMessage(entry: LogEntry): string {
  const timestamp = entry.timestamp.toISOString();
  const level = entry.level.toUpperCase().padEnd(5);
  const context = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
  return `[${timestamp}] ${level} ${entry.message}${context}`;
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    timestamp: new Date(),
    level,
    message,
    context,
  };

  const formatted = formatMessage(entry);

  // In MCP mode, ALL output must go to stderr (stdout = JSON-RPC)
  if (isMcpMode()) {
    process.stderr.write(formatted + '\n');
    return;
  }

  switch (level) {
    case 'error':
      console.error(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    default:
      console.log(formatted);
  }
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => log('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => log('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => log('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => log('error', message, context),
};
