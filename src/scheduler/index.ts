/**
 * Scheduler - Run periodic tasks like briefings
 */

import type { ScheduledTask } from '../types/index.js';
import { logger } from '../config/logger.js';
import { toolRegistry } from '../tools/registry.js';
import { sendBriefing } from '../integrations/slack.js';
import { sendBriefingEmail } from '../integrations/email.js';
import type { Briefing } from '../types/index.js';

const tasks = new Map<string, ScheduledTask>();
const intervals = new Map<string, NodeJS.Timeout>();

/**
 * Parse cron expression to get next run time
 * Simplified: only supports specific times like "0 9 * * *" (9 AM daily)
 */
function parseNextRun(schedule: string): Date {
  const parts = schedule.split(' ');
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const now = new Date();
  const next = new Date();

  // Set time
  next.setMinutes(parseInt(minute, 10) || 0);
  next.setHours(parseInt(hour, 10) || 0);
  next.setSeconds(0);
  next.setMilliseconds(0);

  // If daily schedule and time has passed, move to tomorrow
  if (dayOfMonth === '*' && month === '*') {
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    // Handle day of week (0 = Sunday)
    if (dayOfWeek !== '*') {
      const targetDay = parseInt(dayOfWeek, 10);
      while (next.getDay() !== targetDay) {
        next.setDate(next.getDate() + 1);
      }
    }
  }

  return next;
}

/**
 * Calculate milliseconds until next run
 */
function msUntilNextRun(schedule: string): number {
  const nextRun = parseNextRun(schedule);
  return Math.max(0, nextRun.getTime() - Date.now());
}

/**
 * Register a scheduled task
 */
export function registerTask(task: ScheduledTask): void {
  tasks.set(task.id, task);
  logger.info(`Registered scheduled task: ${task.name}`, { schedule: task.schedule });
}

/**
 * Start all scheduled tasks
 */
export function startScheduler(): void {
  logger.info('Starting scheduler');

  for (const task of tasks.values()) {
    if (!task.enabled) {
      logger.info(`Skipping disabled task: ${task.name}`);
      continue;
    }

    scheduleTask(task);
  }
}

/**
 * Schedule a single task
 */
function scheduleTask(task: ScheduledTask): void {
  const runTask = async () => {
    logger.info(`Running scheduled task: ${task.name}`);
    task.lastRun = new Date();

    try {
      await task.handler();
      logger.info(`Completed scheduled task: ${task.name}`);
    } catch (error) {
      logger.error(`Failed scheduled task: ${task.name}`, { error });
    }

    // Schedule next run
    task.nextRun = parseNextRun(task.schedule);
    const delay = msUntilNextRun(task.schedule);

    const timeout = setTimeout(runTask, delay);
    intervals.set(task.id, timeout);

    logger.info(`Next run of ${task.name}: ${task.nextRun.toISOString()}`);
  };

  // Calculate initial delay
  const initialDelay = msUntilNextRun(task.schedule);
  task.nextRun = parseNextRun(task.schedule);

  logger.info(`Scheduled ${task.name} for ${task.nextRun.toISOString()}`);

  const timeout = setTimeout(runTask, initialDelay);
  intervals.set(task.id, timeout);
}

/**
 * Stop all scheduled tasks
 */
export function stopScheduler(): void {
  logger.info('Stopping scheduler');

  for (const [id, timeout] of intervals.entries()) {
    clearTimeout(timeout);
    intervals.delete(id);
  }
}

/**
 * Run a task immediately
 */
export async function runTaskNow(taskId: string): Promise<void> {
  const task = tasks.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  logger.info(`Running task immediately: ${task.name}`);
  task.lastRun = new Date();
  await task.handler();
}

/**
 * Get all registered tasks
 */
export function getTasks(): ScheduledTask[] {
  return Array.from(tasks.values());
}

/**
 * Register default scheduled tasks
 */
export function registerDefaultTasks(): void {
  // Daily briefing at 9 AM
  registerTask({
    id: 'daily-briefing',
    name: 'Daily Briefing',
    description: 'Generate and send daily business briefing',
    schedule: '0 9 * * *', // 9:00 AM every day
    enabled: true,
    handler: async () => {
      const briefingTool = toolRegistry.get('generate_daily_briefing');
      if (!briefingTool) {
        logger.error('Daily briefing tool not found');
        return;
      }

      const result = await briefingTool.execute({ include_github: true });
      if (!result.success || !result.data) {
        logger.error('Failed to generate daily briefing', { error: result.error });
        return;
      }

      const briefing = result.data as Briefing;
      const content = briefing.sections.map(s => s.content).join('\n\n');

      // Send to Slack
      await sendBriefing(content, '📊 Daily Briefing');

      // Send via email
      const date = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
      await sendBriefingEmail(`Daily Briefing - ${date}`, content, 'daily');
    },
  });

  // Weekly briefing on Monday at 9 AM
  registerTask({
    id: 'weekly-briefing',
    name: 'Weekly Briefing',
    description: 'Generate and send weekly business briefing',
    schedule: '0 9 * * 1', // 9:00 AM every Monday
    enabled: true,
    handler: async () => {
      const briefingTool = toolRegistry.get('generate_weekly_briefing');
      if (!briefingTool) {
        logger.error('Weekly briefing tool not found');
        return;
      }

      const result = await briefingTool.execute({});
      if (!result.success || !result.data) {
        logger.error('Failed to generate weekly briefing', { error: result.error });
        return;
      }

      const briefing = result.data as Briefing;
      const content = briefing.sections.map(s => s.content).join('\n\n');

      // Send to Slack
      await sendBriefing(content, '📅 Weekly Briefing');

      // Send via email
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - 7);
      const dateRange = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      await sendBriefingEmail(`Weekly Briefing - ${dateRange}`, content, 'weekly');
    },
  });
}
