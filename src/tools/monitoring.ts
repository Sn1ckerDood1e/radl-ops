/**
 * Monitoring Tools - Service health and error tracking
 *
 * Provides tools for checking service health across the Radl stack:
 * - Vercel deployment status
 * - Supabase health
 * - Error rate monitoring
 *
 * All monitoring tools are read-tier (automatic execution).
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolExecutionContext } from '../types/index.js';
import { config } from '../config/index.js';
import { toolRegistry } from './registry.js';
import { logger } from '../config/logger.js';

// ============================================
// Input Validation Schemas
// ============================================

const healthCheckSchema = z.object({
  services: z.array(z.enum(['vercel', 'supabase', 'github'])).optional(),
});

const errorSummarySchema = z.object({
  hours: z.number().int().min(1).max(168).optional().default(24),
  severity: z.enum(['all', 'error', 'warning']).optional().default('all'),
});

// ============================================
// Tools
// ============================================

/**
 * Run health checks across services
 */
const serviceHealthCheck: Tool = {
  name: 'service_health_check',
  description: 'Check health status of Vercel, Supabase, and GitHub services for Radl',
  category: 'system',
  permissionTier: 'read',
  parameters: {
    services: {
      type: 'array',
      description: 'Services to check (vercel, supabase, github). Checks all if empty.',
      optional: true,
    },
  },
  inputSchema: healthCheckSchema,
  rateLimit: 10,
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = healthCheckSchema.parse(params);
      const servicesToCheck = validated.services || ['vercel', 'supabase', 'github'];

      const results: Record<string, {
        status: 'healthy' | 'degraded' | 'down' | 'unchecked';
        message: string;
        checkedAt: string;
      }> = {};

      for (const service of servicesToCheck) {
        try {
          switch (service) {
            case 'vercel':
              results.vercel = await checkVercelHealth();
              break;
            case 'supabase':
              results.supabase = await checkSupabaseHealth();
              break;
            case 'github':
              results.github = await checkGitHubHealth();
              break;
          }
        } catch (error) {
          results[service] = {
            status: 'down',
            message: error instanceof Error ? error.message : 'Health check failed',
            checkedAt: new Date().toISOString(),
          };
        }
      }

      const allHealthy = Object.values(results).every(r => r.status === 'healthy');
      const anyDown = Object.values(results).some(r => r.status === 'down');

      logger.info('Health check completed', {
        services: servicesToCheck,
        allHealthy,
        anyDown,
      });

      return {
        success: true,
        data: {
          overall: anyDown ? 'issues_detected' : allHealthy ? 'all_healthy' : 'degraded',
          services: results,
          checkedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      logger.error('service_health_check failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Health check failed',
      };
    }
  },
};

/**
 * Get error summary from monitoring
 */
const errorSummary: Tool = {
  name: 'monitoring_error_summary',
  description: 'Get a summary of errors and issues across Radl services',
  category: 'system',
  permissionTier: 'read',
  parameters: {
    hours: {
      type: 'number',
      description: 'Look back period in hours (1-168, default 24)',
      optional: true,
      default: 24,
    },
    severity: {
      type: 'string',
      description: 'Filter by severity: all, error, warning',
      optional: true,
      default: 'all',
      enum: ['all', 'error', 'warning'],
    },
  },
  inputSchema: errorSummarySchema,
  rateLimit: 10,
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = errorSummarySchema.parse(params);

      // This will be populated from Sentry/logging when integrated
      // For now, returns a summary structure that can be filled in
      const summary = {
        period: `Last ${validated.hours} hours`,
        severity: validated.severity,
        errors: [] as Array<{
          service: string;
          count: number;
          latestMessage: string;
          firstSeen: string;
        }>,
        totalErrors: 0,
        totalWarnings: 0,
        note: 'Sentry integration pending. Currently returns empty summary.',
      };

      logger.info('Error summary generated', {
        hours: validated.hours,
        severity: validated.severity,
      });

      return { success: true, data: summary };
    } catch (error) {
      logger.error('monitoring_error_summary failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get error summary',
      };
    }
  },
};

// ============================================
// Health Check Implementations
// ============================================

async function checkVercelHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'down';
  message: string;
  checkedAt: string;
}> {
  // Check if the Radl app responds
  try {
    const response = await fetch('https://radl.app', {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
    });

    return {
      status: response.ok ? 'healthy' : 'degraded',
      message: response.ok
        ? `Vercel responding (${response.status})`
        : `Vercel returned ${response.status}`,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'down',
      message: 'Vercel not responding (timeout or network error)',
      checkedAt: new Date().toISOString(),
    };
  }
}

async function checkSupabaseHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'down';
  message: string;
  checkedAt: string;
}> {
  const supabaseUrl = config.supabase?.url;
  if (!supabaseUrl) {
    return {
      status: 'degraded',
      message: 'Supabase URL not configured',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: 'HEAD',
      headers: {
        'apikey': config.supabase?.anonKey || '',
      },
      signal: AbortSignal.timeout(10000),
    });

    return {
      status: response.ok || response.status === 401 ? 'healthy' : 'degraded',
      message: `Supabase API responding (${response.status})`,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'down',
      message: 'Supabase not responding',
      checkedAt: new Date().toISOString(),
    };
  }
}

async function checkGitHubHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'down';
  message: string;
  checkedAt: string;
}> {
  try {
    const response = await fetch('https://api.github.com/rate_limit', {
      headers: config.github.token
        ? { 'Authorization': `Bearer ${config.github.token}` }
        : {},
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const data = await response.json() as {
        rate: { remaining: number; limit: number };
      };
      const remaining = data.rate?.remaining ?? 0;
      const limit = data.rate?.limit ?? 0;

      return {
        status: remaining > 100 ? 'healthy' : remaining > 0 ? 'degraded' : 'down',
        message: `GitHub API: ${remaining}/${limit} requests remaining`,
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      status: 'degraded',
      message: `GitHub API returned ${response.status}`,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'down',
      message: 'GitHub API not responding',
      checkedAt: new Date().toISOString(),
    };
  }
}

// ============================================
// Registration
// ============================================

export function registerMonitoringTools(): void {
  toolRegistry.register(serviceHealthCheck);
  toolRegistry.register(errorSummary);

  logger.info('Monitoring tools registered', { count: 2 });
}
