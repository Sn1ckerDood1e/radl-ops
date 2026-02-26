#!/usr/bin/env node
/**
 * Zero-cost knowledge injection for watcher prompts.
 *
 * Runs inverse bloom against the knowledge base (patterns, lessons,
 * antibodies, crystallized checks, causal graph) and outputs a
 * "Watch out for" section to append to the watcher prompt.
 *
 * Usage: node scripts/watcher-knowledge.mjs "issue title" "issue body"
 * Exit: 0 always (failures are silent to avoid breaking the watcher)
 * Output: Markdown to stdout (empty if no matches)
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// Load .env for knowledge dir paths
config({ path: resolve(rootDir, '.env') });

const title = process.argv[2] || '';
const body = process.argv[3] || '';

if (!title) {
  process.exit(0);
}

try {
  const { runInverseBloom } = await import(
    resolve(rootDir, 'dist/mcp/tools/inverse-bloom.js')
  );

  const results = runInverseBloom([{ title, description: body }]);

  const hasMatches = results.some(r => r.matchedItems.length > 0);
  if (hasMatches) {
    const lines = [
      '',
      '## Knowledge Context (auto-injected by watcher)',
      '',
      'The following patterns and lessons from past sprints are relevant to this issue.',
      'Pay attention to these when implementing:',
      '',
    ];
    for (const result of results) {
      lines.push(result.watchOutSection);
    }
    process.stdout.write(lines.join('\n') + '\n');
  }
} catch (error) {
  // Silent failure — never break the watcher
  process.stderr.write(`[watcher-knowledge] Error: ${error.message}\n`);
}
