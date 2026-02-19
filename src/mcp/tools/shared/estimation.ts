/**
 * Estimation Model
 *
 * Learned estimation model that replaces the static 0.5x calibration factor.
 * Uses weighted average with recency bias, per-type calibration, and
 * per-complexity factors. Requires 3+ data points, falls back to defaults.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { getConfig } from '../../../config/paths.js';
import { logger } from '../../../config/logger.js';

// ============================================
// Types
// ============================================

export interface EstimationDataPoint {
  sprintPhase: string;
  taskType: string;
  fileCount: number;
  estimatedMinutes: number;
  actualMinutes: number;
  complexity: 'low' | 'medium' | 'high';
  date: string;
}

export interface EstimationModel {
  overallCalibration: number;
  typeFactors: Record<string, number>;
  complexityFactors: Record<string, number>;
  fileCountSlope: number;
  dataPointCount: number;
}

interface EstimationStore {
  dataPoints: EstimationDataPoint[];
}

// ============================================
// Defaults
// ============================================

const DEFAULT_TYPE_FACTORS: Record<string, number> = {
  migration: 0.8,
  feature: 1.0,
  fix: 0.9,
  refactor: 0.9,
  test: 0.6,
  docs: 0.4,
};

const DEFAULT_COMPLEXITY_FACTORS: Record<string, number> = {
  low: 0.7,
  medium: 1.0,
  high: 1.5,
};

const DEFAULT_CALIBRATION = 0.5;
const MIN_DATA_POINTS = 3;
const RECENCY_WEIGHT = 2.0;
const RECENCY_WINDOW_DAYS = 14;

// ============================================
// Data Persistence
// ============================================

function getEstimationPath(): string {
  return `${getConfig().knowledgeDir}/estimation-data.json`;
}

export function loadEstimationData(): EstimationStore {
  const path = getEstimationPath();
  if (!existsSync(path)) return { dataPoints: [] };

  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { dataPoints: [] };
  }
}

export function saveEstimationData(store: EstimationStore): void {
  const path = getEstimationPath();
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(store, null, 2));
  renameSync(tempPath, path);
}

export function addDataPoint(point: EstimationDataPoint): void {
  const store = loadEstimationData();
  const updatedStore: EstimationStore = {
    dataPoints: [...store.dataPoints, point],
  };
  saveEstimationData(updatedStore);
  logger.info('Estimation data point added', { phase: point.sprintPhase, type: point.taskType });
}

// ============================================
// Model Training
// ============================================

/**
 * Train an estimation model from historical data points.
 * Returns null if insufficient data (< 3 points).
 */
export function trainEstimationModel(data: EstimationDataPoint[]): EstimationModel | null {
  if (data.length < MIN_DATA_POINTS) return null;

  const now = Date.now();

  // Weight recent data higher
  const weights = data.map(d => {
    const ageDays = (now - new Date(d.date).getTime()) / (1000 * 60 * 60 * 24);
    return ageDays <= RECENCY_WINDOW_DAYS ? RECENCY_WEIGHT : 1.0;
  });

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  // Overall calibration: weighted average of (actual / estimated)
  const overallCalibration = data.reduce((sum, d, i) => {
    const ratio = d.estimatedMinutes > 0 ? d.actualMinutes / d.estimatedMinutes : 1;
    return sum + ratio * weights[i];
  }, 0) / totalWeight;

  // Per-type calibration factors
  const typeFactors: Record<string, number> = { ...DEFAULT_TYPE_FACTORS };
  const typeGroups = new Map<string, { ratios: number[]; weights: number[] }>();

  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const group = typeGroups.get(d.taskType) ?? { ratios: [], weights: [] };
    if (d.estimatedMinutes > 0) {
      group.ratios.push(d.actualMinutes / d.estimatedMinutes);
      group.weights.push(weights[i]);
    }
    typeGroups.set(d.taskType, group);
  }

  for (const [type, group] of typeGroups) {
    if (group.ratios.length >= 2) {
      const totalW = group.weights.reduce((s, w) => s + w, 0);
      typeFactors[type] = group.ratios.reduce((s, r, i) => s + r * group.weights[i], 0) / totalW;
    }
  }

  // Per-complexity calibration
  const complexityFactors: Record<string, number> = { ...DEFAULT_COMPLEXITY_FACTORS };
  const complexityGroups = new Map<string, { ratios: number[]; weights: number[] }>();

  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const group = complexityGroups.get(d.complexity) ?? { ratios: [], weights: [] };
    if (d.estimatedMinutes > 0) {
      group.ratios.push(d.actualMinutes / d.estimatedMinutes);
      group.weights.push(weights[i]);
    }
    complexityGroups.set(d.complexity, group);
  }

  for (const [complexity, group] of complexityGroups) {
    if (group.ratios.length >= 2) {
      const totalW = group.weights.reduce((s, w) => s + w, 0);
      complexityFactors[complexity] = group.ratios.reduce((s, r, i) => s + r * group.weights[i], 0) / totalW;
    }
  }

  // Simple file count impact (linear regression slope)
  let fileCountSlope = 0;
  if (data.length >= 3) {
    const avgFiles = data.reduce((s, d) => s + d.fileCount, 0) / data.length;
    const avgRatio = data.reduce((s, d) => s + (d.estimatedMinutes > 0 ? d.actualMinutes / d.estimatedMinutes : 1), 0) / data.length;

    let numerator = 0;
    let denominator = 0;
    for (const d of data) {
      const ratio = d.estimatedMinutes > 0 ? d.actualMinutes / d.estimatedMinutes : 1;
      numerator += (d.fileCount - avgFiles) * (ratio - avgRatio);
      denominator += (d.fileCount - avgFiles) ** 2;
    }

    fileCountSlope = denominator > 0 ? numerator / denominator : 0;
  }

  return {
    overallCalibration: Math.round(overallCalibration * 1000) / 1000,
    typeFactors,
    complexityFactors,
    fileCountSlope: Math.round(fileCountSlope * 1000) / 1000,
    dataPointCount: data.length,
  };
}

/**
 * Load the trained model from stored data.
 * Returns null if insufficient data.
 */
export function loadEstimationModel(): EstimationModel | null {
  const store = loadEstimationData();
  return trainEstimationModel(store.dataPoints);
}

// ============================================
// Prediction
// ============================================

export interface TaskPrediction {
  predictedMinutes: number;
  confidence: 'low' | 'medium' | 'high';
  factors: {
    baseEstimate: number;
    calibration: number;
    typeFactor: number;
    complexityFactor: number;
  };
}

/**
 * Predict task duration using the trained model.
 */
export function predictTaskDuration(
  model: EstimationModel,
  estimatedMinutes: number,
  taskType: string,
  complexity: 'low' | 'medium' | 'high',
  fileCount: number,
): TaskPrediction {
  const typeFactor = model.typeFactors[taskType] ?? 1.0;
  const complexityFactor = model.complexityFactors[complexity] ?? 1.0;

  // File count adjustment (slope-based, small effect)
  const fileAdjustment = model.fileCountSlope * fileCount;

  const predicted = estimatedMinutes * model.overallCalibration * typeFactor * complexityFactor + fileAdjustment;

  // Confidence based on data point count
  let confidence: 'low' | 'medium' | 'high' = 'low';
  if (model.dataPointCount >= 10) confidence = 'high';
  else if (model.dataPointCount >= 5) confidence = 'medium';

  return {
    predictedMinutes: Math.max(1, Math.round(predicted)),
    confidence,
    factors: {
      baseEstimate: estimatedMinutes,
      calibration: model.overallCalibration,
      typeFactor,
      complexityFactor,
    },
  };
}

/**
 * Get the calibration factor to use — learned model if available, otherwise default.
 */
export function getCalibrationFactor(): number {
  const model = loadEstimationModel();
  if (model) {
    logger.info('Using learned calibration factor', { factor: model.overallCalibration, dataPoints: model.dataPointCount });
    return model.overallCalibration;
  }
  logger.info('Using default calibration factor', { factor: DEFAULT_CALIBRATION });
  return DEFAULT_CALIBRATION;
}

// ============================================
// Task Type & Complexity Inference
// ============================================

/**
 * Infer task type from a sprint title string using keyword matching.
 * Returns a type that maps to DEFAULT_TYPE_FACTORS keys.
 */
export function inferTaskType(title: string): string {
  const lower = title.toLowerCase();
  if (/\b(fix|bug|patch|hotfix)\b/.test(lower)) return 'fix';
  if (/\b(refactor|cleanup|clean.?up|tech.?debt)\b/.test(lower)) return 'refactor';
  if (/\btests?\b|\bspec\b|\bcoverage\b/.test(lower)) return 'test';
  if (/\bdocs?\b|\breadme\b|\bdocumentation\b/.test(lower)) return 'docs';
  if (/\bmigrat/.test(lower)) return 'migration';
  return 'feature';
}

/**
 * Infer complexity from task count.
 * 0-2 → low, 3-5 → medium, 6+ → high
 */
export function inferComplexity(taskCount: number): 'low' | 'medium' | 'high' {
  if (taskCount <= 2) return 'low';
  if (taskCount <= 5) return 'medium';
  return 'high';
}
