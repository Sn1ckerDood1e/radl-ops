/**
 * Auto-Dispatcher - Routes tasks to optimal execution strategies
 *
 * From Anthropic's "Building Effective Agents":
 * - Sequential (prompt chaining): Linear dependencies with clear stages
 * - Concurrent (parallelization): Independent analyses for speed
 * - Evaluator-Optimizer: Clear criteria + iterative value
 * - Orchestrator-Workers: Complex open-ended problems
 *
 * The dispatcher detects task characteristics and selects the right pattern.
 */

import type { TaskType } from '../types/index.js';
import { detectTaskType } from '../models/router.js';
import { logger } from '../config/logger.js';

/**
 * Execution strategy for a task
 */
export type ExecutionStrategy =
  | 'direct'          // Simple: single model call, no special pattern
  | 'sequential'      // Pipeline: step 1 → step 2 → step 3
  | 'concurrent'      // Parallel: run multiple analyses, merge results
  | 'eval-opt'        // Generator-evaluator loop until quality threshold
  | 'orchestrator';   // Plan → delegate → synthesize

/**
 * Dispatch decision with strategy and configuration
 */
export interface DispatchDecision {
  strategy: ExecutionStrategy;
  taskType: TaskType;
  /** Evaluation criteria if using eval-opt strategy */
  evalCriteria?: string[];
  /** Steps if using sequential strategy */
  steps?: string[];
  /** Parallel tasks if using concurrent strategy */
  parallelTasks?: string[];
  /** Reasoning for why this strategy was chosen */
  reasoning: string;
}

/**
 * Task characteristics used to determine strategy
 */
interface TaskCharacteristics {
  taskType: TaskType;
  /** Does the task have clear quality criteria? */
  hasEvalCriteria: boolean;
  /** Does the task benefit from multiple perspectives? */
  benefitsFromParallel: boolean;
  /** Does the task have ordered dependencies? */
  hasSequentialSteps: boolean;
  /** Is the task complex enough to warrant planning? */
  requiresPlanning: boolean;
  /** Estimated complexity (1-5) */
  complexity: number;
}

/**
 * Analyze a message to determine task characteristics
 */
function analyzeTask(message: string): TaskCharacteristics {
  const lower = message.toLowerCase();
  const taskType = detectTaskType(message);

  // Heuristics for task characteristics
  const hasEvalCriteria =
    lower.includes('quality') ||
    lower.includes('review') ||
    lower.includes('check') ||
    lower.includes('briefing') ||
    lower.includes('report') ||
    taskType === 'review' ||
    taskType === 'briefing';

  const benefitsFromParallel =
    lower.includes('compare') ||
    lower.includes('analyze') ||
    lower.includes('multiple') ||
    lower.includes('options') ||
    lower.includes('alternatives') ||
    taskType === 'architecture';

  const hasSequentialSteps =
    lower.includes('then') ||
    lower.includes('after that') ||
    lower.includes('first') ||
    lower.includes('step') ||
    lower.includes('migrate') ||
    lower.includes('deploy');

  const requiresPlanning =
    lower.includes('implement') ||
    lower.includes('build') ||
    lower.includes('create feature') ||
    lower.includes('refactor') ||
    taskType === 'planning' ||
    taskType === 'architecture';

  // Complexity estimation
  let complexity = 1;
  if (message.length > 500) complexity += 1;
  if (requiresPlanning) complexity += 1;
  if (benefitsFromParallel) complexity += 1;
  if (hasSequentialSteps) complexity += 1;
  complexity = Math.min(complexity, 5);

  return {
    taskType,
    hasEvalCriteria,
    benefitsFromParallel,
    hasSequentialSteps,
    requiresPlanning,
    complexity,
  };
}

/**
 * Dispatch a task to the optimal execution strategy.
 * This is the main entry point for the auto-dispatcher.
 */
export function dispatch(message: string): DispatchDecision {
  const chars = analyzeTask(message);

  logger.debug('Task analysis', {
    taskType: chars.taskType,
    complexity: chars.complexity,
    hasEvalCriteria: chars.hasEvalCriteria,
    benefitsFromParallel: chars.benefitsFromParallel,
    hasSequentialSteps: chars.hasSequentialSteps,
    requiresPlanning: chars.requiresPlanning,
  });

  // Strategy selection decision tree (from Anthropic research)
  if (chars.complexity <= 2 && !chars.requiresPlanning) {
    return {
      strategy: 'direct',
      taskType: chars.taskType,
      reasoning: 'Simple task, direct execution is optimal.',
    };
  }

  if (chars.hasEvalCriteria && chars.taskType === 'briefing') {
    return {
      strategy: 'eval-opt',
      taskType: chars.taskType,
      evalCriteria: getBriefingCriteria(),
      reasoning: 'Briefing with clear quality criteria benefits from evaluator-optimizer loop.',
    };
  }

  if (chars.hasEvalCriteria && chars.taskType === 'review') {
    return {
      strategy: 'eval-opt',
      taskType: chars.taskType,
      evalCriteria: getReviewCriteria(),
      reasoning: 'Review task with clear criteria benefits from iterative refinement.',
    };
  }

  if (chars.benefitsFromParallel && !chars.hasSequentialSteps) {
    return {
      strategy: 'concurrent',
      taskType: chars.taskType,
      parallelTasks: ['analysis-1', 'analysis-2'],
      reasoning: 'Multiple independent analyses needed, concurrent execution for speed.',
    };
  }

  if (chars.hasSequentialSteps) {
    return {
      strategy: 'sequential',
      taskType: chars.taskType,
      steps: ['step-1', 'step-2', 'step-3'],
      reasoning: 'Task has ordered dependencies requiring sequential execution.',
    };
  }

  if (chars.requiresPlanning && chars.complexity >= 4) {
    return {
      strategy: 'orchestrator',
      taskType: chars.taskType,
      reasoning: 'Complex task requiring planning and delegation.',
    };
  }

  // Default: direct execution
  return {
    strategy: 'direct',
    taskType: chars.taskType,
    reasoning: 'No special pattern needed, using direct execution.',
  };
}

/**
 * Evaluation criteria for briefings
 */
function getBriefingCriteria(): string[] {
  return [
    'Completeness: Covers all required sections (status, issues, priorities)',
    'Accuracy: Facts are correct and data is current',
    'Actionability: Clear next steps and priorities identified',
    'Conciseness: No fluff, appropriate length for quick reading',
    'Formatting: Well-structured with clear sections and visual hierarchy',
  ];
}

/**
 * Evaluation criteria for code/content reviews
 */
function getReviewCriteria(): string[] {
  return [
    'Thoroughness: All significant issues identified',
    'Accuracy: No false positives or incorrect suggestions',
    'Prioritization: Issues properly ranked by severity',
    'Specificity: Line-level references with concrete fix suggestions',
    'Constructiveness: Feedback is helpful, not just critical',
  ];
}
