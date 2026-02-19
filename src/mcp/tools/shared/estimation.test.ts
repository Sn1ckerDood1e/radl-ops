import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  trainEstimationModel,
  predictTaskDuration,
  loadEstimationData,
  saveEstimationData,
  addDataPoint,
  getCalibrationFactor,
  inferTaskType,
  inferComplexity,
} from './estimation.js';
import type { EstimationDataPoint, EstimationModel } from './estimation.js';

// Mock dependencies
vi.mock('../../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/tmp/test-knowledge',
    radlDir: '/home/hb/radl',
    sprintDir: '/tmp/test-sprints',
    opsDir: '/home/hb/radl-ops',
  })),
}));

vi.mock('../../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from 'fs';

function makeDataPoint(overrides: Partial<EstimationDataPoint> = {}): EstimationDataPoint {
  return {
    sprintPhase: 'Phase 70',
    taskType: 'feature',
    fileCount: 3,
    estimatedMinutes: 60,
    actualMinutes: 30,
    complexity: 'medium',
    date: new Date().toISOString(),
    ...overrides,
  };
}

describe('trainEstimationModel', () => {
  it('returns null with fewer than 3 data points', () => {
    expect(trainEstimationModel([makeDataPoint()])).toBeNull();
    expect(trainEstimationModel([makeDataPoint(), makeDataPoint()])).toBeNull();
  });

  it('returns model with 3+ data points', () => {
    const data = [
      makeDataPoint({ estimatedMinutes: 60, actualMinutes: 30 }),
      makeDataPoint({ estimatedMinutes: 120, actualMinutes: 60 }),
      makeDataPoint({ estimatedMinutes: 90, actualMinutes: 45 }),
    ];

    const model = trainEstimationModel(data);
    expect(model).not.toBeNull();
    expect(model!.overallCalibration).toBeCloseTo(0.5, 1);
    expect(model!.dataPointCount).toBe(3);
  });

  it('applies recency weighting to recent data', () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();

    const data = [
      makeDataPoint({ estimatedMinutes: 60, actualMinutes: 60, date: oldDate }), // ratio 1.0
      makeDataPoint({ estimatedMinutes: 60, actualMinutes: 60, date: oldDate }), // ratio 1.0
      makeDataPoint({ estimatedMinutes: 60, actualMinutes: 30, date: recentDate }), // ratio 0.5 (weighted 2x)
    ];

    const model = trainEstimationModel(data);
    // Recent data point weighted 2x, so effective average is (1.0 + 1.0 + 0.5*2) / (1+1+2) = 3.0/4 = 0.75
    expect(model!.overallCalibration).toBeLessThan(1.0);
    expect(model!.overallCalibration).toBeGreaterThan(0.5);
  });

  it('computes per-type factors with sufficient data', () => {
    const data = [
      makeDataPoint({ taskType: 'test', estimatedMinutes: 60, actualMinutes: 36 }), // 0.6
      makeDataPoint({ taskType: 'test', estimatedMinutes: 60, actualMinutes: 36 }), // 0.6
      makeDataPoint({ taskType: 'feature', estimatedMinutes: 60, actualMinutes: 30 }), // 0.5
    ];

    const model = trainEstimationModel(data);
    expect(model!.typeFactors['test']).toBeCloseTo(0.6, 1);
  });
});

describe('predictTaskDuration', () => {
  const model: EstimationModel = {
    overallCalibration: 0.5,
    typeFactors: { feature: 1.0, test: 0.6 },
    complexityFactors: { low: 0.7, medium: 1.0, high: 1.5 },
    fileCountSlope: 0,
    dataPointCount: 10,
  };

  it('predicts duration using model factors', () => {
    const result = predictTaskDuration(model, 60, 'feature', 'medium', 3);
    expect(result.predictedMinutes).toBe(30); // 60 * 0.5 * 1.0 * 1.0
    expect(result.confidence).toBe('high');
  });

  it('applies type factor', () => {
    const result = predictTaskDuration(model, 60, 'test', 'medium', 3);
    expect(result.predictedMinutes).toBe(18); // 60 * 0.5 * 0.6 * 1.0
  });

  it('applies complexity factor', () => {
    const result = predictTaskDuration(model, 60, 'feature', 'high', 3);
    expect(result.predictedMinutes).toBe(45); // 60 * 0.5 * 1.0 * 1.5
  });

  it('defaults to 1.0 for unknown type', () => {
    const result = predictTaskDuration(model, 60, 'unknown', 'medium', 3);
    expect(result.predictedMinutes).toBe(30); // 60 * 0.5 * 1.0 * 1.0
  });

  it('returns low confidence for few data points', () => {
    const smallModel = { ...model, dataPointCount: 3 };
    const result = predictTaskDuration(smallModel, 60, 'feature', 'medium', 3);
    expect(result.confidence).toBe('low');
  });

  it('returns medium confidence for moderate data', () => {
    const medModel = { ...model, dataPointCount: 7 };
    const result = predictTaskDuration(medModel, 60, 'feature', 'medium', 3);
    expect(result.confidence).toBe('medium');
  });

  it('never returns less than 1 minute', () => {
    const result = predictTaskDuration(model, 1, 'feature', 'low', 1);
    expect(result.predictedMinutes).toBeGreaterThanOrEqual(1);
  });
});

describe('loadEstimationData', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty store when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const store = loadEstimationData();
    expect(store.dataPoints).toHaveLength(0);
  });

  it('parses stored data', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      dataPoints: [makeDataPoint()],
    }));

    const store = loadEstimationData();
    expect(store.dataPoints).toHaveLength(1);
  });
});

describe('addDataPoint', () => {
  beforeEach(() => vi.clearAllMocks());

  it('appends to existing data', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      dataPoints: [makeDataPoint()],
    }));

    addDataPoint(makeDataPoint({ sprintPhase: 'Phase 71' }));
    expect(writeFileSync).toHaveBeenCalled();
  });
});

describe('getCalibrationFactor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns default when no data', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(getCalibrationFactor()).toBe(0.5);
  });

  it('returns learned factor with sufficient data', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      dataPoints: [
        makeDataPoint({ estimatedMinutes: 60, actualMinutes: 30 }),
        makeDataPoint({ estimatedMinutes: 120, actualMinutes: 60 }),
        makeDataPoint({ estimatedMinutes: 90, actualMinutes: 45 }),
      ],
    }));

    const factor = getCalibrationFactor();
    expect(factor).toBeCloseTo(0.5, 1);
  });
});

describe('inferTaskType', () => {
  it('returns fix for bug-related keywords', () => {
    expect(inferTaskType('Fix login bug')).toBe('fix');
    expect(inferTaskType('Patch authentication')).toBe('fix');
    expect(inferTaskType('Hotfix for crash')).toBe('fix');
    expect(inferTaskType('Bug in dashboard')).toBe('fix');
  });

  it('returns refactor for cleanup keywords', () => {
    expect(inferTaskType('Refactor auth module')).toBe('refactor');
    expect(inferTaskType('Code cleanup sprint')).toBe('refactor');
    expect(inferTaskType('Tech debt reduction')).toBe('refactor');
  });

  it('returns test for test keywords', () => {
    expect(inferTaskType('Add unit tests')).toBe('test');
    expect(inferTaskType('Improve test coverage')).toBe('test');
    expect(inferTaskType('Write spec for API')).toBe('test');
  });

  it('returns docs for documentation keywords', () => {
    expect(inferTaskType('Update documentation')).toBe('docs');
    expect(inferTaskType('Write README')).toBe('docs');
    expect(inferTaskType('Add doc comments')).toBe('docs');
  });

  it('returns migration for migration keywords', () => {
    expect(inferTaskType('Database migration')).toBe('migration');
    expect(inferTaskType('Schema migration for teams')).toBe('migration');
    expect(inferTaskType('Migrate user data')).toBe('migration');
  });

  it('returns feature as default', () => {
    expect(inferTaskType('Add user dashboard')).toBe('feature');
    expect(inferTaskType('Implement lineup management')).toBe('feature');
    expect(inferTaskType('Wire intelligence layer')).toBe('feature');
  });

  it('is case insensitive', () => {
    expect(inferTaskType('FIX LOGIN BUG')).toBe('fix');
    expect(inferTaskType('REFACTOR AUTH')).toBe('refactor');
  });
});

describe('inferComplexity', () => {
  it('returns low for 0-2 tasks', () => {
    expect(inferComplexity(0)).toBe('low');
    expect(inferComplexity(1)).toBe('low');
    expect(inferComplexity(2)).toBe('low');
  });

  it('returns medium for 3-5 tasks', () => {
    expect(inferComplexity(3)).toBe('medium');
    expect(inferComplexity(4)).toBe('medium');
    expect(inferComplexity(5)).toBe('medium');
  });

  it('returns high for 6+ tasks', () => {
    expect(inferComplexity(6)).toBe('high');
    expect(inferComplexity(10)).toBe('high');
    expect(inferComplexity(100)).toBe('high');
  });
});
