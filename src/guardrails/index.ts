/**
 * Guardrails Module - Iron laws, error protocol, drift detection, loop guard
 */

export {
  checkIronLaws,
  getIronLaws,
  recordError,
  clearError,
  getErrorCount,
} from './iron-laws.js';

export type {
  IronLaw,
  LawCheckContext,
  LawCheckResult,
} from './iron-laws.js';

export {
  checkToolCall,
  recordToolResult,
  resetLoopGuard,
  getLoopGuardStats,
} from './loop-guard.js';

export type { LoopGuardResult } from './loop-guard.js';
