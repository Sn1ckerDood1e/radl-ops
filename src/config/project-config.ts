/**
 * Hierarchical Project Configuration
 *
 * Loads project-level config from .radl-ops.json in the project root,
 * merging with global defaults. Allows per-project overrides for
 * model preferences, effort defaults, quality thresholds, and feature flags.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getConfig } from './paths.js';
import { logger } from './logger.js';

// ============================================
// Types
// ============================================

export interface ProjectConfig {
  /** Default effort level for sprint conductor */
  defaultEffort: 'instant' | 'light' | 'deep' | 'exhaustive';
  /** Default quality threshold for eval-opt (0-10) */
  qualityThreshold: number;
  /** Max eval-opt iterations before accepting */
  maxIterations: number;
  /** Feature flags */
  features: {
    vectorSearch: boolean;
    sessionRecovery: boolean;
    spotCheckDiffs: boolean;
    autoCompoundExtract: boolean;
  };
  /** Model preferences per task type */
  models: {
    generation: 'haiku' | 'sonnet' | 'opus';
    evaluation: 'haiku' | 'sonnet' | 'opus';
    planning: 'haiku' | 'sonnet' | 'opus';
  };
}

// ============================================
// Defaults
// ============================================

const DEFAULT_CONFIG: ProjectConfig = {
  defaultEffort: 'deep',
  qualityThreshold: 7,
  maxIterations: 3,
  features: {
    vectorSearch: false,
    sessionRecovery: true,
    spotCheckDiffs: true,
    autoCompoundExtract: true,
  },
  models: {
    generation: 'haiku',
    evaluation: 'sonnet',
    planning: 'sonnet',
  },
};

// ============================================
// Loading
// ============================================

let cachedProjectConfig: ProjectConfig | null = null;

/**
 * Deep merge source into target, returning a new object.
 * Only merges known keys from the default config shape.
 */
function mergeConfig(
  defaults: ProjectConfig,
  overrides: Record<string, unknown>,
): ProjectConfig {
  const result = { ...defaults };

  if (typeof overrides.defaultEffort === 'string' &&
    ['instant', 'light', 'deep', 'exhaustive'].includes(overrides.defaultEffort)) {
    result.defaultEffort = overrides.defaultEffort as ProjectConfig['defaultEffort'];
  }

  if (typeof overrides.qualityThreshold === 'number' &&
    overrides.qualityThreshold >= 0 && overrides.qualityThreshold <= 10) {
    result.qualityThreshold = overrides.qualityThreshold;
  }

  if (typeof overrides.maxIterations === 'number' &&
    overrides.maxIterations >= 1 && overrides.maxIterations <= 10) {
    result.maxIterations = overrides.maxIterations;
  }

  if (typeof overrides.features === 'object' && overrides.features !== null) {
    const featOverrides = overrides.features as Record<string, unknown>;
    result.features = { ...defaults.features };
    for (const key of Object.keys(defaults.features) as Array<keyof ProjectConfig['features']>) {
      if (typeof featOverrides[key] === 'boolean') {
        result.features[key] = featOverrides[key] as boolean;
      }
    }
  }

  if (typeof overrides.models === 'object' && overrides.models !== null) {
    const modelOverrides = overrides.models as Record<string, unknown>;
    const validModels = ['haiku', 'sonnet', 'opus'];
    result.models = { ...defaults.models };
    for (const key of Object.keys(defaults.models) as Array<keyof ProjectConfig['models']>) {
      if (typeof modelOverrides[key] === 'string' && validModels.includes(modelOverrides[key] as string)) {
        result.models[key] = modelOverrides[key] as ProjectConfig['models'][typeof key];
      }
    }
  }

  return result;
}

/**
 * Load project config from .radl-ops.json in the radl project directory.
 * Falls back to defaults if file doesn't exist or is invalid.
 */
function loadProjectConfig(): ProjectConfig {
  try {
    const radlDir = getConfig().radlDir;
    const configPath = join(radlDir, '.radl-ops.json');
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const merged = mergeConfig(DEFAULT_CONFIG, parsed);

    logger.info('Project config loaded', {
      path: configPath,
      effort: merged.defaultEffort,
      threshold: merged.qualityThreshold,
    });

    return merged;
  } catch {
    // File doesn't exist or is invalid — use defaults
    return { ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features }, models: { ...DEFAULT_CONFIG.models } };
  }
}

// ============================================
// Public API
// ============================================

/**
 * Get the merged project config. Cached after first load.
 */
export function getProjectConfig(): ProjectConfig {
  if (cachedProjectConfig) return cachedProjectConfig;
  cachedProjectConfig = loadProjectConfig();
  return cachedProjectConfig;
}

/**
 * Get the default config (without project overrides).
 */
export function getDefaultConfig(): ProjectConfig {
  return { ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features }, models: { ...DEFAULT_CONFIG.models } };
}

/**
 * Reset cached config (for testing).
 */
export function resetProjectConfig(): void {
  cachedProjectConfig = null;
}
