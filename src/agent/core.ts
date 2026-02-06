/**
 * Core Agent - The brain of Radl Ops
 *
 * Security-first design based on research of OpenClaw and industry best practices.
 *
 * Features:
 * - Permission tier enforcement
 * - Audit logging for all actions
 * - Memory integration for context
 * - Approval workflow for sensitive operations
 * - Auto-dispatch to optimal execution strategy
 * - Iron law enforcement with context enrichment
 * - 3-strike error escalation with deterministic keys
 */

import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type {
  Tool,
  ToolResult,
  AgentContext,
  AgentResponse,
  ToolCall,
  ApprovalRequest,
  PermissionTier,
  ToolExecutionContext,
  TaskType,
  ModelId,
} from '../types/index.js';
import { toolRegistry } from '../tools/registry.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { audit, auditApprovalRequested, auditApprovalResponse } from '../audit/index.js';
import { recall, remember, getRelevantContext } from '../memory/index.js';
import { getRoute, detectTaskType, trackUsage } from '../models/index.js';
import { checkIronLaws, recordError, clearError, getErrorCount } from '../guardrails/index.js';
import { dispatch } from '../patterns/index.js';

// ============================================
// Named Constants (no magic numbers)
// ============================================

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONVERSATION_HISTORY = 50;
const CONVERSATION_TRIM_TARGET = 40;
const MAX_CONVERSATIONS = 100;
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_MEMORY_CONTEXT_ITEMS = 5;

// ============================================
// Anthropic Client
// ============================================

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
});

// ============================================
// Conversation Management (with TTL + max size)
// ============================================

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlock[] | Anthropic.ToolResultBlockParam[];
}

interface ConversationEntry {
  messages: ConversationMessage[];
  lastAccessedAt: number;
}

const conversations = new Map<string, ConversationEntry>();

/**
 * Clean up expired and excess conversations to prevent memory leaks.
 */
function cleanupConversations(): void {
  const now = Date.now();

  // Remove expired entries
  for (const [id, entry] of conversations) {
    if (now - entry.lastAccessedAt > CONVERSATION_TTL_MS) {
      conversations.delete(id);
    }
  }

  // Enforce max size by removing oldest entries
  if (conversations.size > MAX_CONVERSATIONS) {
    const sorted = Array.from(conversations.entries())
      .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
    const toRemove = sorted.slice(0, sorted.length - MAX_CONVERSATIONS);
    for (const [id] of toRemove) {
      conversations.delete(id);
    }
  }
}

/**
 * Get conversation history, creating a new entry if needed.
 */
function getConversation(conversationId: string): ConversationMessage[] {
  const entry = conversations.get(conversationId);
  if (entry) {
    return entry.messages;
  }
  return [];
}

/**
 * Save conversation history with trimming.
 */
function saveConversation(conversationId: string, messages: ConversationMessage[]): void {
  const trimmed = messages.length > MAX_CONVERSATION_HISTORY
    ? messages.slice(-CONVERSATION_TRIM_TARGET)
    : messages;

  conversations.set(conversationId, {
    messages: trimmed,
    lastAccessedAt: Date.now(),
  });
}

// ============================================
// Approval Management
// ============================================

const pendingApprovals = new Map<string, ApprovalRequest>();

/**
 * Clean up expired approvals
 */
function cleanupExpiredApprovals(): void {
  const now = new Date();
  for (const [id, request] of pendingApprovals) {
    if (request.expiresAt < now && request.status === 'pending') {
      const expired: ApprovalRequest = { ...request, status: 'expired' };
      audit('approval_expired', {
        tool: expired.tool,
        channel: expired.requestedFrom.channel,
        result: 'failure',
      });
      pendingApprovals.delete(id);
    }
  }
}

/**
 * Create an approval request for a sensitive tool operation.
 */
function createApprovalRequest(
  toolName: string,
  params: Record<string, unknown>,
  tier: PermissionTier,
  context: AgentContext
): ApprovalRequest {
  const approvalId = crypto.randomUUID();
  const now = new Date();

  const request: ApprovalRequest = {
    id: approvalId,
    tool: toolName,
    params,
    permissionTier: tier,
    reason: `Tool "${toolName}" requires ${tier}-level approval before execution`,
    requestedAt: now,
    expiresAt: new Date(now.getTime() + APPROVAL_TIMEOUT_MS),
    status: 'pending',
    requestedFrom: {
      channel: context.channel ?? 'unknown',
      userId: context.userId,
      conversationId: context.conversationId,
    },
  };

  pendingApprovals.set(approvalId, request);

  auditApprovalRequested(
    toolName,
    tier,
    context.channel ?? 'unknown',
    context.conversationId,
    params
  );

  return request;
}

// ============================================
// Iron Law Context Enrichment
// ============================================

/** Tools that perform git operations */
const GIT_TOOLS = new Set([
  'git_push', 'git_commit', 'git_merge', 'git_rebase',
  'github_merge_pr', 'github_create_pr',
]);

/** Tools that write files */
const FILE_WRITE_TOOLS = new Set([
  'file_write', 'file_edit', 'file_create',
  'github_create_file', 'github_push_files',
]);

/**
 * Build enriched iron law check context from tool name and params.
 * Extracts git branch, target file, and force flags from tool parameters.
 */
function buildIronLawContext(
  toolName: string,
  params: Record<string, unknown>
): {
  action: string;
  toolName: string;
  params: Record<string, unknown>;
  targetFile?: string;
  gitBranch?: string;
} {
  const context: {
    action: string;
    toolName: string;
    params: Record<string, unknown>;
    targetFile?: string;
    gitBranch?: string;
  } = {
    action: GIT_TOOLS.has(toolName)
      ? 'git_push'
      : FILE_WRITE_TOOLS.has(toolName)
        ? 'file_write'
        : 'tool_execution',
    toolName,
    params,
  };

  // Extract git branch from various param shapes
  if (typeof params.branch === 'string') {
    context.gitBranch = params.branch;
  } else if (typeof params.ref === 'string') {
    context.gitBranch = params.ref;
  } else if (typeof params.base === 'string') {
    context.gitBranch = params.base;
  }

  // Extract target file from various param shapes
  if (typeof params.path === 'string') {
    context.targetFile = params.path;
  } else if (typeof params.file === 'string') {
    context.targetFile = params.file;
  } else if (typeof params.filePath === 'string') {
    context.targetFile = params.filePath;
  } else if (typeof params.targetFile === 'string') {
    context.targetFile = params.targetFile;
  }

  // Detect force push
  if (params.force === true || params.forceWithLease === true) {
    context.params = { ...params, force: true };
  }

  return context;
}

// ============================================
// Deterministic Error Key
// ============================================

/**
 * Build a deterministic error key from tool name and input.
 * Uses sorted keys + SHA-256 hash to avoid non-deterministic JSON.stringify.
 */
function buildErrorKey(toolName: string, input: Record<string, unknown>): string {
  const sortedKeys = Object.keys(input).sort();
  const stableEntries = sortedKeys
    .map(k => `${k}:${String(input[k])}`)
    .join('|');
  const hash = createHash('sha256')
    .update(stableEntries)
    .digest('hex')
    .substring(0, 12);
  return `${toolName}:${hash}`;
}

// ============================================
// System Prompt
// ============================================

/**
 * Build system prompt with relevant context
 */
function buildSystemPrompt(context: AgentContext): string {
  const basePrompt = `You are Radl Ops, an autonomous AI assistant helping manage the Radl rowing team management SaaS business.

Your responsibilities:
1. **Feature Planning & Roadmap** - Help brainstorm, prioritize, and plan new features for the Radl app
2. **Code Assistance** - Help with implementation, create GitHub issues/PRs, review code
3. **Social Media** - Draft and schedule posts for Twitter/LinkedIn, monitor engagement
4. **Briefings** - Generate daily/weekly summaries of business metrics and tasks
5. **General Operations** - Answer questions, provide insights, help with decisions

Guidelines:
- Be proactive: suggest improvements, flag issues, anticipate needs
- Be concise: busy founder, get to the point
- Be autonomous: take action when confident, ask for approval when uncertain
- Be transparent: explain your reasoning, admit uncertainty
- Stay in scope: you manage Radl business ops, not personal tasks

Tool Usage:
- Tools marked [REQUIRES APPROVAL] need human confirmation before execution
- Chain multiple tool calls when needed to complete a task
- Always summarize what you did after completing actions

Security Notes:
- Never expose API keys, tokens, or credentials in responses
- Always validate user requests before executing sensitive actions
- Log all actions for audit purposes

Current date: ${new Date().toISOString().split('T')[0]}
Channel: ${context.channel}
`;

  const memories = getRelevantContext('', MAX_MEMORY_CONTEXT_ITEMS);
  if (memories) {
    return basePrompt + '\n\n' + memories;
  }

  return basePrompt;
}

// ============================================
// Response Parsing
// ============================================

interface ParsedResponse {
  textResponse: string;
  toolCalls: ToolCall[];
  highestTier: PermissionTier;
}

/**
 * Parse Claude response into text, tool calls, and permission tier.
 */
function parseResponse(content: Anthropic.ContentBlock[]): ParsedResponse {
  const tierOrder: PermissionTier[] = ['read', 'create', 'modify', 'delete', 'external', 'dangerous'];
  let textResponse = '';
  const toolCalls: ToolCall[] = [];
  let highestTier: PermissionTier = 'read';

  for (const block of content) {
    if (block.type === 'text') {
      textResponse += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });

      const tool = toolRegistry.get(block.name);
      if (tool && tierOrder.indexOf(tool.permissionTier) > tierOrder.indexOf(highestTier)) {
        highestTier = tool.permissionTier;
      }
    }
  }

  return { textResponse, toolCalls, highestTier };
}

// ============================================
// Tool Execution
// ============================================

/**
 * Execute a tool with iron law enforcement and context enrichment.
 */
async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  context: AgentContext,
  approvalId?: string
): Promise<ToolResult> {
  // Build enriched iron law context
  const lawContext = buildIronLawContext(toolName, params);
  const lawCheck = checkIronLaws(lawContext);

  if (!lawCheck.passed) {
    const violations = lawCheck.violations
      .filter(v => v.severity === 'block')
      .map(v => v.message)
      .join('; ');
    logger.warn('Iron law blocked tool execution', { toolName, violations });
    return { success: false, error: `IRON LAW VIOLATION: ${violations}` };
  }

  const execContext: ToolExecutionContext = {
    userId: context.userId,
    channel: context.channel ?? 'cli',
    conversationId: context.conversationId,
    approvalId,
    approvedBy: approvalId ? pendingApprovals.get(approvalId)?.respondedBy : undefined,
  };

  return toolRegistry.execute(toolName, params, execContext);
}

/**
 * Execute all pending tool calls with 3-strike enforcement.
 * Returns tool results for the follow-up message.
 */
async function executeToolCalls(
  toolCalls: ToolCall[],
  context: AgentContext
): Promise<{
  toolResults: Anthropic.ToolResultBlockParam[];
  requiresApproval: boolean;
  approvalReason: string;
}> {
  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  let requiresApproval = false;
  let approvalReason = '';

  for (const call of toolCalls) {
    // 3-strike check with deterministic key
    const errorKey = buildErrorKey(call.name, call.input);
    const strikeCheck = checkIronLaws({
      action: 'tool_execution',
      toolName: call.name,
      params: call.input,
      errorCount: getErrorCount(errorKey),
    });

    if (!strikeCheck.passed) {
      const msg = strikeCheck.violations.map(v => v.message).join('; ');
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify({ success: false, error: msg }),
      });
      continue;
    }

    const result = await executeTool(call.name, call.input, context);

    // Track errors for 3-strike rule
    if (!result.success && result.error) {
      recordError(errorKey);
    } else if (result.success) {
      clearError(errorKey);
    }

    // Handle approval requirement
    if (result.error?.startsWith('APPROVAL_REQUIRED:')) {
      const tier = result.error.split(':')[1] as PermissionTier;
      const approvalRequest = createApprovalRequest(call.name, call.input, tier, context);

      requiresApproval = true;
      approvalReason = `Action "${call.name}" requires ${tier}-level approval. Approval ID: ${approvalRequest.id}`;

      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify({
          status: 'pending_approval',
          approvalId: approvalRequest.id,
          tier,
          message: 'This action requires approval. Please approve or reject.',
          expiresAt: approvalRequest.expiresAt.toISOString(),
        }),
      });
    } else {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { toolResults, requiresApproval, approvalReason };
}

// ============================================
// Token Usage Tracking
// ============================================

/**
 * Track token usage from an API response.
 */
function trackResponseUsage(
  response: Anthropic.Message,
  model: ModelId,
  taskType: TaskType,
  toolName?: string
): void {
  const usage = response.usage as unknown as Record<string, number>;
  trackUsage(
    model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    taskType,
    toolName,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens
  );
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Process a message and generate a response.
 * Uses auto-dispatch for strategy selection and model routing per task type.
 */
export async function processMessage(
  message: string,
  context: AgentContext
): Promise<AgentResponse> {
  cleanupExpiredApprovals();
  cleanupConversations();

  audit('agent_started', {
    channel: context.channel ?? 'unknown',
    conversationId: context.conversationId,
    userId: context.userId,
    result: 'success',
  });

  // Auto-dispatch to determine strategy and task type
  const decision = dispatch(message);
  const taskType: TaskType = (context.metadata?.taskType as TaskType) ?? decision.taskType;
  const route = getRoute(taskType);

  logger.info('Dispatch decision', {
    strategy: decision.strategy,
    taskType,
    model: route.model,
    reasoning: decision.reasoning,
  });

  // Get conversation history and add user message
  const history = [...getConversation(context.conversationId)];
  history.push({ role: 'user', content: message });

  const systemPrompt = buildSystemPrompt(context);

  // Initial API call
  const response = await anthropic.messages.create({
    model: route.model,
    max_tokens: route.maxTokens,
    system: systemPrompt,
    tools: toolRegistry.formatForClaude(),
    messages: history.map(m => ({ role: m.role, content: m.content })),
  });

  trackResponseUsage(response, route.model, taskType);

  const { textResponse: initialText, toolCalls, highestTier } = parseResponse(response.content);
  let textResponse = initialText;
  let requiresApproval = false;
  let approvalReason: string | undefined;

  // Execute tool calls if model requested them
  if (toolCalls.length > 0 && response.stop_reason === 'tool_use') {
    history.push({ role: 'assistant', content: response.content });

    const execResult = await executeToolCalls(toolCalls, context);
    requiresApproval = execResult.requiresApproval;
    approvalReason = execResult.requiresApproval ? execResult.approvalReason : undefined;

    history.push({ role: 'user', content: execResult.toolResults });

    // Follow-up call for tool results
    const followUpRoute = getRoute('tool_execution');
    const followUp = await anthropic.messages.create({
      model: followUpRoute.model,
      max_tokens: followUpRoute.maxTokens,
      system: systemPrompt,
      tools: toolRegistry.formatForClaude(),
      messages: history.map(m => ({ role: m.role, content: m.content })),
    });

    trackResponseUsage(followUp, followUpRoute.model, 'tool_execution', toolCalls.map(c => c.name).join(','));

    // Extract text from follow-up
    for (const block of followUp.content) {
      if (block.type === 'text') {
        textResponse = block.text;
      }
    }

    history.push({ role: 'assistant', content: followUp.content });
  } else {
    history.push({ role: 'assistant', content: response.content });
  }

  saveConversation(context.conversationId, history);

  return {
    message: textResponse,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    requiresApproval,
    approvalReason,
    highestTier,
  };
}

// ============================================
// Approval Handlers
// ============================================

/**
 * Approve a pending action
 */
export async function approveAction(
  approvalId: string,
  approvedBy: string
): Promise<ToolResult> {
  const request = pendingApprovals.get(approvalId);
  if (!request) {
    return { success: false, error: 'Approval request not found or expired' };
  }

  if (request.status !== 'pending') {
    return { success: false, error: `Request already ${request.status}` };
  }

  if (request.expiresAt < new Date()) {
    pendingApprovals.delete(approvalId);
    return { success: false, error: 'Approval request expired' };
  }

  const approved: ApprovalRequest = {
    ...request,
    status: 'approved',
    respondedAt: new Date(),
    respondedBy: approvedBy,
  };
  pendingApprovals.set(approvalId, approved);

  auditApprovalResponse(
    approved.tool,
    true,
    approvedBy,
    approved.requestedFrom.channel
  );

  const execContext: ToolExecutionContext = {
    userId: approved.requestedFrom.userId,
    channel: approved.requestedFrom.channel as 'slack' | 'cli' | 'scheduler' | 'email',
    conversationId: approved.requestedFrom.conversationId,
    approvalId,
    approvedBy,
  };

  try {
    const tool = toolRegistry.get(approved.tool);
    if (!tool) {
      return { success: false, error: 'Tool not found' };
    }

    const result = await tool.execute(approved.params, execContext);
    pendingApprovals.delete(approvalId);
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Execution failed',
    };
  }
}

/**
 * Reject a pending action
 */
export function rejectAction(approvalId: string, rejectedBy: string): ToolResult {
  const request = pendingApprovals.get(approvalId);
  if (!request) {
    return { success: false, error: 'Approval request not found or expired' };
  }

  if (request.status !== 'pending') {
    return { success: false, error: `Request already ${request.status}` };
  }

  const rejected: ApprovalRequest = {
    ...request,
    status: 'rejected',
    respondedAt: new Date(),
    respondedBy: rejectedBy,
  };

  auditApprovalResponse(
    rejected.tool,
    false,
    rejectedBy,
    rejected.requestedFrom.channel
  );

  pendingApprovals.delete(approvalId);

  return { success: true, data: { message: 'Action rejected' } };
}

/**
 * Get pending approvals
 */
export function getPendingApprovals(): ApprovalRequest[] {
  cleanupExpiredApprovals();
  return Array.from(pendingApprovals.values()).filter(r => r.status === 'pending');
}

// ============================================
// Utility Exports
// ============================================

/**
 * Clear conversation history
 */
export function clearConversation(conversationId: string): void {
  conversations.delete(conversationId);
}

/**
 * Save a memory from the conversation
 */
export function saveToMemory(
  type: 'fact' | 'preference' | 'context' | 'task' | 'reminder',
  content: string,
  context: AgentContext,
  options?: {
    tags?: string[];
    importance?: number;
    expiresInDays?: number;
  }
): void {
  remember(type, content, {
    tags: options?.tags || [],
    importance: options?.importance ?? 5,
    expiresInDays: options?.expiresInDays,
    source: {
      channel: context.channel ?? 'unknown',
      conversationId: context.conversationId,
    },
  });
}
