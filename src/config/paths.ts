/**
 * Configurable file paths for radl-ops
 *
 * All hardcoded paths centralized here with env var overrides.
 * Defaults to /home/hb paths for backward compatibility.
 *
 * Security: All paths are validated to prevent path traversal.
 * Only paths under allowed base directories are accepted.
 */

import { resolve, normalize } from 'path';

export interface PathConfig {
  radlDir: string;
  radlOpsDir: string;
  knowledgeDir: string;
  usageLogsDir: string;
  sprintScript: string;
  compoundScript: string;
}

const ALLOWED_BASE_DIRS = process.env.RADL_OPS_ALLOWED_DIRS
  ? process.env.RADL_OPS_ALLOWED_DIRS.split(',').map(d => d.trim())
  : ['/home/hb', '/tmp'];

function validatePath(rawPath: string, label: string): string {
  const absolutePath = resolve(normalize(rawPath));
  if (rawPath.includes('..')) {
    throw new Error(`${label}: path cannot contain '..' sequences`);
  }
  const isAllowed = ALLOWED_BASE_DIRS.some(base => absolutePath.startsWith(base));
  if (!isAllowed) {
    throw new Error(`${label}: path must be under ${ALLOWED_BASE_DIRS.join(' or ')}, got: ${absolutePath}`);
  }
  return absolutePath;
}

function validateScript(rawPath: string, label: string): string {
  const absolutePath = validatePath(rawPath, label);
  if (!absolutePath.endsWith('.sh')) {
    throw new Error(`${label}: script must have .sh extension, got: ${absolutePath}`);
  }
  return absolutePath;
}

let cachedConfig: PathConfig | null = null;

export function getConfig(): PathConfig {
  if (cachedConfig) return cachedConfig;

  const radlOpsDir = validatePath(
    process.env.RADL_OPS_DIR || '/home/hb/radl-ops',
    'RADL_OPS_DIR'
  );

  cachedConfig = {
    radlDir: validatePath(
      process.env.RADL_DIR || '/home/hb/radl',
      'RADL_DIR'
    ),
    radlOpsDir,
    knowledgeDir: validatePath(
      process.env.RADL_OPS_KNOWLEDGE_DIR || `${radlOpsDir}/knowledge`,
      'RADL_OPS_KNOWLEDGE_DIR'
    ),
    usageLogsDir: validatePath(
      process.env.RADL_OPS_USAGE_DIR || `${radlOpsDir}/usage-logs`,
      'RADL_OPS_USAGE_DIR'
    ),
    sprintScript: validateScript(
      process.env.RADL_OPS_SPRINT_SCRIPT || `${radlOpsDir}/scripts/sprint.sh`,
      'RADL_OPS_SPRINT_SCRIPT'
    ),
    compoundScript: validateScript(
      process.env.RADL_OPS_COMPOUND_SCRIPT || `${radlOpsDir}/scripts/compound.sh`,
      'RADL_OPS_COMPOUND_SCRIPT'
    ),
  };

  return cachedConfig;
}

/** Reset cached config (for testing) */
export function resetConfig(): void {
  cachedConfig = null;
}
