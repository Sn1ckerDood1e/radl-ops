/**
 * MCP Data Flow Verifier Tool
 *
 * Zero-cost file scanning tool (NO AI calls, $0 cost).
 * Checks that a Prisma field is properly wired through all layers
 * of the data flow: Schema -> Migration -> Validation -> API Handler -> Client.
 *
 * Prevents the Phase 69 class of bug where a field is added to the schema
 * and client but never processed by the API handler.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';

interface LayerResult {
  name: string;
  status: 'FOUND' | 'MISSING';
  files: string[];
}

/** Sanitize a search pattern to prevent command injection via grep */
function sanitizePattern(input: string): string {
  return input.replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Search files in a directory for a pattern using grep.
 * Returns relative file paths (relative to radlDir) that contain the pattern.
 */
function searchFiles(dir: string, pattern: string, extensions: string[]): string[] {
  const config = getConfig();
  const searchDir = `${config.radlDir}/${dir}`;
  if (!existsSync(searchDir)) return [];
  try {
    const extGlob = extensions.map(e => `--include="*.${e}"`).join(' ');
    const output = execSync(
      `grep -rl "${pattern}" ${extGlob} "${searchDir}" 2>/dev/null || true`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const radlDir = config.radlDir;
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(f => f.startsWith(radlDir) ? f.slice(radlDir.length + 1) : f);
  } catch {
    return [];
  }
}

function checkSchema(field: string, model: string): LayerResult {
  const safeField = sanitizePattern(field);
  const safeModel = sanitizePattern(model);
  const files = searchFiles('prisma', safeField, ['prisma']);
  // Verify the field appears near the model name (rough heuristic)
  const modelFiles = searchFiles('prisma', safeModel, ['prisma']);
  const matched = files.filter(f => modelFiles.includes(f));
  return {
    name: 'Schema',
    status: matched.length > 0 ? 'FOUND' : 'MISSING',
    files: matched,
  };
}

function checkMigration(field: string): LayerResult {
  const safeField = sanitizePattern(field);
  const files = searchFiles('prisma/migrations', safeField, ['sql']);
  return {
    name: 'Migration',
    status: files.length > 0 ? 'FOUND' : 'MISSING',
    files,
  };
}

function checkValidation(field: string): LayerResult {
  const safeField = sanitizePattern(field);
  const files = searchFiles('src/lib/validations', safeField, ['ts']);
  return {
    name: 'Validation',
    status: files.length > 0 ? 'FOUND' : 'MISSING',
    files,
  };
}

function checkApiHandler(field: string): LayerResult {
  const safeField = sanitizePattern(field);
  const files = searchFiles('src/app/api', safeField, ['ts']);
  return {
    name: 'API Handler',
    status: files.length > 0 ? 'FOUND' : 'MISSING',
    files,
  };
}

function checkClient(field: string): LayerResult {
  const safeField = sanitizePattern(field);
  const componentFiles = searchFiles('src/components', safeField, ['ts', 'tsx']);
  const appFiles = searchFiles('src/app', safeField, ['ts', 'tsx']);
  // Exclude API routes from client check (those are handled by checkApiHandler)
  const clientFiles = [...componentFiles, ...appFiles.filter(f => !f.includes('/api/'))];
  // Deduplicate
  const unique = [...new Set(clientFiles)];
  return {
    name: 'Client',
    status: unique.length > 0 ? 'FOUND' : 'MISSING',
    files: unique,
  };
}

function formatReport(model: string, field: string, layers: LayerResult[]): string {
  const lines: string[] = [
    `# Data Flow Verification: ${model}.${field}`,
    '',
    '| Layer | Status | Files |',
    '|-------|--------|-------|',
  ];

  for (const layer of layers) {
    const filesStr = layer.files.length > 0
      ? layer.files.join(', ')
      : '\u2014';
    lines.push(`| ${layer.name} | ${layer.status} | ${filesStr} |`);
  }

  lines.push('');

  const missingLayers = layers.filter(l => l.status === 'MISSING');
  if (missingLayers.length === 0) {
    lines.push('**Result:** COMPLETE \u2014 field found in all data flow layers');
  } else {
    const missing = missingLayers.map(l => l.name).join(', ');
    lines.push(`**Result:** INCOMPLETE \u2014 ${missing} layer${missingLayers.length > 1 ? 's' : ''} missing`);
    lines.push(`**Action:** Add field handling to the missing layer${missingLayers.length > 1 ? 's' : ''}`);
  }

  return lines.join('\n');
}

export function registerDataFlowVerifierTools(server: McpServer): void {
  server.tool(
    'verify_data_flow',
    'Verify a Prisma field is properly wired through all data flow layers: Schema \u2192 Migration \u2192 Validation \u2192 API Handler \u2192 Client. Zero cost (file scan only). Example: { "field": "setupChecklistDismissed", "model": "FacilitySettings" }',
    {
      field: z.string().min(1).max(100).describe('Field name to trace'),
      model: z.string().min(1).max(100).describe('Prisma model name'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('verify_data_flow', async ({ field, model }) => {
      logger.info('Data flow verification started', { field, model });

      const layers: LayerResult[] = [
        checkSchema(field, model),
        checkMigration(field),
        checkValidation(field),
        checkApiHandler(field),
        checkClient(field),
      ];

      const allFound = layers.every(l => l.status === 'FOUND');
      const totalFiles = layers.reduce((sum, l) => sum + l.files.length, 0);

      logger.info('Data flow verification complete', {
        field,
        model,
        allFound,
        totalFiles,
        layers: layers.map(l => ({ name: l.name, status: l.status, fileCount: l.files.length })),
      });

      const report = formatReport(model, field, layers);

      return { content: [{ type: 'text' as const, text: report }] };
    })
  );
}
