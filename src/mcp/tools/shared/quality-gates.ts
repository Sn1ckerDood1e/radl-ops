/**
 * Sprint quality gate warnings (D1-D3).
 *
 * Extracted from sprint.ts to keep file sizes manageable.
 * These are non-blocking warnings appended to sprint_complete output.
 */

export function parseTimeToMinutes(timeStr: string): number {
  const hourMatch = timeStr.match(/(\d+(?:\.\d+)?)\s*h/i);
  const minMatch = timeStr.match(/(\d+)\s*m/i);
  let total = 0;
  if (hourMatch) total += parseFloat(hourMatch[1]) * 60;
  if (minMatch) total += parseInt(minMatch[1], 10);
  return total;
}

export interface QualityGateInput {
  /** Raw sprint data from filesystem (null if no sprint file found) */
  completedRaw: {
    completedTasks?: unknown[];
    blockers?: unknown[];
    estimate?: string;
  } | null;
  /** Fallback task count from sprint.sh output parsing */
  completedTaskCount: number;
  /** Actual time string from sprint_complete call */
  actualTime: string;
}

/**
 * Evaluate D1-D3 quality gates and return warning string.
 * Returns empty string if no warnings.
 */
export function evaluateQualityGates(input: QualityGateInput): string {
  const { completedRaw, completedTaskCount, actualTime } = input;
  const qualityWarnings: string[] = [];

  const taskCount = completedRaw && Array.isArray(completedRaw.completedTasks)
    ? completedRaw.completedTasks.length : completedTaskCount;
  const estimateStr = completedRaw ? String(completedRaw.estimate ?? '') : '';
  const estimateMinutes = estimateStr ? parseTimeToMinutes(estimateStr) : 0;
  const actualMinutes = parseTimeToMinutes(actualTime);

  // D1: Task granularity
  if (taskCount === 0) {
    qualityWarnings.push('QUALITY: 0 tasks recorded — consider tracking tasks for future sprints');
  } else if (taskCount === 1 && estimateMinutes >= 120) {
    qualityWarnings.push('QUALITY NOTE: 1 task on a ' + estimateStr + ' sprint — consider decomposing into smaller tasks');
  }

  // D2: Blocker tracking (only when sprint data exists — skip if no completedRaw)
  if (completedRaw) {
    const blockers = Array.isArray(completedRaw.blockers) ? completedRaw.blockers : [];
    if (blockers.length === 0) {
      qualityWarnings.push('QUALITY NOTE: 0 blockers recorded — if none occurred, great! Otherwise consider documenting them');
    }
  }

  // D3: Estimation accuracy red flag
  if (estimateMinutes > 0 && actualMinutes > 0 && actualMinutes < estimateMinutes * 0.3) {
    qualityWarnings.push(`QUALITY: Actual (${actualTime}) was <30% of estimate (${estimateStr}) — consider recalibrating estimates`);
  }

  if (qualityWarnings.length > 0) {
    return '\n' + qualityWarnings.join('\n');
  }
  return '';
}
