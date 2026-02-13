/**
 * Configurable file paths for radl-ops
 *
 * All hardcoded paths centralized here with env var overrides.
 * Defaults to /home/hb paths for backward compatibility.
 */

export interface PathConfig {
  radlDir: string;
  radlOpsDir: string;
  knowledgeDir: string;
  usageLogsDir: string;
  sprintScript: string;
  compoundScript: string;
}

let cachedConfig: PathConfig | null = null;

export function getConfig(): PathConfig {
  if (cachedConfig) return cachedConfig;

  const radlOpsDir = process.env.RADL_OPS_DIR || '/home/hb/radl-ops';

  cachedConfig = {
    radlDir: process.env.RADL_DIR || '/home/hb/radl',
    radlOpsDir,
    knowledgeDir: process.env.RADL_OPS_KNOWLEDGE_DIR || `${radlOpsDir}/knowledge`,
    usageLogsDir: process.env.RADL_OPS_USAGE_DIR || `${radlOpsDir}/usage-logs`,
    sprintScript: process.env.RADL_OPS_SPRINT_SCRIPT || `${radlOpsDir}/scripts/sprint.sh`,
    compoundScript: process.env.RADL_OPS_COMPOUND_SCRIPT || `${radlOpsDir}/scripts/compound.sh`,
  };

  return cachedConfig;
}

/** Reset cached config (for testing) */
export function resetConfig(): void {
  cachedConfig = null;
}
