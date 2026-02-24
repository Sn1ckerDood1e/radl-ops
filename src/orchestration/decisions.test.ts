/**
 * Pure Decision Functions Tests
 *
 * All tests are synchronous — no mocks needed since these are pure functions.
 */

import { describe, it, expect } from 'vitest';
import {
  getStepsForEffort,
  determineStrategy,
  shouldRecommendTeam,
  getQualityThreshold,
  shouldSkipEnrichment,
  calibrateEstimate,
} from './decisions.js';

describe('getStepsForEffort', () => {
  it('instant: only loads knowledge', () => {
    const steps = getStepsForEffort('instant');
    expect(steps.loadKnowledge).toBe(true);
    expect(steps.generateSpec).toBe(false);
    expect(steps.useEvalOpt).toBe(false);
    expect(steps.decomposeTasks).toBe(false);
    expect(steps.enrichWithBloom).toBe(false);
    expect(steps.speculativeValidate).toBe(false);
    expect(steps.saveCheckpoints).toBe(false);
  });

  it('light: spec + decompose, no eval-opt or bloom', () => {
    const steps = getStepsForEffort('light');
    expect(steps.loadKnowledge).toBe(true);
    expect(steps.generateSpec).toBe(true);
    expect(steps.useEvalOpt).toBe(false);
    expect(steps.decomposeTasks).toBe(true);
    expect(steps.enrichWithBloom).toBe(false);
    expect(steps.speculativeValidate).toBe(false);
    expect(steps.saveCheckpoints).toBe(true);
  });

  it('deep: everything except speculative validate', () => {
    const steps = getStepsForEffort('deep');
    expect(steps.loadKnowledge).toBe(true);
    expect(steps.generateSpec).toBe(true);
    expect(steps.useEvalOpt).toBe(true);
    expect(steps.decomposeTasks).toBe(true);
    expect(steps.enrichWithBloom).toBe(true);
    expect(steps.speculativeValidate).toBe(false);
    expect(steps.saveCheckpoints).toBe(true);
  });

  it('exhaustive: everything enabled', () => {
    const steps = getStepsForEffort('exhaustive');
    expect(steps.loadKnowledge).toBe(true);
    expect(steps.generateSpec).toBe(true);
    expect(steps.useEvalOpt).toBe(true);
    expect(steps.decomposeTasks).toBe(true);
    expect(steps.enrichWithBloom).toBe(true);
    expect(steps.speculativeValidate).toBe(true);
    expect(steps.saveCheckpoints).toBe(true);
  });
});

describe('determineStrategy', () => {
  it('returns sequential for empty waves', () => {
    expect(determineStrategy([], 0)).toBe('sequential');
  });

  it('returns parallel when single wave contains all tasks', () => {
    expect(determineStrategy([{ taskCount: 5 }], 5)).toBe('parallel');
  });

  it('returns sequential when all waves have 1 task', () => {
    expect(determineStrategy([{ taskCount: 1 }, { taskCount: 1 }], 2)).toBe('sequential');
  });

  it('returns mixed when waves have varying sizes', () => {
    expect(determineStrategy([{ taskCount: 3 }, { taskCount: 1 }], 4)).toBe('mixed');
  });
});

describe('shouldRecommendTeam', () => {
  it('returns false for empty waves', () => {
    expect(shouldRecommendTeam([])).toBe(false);
  });

  it('returns false when max wave size is 1', () => {
    expect(shouldRecommendTeam([{ taskCount: 1 }, { taskCount: 1 }])).toBe(false);
  });

  it('returns true when any wave has 2+ tasks', () => {
    expect(shouldRecommendTeam([{ taskCount: 1 }, { taskCount: 2 }])).toBe(true);
  });
});

describe('getQualityThreshold', () => {
  it('returns correct defaults for each effort', () => {
    expect(getQualityThreshold('instant')).toBe(5);
    expect(getQualityThreshold('light')).toBe(6);
    expect(getQualityThreshold('deep')).toBe(8);
    expect(getQualityThreshold('exhaustive')).toBe(9);
  });

  it('respects user override', () => {
    expect(getQualityThreshold('deep', 7)).toBe(7);
    expect(getQualityThreshold('light', 10)).toBe(10);
  });
});

describe('shouldSkipEnrichment', () => {
  it('always skips for instant', () => {
    expect(shouldSkipEnrichment('instant', true)).toBe(true);
    expect(shouldSkipEnrichment('instant', false)).toBe(true);
  });

  it('skips for light when no knowledge', () => {
    expect(shouldSkipEnrichment('light', false)).toBe(true);
  });

  it('does not skip for light when knowledge exists', () => {
    expect(shouldSkipEnrichment('light', true)).toBe(false);
  });

  it('does not skip for deep/exhaustive', () => {
    expect(shouldSkipEnrichment('deep', false)).toBe(false);
    expect(shouldSkipEnrichment('exhaustive', false)).toBe(false);
  });
});

describe('calibrateEstimate', () => {
  it('calibrates with factor', () => {
    expect(calibrateEstimate(100, 0.5)).toBe(50);
    expect(calibrateEstimate(60, 0.75)).toBe(45);
  });

  it('rounds to nearest integer', () => {
    expect(calibrateEstimate(33, 0.5)).toBe(17); // 16.5 rounds to 17
  });
});
