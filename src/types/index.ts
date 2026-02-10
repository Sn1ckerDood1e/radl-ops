/**
 * Core types for Radl Ops MCP Server
 */

// ============================================
// Model Routing
// ============================================

export type ModelId =
  | 'claude-opus-4-6'
  | 'claude-sonnet-4-5-20250929'
  | 'claude-haiku-4-5-20251001';

export type EffortLevel = 'low' | 'medium' | 'high';

export interface ModelRoute {
  model: ModelId;
  effort: EffortLevel;
  maxTokens: number;
  inputCostPer1M: number;
  outputCostPer1M: number;
}

export type TaskType =
  | 'briefing'
  | 'tool_execution'
  | 'conversation'
  | 'planning'
  | 'review'
  | 'architecture'
  | 'roadmap';

// ============================================
// Token Tracking
// ============================================

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
// Cost Alerting
// ============================================

export interface CostAlert {
  level: 'ok' | 'warn' | 'critical';
  dailyCost: number;
  threshold: number;
  message: string;
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
