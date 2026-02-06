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
 */

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
} from '../types/index.js';
import { toolRegistry } from '../tools/registry.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { audit, auditApprovalRequested, auditApprovalResponse } from '../audit/index.js';
import { recall, remember, getRelevantContext } from '../memory/index.js';
import { getRoute, detectTaskType, trackUsage } from '../models/index.js';
import { checkIronLaws, recordError, clearError, getErrorCount } from '../guardrails/index.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
});

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

  // Add relevant memories if available
  const memories = getRelevantContext('', 5);
  if (memories) {
    return basePrompt + '\n\n' + memories;
  }

  return basePrompt;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlock[] | Anthropic.ToolResultBlockParam[];
}

// In-memory conversation storage
const conversations = new Map<string, ConversationMessage[]>();

// Pending approval requests with expiration
const pendingApprovals = new Map<string, ApprovalRequest>();

// Approval timeout (5 minutes)
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Clean up expired approvals
 */
function cleanupExpiredApprovals(): void {
  const now = new Date();
  for (const [id, request] of pendingApprovals) {
    if (request.expiresAt < now && request.status === 'pending') {
      request.status = 'expired';
      audit('approval_expired', {
        tool: request.tool,
        channel: request.requestedFrom.channel,
        result: 'failure',
      });
      pendingApprovals.delete(id);
    }
  }
}

/**
 * Execute a tool with security checks
 */
async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  context: AgentContext,
  approvalId?: string
): Promise<ToolResult> {
  // Check iron laws before execution
  const lawCheck = checkIronLaws({
    action: 'tool_execution',
    toolName,
    params,
  });

  if (!lawCheck.passed) {
    const violations = lawCheck.violations
      .filter(v => v.severity === 'block')
      .map(v => v.message)
      .join('; ');
    logger.warn('Iron law blocked tool execution', { toolName, violations });
    return {
      success: false,
      error: `IRON LAW VIOLATION: ${violations}`,
    };
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
 * Handle approval requirement
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

  // Audit the approval request
  auditApprovalRequested(
    toolName,
    tier,
    context.channel ?? 'unknown',
    context.conversationId,
    params
  );

  return request;
}

/**
 * Process a message and generate a response.
 * Uses model routing to select the optimal model per task type.
 * Tracks token usage for cost analytics.
 */
export async function processMessage(
  message: string,
  context: AgentContext
): Promise<AgentResponse> {
  // Clean up expired approvals
  cleanupExpiredApprovals();

  // Log agent activity
  audit('agent_started', {
    channel: context.channel ?? 'unknown',
    conversationId: context.conversationId,
    userId: context.userId,
    result: 'success',
  });

  // Detect task type and get model route
  const taskType: TaskType = (context.metadata?.taskType as TaskType) ?? detectTaskType(message);
  const route = getRoute(taskType);

  logger.info('Model route selected', {
    taskType,
    model: route.model,
    effort: route.effort,
    maxTokens: route.maxTokens,
  });

  // Get or create conversation history
  let history = conversations.get(context.conversationId) || [];

  // Add user message
  history.push({ role: 'user', content: message });

  // Build system prompt with context
  const systemPrompt = buildSystemPrompt(context);

  // Call Claude with routed model
  const response = await anthropic.messages.create({
    model: route.model,
    max_tokens: route.maxTokens,
    system: systemPrompt,
    tools: toolRegistry.formatForClaude(),
    messages: history.map(m => ({
      role: m.role,
      content: m.content,
    })),
  });

  // Track token usage
  trackUsage(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    taskType,
    undefined,
    (response.usage as unknown as Record<string, number>).cache_read_input_tokens,
    (response.usage as unknown as Record<string, number>).cache_creation_input_tokens
  );

  // Process response
  const toolCalls: ToolCall[] = [];
  let textResponse = '';
  let requiresApproval = false;
  let approvalReason = '';
  let highestTier: PermissionTier = 'read';

  for (const block of response.content) {
    if (block.type === 'text') {
      textResponse += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });

      // Track highest permission tier
      const tool = toolRegistry.get(block.name);
      if (tool) {
        const tierOrder: PermissionTier[] = ['read', 'create', 'modify', 'delete', 'external', 'dangerous'];
        if (tierOrder.indexOf(tool.permissionTier) > tierOrder.indexOf(highestTier)) {
          highestTier = tool.permissionTier;
        }
      }
    }
  }

  // Execute tool calls if any
  if (toolCalls.length > 0 && response.stop_reason === 'tool_use') {
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const call of toolCalls) {
      // Check 3-strike rule before executing
      const errorKey = `${call.name}:${JSON.stringify(call.input).substring(0, 100)}`;
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

      // Check for approval requirement
      if (result.error?.startsWith('APPROVAL_REQUIRED:')) {
        const tier = result.error.split(':')[1] as PermissionTier;
        const approvalRequest = createApprovalRequest(call.name, call.input, tier, context);

        requiresApproval = true;
        approvalReason = `Action "${call.name}" requires ${tier}-level approval before proceeding. Approval ID: ${approvalRequest.id}`;

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

    // Add assistant response with tool calls to history
    history.push({ role: 'assistant', content: response.content });

    // Add tool results and get final response
    history.push({ role: 'user', content: toolResults });

    // Follow-up uses tool_execution route (may differ from initial)
    const followUpRoute = getRoute('tool_execution');

    const followUp = await anthropic.messages.create({
      model: followUpRoute.model,
      max_tokens: followUpRoute.maxTokens,
      system: systemPrompt,
      tools: toolRegistry.formatForClaude(),
      messages: history.map(m => ({
        role: m.role,
        content: m.content,
      })),
    });

    // Track follow-up token usage
    trackUsage(
      followUpRoute.model,
      followUp.usage.input_tokens,
      followUp.usage.output_tokens,
      'tool_execution',
      toolCalls.map(c => c.name).join(','),
      (followUp.usage as unknown as Record<string, number>).cache_read_input_tokens,
      (followUp.usage as unknown as Record<string, number>).cache_creation_input_tokens
    );

    // Extract text from follow-up
    for (const block of followUp.content) {
      if (block.type === 'text') {
        textResponse = block.text;
      }
    }

    // Add follow-up to history
    history.push({ role: 'assistant', content: followUp.content });
  } else {
    // No tool calls, just add response to history
    history.push({ role: 'assistant', content: response.content });
  }

  // Save conversation (limit history length to prevent memory bloat)
  if (history.length > 50) {
    history = history.slice(-40);
  }
  conversations.set(context.conversationId, history);

  return {
    message: textResponse,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    requiresApproval,
    approvalReason: requiresApproval ? approvalReason : undefined,
    highestTier,
  };
}

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

  // Check expiration
  if (request.expiresAt < new Date()) {
    request.status = 'expired';
    pendingApprovals.delete(approvalId);
    return { success: false, error: 'Approval request expired' };
  }

  // Update status
  request.status = 'approved';
  request.respondedAt = new Date();
  request.respondedBy = approvedBy;

  // Audit the approval
  auditApprovalResponse(
    request.tool,
    true,
    approvedBy,
    request.requestedFrom.channel
  );

  // Execute the tool with approval context
  const execContext: ToolExecutionContext = {
    userId: request.requestedFrom.userId,
    channel: request.requestedFrom.channel as 'slack' | 'cli' | 'scheduler' | 'email',
    conversationId: request.requestedFrom.conversationId,
    approvalId,
    approvedBy,
  };

  try {
    const tool = toolRegistry.get(request.tool);
    if (!tool) {
      return { success: false, error: 'Tool not found' };
    }

    const result = await tool.execute(request.params, execContext);
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

  request.status = 'rejected';
  request.respondedAt = new Date();
  request.respondedBy = rejectedBy;

  // Audit the rejection
  auditApprovalResponse(
    request.tool,
    false,
    rejectedBy,
    request.requestedFrom.channel
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
