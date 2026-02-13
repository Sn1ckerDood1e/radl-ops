/**
 * MCP Prompts
 *
 * Exposes workflow templates as MCP prompts. Prompts appear as prompt selections
 * in Claude Code and provide reusable templates with dynamic arguments.
 *
 * Prompts are registered using `server.prompt()` API from MCP SDK v1.26.0.
 * Each prompt returns a messages array with a single user message containing
 * the template content with substituted arguments.
 *
 * Available prompts:
 * - sprint-start: Pre-filled sprint start workflow
 * - sprint-review: End-of-sprint review checklist
 * - code-review: Structured code review prompt
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * Register all MCP prompts with the server.
 *
 * @param server - The MCP server instance
 */
export function registerPrompts(server: McpServer): void {
  // Sprint start workflow template
  server.prompt(
    'sprint-start',
    'Pre-filled sprint start workflow template with branch creation, tracking, and task execution steps',
    {
      phase: z.string().max(50).describe('Phase identifier (e.g., "Phase 70", "01-foundation")'),
      title: z.string().max(200).describe('Sprint title describing the work being done'),
      estimate: z.string().max(50).optional().describe('Time estimate (e.g., "3 hours", "90 minutes")'),
    },
    ({ phase, title, estimate }) => {
      const phaseSlug = phase.toLowerCase().replace(/\s+/g, '-');
      const estimateText = estimate || 'not specified';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Start a new sprint:
- Phase: ${phase}
- Title: ${title}
- Estimate: ${estimateText}

Workflow:
1. Create feature branch: git checkout -b feat/${phaseSlug}
2. Start sprint tracking: sprint_start(phase: "${phase}", title: "${title}", estimate: "${estimateText}")
3. Create task list with TaskCreate
4. Execute tasks with per-task commits
5. Run typecheck + code review + security review
6. Complete sprint: sprint_complete(commit, actual_time)`,
            },
          },
        ],
      };
    }
  );

  // Sprint review checklist
  server.prompt(
    'sprint-review',
    'End-of-sprint review checklist with pre-PR verification steps and completion workflow',
    {
      phase: z.string().max(50).describe('Phase identifier (e.g., "Phase 70", "01-foundation")'),
      branch: z.string().max(100).optional().describe('Feature branch name (defaults to phase-slug)'),
    },
    ({ phase, branch }) => {
      const phaseSlug = phase.toLowerCase().replace(/\s+/g, '-');
      const branchName = branch || phaseSlug;

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Sprint review for ${phase}:

## Pre-PR Checklist
- [ ] All tasks completed and committed
- [ ] npm run typecheck passes
- [ ] npm run build succeeds
- [ ] Code review agent run (code-reviewer)
- [ ] Security review agent run (security-reviewer)
- [ ] No console.log statements in production code
- [ ] CSRF headers in all authenticated API calls

## Sprint Completion
1. Complete sprint: sprint_complete(commit, actual_time)
2. Extract learnings: compound_extract
3. Push branch: git push -u origin ${branchName}
4. Create PR: gh pr create
5. Update STATE.md with results`,
            },
          },
        ],
      };
    }
  );

  // Code review prompt
  server.prompt(
    'code-review',
    'Structured code review prompt with severity levels and focus areas',
    {
      files: z.string().max(2000).describe('Comma-separated list of file paths to review'),
      focus: z
        .enum(['security', 'performance', 'correctness', 'all'])
        .default('all')
        .describe('Review focus area (security, performance, correctness, or all)'),
    },
    ({ files, focus }) => {
      const focusText = focus === 'all' ? 'all' : focus;

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Review the following files for ${focusText} issues:

Files: ${files}

Review criteria:
- CRITICAL: Security vulnerabilities, data leaks, auth bypass
- HIGH: Logic errors, missing validation, race conditions
- MEDIUM: Code quality, naming, type safety
- LOW: Style, documentation, minor improvements

For each finding, provide:
1. Severity (CRITICAL/HIGH/MEDIUM/LOW)
2. File and line number
3. Description of the issue
4. Suggested fix`,
            },
          },
        ],
      };
    }
  );
}
