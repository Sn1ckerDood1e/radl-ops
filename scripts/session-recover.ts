#!/usr/bin/env npx tsx
/**
 * Session Recovery Script
 *
 * Scans Claude Code's JSONL session files for recovery context.
 * Extracts: last branch, recent tool calls, file modifications, git operations.
 * Outputs structured markdown summary for context restoration.
 *
 * Usage:
 *   npx tsx scripts/session-recover.ts [--hours 24] [--session <id>]
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// ============================================
// Types
// ============================================

interface SessionEntry {
  type: string;
  timestamp?: string;
  gitBranch?: string;
  sessionId?: string;
  message?: {
    content?: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
      text?: string;
    }>;
  };
  data?: Record<string, unknown>;
}

interface SessionSummary {
  sessionId: string;
  lastModified: Date;
  branch: string;
  toolCalls: ToolCallSummary[];
  fileModifications: string[];
  gitOperations: string[];
  mcpTools: string[];
}

interface ToolCallSummary {
  tool: string;
  count: number;
  lastUsed: string;
}

// ============================================
// Constants
// ============================================

const SESSIONS_DIR = join(
  process.env.HOME ?? '/home/hb',
  '.claude/projects/-home-hb'
);

const DEFAULT_HOURS = 24;

// ============================================
// Parsing
// ============================================

/**
 * Parse a JSONL session file and extract relevant entries.
 * Streams line-by-line to handle large files efficiently.
 */
function parseSessionFile(filePath: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as SessionEntry;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Skip unreadable files
  }
  return entries;
}

/**
 * Extract a structured summary from session entries.
 */
function summarizeSession(
  sessionId: string,
  entries: SessionEntry[],
  lastModified: Date,
): SessionSummary {
  let branch = 'unknown';
  const toolCounts = new Map<string, { count: number; lastUsed: string }>();
  const fileModifications = new Set<string>();
  const gitOperations: string[] = [];
  const mcpTools = new Set<string>();

  for (const entry of entries) {
    // Track branch
    if (entry.gitBranch) {
      branch = entry.gitBranch;
    }

    // Track tool calls from assistant messages
    if (entry.type === 'assistant' && entry.message?.content) {
      for (const block of entry.message.content) {
        if (block.type !== 'tool_use' || !block.name) continue;

        const toolName = block.name;
        const timestamp = entry.timestamp ?? '';

        // Count tool usage
        const existing = toolCounts.get(toolName) ?? { count: 0, lastUsed: '' };
        toolCounts.set(toolName, {
          count: existing.count + 1,
          lastUsed: timestamp || existing.lastUsed,
        });

        // Track MCP tools
        if (toolName.startsWith('mcp__')) {
          mcpTools.add(toolName);
        }

        // Track file modifications from Edit/Write tools
        if (toolName === 'Edit' || toolName === 'Write') {
          const filePath = block.input?.file_path as string | undefined;
          if (filePath) {
            fileModifications.add(filePath);
          }
        }

        // Track git operations from Bash tool
        if (toolName === 'Bash') {
          const command = block.input?.command as string | undefined;
          if (command && isGitOperation(command)) {
            gitOperations.push(command.substring(0, 120));
          }
        }
      }
    }
  }

  // Convert tool counts to sorted summary
  const toolCalls = [...toolCounts.entries()]
    .map(([tool, data]) => ({
      tool,
      count: data.count,
      lastUsed: data.lastUsed,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    sessionId,
    lastModified,
    branch,
    toolCalls,
    fileModifications: [...fileModifications].sort(),
    gitOperations: gitOperations.slice(-20), // Last 20 git ops
    mcpTools: [...mcpTools].sort(),
  };
}

function isGitOperation(command: string): boolean {
  const gitPatterns = [
    /^git\s/,
    /&&\s*git\s/,
    /^gh\s/,
  ];
  return gitPatterns.some(p => p.test(command.trim()));
}

// ============================================
// Discovery
// ============================================

/**
 * Find session files modified within the given time window.
 */
function findRecentSessions(
  hoursBack: number,
  specificSessionId?: string,
): Array<{ path: string; sessionId: string; lastModified: Date }> {
  const cutoff = new Date(Date.now() - hoursBack * 3600_000);
  const sessions: Array<{ path: string; sessionId: string; lastModified: Date }> = [];

  try {
    const files = readdirSync(SESSIONS_DIR);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;

      const sessionId = file.replace('.jsonl', '');
      if (specificSessionId && sessionId !== specificSessionId) continue;

      const fullPath = join(SESSIONS_DIR, file);
      try {
        const stat = statSync(fullPath);
        if (stat.mtime >= cutoff) {
          sessions.push({
            path: fullPath,
            sessionId,
            lastModified: stat.mtime,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Sessions directory doesn't exist
  }

  // Sort by most recently modified
  return sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

// ============================================
// Output
// ============================================

/**
 * Format session summaries as markdown.
 */
export function formatRecoveryMarkdown(summaries: SessionSummary[]): string {
  if (summaries.length === 0) {
    return 'No recent sessions found.';
  }

  const lines: string[] = ['SESSION RECOVERY CONTEXT'];

  for (const s of summaries.slice(0, 3)) {
    lines.push(`  Session: ${s.sessionId.substring(0, 8)}...`);
    lines.push(`  Branch: ${s.branch}`);
    lines.push(`  Last active: ${s.lastModified.toISOString().substring(0, 19)}`);

    if (s.fileModifications.length > 0) {
      lines.push(`  Modified files (${s.fileModifications.length}):`);
      for (const f of s.fileModifications.slice(0, 15)) {
        lines.push(`    - ${f}`);
      }
      if (s.fileModifications.length > 15) {
        lines.push(`    ... and ${s.fileModifications.length - 15} more`);
      }
    }

    if (s.gitOperations.length > 0) {
      lines.push(`  Recent git operations:`);
      for (const op of s.gitOperations.slice(-5)) {
        lines.push(`    $ ${op}`);
      }
    }

    if (s.toolCalls.length > 0) {
      const topTools = s.toolCalls.slice(0, 8);
      lines.push(`  Top tools: ${topTools.map(t => `${t.tool}(${t.count})`).join(', ')}`);
    }

    if (s.mcpTools.size > 0) {
      lines.push(`  MCP tools used: ${[...s.mcpTools].join(', ')}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ============================================
// Main
// ============================================

/**
 * Run session recovery. Exported for programmatic use.
 */
export function recoverSessions(
  hoursBack: number = DEFAULT_HOURS,
  specificSessionId?: string,
): SessionSummary[] {
  const recentSessions = findRecentSessions(hoursBack, specificSessionId);
  const summaries: SessionSummary[] = [];

  for (const session of recentSessions.slice(0, 5)) {
    const entries = parseSessionFile(session.path);
    if (entries.length === 0) continue;

    const summary = summarizeSession(
      session.sessionId,
      entries,
      session.lastModified,
    );
    summaries.push(summary);
  }

  return summaries;
}

// CLI entry point
if (process.argv[1]?.endsWith('session-recover.ts')) {
  const args = process.argv.slice(2);
  let hours = DEFAULT_HOURS;
  let sessionId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hours' && args[i + 1]) {
      hours = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--session' && args[i + 1]) {
      sessionId = args[i + 1];
      i++;
    }
  }

  const summaries = recoverSessions(hours, sessionId);
  const output = formatRecoveryMarkdown(summaries);
  process.stdout.write(output + '\n');
}
