import { describe, it, expect } from 'vitest';
import {
  extractAcceptanceCriteria,
  classifyCriterion,
  generateTestSkeleton,
  formatCriteriaList,
} from './acceptance-criteria.js';

describe('extractAcceptanceCriteria', () => {
  it('extracts "should" statements from bullet lists', () => {
    const spec = `
## Requirements
- Should display a list of athletes
- Must validate email format
- Can navigate to profile page
    `;
    const criteria = extractAcceptanceCriteria(spec);
    expect(criteria.length).toBe(3);
    expect(criteria[0].text).toContain('display a list of athletes');
    expect(criteria[1].text).toContain('validate email format');
    expect(criteria[2].text).toContain('navigate to profile page');
  });

  it('extracts from numbered lists', () => {
    const spec = `
1. Should allow admin to create teams
2. Must restrict access to team settings
    `;
    const criteria = extractAcceptanceCriteria(spec);
    expect(criteria.length).toBe(2);
  });

  it('extracts action verbs (display, show, etc.)', () => {
    const spec = `
- Display athlete name and number
- Show error message on invalid input
- Navigate to dashboard after login
    `;
    const criteria = extractAcceptanceCriteria(spec);
    expect(criteria.length).toBe(3);
  });

  it('deduplicates identical criteria', () => {
    const spec = `
- Should display a list of athletes
- should display a list of athletes
    `;
    const criteria = extractAcceptanceCriteria(spec);
    expect(criteria.length).toBe(1);
  });

  it('skips very short matches', () => {
    const spec = `
- Should do
- Must validate all form fields properly
    `;
    const criteria = extractAcceptanceCriteria(spec);
    expect(criteria.length).toBe(1);
    expect(criteria[0].text).toContain('validate');
  });

  it('returns empty array for specs with no criteria', () => {
    const spec = 'This is a general description without any criteria.';
    const criteria = extractAcceptanceCriteria(spec);
    expect(criteria).toEqual([]);
  });
});

describe('classifyCriterion', () => {
  it('classifies permission criteria', () => {
    expect(classifyCriterion('restrict access to admin panel')).toBe('permission');
    expect(classifyCriterion('only allow coaches to modify lineups')).toBe('permission');
  });

  it('classifies validation criteria', () => {
    expect(classifyCriterion('validate email format before submission')).toBe('validation');
    expect(classifyCriterion('show error message for invalid input')).toBe('validation');
  });

  it('classifies navigation criteria', () => {
    expect(classifyCriterion('navigate to dashboard after login')).toBe('navigation');
    expect(classifyCriterion('redirect unauthenticated users to login page')).toBe('navigation');
  });

  it('classifies error-handling criteria', () => {
    expect(classifyCriterion('show fallback UI when API fails')).toBe('error-handling');
    expect(classifyCriterion('gracefully handle timeout errors')).toBe('error-handling');
  });

  it('defaults to functional', () => {
    expect(classifyCriterion('display a list of athletes sorted by name')).toBe('functional');
  });
});

describe('generateTestSkeleton', () => {
  it('generates a Playwright test file', () => {
    const criteria = [
      { id: 1, text: 'display athlete list', type: 'functional' as const, source: 'regex' as const },
      { id: 2, text: 'validate email format', type: 'validation' as const, source: 'regex' as const },
    ];
    const skeleton = generateTestSkeleton(criteria, 'Athlete Management');
    expect(skeleton.filePath).toBe('e2e/athlete-management.spec.ts');
    expect(skeleton.content).toContain("import { test, expect } from '@playwright/test'");
    expect(skeleton.content).toContain('display athlete list');
    expect(skeleton.content).toContain('validate email format');
    expect(skeleton.content).toContain('// TODO: Implement this test');
    expect(skeleton.criteriaCount).toBe(2);
  });

  it('includes type-appropriate boilerplate', () => {
    const criteria = [
      { id: 1, text: 'navigate to profile page', type: 'navigation' as const, source: 'regex' as const },
    ];
    const skeleton = generateTestSkeleton(criteria, 'Navigation');
    expect(skeleton.content).toContain('page.goto');
    expect(skeleton.content).toContain('toHaveURL');
  });

  it('escapes single quotes in test names', () => {
    const criteria = [
      { id: 1, text: "should display user's profile", type: 'functional' as const, source: 'regex' as const },
    ];
    const skeleton = generateTestSkeleton(criteria, 'Profile');
    expect(skeleton.content).toContain("\\'s profile");
  });
});

describe('formatCriteriaList', () => {
  it('formats criteria grouped by type', () => {
    const criteria = [
      { id: 1, text: 'display athletes', type: 'functional' as const, source: 'regex' as const },
      { id: 2, text: 'validate email', type: 'validation' as const, source: 'regex' as const },
    ];
    const output = formatCriteriaList(criteria);
    expect(output).toContain('## Acceptance Criteria (2)');
    expect(output).toContain('### Functional (1)');
    expect(output).toContain('### Validation (1)');
  });

  it('returns message for empty criteria', () => {
    const output = formatCriteriaList([]);
    expect(output).toContain('No acceptance criteria found');
  });
});
