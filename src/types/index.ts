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
  | 'roadmap'
  | 'spot_check'
  | 'social_generation';

// ============================================
// Model Gateway
// ============================================

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  model: ModelId;
  maxTokens: number;
  messages: ChatMessage[];
  system?: string;
}

export interface ChatResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface ModelGateway {
  name: string;
  chat(params: ChatParams): Promise<ChatResponse>;
}

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
  sprintPhase?: string;
}

export interface CostAnalytics {
  period: 'daily' | 'weekly' | 'monthly';
  startDate: string;
  endDate: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  estimatedCacheSavingsUsd: number;
  byModel: Record<string, { calls: number; costUsd: number; tokens: number }>;
  byTaskType: Record<string, { calls: number; costUsd: number }>;
  bySprint: Record<string, { calls: number; costUsd: number }>;
  byTool: Record<string, { calls: number; costUsd: number; avgCostUsd: number }>;
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

// ============================================
// Team Recipes
// ============================================

// ============================================
// Team Performance Memory
// ============================================

export interface TeamRun {
  id: number;
  sprintPhase: string;
  recipe: string;
  teammateCount: number;
  model: string;
  duration: string;
  findingsCount?: number;
  tasksCompleted?: number;
  outcome: 'success' | 'partial' | 'failed';
  lessonsLearned?: string;
  date: string;
}

export interface TeamRunStore {
  runs: TeamRun[];
}

export interface TeamRecipe {
  teamName: string;
  teammates: Array<{
    name: string;
    subagentType: string;
    model: 'haiku' | 'sonnet' | 'opus';
    taskDescription: string;
    fileOwnership?: string[];
  }>;
  setupSteps: string[];
  cleanupSteps: string[];
  tips: string[];
}
