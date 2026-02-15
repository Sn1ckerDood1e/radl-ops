/**
 * Acceptance Criteria Extractor
 *
 * Extracts "should/must/can" statements from conductor specs.
 * Classifies each as: functional, validation, navigation, error-handling, permission.
 * Generates Playwright test skeletons with TODOs.
 */

// ============================================
// Types
// ============================================

export type CriterionType = 'functional' | 'validation' | 'navigation' | 'error-handling' | 'permission';

export interface AcceptanceCriterion {
  id: number;
  text: string;
  type: CriterionType;
  source: 'regex' | 'ai';
}

export interface TestSkeleton {
  filePath: string;
  content: string;
  criteriaCount: number;
}

// ============================================
// Constants
// ============================================

const CRITERIA_PATTERNS = [
  /(?:^|\n)\s*[-*]\s*((?:should|must|can|shall|will)\s+.+?)(?=\n|$)/gi,
  /(?:^|\n)\s*\d+\.\s*((?:should|must|can|shall|will)\s+.+?)(?=\n|$)/gi,
  /(?:^|\n)\s*[-*]\s*(?:users?|admins?|coaches?|athletes?)\s+((?:should|must|can|shall|will)\s+.+?)(?=\n|$)/gi,
  /(?:^|\n)\s*[-*]\s*((?:display|show|render|navigate|redirect|validate|prevent|allow|restrict|require)\s+.+?)(?=\n|$)/gi,
];

const TYPE_KEYWORDS: Record<CriterionType, RegExp> = {
  'permission': /(?:permission|role|\badmin\b|\bauth\b|restrict|allow|deny|access|forbid|unauthorized)/i,
  'validation': /(?:validat|required|invalid|error message|format|\bmin\b|\bmax\b|length|empty|blank)/i,
  'navigation': /(?:navigate|redirect|\broute\b|\bpage\b|\burl\b|\blink\b|\bback\b|forward|\btab\b)/i,
  'error-handling': /(?:\berror\b|\bfail|catch|fallback|retry|timeout|unavailable|offline|graceful)/i,
  'functional': /./,  // Default — matches everything
};

// ============================================
// Core Logic
// ============================================

/**
 * Extract acceptance criteria from a spec string.
 * Uses regex to find "should/must/can" statements and classifies them.
 */
export function extractAcceptanceCriteria(spec: string): AcceptanceCriterion[] {
  const seen = new Set<string>();
  const criteria: AcceptanceCriterion[] = [];
  let nextId = 1;

  for (const pattern of CRITERIA_PATTERNS) {
    // Reset lastIndex for each pattern since they have the `g` flag
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(spec)) !== null) {
      const text = match[1].trim().replace(/\s+/g, ' ');

      // Deduplicate by normalized text
      const normalized = text.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      // Skip very short matches (noise)
      if (text.length < 10) continue;

      criteria.push({
        id: nextId++,
        text,
        type: classifyCriterion(text),
        source: 'regex',
      });
    }
  }

  return criteria;
}

/**
 * Classify a criterion by matching keywords.
 * Returns the first matching type (checked in priority order).
 */
export function classifyCriterion(text: string): CriterionType {
  const types: CriterionType[] = ['permission', 'validation', 'navigation', 'error-handling', 'functional'];
  for (const type of types) {
    if (TYPE_KEYWORDS[type].test(text)) {
      return type;
    }
  }
  return 'functional';
}

/**
 * Generate a Playwright test skeleton from acceptance criteria.
 */
export function generateTestSkeleton(criteria: AcceptanceCriterion[], title: string): TestSkeleton {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);

  const filePath = `e2e/${slug}.spec.ts`;

  const testCases = criteria.map(c => {
    const boilerplate = getBoilerplate(c.type);
    return [
      `  test('${escapeQuotes(c.text)}', async ({ page }) => {`,
      `    // Criterion #${c.id} [${c.type}]`,
      ...boilerplate.map(line => `    ${line}`),
      `    // TODO: Implement this test`,
      `  });`,
    ].join('\n');
  });

  const content = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test.describe('${escapeQuotes(title)}', () => {`,
    `  test.beforeEach(async ({ page }) => {`,
    `    // TODO: Set up test state (login, navigate, seed data)`,
    `  });`,
    ``,
    testCases.join('\n\n'),
    `});`,
    ``,
  ].join('\n');

  return {
    filePath,
    content,
    criteriaCount: criteria.length,
  };
}

/**
 * Get type-appropriate boilerplate for a test case.
 */
function getBoilerplate(type: CriterionType): string[] {
  switch (type) {
    case 'navigation':
      return [
        `await page.goto('/target-page');`,
        `await expect(page).toHaveURL(/expected-pattern/);`,
      ];
    case 'validation':
      return [
        `await page.getByRole('textbox', { name: 'field' }).fill('invalid-value');`,
        `await page.getByRole('button', { name: 'Submit' }).click();`,
        `await expect(page.getByText('Error message')).toBeVisible();`,
      ];
    case 'permission':
      return [
        `// Login as user with specific role`,
        `await page.goto('/protected-page');`,
        `await expect(page.getByRole('button', { name: 'Action' })).toBeVisible();`,
      ];
    case 'error-handling':
      return [
        `// Simulate error condition`,
        `await page.route('**/api/**', route => route.abort());`,
        `await expect(page.getByText('Error')).toBeVisible();`,
      ];
    case 'functional':
    default:
      return [
        `await page.getByRole('button', { name: 'Action' }).click();`,
        `await expect(page.getByText('Expected result')).toBeVisible();`,
      ];
  }
}

/**
 * Escape single quotes for use in test names.
 */
function escapeQuotes(text: string): string {
  return text.replace(/'/g, "\\'");
}

/**
 * Format criteria as a numbered list for display.
 */
export function formatCriteriaList(criteria: AcceptanceCriterion[]): string {
  if (criteria.length === 0) {
    return 'No acceptance criteria found in the spec.';
  }

  const byType = new Map<CriterionType, AcceptanceCriterion[]>();
  for (const c of criteria) {
    const list = byType.get(c.type) ?? [];
    byType.set(c.type, [...list, c]);
  }

  const lines: string[] = [
    `## Acceptance Criteria (${criteria.length})`,
    '',
  ];

  const typeOrder: CriterionType[] = ['functional', 'validation', 'navigation', 'error-handling', 'permission'];

  for (const type of typeOrder) {
    const items = byType.get(type);
    if (!items || items.length === 0) continue;

    lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)} (${items.length})`);
    for (const item of items) {
      lines.push(`${item.id}. ${item.text}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
