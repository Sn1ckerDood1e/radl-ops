/**
 * Tool Registry - Central registration and management for all tools
 *
 * Security features (based on OpenClaw lessons):
 * - Permission tier enforcement
 * - Rate limiting per tool
 * - Input validation via Zod
 * - Audit logging for all executions
 */

import { z } from 'zod';
import type {
  Tool,
  ToolResult,
  ToolExecutionContext,
  PermissionTier,
  ToolCategory,
  GuardrailConfig,
  DEFAULT_GUARDRAILS,
} from '../types/index.js';
import {
  auditToolExecution,
  auditToolBlocked,
  auditRateLimited,
  auditValidationFailed,
} from '../audit/index.js';
import { logger } from '../config/logger.js';

interface RateLimitEntry {
  count: number;
  resetAt: Date;
}

class ToolRegistry {
  private tools = new Map<string, Tool>();
  private rateLimits = new Map<string, RateLimitEntry>();
  private guardrails: GuardrailConfig;

  constructor() {
    // Default guardrails - can be overridden via configure()
    this.guardrails = {
      approvalRequiredTiers: ['delete', 'external', 'dangerous'],
      globalRateLimit: 100,
      approvalTimeoutSeconds: 300,
      auditAllActions: true,
    };
  }

  /**
   * Configure guardrails
   */
  configure(config: Partial<GuardrailConfig>): void {
    this.guardrails = { ...this.guardrails, ...config };
    logger.info('Tool registry configured', { guardrails: this.guardrails });
  }

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    // Validate tool has required security metadata
    if (!tool.permissionTier) {
      throw new Error(`Tool ${tool.name} missing permissionTier`);
    }
    if (!tool.category) {
      throw new Error(`Tool ${tool.name} missing category`);
    }

    this.tools.set(tool.name, tool);
    logger.debug('Tool registered', {
      name: tool.name,
      tier: tool.permissionTier,
      category: tool.category,
    });
  }

  /**
   * Get a tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools by category
   */
  getByCategory(category: ToolCategory): Tool[] {
    return this.getAll().filter(t => t.category === category);
  }

  /**
   * Get tools by permission tier
   */
  getByTier(tier: PermissionTier): Tool[] {
    return this.getAll().filter(t => t.permissionTier === tier);
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * List all tool names
   */
  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Check if a tool requires approval
   */
  requiresApproval(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return true; // Unknown tools always require approval

    return this.guardrails.approvalRequiredTiers.includes(tool.permissionTier);
  }

  /**
   * Execute a tool with all security checks
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const tool = this.tools.get(toolName);

    // Check tool exists
    if (!tool) {
      auditToolBlocked(toolName, 'dangerous', context.channel, 'Tool not found');
      return {
        success: false,
        error: `Unknown tool: ${toolName}`,
      };
    }

    // Check rate limit
    if (!this.checkRateLimit(toolName, tool.rateLimit)) {
      auditRateLimited(toolName, context.channel, context.userId);
      return {
        success: false,
        error: `Rate limit exceeded for ${toolName}. Please wait before trying again.`,
      };
    }

    // Validate input if schema provided
    if (tool.inputSchema) {
      const validation = tool.inputSchema.safeParse(params);
      if (!validation.success) {
        const errors = validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
        auditValidationFailed(toolName, context.channel, errors);
        return {
          success: false,
          error: `Validation failed: ${errors.join(', ')}`,
        };
      }
    }

    // Check if approval is required (and not already approved)
    if (this.requiresApproval(toolName) && !context.approvalId) {
      return {
        success: false,
        error: `APPROVAL_REQUIRED:${tool.permissionTier}`,
        data: {
          tool: toolName,
          tier: tool.permissionTier,
          reason: `Action requires ${tool.permissionTier}-level approval`,
        },
      };
    }

    // Execute the tool
    try {
      const result = await tool.execute(params, context);

      // Audit successful execution
      if (this.guardrails.auditAllActions) {
        auditToolExecution(
          toolName,
          tool.permissionTier,
          context.channel,
          params,
          result.success ? 'success' : 'failure',
          result.error,
          {
            executionTimeMs: Date.now() - startTime,
            approvedBy: context.approvedBy,
          }
        );
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      auditToolExecution(
        toolName,
        tool.permissionTier,
        context.channel,
        params,
        'failure',
        errorMessage,
        { executionTimeMs: Date.now() - startTime }
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Check and update rate limit
   */
  private checkRateLimit(toolName: string, limit?: number): boolean {
    // No limit set = unlimited
    if (!limit || limit <= 0) return true;

    const now = new Date();
    const entry = this.rateLimits.get(toolName);

    // Reset if window expired
    if (!entry || entry.resetAt < now) {
      this.rateLimits.set(toolName, {
        count: 1,
        resetAt: new Date(now.getTime() + 60000), // 1 minute window
      });
      return true;
    }

    // Check limit
    if (entry.count >= limit) {
      return false;
    }

    // Increment counter
    entry.count++;
    return true;
  }

  /**
   * Get tool metadata for documentation/display
   */
  getToolInfo(): Array<{
    name: string;
    description: string;
    category: ToolCategory;
    tier: PermissionTier;
    requiresApproval: boolean;
    rateLimit?: number;
  }> {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      category: tool.category,
      tier: tool.permissionTier,
      requiresApproval: this.requiresApproval(tool.name),
      rateLimit: tool.rateLimit,
    }));
  }

  /**
   * Format tools for Claude API (function calling)
   */
  formatForClaude(): Array<{
    name: string;
    description: string;
    input_schema: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  }> {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: this.formatToolDescription(tool),
      input_schema: {
        type: 'object' as const,
        properties: this.formatParameters(tool.parameters),
        required: Object.entries(tool.parameters)
          .filter(([_, param]) => !param.optional)
          .map(([name]) => name),
      },
    }));
  }

  /**
   * Format tool description with security info
   */
  private formatToolDescription(tool: Tool): string {
    const approval = this.requiresApproval(tool.name)
      ? ' [REQUIRES APPROVAL]'
      : '';
    return `${tool.description}${approval}`;
  }

  /**
   * Format parameters for Claude API
   */
  private formatParameters(
    params: Tool['parameters']
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [name, param] of Object.entries(params)) {
      result[name] = {
        type: param.type,
        description: param.description,
        ...(param.enum ? { enum: param.enum } : {}),
        ...(param.default !== undefined ? { default: param.default } : {}),
      };
    }

    return result;
  }

  /**
   * Clear rate limits (for testing)
   */
  clearRateLimits(): void {
    this.rateLimits.clear();
  }
}

// Export singleton instance
export const toolRegistry = new ToolRegistry();
