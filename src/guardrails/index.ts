/**
 * Guardrails Module - Iron laws, error protocol, drift detection
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
