/**
 * Pure Decision Functions for Sprint Orchestration
 *
 * All lifecycle decisions as pure functions: (state + config) → action.
 * No side effects, no I/O, no API calls. Easy to test and reason about.
 */

export type EffortLevel = 'instant' | 'light' | 'deep' | 'exhaustive';

export interface PipelineSteps {
  loadKnowledge: boolean;
  generateSpec: boolean;
  useEvalOpt: boolean;
  decomposeTasks: boolean;
  enrichWithBloom: boolean;
  speculativeValidate: boolean;
  saveCheckpoints: boolean;
}

/**
 * Determine which pipeline steps to run based on effort level.
 */
export function getStepsForEffort(effort: EffortLevel): PipelineSteps {
  switch (effort) {
    case 'instant':
      return {
        loadKnowledge: true,
        generateSpec: false,
        useEvalOpt: false,
        decomposeTasks: false,
        enrichWithBloom: false,
        speculativeValidate: false,
        saveCheckpoints: false,
      };
    case 'light':
      return {
        loadKnowledge: true,
        generateSpec: true,
        useEvalOpt: false,
        decomposeTasks: true,
        enrichWithBloom: false,
        speculativeValidate: false,
        saveCheckpoints: true,
      };
    case 'deep':
      return {
        loadKnowledge: true,
        generateSpec: true,
        useEvalOpt: true,
        decomposeTasks: true,
        enrichWithBloom: true,
        speculativeValidate: false,
        saveCheckpoints: true,
      };
    case 'exhaustive':
      return {
        loadKnowledge: true,
        generateSpec: true,
        useEvalOpt: true,
        decomposeTasks: true,
        enrichWithBloom: true,
        speculativeValidate: true,
        saveCheckpoints: true,
      };
  }
}

export type ExecutionStrategy = 'sequential' | 'parallel' | 'mixed';

interface WaveInfo {
  taskCount: number;
}

/**
 * Determine execution strategy from wave decomposition.
 */
export function determineStrategy(waves: WaveInfo[], totalTasks: number): ExecutionStrategy {
  if (waves.length === 0) return 'sequential';

  // If everything fits in one wave, it's parallel
  if (waves.length === 1 && waves[0].taskCount === totalTasks) {
    return 'parallel';
  }

  // If all waves have exactly 1 task, it's sequential
  if (waves.every(w => w.taskCount === 1)) {
    return 'sequential';
  }

  return 'mixed';
}

/**
 * Decide whether to recommend team-based execution.
 */
export function shouldRecommendTeam(waves: WaveInfo[]): boolean {
  if (waves.length === 0) return false;
  const maxWaveSize = Math.max(...waves.map(w => w.taskCount), 0);
  return maxWaveSize >= 2;
}

/**
 * Select quality threshold based on effort level.
 */
export function getQualityThreshold(effort: EffortLevel, userOverride?: number): number {
  if (userOverride !== undefined) return userOverride;
  switch (effort) {
    case 'instant': return 5;
    case 'light': return 6;
    case 'deep': return 8;
    case 'exhaustive': return 9;
  }
}

/**
 * Determine if speculative validation warnings should trigger enrichment skip.
 */
export function shouldSkipEnrichment(
  effort: EffortLevel,
  hasKnowledge: boolean,
): boolean {
  if (effort === 'instant') return true;
  if (effort === 'light' && !hasKnowledge) return true;
  return false;
}

/**
 * Calibrate time estimate with historical factor.
 */
export function calibrateEstimate(rawMinutes: number, calibrationFactor: number): number {
  return Math.round(rawMinutes * calibrationFactor);
}
