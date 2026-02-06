/**
 * Core types for Radl Ops
 *
 * Security-first design based on research of OpenClaw, Leon, and OVOS.
 * Key principles:
 * - Permission tiers (not just approval boolean)
 * - Audit logging for all actions
 * - Input validation required
 */

import { z } from 'zod';

// ============================================
// Model Routing (Opus 4.6 Optimizations)
// ============================================

/**
 * Supported Claude model IDs with pricing per 1M tokens.
 * Opus 4.6: Deep reasoning, complex architecture ($5/$25)
 * Sonnet 4.5: Best coding model, orchestration ($3/$15)
 * Haiku 4.5: Fast lightweight tasks, worker agents ($0.80/$4)
 */
export type ModelId =
  | 'claude-opus-4-6'
  | 'claude-sonnet-4-5-20250929'
  | 'claude-haiku-4-5-20251001';

/**
 * Effort level controls reasoning depth.
 * Maps to thinking budget - higher effort = more reasoning tokens.
 */
export type EffortLevel = 'low' | 'medium' | 'high';

/**
 * Model routing configuration for different task types
 */
export interface ModelRoute {
  model: ModelId;
  effort: EffortLevel;
  maxTokens: number;
  /** Cost per 1M input tokens (USD) */
  inputCostPer1M: number;
  /** Cost per 1M output tokens (USD) */
  outputCostPer1M: number;
}

/**
 * Task type determines which model and effort level to use
 */
export type TaskType =
  | 'briefing'        // Routine summaries → haiku/low
  | 'tool_execution'  // Tool calls → sonnet/medium
  | 'conversation'    // General chat → sonnet/medium
  | 'planning'        // Feature planning → sonnet/high
  | 'review'          // Code/content review → sonnet/high
  | 'architecture'    // System design → opus/high
  | 'roadmap';        // Strategic thinking → opus/high

/**
 * Token usage tracking for a single API call
 */
export interface TokenUsage {
  model: ModelId;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  timestamp: Date;
  taskType: TaskType;
  toolName?: string;
}

/**
 * Aggregated cost analytics
 */
export interface CostAnalytics {
  period: 'daily' | 'weekly' | 'monthly';
  startDate: string;
  endDate: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byModel: Record<string, { calls: number; costUsd: number; tokens: number }>;
  byTaskType: Record<string, { calls: number; costUsd: number }>;
}

// ============================================
// Permission System (Based on Security Research)
// ============================================

/**
 * Permission tiers based on OWASP 2025 agent security recommendations.
 * Lower tier = less risk = automatic execution.
 * Higher tier = more risk = requires human approval.
 */
export type PermissionTier =
  | 'read'      // Tier 1: List, get stats, view - automatic
  | 'create'    // Tier 2: Create issues, draft posts - automatic
  | 'modify'    // Tier 3: Update issues, comment - automatic (configurable)
  | 'delete'    // Tier 4: Close issues, delete - requires approval
  | 'external'  // Tier 5: Post to social, send emails - always requires approval
  | 'dangerous'; // Tier 6: Merge PRs, execute code - always requires approval + confirmation

/**
 * Tool category for organization and filtering
 */
export type ToolCategory =
  | 'github'
  | 'slack'
  | 'email'
  | 'social'
  | 'briefing'
  | 'memory'
  | 'system';

// ============================================
// Tool System
// ============================================

/**
 * Tool parameter definition with validation
 */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  optional?: boolean;
  enum?: string[];
  default?: unknown;
}

/**
 * Tool definition with security metadata
 */
export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  permissionTier: PermissionTier;
  parameters: Record<string, ToolParameter>;

  /** Zod schema for runtime validation */
  inputSchema?: z.ZodType;

  /** Execute the tool */
  execute: (params: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;

  /** Rate limit: max calls per minute (0 = unlimited) */
  rateLimit?: number;

  /** Whether this tool can be called in batch with others */
  allowBatch?: boolean;
}

/**
 * Context passed to tool execution
 */
export interface ToolExecutionContext {
  userId?: string;
  channel: 'slack' | 'cli' | 'scheduler' | 'email';
  conversationId: string;
  approvedBy?: string;
  approvalId?: string;
}

/**
 * Result from tool execution
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** For audit logging */
  metadata?: {
    executionTimeMs?: number;
    apiCallsMade?: number;
    cacheHit?: boolean;
  };
}

// ============================================
// Agent System
// ============================================

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: Date;
}

export interface AgentContext {
  conversationId: string;
  userId?: string;
  channel: 'slack' | 'cli' | 'scheduler' | 'email';
  metadata?: Record<string, unknown>;
}

export interface AgentResponse {
  message: string;
  toolCalls?: ToolCall[];
  requiresApproval?: boolean;
  approvalReason?: string;
  /** Permission tier of the highest-risk action */
  highestTier?: PermissionTier;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ============================================
// Approval System
// ============================================

export interface ApprovalRequest {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  permissionTier: PermissionTier;
  reason: string;
  requestedAt: Date;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt: Date;
  respondedAt?: Date;
  respondedBy?: string;
  /** Audit trail */
  requestedFrom: {
    channel: string;
    userId?: string;
    conversationId: string;
  };
}

// ============================================
// Audit System (Critical for Security)
// ============================================

export type AuditAction =
  | 'tool_executed'
  | 'tool_blocked'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_denied'
  | 'approval_expired'
  | 'rate_limited'
  | 'validation_failed'
  | 'agent_started'
  | 'agent_stopped'
  | 'briefing_generated'
  | 'briefing_sent';

export interface AuditEntry {
  id: string;
  timestamp: Date;
  action: AuditAction;
  tool?: string;
  permissionTier?: PermissionTier;
  userId?: string;
  channel: string;
  conversationId?: string;
  params?: Record<string, unknown>;
  result?: 'success' | 'failure' | 'pending';
  error?: string;
  metadata?: Record<string, unknown>;
}

// ============================================
// Memory System (Persistent Context)
// ============================================

export interface MemoryEntry {
  id: string;
  type: 'fact' | 'preference' | 'context' | 'task' | 'reminder';
  content: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  source: {
    channel: string;
    conversationId: string;
  };
  /** Relevance score for retrieval */
  importance: number;
  /** Auto-expire after this date */
  expiresAt?: Date;
}

export interface MemoryQuery {
  types?: MemoryEntry['type'][];
  tags?: string[];
  minImportance?: number;
  limit?: number;
  query?: string;
}

// ============================================
// Scheduler System
// ============================================

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  schedule: string; // cron expression
  enabled: boolean;
  handler: () => Promise<void>;
  lastRun?: Date;
  nextRun?: Date;
  /** Who can enable/disable */
  managedBy?: string[];
}

// ============================================
// Briefing System
// ============================================

export interface Briefing {
  id: string;
  type: 'daily' | 'weekly' | 'adhoc';
  generatedAt: Date;
  sections: BriefingSection[];
  /** Channels to send to */
  distribution: ('slack' | 'email')[];
  status: 'generated' | 'sent' | 'failed';
}

export interface BriefingSection {
  title: string;
  content: string;
  priority: 'high' | 'medium' | 'low';
  actionItems?: string[];
  data?: unknown;
}

// ============================================
// Logging
// ============================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

// ============================================
// Configuration Types
// ============================================

export interface GuardrailConfig {
  /** Tiers that require approval */
  approvalRequiredTiers: PermissionTier[];
  /** Maximum requests per minute across all tools */
  globalRateLimit: number;
  /** Approval request timeout in seconds */
  approvalTimeoutSeconds: number;
  /** Whether to log all tool executions */
  auditAllActions: boolean;
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  approvalRequiredTiers: ['delete', 'external', 'dangerous'],
  globalRateLimit: 100,
  approvalTimeoutSeconds: 300, // 5 minutes
  auditAllActions: true,
};
