/**
 * Core Agent - The brain of Radl Ops
 *
 * Uses Claude API with tool use to:
 * - Understand requests and context
 * - Decide which tools to use
 * - Execute actions (with approval workflow for sensitive ops)
 * - Generate responses and briefings
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Tool, ToolResult, AgentContext, AgentResponse, ToolCall, ApprovalRequest } from '../types/index.js';
import { toolRegistry } from '../tools/registry.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
});

const SYSTEM_PROMPT = `You are Radl Ops, an autonomous AI assistant helping manage the Radl rowing team management SaaS business.

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

When using tools:
- Chain multiple tool calls when needed to complete a task
- If a tool requires approval, explain why and wait for confirmation
- Always summarize what you did after completing actions

Current date: ${new Date().toISOString().split('T')[0]}
`;

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlock[] | Anthropic.ToolResultBlockParam[];
}

// In-memory conversation storage (could be persisted to Supabase later)
const conversations = new Map<string, ConversationMessage[]>();

// Pending approval requests
const pendingApprovals = new Map<string, ApprovalRequest>();

/**
 * Format tools for Claude API
 */
function formatToolsForClaude(): Anthropic.Tool[] {
  return toolRegistry.getAll().map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      properties: tool.parameters,
      required: Object.keys(tool.parameters).filter(
        key => !(tool.parameters[key] as { optional?: boolean }).optional
      ),
    },
  }));
}

/**
 * Execute a tool call
 */
async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  context: AgentContext
): Promise<ToolResult> {
  const tool = toolRegistry.get(toolName);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  // Check if tool requires approval
  if (tool.requiresApproval) {
    const approvalId = crypto.randomUUID();
    const request: ApprovalRequest = {
      id: approvalId,
      tool: toolName,
      params,
      reason: `Tool ${toolName} requires approval before execution`,
      requestedAt: new Date(),
      status: 'pending',
    };
    pendingApprovals.set(approvalId, request);

    return {
      success: false,
      error: `APPROVAL_REQUIRED:${approvalId}`,
      data: { approvalId, request },
    };
  }

  try {
    logger.info(`Executing tool: ${toolName}`, { params, context });
    const result = await tool.execute(params);
    logger.info(`Tool result: ${toolName}`, { success: result.success });
    return result;
  } catch (error) {
    logger.error(`Tool execution failed: ${toolName}`, { error });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Process a message and generate a response
 */
export async function processMessage(
  message: string,
  context: AgentContext
): Promise<AgentResponse> {
  // Get or create conversation history
  let history = conversations.get(context.conversationId) || [];

  // Add user message
  history.push({ role: 'user', content: message });

  // Call Claude
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: formatToolsForClaude(),
    messages: history.map(m => ({
      role: m.role,
      content: m.content,
    })),
  });

  // Process response
  const toolCalls: ToolCall[] = [];
  let textResponse = '';
  let requiresApproval = false;
  let approvalReason = '';

  for (const block of response.content) {
    if (block.type === 'text') {
      textResponse += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  // Execute tool calls if any
  if (toolCalls.length > 0 && response.stop_reason === 'tool_use') {
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const call of toolCalls) {
      const result = await executeTool(call.name, call.input, context);

      // Check for approval requirement
      if (result.error?.startsWith('APPROVAL_REQUIRED:')) {
        requiresApproval = true;
        approvalReason = `Action "${call.name}" requires your approval before proceeding.`;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify({
            status: 'pending_approval',
            message: 'This action requires approval. Please approve or reject.',
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

    // Get follow-up response
    const followUp = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: formatToolsForClaude(),
      messages: history.map(m => ({
        role: m.role,
        content: m.content,
      })),
    });

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

  // Save conversation
  conversations.set(context.conversationId, history);

  return {
    message: textResponse,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    requiresApproval,
    approvalReason: requiresApproval ? approvalReason : undefined,
  };
}

/**
 * Approve a pending action
 */
export async function approveAction(approvalId: string, approvedBy: string): Promise<ToolResult> {
  const request = pendingApprovals.get(approvalId);
  if (!request) {
    return { success: false, error: 'Approval request not found' };
  }

  if (request.status !== 'pending') {
    return { success: false, error: `Request already ${request.status}` };
  }

  // Update status
  request.status = 'approved';
  request.respondedAt = new Date();
  request.respondedBy = approvedBy;

  // Execute the tool
  const tool = toolRegistry.get(request.tool);
  if (!tool) {
    return { success: false, error: 'Tool not found' };
  }

  try {
    const result = await tool.execute(request.params);
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
    return { success: false, error: 'Approval request not found' };
  }

  request.status = 'rejected';
  request.respondedAt = new Date();
  request.respondedBy = rejectedBy;
  pendingApprovals.delete(approvalId);

  return { success: true, data: { message: 'Action rejected' } };
}

/**
 * Get pending approvals
 */
export function getPendingApprovals(): ApprovalRequest[] {
  return Array.from(pendingApprovals.values());
}

/**
 * Clear conversation history
 */
export function clearConversation(conversationId: string): void {
  conversations.delete(conversationId);
}
