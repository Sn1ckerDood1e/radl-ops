import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeFeatureHash,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
} from './conductor-checkpoint.js';
import type { ConductorCheckpoint } from './conductor-checkpoint.js';

// Mock file system
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({ knowledgeDir: '/tmp/test-knowledge' })),
}));

vi.mock('../../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

function makeCheckpoint(overrides: Partial<ConductorCheckpoint> = {}): ConductorCheckpoint {
  return {
    featureHash: 'abc123',
    phase: 'spec',
    completedAt: '2026-02-16T12:00:00Z',
    totalCostSoFar: 0.05,
    ...overrides,
  };
}

describe('computeFeatureHash', () => {
  it('returns a 16-char hex string', () => {
    const hash = computeFeatureHash('Add login form');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for same input', () => {
    const hash1 = computeFeatureHash('Add login form');
    const hash2 = computeFeatureHash('Add login form');
    expect(hash1).toBe(hash2);
  });

  it('differs for different features', () => {
    const hash1 = computeFeatureHash('Add login');
    const hash2 = computeFeatureHash('Add signup');
    expect(hash1).not.toBe(hash2);
  });

  it('includes context in hash computation', () => {
    const hash1 = computeFeatureHash('Add auth', 'with JWT');
    const hash2 = computeFeatureHash('Add auth', 'with OAuth');
    expect(hash1).not.toBe(hash2);
  });

  it('treats undefined context same as empty context', () => {
    const hash1 = computeFeatureHash('Add auth');
    const hash2 = computeFeatureHash('Add auth', '');
    expect(hash1).toBe(hash2);
  });
});

describe('loadCheckpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no file exists', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadCheckpoint('abc123')).toBeNull();
  });

  it('loads and returns valid checkpoint', () => {
    const checkpoint = makeCheckpoint({ featureHash: 'abc123' });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(checkpoint));

    const result = loadCheckpoint('abc123');
    expect(result).toEqual(checkpoint);
  });

  it('returns null on hash mismatch', () => {
    const checkpoint = makeCheckpoint({ featureHash: 'wrong_hash' });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(checkpoint));

    expect(loadCheckpoint('abc123')).toBeNull();
  });

  it('returns null on corrupted JSON', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('not valid json{{{');

    expect(loadCheckpoint('abc123')).toBeNull();
  });

  it('returns null when readFileSync throws', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('EACCES'); });

    expect(loadCheckpoint('abc123')).toBeNull();
  });
});

describe('saveCheckpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it('writes checkpoint as formatted JSON', () => {
    const checkpoint = makeCheckpoint();
    saveCheckpoint(checkpoint);

    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('abc123.json'),
      JSON.stringify(checkpoint, null, 2),
    );
  });
});

describe('clearCheckpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes file when it exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    clearCheckpoint('abc123');
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining('abc123.json'));
  });

  it('does nothing when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    clearCheckpoint('abc123');
    expect(unlinkSync).not.toHaveBeenCalled();
  });
});
