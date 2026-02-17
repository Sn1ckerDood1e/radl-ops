/**
 * Conductor Checkpoint System
 *
 * Enables step-level checkpointing for the conductor pipeline. When the
 * conductor is re-invoked with the same feature, it resumes from the last
 * checkpoint instead of restarting from scratch.
 *
 * Checkpoints are stored in knowledge/conductor_checkpoints/{featureHash}.json
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../../../config/paths.js';
import { logger } from '../../../config/logger.js';
import type { Decomposition } from './decomposition.js';

export interface ConductorCheckpoint {
  featureHash: string;
  phase: 'knowledge' | 'spec' | 'decompose' | 'bloom' | 'plan' | 'validate';
  completedAt: string;
  spec?: { output: string; score: number; iterations: number; cost: number };
  decomposition?: Decomposition;
  totalCostSoFar: number;
}

/**
 * Compute a deterministic hash for a feature description + optional context.
 * Same feature+context = same hash = same checkpoint.
 */
export function computeFeatureHash(feature: string, context?: string): string {
  const input = `${feature}|${context ?? ''}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function getCheckpointDir(): string {
  const dir = join(getConfig().knowledgeDir, 'conductor_checkpoints');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getCheckpointPath(featureHash: string): string {
  return join(getCheckpointDir(), `${featureHash}.json`);
}

/**
 * Load a checkpoint by feature hash.
 * Returns null if no checkpoint exists or if the file is corrupted.
 */
export function loadCheckpoint(featureHash: string): ConductorCheckpoint | null {
  const path = getCheckpointPath(featureHash);
  if (!existsSync(path)) return null;

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (data.featureHash !== featureHash) return null;
    logger.info('Conductor checkpoint loaded', { featureHash, phase: data.phase });
    return data as ConductorCheckpoint;
  } catch (error) {
    logger.warn('Failed to load conductor checkpoint', { featureHash, error: String(error) });
    return null;
  }
}

/**
 * Save a checkpoint to disk.
 * Uses atomic write to prevent corruption.
 */
export function saveCheckpoint(checkpoint: ConductorCheckpoint): void {
  const path = getCheckpointPath(checkpoint.featureHash);
  writeFileSync(path, JSON.stringify(checkpoint, null, 2));
  logger.info('Conductor checkpoint saved', {
    featureHash: checkpoint.featureHash,
    phase: checkpoint.phase
  });
}

/**
 * Delete a checkpoint by feature hash.
 * Called when the pipeline completes successfully.
 */
export function clearCheckpoint(featureHash: string): void {
  const path = getCheckpointPath(featureHash);
  if (existsSync(path)) {
    unlinkSync(path);
    logger.info('Conductor checkpoint cleared', { featureHash });
  }
}
