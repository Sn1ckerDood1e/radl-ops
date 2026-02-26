#!/usr/bin/env node
/**
 * Auto-create antibodies from watcher failures.
 *
 * When the watcher fails on an issue, this script calls Haiku (~$0.001)
 * to classify the failure into an antibody pattern. Future inverse bloom
 * runs will surface the antibody for similar issues.
 *
 * Usage: node scripts/watcher-antibody.mjs "failure description" ["sprint phase"]
 * Exit: 0 always (failures are silent to avoid breaking the watcher)
 * Output: Antibody summary to stdout (for logging)
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// Load .env for API key and knowledge dir
config({ path: resolve(rootDir, '.env') });

// Cap inputs to prevent oversized prompts to Haiku
const MAX_DESCRIPTION_LEN = 2000;
const MAX_PHASE_LEN = 100;

const description = (process.argv[2] || '').slice(0, MAX_DESCRIPTION_LEN);
const phase = (process.argv[3] || 'watcher').slice(0, MAX_PHASE_LEN);

if (!description || description.length < 10) {
  process.exit(0);
}

try {
  const { createAntibodyCore } = await import(
    resolve(rootDir, 'dist/mcp/tools/immune-system.js')
  );

  const result = await createAntibodyCore(description, null, phase);
  if (result) {
    process.stdout.write(
      `Antibody #${result.id} created: ${result.trigger}\n` +
      `  Keywords: ${result.triggerKeywords.join(', ')}\n` +
      `  Check: ${result.check}\n`
    );
  } else {
    process.stdout.write('Antibody classification failed (no structured output from AI)\n');
  }
} catch (error) {
  // Silent failure — never break the watcher
  process.stderr.write(`[watcher-antibody] Error: ${error.message}\n`);
}
