import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('./paths.js', () => ({
  getConfig: vi.fn(() => ({ radlDir: '/fake/radl' })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { readFileSync } from 'fs';
import {
  getProjectConfig,
  getDefaultConfig,
  resetProjectConfig,
} from './project-config.js';

const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectConfig();
});

describe('getDefaultConfig', () => {
  it('should return default values', () => {
    const config = getDefaultConfig();
    expect(config.defaultEffort).toBe('deep');
    expect(config.qualityThreshold).toBe(7);
    expect(config.maxIterations).toBe(3);
    expect(config.features.vectorSearch).toBe(false);
    expect(config.features.sessionRecovery).toBe(true);
    expect(config.models.generation).toBe('haiku');
    expect(config.models.evaluation).toBe('sonnet');
  });

  it('should return a fresh copy each time', () => {
    const a = getDefaultConfig();
    const b = getDefaultConfig();
    expect(a).not.toBe(b);
    expect(a.features).not.toBe(b.features);
    expect(a.models).not.toBe(b.models);
  });
});

describe('getProjectConfig', () => {
  it('should return defaults when config file does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const config = getProjectConfig();
    expect(config.defaultEffort).toBe('deep');
    expect(config.qualityThreshold).toBe(7);
    expect(config.maxIterations).toBe(3);
  });

  it('should return defaults when config file has invalid JSON', () => {
    mockReadFileSync.mockReturnValue('not json {{{');

    const config = getProjectConfig();
    expect(config.defaultEffort).toBe('deep');
  });

  it('should cache config after first load', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const first = getProjectConfig();
    const second = getProjectConfig();
    expect(first).toBe(second);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('should reset cache', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    getProjectConfig();
    resetProjectConfig();
    getProjectConfig();
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });
});

describe('mergeConfig (via getProjectConfig)', () => {
  it('should override defaultEffort with valid value', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultEffort: 'exhaustive' }));
    expect(getProjectConfig().defaultEffort).toBe('exhaustive');
  });

  it('should ignore invalid defaultEffort', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultEffort: 'turbo' }));
    expect(getProjectConfig().defaultEffort).toBe('deep');
  });

  it('should ignore non-string defaultEffort', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultEffort: 42 }));
    expect(getProjectConfig().defaultEffort).toBe('deep');
  });

  it('should override qualityThreshold within range', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ qualityThreshold: 9 }));
    expect(getProjectConfig().qualityThreshold).toBe(9);
  });

  it('should accept boundary values for qualityThreshold', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ qualityThreshold: 1 }));
    expect(getProjectConfig().qualityThreshold).toBe(1);

    resetProjectConfig();
    mockReadFileSync.mockReturnValue(JSON.stringify({ qualityThreshold: 10 }));
    expect(getProjectConfig().qualityThreshold).toBe(10);
  });

  it('should ignore qualityThreshold out of range', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ qualityThreshold: 0 }));
    expect(getProjectConfig().qualityThreshold).toBe(7);

    resetProjectConfig();
    mockReadFileSync.mockReturnValue(JSON.stringify({ qualityThreshold: 11 }));
    expect(getProjectConfig().qualityThreshold).toBe(7);
  });

  it('should ignore non-number qualityThreshold', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ qualityThreshold: 'high' }));
    expect(getProjectConfig().qualityThreshold).toBe(7);
  });

  it('should override maxIterations within range', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ maxIterations: 5 }));
    expect(getProjectConfig().maxIterations).toBe(5);
  });

  it('should ignore maxIterations out of range', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ maxIterations: 0 }));
    expect(getProjectConfig().maxIterations).toBe(3);

    resetProjectConfig();
    mockReadFileSync.mockReturnValue(JSON.stringify({ maxIterations: 11 }));
    expect(getProjectConfig().maxIterations).toBe(3);
  });

  it('should merge feature flags selectively', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      features: { vectorSearch: true, spotCheckDiffs: false },
    }));

    const config = getProjectConfig();
    expect(config.features.vectorSearch).toBe(true);
    expect(config.features.spotCheckDiffs).toBe(false);
    // Unspecified features keep defaults
    expect(config.features.sessionRecovery).toBe(true);
    expect(config.features.autoCompoundExtract).toBe(true);
  });

  it('should ignore non-boolean feature values', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      features: { vectorSearch: 'yes', sessionRecovery: 1 },
    }));

    const config = getProjectConfig();
    expect(config.features.vectorSearch).toBe(false);
    expect(config.features.sessionRecovery).toBe(true);
  });

  it('should ignore unknown feature keys', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      features: { unknownFeature: true },
    }));

    const config = getProjectConfig();
    expect((config.features as Record<string, unknown>)['unknownFeature']).toBeUndefined();
  });

  it('should merge model preferences selectively', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      models: { generation: 'sonnet', planning: 'opus' },
    }));

    const config = getProjectConfig();
    expect(config.models.generation).toBe('sonnet');
    expect(config.models.planning).toBe('opus');
    // Unspecified keeps default
    expect(config.models.evaluation).toBe('sonnet');
  });

  it('should ignore invalid model values', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      models: { generation: 'gpt-4', evaluation: 42 },
    }));

    const config = getProjectConfig();
    expect(config.models.generation).toBe('haiku');
    expect(config.models.evaluation).toBe('sonnet');
  });

  it('should handle a complete override config', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      defaultEffort: 'instant',
      qualityThreshold: 5,
      maxIterations: 1,
      features: {
        vectorSearch: true,
        sessionRecovery: false,
        spotCheckDiffs: false,
        autoCompoundExtract: false,
      },
      models: {
        generation: 'opus',
        evaluation: 'opus',
        planning: 'opus',
      },
    }));

    const config = getProjectConfig();
    expect(config.defaultEffort).toBe('instant');
    expect(config.qualityThreshold).toBe(5);
    expect(config.maxIterations).toBe(1);
    expect(config.features.vectorSearch).toBe(true);
    expect(config.features.sessionRecovery).toBe(false);
    expect(config.models.generation).toBe('opus');
    expect(config.models.evaluation).toBe('opus');
    expect(config.models.planning).toBe('opus');
  });

  it('should handle empty config file', () => {
    mockReadFileSync.mockReturnValue('{}');

    const config = getProjectConfig();
    expect(config.defaultEffort).toBe('deep');
    expect(config.qualityThreshold).toBe(7);
  });

  it('should not mutate default config across calls', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultEffort: 'instant' }));
    getProjectConfig();

    resetProjectConfig();
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const fallback = getProjectConfig();
    expect(fallback.defaultEffort).toBe('deep');
  });
});
