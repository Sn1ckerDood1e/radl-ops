/**
 * Structured Agent Output Parser (Antfarm Pattern)
 *
 * Parses KEY:VALUE formatted output from agent teammates.
 * Convention: agents should output structured pairs like:
 *   STATUS: done|retry|fail
 *   ISSUES: description of problems
 *   FILES_CHANGED: 3
 *   TESTS_PASSED: 12
 *
 * Multi-line values are supported — lines without a KEY: prefix
 * are appended to the previous key's value.
 */

/**
 * Parse KEY:VALUE pairs from agent output text.
 * Keys are uppercase words/underscores, values are everything after the colon.
 * Multi-line values are concatenated with newlines.
 *
 * @returns Record with lowercase keys and trimmed string values
 */
export function parseAgentOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  let pendingKey: string | null = null;
  let pendingValue = '';

  for (const line of output.split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*):\s*(.*)$/);
    if (match) {
      // Flush previous key
      if (pendingKey) {
        result[pendingKey.toLowerCase()] = pendingValue.trim();
      }
      pendingKey = match[1];
      pendingValue = match[2];
    } else if (pendingKey) {
      // Continuation of previous value
      pendingValue += '\n' + line;
    }
  }

  // Flush last key
  if (pendingKey) {
    result[pendingKey.toLowerCase()] = pendingValue.trim();
  }

  return result;
}

/**
 * Extract a numeric value from parsed output.
 * Returns undefined if the key doesn't exist or isn't a number.
 */
export function getNumericField(
  parsed: Record<string, string>,
  key: string,
): number | undefined {
  const value = parsed[key.toLowerCase()];
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Check if parsed output indicates success.
 * Looks for STATUS field with value 'done', 'pass', or 'success'.
 */
export function isSuccessStatus(parsed: Record<string, string>): boolean {
  const status = (parsed.status ?? '').toLowerCase().trim();
  return status === 'done' || status === 'pass' || status === 'success';
}
