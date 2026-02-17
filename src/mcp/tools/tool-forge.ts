/**
 * MCP Tool Forge
 *
 * Generates new MCP tool code from crystallized checks or antibodies.
 * Uses Sonnet to produce tool + test files following existing patterns.
 * Output is markdown for human review -- does NOT auto-register.
 *
 * Cost: ~$0.02 per generation (Sonnet).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withErrorTracking } from '../with-error-tracking.js';
import { logger } from '../../config/logger.js';
import { getRoute, calculateCost } from '../../models/router.js';
import { trackUsage } from '../../models/token-tracker.js';
import { getAnthropicClient } from '../../config/anthropic.js';
import { withRetry } from '../../utils/retry.js';
import { loadCrystallized } from './crystallization.js';
import type { CrystallizedCheck } from './crystallization.js';
import { loadAntibodies } from './immune-system.js';
import type { Antibody } from './immune-system.js';

// ============================================
// Types
// ============================================

export interface ToolForgeSource {
  type: 'crystallized' | 'antibody';
  id: number;
  trigger: string;
  triggerKeywords: string[];
  check: string;
  checkType: 'grep' | 'manual';
  pattern: string | null;
}

export interface ToolForgeResult {
  source: ToolForgeSource;
  toolName: string;
  toolCode: string;
  testCode: string;
  costUsd: number;
}

// ============================================
// Constants
// ============================================

const __dirname = dirname(fileURLToPath(import.meta.url));

const FORGE_SYSTEM = `You are a code generation engine for an MCP (Model Context Protocol) server. You generate new MCP tools that automatically check for specific code issues.

You will receive:
1. A source check/antibody with trigger, keywords, and check description
2. An example MCP tool implementation (spot-check.ts) as a pattern to follow
3. An example test file (spot-check.test.ts) as a test pattern

Your job is to generate:
1. A new MCP tool TypeScript file that detects the specific issue described
2. A matching test file

Rules:
1. Follow the EXACT same code structure, import patterns, and registration pattern as the example tool.
2. Use the same Anthropic SDK patterns (structured tool_use, getAnthropicClient, withErrorTracking, withRetry).
3. For 'grep' type checks, the tool should use execFileSync to run grep on the codebase.
4. For 'manual' type checks, the tool should use Haiku AI to analyze relevant code.
5. Include proper TypeScript types for all interfaces.
6. The tool should be registered via a \`registerXxxTools(server)\` function.
7. Tests should mock all external dependencies (Anthropic client, file system, etc.).
8. Tests should cover: registration, happy path, error cases, and edge cases.
9. Use vitest for testing (describe, it, expect, vi, beforeEach).
10. All imports should use .js extension (ESM).

Output format: Provide two fenced code blocks:
- First block: the tool source code (labeled \`\`\`typescript)
- Second block: the test code (labeled \`\`\`typescript)

Do NOT include any other code blocks. Only the two above.`;

// ============================================
// Source Loading
// ============================================

/**
 * Load source details from a crystallized check by id.
 */
export function loadCrystallizedSource(id: number): ToolForgeSource | null {
  const { checks } = loadCrystallized();
  const check = checks.find((c: CrystallizedCheck) => c.id === id);

  if (!check) {
    return null;
  }

  return {
    type: 'crystallized',
    id: check.id,
    trigger: check.trigger,
    triggerKeywords: check.triggerKeywords,
    check: check.check,
    checkType: check.checkType,
    pattern: check.grepPattern,
  };
}

/**
 * Load source details from an antibody by id.
 */
export function loadAntibodySource(id: number): ToolForgeSource | null {
  const { antibodies } = loadAntibodies();
  const antibody = antibodies.find((a: Antibody) => a.id === id);

  if (!antibody) {
    return null;
  }

  return {
    type: 'antibody',
    id: antibody.id,
    trigger: antibody.trigger,
    triggerKeywords: antibody.triggerKeywords,
    check: antibody.check,
    checkType: antibody.checkType,
    pattern: antibody.checkPattern,
  };
}

// ============================================
// Template Loading
// ============================================

/**
 * Read template files (spot-check.ts and spot-check.test.ts) as patterns.
 */
export async function loadTemplates(): Promise<{ toolTemplate: string; testTemplate: string }> {
  const toolPath = resolve(__dirname, 'spot-check.ts');
  const testPath = resolve(__dirname, 'spot-check.test.ts');

  const [toolTemplate, testTemplate] = await Promise.all([
    readFile(toolPath, 'utf-8'),
    readFile(testPath, 'utf-8'),
  ]);

  return { toolTemplate, testTemplate };
}

// ============================================
// Code Generation
// ============================================

/**
 * Derive a tool name from the source trigger if not provided.
 */
export function deriveToolName(source: ToolForgeSource, customName?: string): string {
  if (customName) {
    return customName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
  }

  const words = source.trigger
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 4);

  return `check_${words.join('_')}`;
}

/**
 * Parse the two code blocks from the Sonnet response.
 */
export function parseGeneratedCode(responseText: string): { toolCode: string; testCode: string } {
  const codeBlockRegex = /```typescript\n([\s\S]*?)```/g;
  const blocks: string[] = [];

  let match = codeBlockRegex.exec(responseText);
  while (match !== null) {
    blocks.push(match[1].trim());
    match = codeBlockRegex.exec(responseText);
  }

  return {
    toolCode: blocks[0] ?? '// No tool code generated',
    testCode: blocks[1] ?? '// No test code generated',
  };
}

/**
 * Generate tool code using Sonnet.
 */
export async function generateToolCode(
  source: ToolForgeSource,
  toolName: string,
  toolTemplate: string,
  testTemplate: string,
): Promise<{ toolCode: string; testCode: string; costUsd: number }> {
  const route = getRoute('review');

  const userMessage = [
    `## Source (${source.type} #${source.id})`,
    '',
    `**Trigger:** ${source.trigger}`,
    `**Keywords:** ${source.triggerKeywords.join(', ')}`,
    `**Check:** ${source.check}`,
    `**Check Type:** ${source.checkType}`,
    source.pattern ? `**Pattern:** \`${source.pattern}\`` : '',
    '',
    `## Desired Tool Name: \`${toolName}\``,
    '',
    '## Example Tool (spot-check.ts):',
    '```typescript',
    toolTemplate,
    '```',
    '',
    '## Example Test (spot-check.test.ts):',
    '```typescript',
    testTemplate,
    '```',
    '',
    `Generate a new MCP tool named \`${toolName}\` that automatically checks for the issue described above. Follow the exact same patterns as the example tool.`,
  ].filter(line => line !== '').join('\n');

  const response = await withRetry(
    () => getAnthropicClient().messages.create({
      model: route.model,
      max_tokens: route.maxTokens,
      system: FORGE_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    }),
    { maxRetries: 2, baseDelayMs: 1000 },
  );

  const cost = calculateCost(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );

  trackUsage(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    'review',
    'tool-forge',
  );

  const textBlock = response.content.find(b => b.type === 'text');
  const responseText = textBlock && textBlock.type === 'text' ? textBlock.text : '';

  const { toolCode, testCode } = parseGeneratedCode(responseText);

  return {
    toolCode,
    testCode,
    costUsd: Math.round(cost * 1_000_000) / 1_000_000,
  };
}

// ============================================
// Output Formatting
// ============================================

/**
 * Format the forge result as markdown for human review.
 */
export function formatForgeOutput(result: ToolForgeResult): string {
  const lines: string[] = [
    '## Tool Forge Output',
    '',
    `**Source:** ${result.source.type} #${result.source.id}`,
    `**Trigger:** ${result.source.trigger}`,
    `**Check:** ${result.source.check}`,
    `**Generated Tool Name:** \`${result.toolName}\``,
    `**Cost:** $${result.costUsd}`,
    '',
    '---',
    '',
    `### Tool Source (\`src/mcp/tools/${result.toolName}.ts\`)`,
    '',
    '```typescript',
    result.toolCode,
    '```',
    '',
    '---',
    '',
    `### Test Source (\`src/mcp/tools/${result.toolName}.test.ts\`)`,
    '',
    '```typescript',
    result.testCode,
    '```',
    '',
    '---',
    '',
    '### Registration Instructions',
    '',
    '1. Save the tool source to `src/mcp/tools/' + result.toolName + '.ts`',
    '2. Save the test source to `src/mcp/tools/' + result.toolName + '.test.ts`',
    '3. Import and register in `src/mcp/server.ts`:',
    '   ```typescript',
    `   import { register${toPascalCase(result.toolName)}Tools } from './tools/${result.toolName}.js';`,
    `   register${toPascalCase(result.toolName)}Tools(server);`,
    '   ```',
    '4. Run `npx tsc --noEmit` to verify types',
    '5. Run `npx vitest run src/mcp/tools/' + result.toolName + '.test.ts` to verify tests',
    '',
    '_Review the generated code before registering. AI-generated code may need adjustments._',
  ];

  return lines.join('\n');
}

/**
 * Convert a snake_case tool name to PascalCase for function naming.
 */
function toPascalCase(snakeCase: string): string {
  return snakeCase
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

// ============================================
// MCP Registration
// ============================================

export function registerToolForgeTools(server: McpServer): void {
  server.tool(
    'tool_forge',
    'Generate new MCP tool code from a crystallized check or antibody. Uses Sonnet to produce tool + test files following existing patterns. Output is markdown for human review -- does NOT auto-register.',
    {
      source_type: z.enum(['crystallized', 'antibody']).describe('Source type'),
      source_id: z.number().int().min(1).describe('ID of the source check or antibody'),
      tool_name: z.string().optional().describe('Optional custom tool name'),
      write_files: z.boolean().optional().default(false)
        .describe('Write generated .ts and .test.ts to src/mcp/tools/generated/ and run tsc --noEmit to verify'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    withErrorTracking('tool_forge', async ({ source_type, source_id, tool_name, write_files }) => {
      // 1. Load source
      const source = source_type === 'crystallized'
        ? loadCrystallizedSource(source_id)
        : loadAntibodySource(source_id);

      if (!source) {
        return {
          content: [{
            type: 'text' as const,
            text: `${source_type} #${source_id} not found. Use \`crystallize_list\` or \`antibody_list\` to see available IDs.`,
          }],
          isError: true,
        };
      }

      // 2. Load templates
      const { toolTemplate, testTemplate } = await loadTemplates();

      // 3. Derive tool name
      const toolName = deriveToolName(source, tool_name);

      logger.info('Tool forge starting', {
        sourceType: source_type,
        sourceId: source_id,
        toolName,
        trigger: source.trigger,
      });

      // 4. Generate code via Sonnet
      const { toolCode, testCode, costUsd } = await generateToolCode(
        source,
        toolName,
        toolTemplate,
        testTemplate,
      );

      const result: ToolForgeResult = {
        source,
        toolName,
        toolCode,
        testCode,
        costUsd,
      };

      // 5. Optionally write files to disk and run compilation check
      let writeStatus = '';
      if (write_files) {
        try {
          const generatedDir = resolve(__dirname, 'generated');
          await mkdir(generatedDir, { recursive: true });

          const toolPath = resolve(generatedDir, `${toolName}.ts`);
          const testPath = resolve(generatedDir, `${toolName}.test.ts`);

          await writeFile(toolPath, toolCode, 'utf-8');
          await writeFile(testPath, testCode, 'utf-8');

          // Run tsc --noEmit to verify compilation
          let compileStatus = 'unknown';
          try {
            execFileSync('npx', ['tsc', '--noEmit'], {
              cwd: resolve(__dirname, '../../..'),
              timeout: 30000,
              stdio: 'pipe',
            });
            compileStatus = 'pass';
          } catch (tscError) {
            const stderr = tscError instanceof Error && 'stderr' in tscError
              ? String((tscError as { stderr: unknown }).stderr)
              : String(tscError);
            compileStatus = `fail: ${stderr.slice(0, 500)}`;
          }

          writeStatus = `\n\n### File Write Results\n\n` +
            `- **Tool:** \`${toolPath}\`\n` +
            `- **Test:** \`${testPath}\`\n` +
            `- **Compilation:** ${compileStatus}\n` +
            `\n_Files written to generated/ directory. Do NOT auto-register._`;

          logger.info('Tool forge files written', {
            toolPath,
            testPath,
            compileStatus,
          });
        } catch (writeError) {
          writeStatus = `\n\n### File Write Failed\n\n${String(writeError)}`;
          logger.warn('Tool forge file write failed', { error: String(writeError) });
        }
      }

      // 6. Format output
      const output = formatForgeOutput(result) + writeStatus;

      logger.info('Tool forge complete', {
        toolName,
        sourceType: source_type,
        sourceId: source_id,
        cost: costUsd,
        toolCodeLength: toolCode.length,
        testCodeLength: testCode.length,
        filesWritten: !!write_files,
      });

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    }),
  );
}
