/**
 * CLI Interface - Interactive command-line interface for Radl Ops
 */

import * as readline from 'readline';
import { processMessage, clearConversation, getPendingApprovals, approveAction, rejectAction } from '../agent/core.js';
import { runTaskNow, getTasks } from '../scheduler/index.js';
import { toolRegistry } from '../tools/registry.js';
import type { AgentContext } from '../types/index.js';
import { getTodaySummary, getAllRoutes } from '../models/index.js';

const WELCOME_MESSAGE = `
╔══════════════════════════════════════════════════════════════╗
║                      🚣 RADL OPS 🚣                          ║
║        Your AI Assistant for Managing the Radl Business       ║
╚══════════════════════════════════════════════════════════════╝

Commands:
  /help       - Show this help message
  /tools      - List available tools
  /tasks      - List scheduled tasks
  /run <id>   - Run a scheduled task immediately
  /pending    - Show pending approvals
  /approve    - Approve the latest pending action
  /reject     - Reject the latest pending action
  /costs      - Show today's API costs and token usage
  /routes     - Show model routing configuration
  /clear      - Clear conversation history
  /exit       - Exit the CLI

Type your message to chat with Radl Ops.
`;

const conversationId = `cli-${Date.now()}`;

const context: AgentContext = {
  conversationId,
  channel: 'cli',
};

/**
 * Handle CLI commands
 */
async function handleCommand(input: string): Promise<string | null> {
  const [cmd, ...args] = input.trim().split(' ');

  switch (cmd.toLowerCase()) {
    case '/help':
      return WELCOME_MESSAGE;

    case '/tools':
      const tools = toolRegistry.getToolInfo();
      const toolList = tools.map(t => {
        const approval = t.requiresApproval ? ' [requires approval]' : '';
        return `  • ${t.name} (${t.tier})${approval}\n    ${t.description}`;
      }).join('\n\n');
      return `Available tools (${tools.length}):\n\n${toolList}`;

    case '/tasks':
      const tasks = getTasks();
      if (tasks.length === 0) {
        return 'No scheduled tasks registered.';
      }
      const taskList = tasks.map(t => {
        const status = t.enabled ? '✅' : '⏸️';
        const lastRun = t.lastRun ? t.lastRun.toISOString() : 'never';
        const nextRun = t.nextRun ? t.nextRun.toISOString() : 'not scheduled';
        return `  ${status} ${t.id}\n     ${t.name} - ${t.description}\n     Schedule: ${t.schedule}\n     Last run: ${lastRun}\n     Next run: ${nextRun}`;
      }).join('\n\n');
      return `Scheduled tasks:\n\n${taskList}`;

    case '/run':
      if (!args[0]) {
        return 'Usage: /run <task-id>';
      }
      try {
        await runTaskNow(args[0]);
        return `Task "${args[0]}" executed.`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }

    case '/pending':
      const pending = getPendingApprovals();
      if (pending.length === 0) {
        return 'No pending approvals.';
      }
      const pendingList = pending.map(p => {
        return `  • ID: ${p.id}\n    Tool: ${p.tool}\n    Reason: ${p.reason}\n    Requested: ${p.requestedAt.toISOString()}\n    Params: ${JSON.stringify(p.params, null, 2)}`;
      }).join('\n\n');
      return `Pending approvals (${pending.length}):\n\n${pendingList}`;

    case '/approve':
      const pendingToApprove = getPendingApprovals();
      if (pendingToApprove.length === 0) {
        return 'No pending approvals.';
      }
      const latestApproval = pendingToApprove[pendingToApprove.length - 1];
      const approveResult = await approveAction(latestApproval.id, 'cli-user');
      if (approveResult.success) {
        return `✅ Action approved and executed.\n${JSON.stringify(approveResult.data, null, 2)}`;
      }
      return `❌ Error: ${approveResult.error}`;

    case '/reject':
      const pendingToReject = getPendingApprovals();
      if (pendingToReject.length === 0) {
        return 'No pending approvals.';
      }
      const latestRejection = pendingToReject[pendingToReject.length - 1];
      const rejectResult = rejectAction(latestRejection.id, 'cli-user');
      if (rejectResult.success) {
        return '❌ Action rejected.';
      }
      return `Error: ${rejectResult.error}`;

    case '/costs': {
      const summary = getTodaySummary();
      if (summary.totalCostUsd === 0) {
        return 'No API usage recorded today.';
      }
      const modelLines = Object.entries(summary.byModel).map(([model, data]) => {
        const name = model.split('-').slice(1, 2)[0];
        return `  ${name}: ${data.calls} calls, ${data.tokens.toLocaleString()} tokens, $${data.costUsd.toFixed(4)}`;
      });
      const taskLines = Object.entries(summary.byTaskType).map(([task, data]) => {
        return `  ${task}: ${data.calls} calls, $${data.costUsd.toFixed(4)}`;
      });
      return [
        `API Costs Today (${summary.startDate})`,
        `Total: $${summary.totalCostUsd.toFixed(4)}`,
        `Tokens: ${(summary.totalInputTokens + summary.totalOutputTokens).toLocaleString()}`,
        '',
        'By Model:',
        ...modelLines,
        '',
        'By Task:',
        ...taskLines,
      ].join('\n');
    }

    case '/routes': {
      const routes = getAllRoutes();
      const routeLines = Object.entries(routes).map(([task, route]) => {
        const modelName = route.model.split('-').slice(1, 2)[0];
        return `  ${task}: ${modelName} (effort: ${route.effort}, max: ${route.maxTokens})`;
      });
      return ['Model Routing:', ...routeLines].join('\n');
    }

    case '/clear':
      clearConversation(conversationId);
      return 'Conversation history cleared.';

    case '/exit':
    case '/quit':
      console.log('\nGoodbye! 👋\n');
      process.exit(0);

    default:
      return null; // Not a command
  }
}

/**
 * Start the CLI
 */
export async function startCli(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(WELCOME_MESSAGE);

  const prompt = () => {
    rl.question('\n> ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // Check if it's a command
      if (trimmed.startsWith('/')) {
        const result = await handleCommand(trimmed);
        if (result) {
          console.log(`\n${result}`);
        } else {
          console.log(`\nUnknown command: ${trimmed.split(' ')[0]}`);
        }
        prompt();
        return;
      }

      // Process as chat message
      console.log('\n🤔 Thinking...');

      try {
        const response = await processMessage(trimmed, context);

        if (response.requiresApproval) {
          console.log(`\n${response.message}`);
          console.log(`\n⚠️  ${response.approvalReason}`);
          console.log('\nUse /approve or /reject to respond.');
        } else {
          console.log(`\n${response.message}`);
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
          console.log(`\n📦 Used tools: ${response.toolCalls.map(t => t.name).join(', ')}`);
        }
      } catch (error) {
        console.error(`\n❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      prompt();
    });
  };

  // Handle Ctrl+C gracefully
  rl.on('close', () => {
    console.log('\nGoodbye! 👋\n');
    process.exit(0);
  });

  prompt();
}
