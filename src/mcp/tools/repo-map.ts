/**
 * MCP Repository Map Tool
 *
 * Generates a lightweight file tree with top-level exports for a scoped
 * area of the Radl codebase. Helps autonomous agents understand file
 * structure before implementing changes.
 *
 * Zero AI cost — uses git ls-files + grep for export extraction.
 * Output capped at 3000 chars to preserve context window.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';

const MAX_OUTPUT_CHARS = 3000;
const RADL_DIR = '/home/hb/radl';

interface FileExport {
  path: string;
  exports: string[];
}

/**
 * Get scoped file list from git ls-files, filtered by keyword.
 */
function getScopedFiles(scope: string): string[] {
  try {
    const output = execSync(
      `git ls-files -- '*.ts' '*.tsx' | grep -i "${scope.replace(/[^a-z0-9-]/gi, '')}"`,
      { cwd: RADL_DIR, encoding: 'utf-8', timeout: 5000 }
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Extract top-level exports from a TypeScript file.
 */
function extractExports(filePath: string): string[] {
  try {
    const output = execSync(
      `grep -E "^export (function|const|default|class|type|interface|enum)" "${filePath}" | head -10`,
      { cwd: RADL_DIR, encoding: 'utf-8', timeout: 3000 }
    );
    return output.trim().split('\n').filter(Boolean).map(line => {
      // Extract just the export name
      const match = line.match(/export\s+(?:default\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/);
      return match ? match[1] : line.trim().substring(0, 80);
    });
  } catch {
    return [];
  }
}

/**
 * Build an indented tree with export annotations.
 */
function buildTree(files: FileExport[]): string {
  const lines: string[] = [];

  // Group by directory
  const dirs = new Map<string, FileExport[]>();
  for (const file of files) {
    const parts = file.path.split('/');
    const dir = parts.slice(0, -1).join('/') || '.';
    const existing = dirs.get(dir) ?? [];
    existing.push(file);
    dirs.set(dir, existing);
  }

  for (const [dir, dirFiles] of [...dirs.entries()].sort()) {
    lines.push(`${dir}/`);
    for (const file of dirFiles) {
      const fileName = file.path.split('/').pop() ?? file.path;
      if (file.exports.length > 0) {
        lines.push(`  ${fileName} → ${file.exports.join(', ')}`);
      } else {
        lines.push(`  ${fileName}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Generate a repository map for a given scope.
 */
export function generateRepoMap(scope: string): string {
  const files = getScopedFiles(scope);

  if (files.length === 0) {
    return `No files found matching scope: "${scope}"\nTry broader keywords like: practices, equipment, roster, auth, api, components`;
  }

  const fileExports: FileExport[] = files.slice(0, 50).map(path => ({
    path,
    exports: extractExports(path),
  }));

  let tree = `Repository map for "${scope}" (${files.length} files):\n\n`;
  tree += buildTree(fileExports);

  // Cap output to preserve context
  if (tree.length > MAX_OUTPUT_CHARS) {
    tree = tree.substring(0, MAX_OUTPUT_CHARS) + '\n...(truncated)';
  }

  return tree;
}

export function registerRepoMapTools(server: McpServer): void {
  server.tool(
    'repo_map',
    'Generate a lightweight file tree with top-level exports for a scoped area of the codebase. Zero AI cost.',
    {
      scope: z.string().min(1).max(100).describe(
        'Keyword to filter files (e.g., "practices", "equipment", "auth", "api/athletes")'
      ),
    },
    withErrorTracking('repo_map', async ({ scope }) => {
      logger.info('Generating repo map', { scope });
      const map = generateRepoMap(scope);
      return { content: [{ type: 'text' as const, text: map }] };
    }),
  );
}
