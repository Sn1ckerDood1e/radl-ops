/**
 * Core types for Radl Ops
 */

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresApproval?: boolean;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentContext {
  conversationId: string;
  userId?: string;
  channel?: 'slack' | 'cli' | 'scheduler' | 'email';
  metadata?: Record<string, unknown>;
}

export interface AgentResponse {
  message: string;
  toolCalls?: ToolCall[];
  requiresApproval?: boolean;
  approvalReason?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  schedule: string; // cron expression
  enabled: boolean;
  handler: () => Promise<void>;
  lastRun?: Date;
  nextRun?: Date;
}

export interface Briefing {
  type: 'daily' | 'weekly';
  generatedAt: Date;
  sections: BriefingSection[];
}

export interface BriefingSection {
  title: string;
  content: string;
  priority: 'high' | 'medium' | 'low';
  actionItems?: string[];
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  reason: string;
  requestedAt: Date;
  status: 'pending' | 'approved' | 'rejected';
  respondedAt?: Date;
  respondedBy?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}
