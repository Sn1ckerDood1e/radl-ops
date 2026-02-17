import { describe, it, expect } from 'vitest';
import { parseAgentOutput, getNumericField, isSuccessStatus } from './agent-output-parser.js';

describe('parseAgentOutput', () => {
  it('parses single KEY:VALUE pair', () => {
    const result = parseAgentOutput('STATUS: done');
    expect(result).toEqual({ status: 'done' });
  });

  it('parses multiple KEY:VALUE pairs', () => {
    const result = parseAgentOutput(
      'STATUS: pass\nFILES_CHANGED: 3\nTESTS_PASSED: 12',
    );
    expect(result).toEqual({
      status: 'pass',
      files_changed: '3',
      tests_passed: '12',
    });
  });

  it('handles multi-line values', () => {
    const result = parseAgentOutput(
      'STATUS: retry\nISSUES: Missing error handling\n  in the login route\n  and signup route',
    );
    expect(result.status).toBe('retry');
    expect(result.issues).toContain('Missing error handling');
    expect(result.issues).toContain('in the login route');
    expect(result.issues).toContain('and signup route');
  });

  it('returns empty object for empty input', () => {
    expect(parseAgentOutput('')).toEqual({});
  });

  it('ignores lines before first KEY:VALUE', () => {
    const result = parseAgentOutput('Some preamble\nAnother line\nSTATUS: done');
    expect(result).toEqual({ status: 'done' });
  });

  it('lowercases keys', () => {
    const result = parseAgentOutput('MY_KEY: value');
    expect(result).toHaveProperty('my_key', 'value');
    expect(result).not.toHaveProperty('MY_KEY');
  });

  it('trims values', () => {
    const result = parseAgentOutput('STATUS:   done  ');
    expect(result.status).toBe('done');
  });

  it('handles keys with numbers', () => {
    const result = parseAgentOutput('STEP2_RESULT: ok');
    expect(result).toHaveProperty('step2_result', 'ok');
  });
});

describe('getNumericField', () => {
  it('extracts numeric value', () => {
    const parsed = { files_changed: '3', status: 'done' };
    expect(getNumericField(parsed, 'files_changed')).toBe(3);
  });

  it('returns undefined for non-numeric value', () => {
    const parsed = { status: 'done' };
    expect(getNumericField(parsed, 'status')).toBeUndefined();
  });

  it('returns undefined for missing key', () => {
    const parsed = { status: 'done' };
    expect(getNumericField(parsed, 'missing')).toBeUndefined();
  });

  it('handles case-insensitive key lookup', () => {
    const parsed = { files_changed: '5' };
    expect(getNumericField(parsed, 'FILES_CHANGED')).toBe(5);
  });

  it('returns undefined for NaN values', () => {
    const parsed = { count: 'abc' };
    expect(getNumericField(parsed, 'count')).toBeUndefined();
  });

  it('returns undefined for Infinity', () => {
    const parsed = { count: 'Infinity' };
    expect(getNumericField(parsed, 'count')).toBeUndefined();
  });
});

describe('isSuccessStatus', () => {
  it('returns true for "done"', () => {
    expect(isSuccessStatus({ status: 'done' })).toBe(true);
  });

  it('returns true for "pass"', () => {
    expect(isSuccessStatus({ status: 'pass' })).toBe(true);
  });

  it('returns true for "success"', () => {
    expect(isSuccessStatus({ status: 'success' })).toBe(true);
  });

  it('returns false for "retry"', () => {
    expect(isSuccessStatus({ status: 'retry' })).toBe(false);
  });

  it('returns false for "fail"', () => {
    expect(isSuccessStatus({ status: 'fail' })).toBe(false);
  });

  it('returns false when status missing', () => {
    expect(isSuccessStatus({})).toBe(false);
  });

  it('handles case-insensitive status', () => {
    expect(isSuccessStatus({ status: 'DONE' })).toBe(true);
    expect(isSuccessStatus({ status: 'Pass' })).toBe(true);
  });
});
