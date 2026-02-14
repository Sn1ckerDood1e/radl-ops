import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  sanitizeForPrompt,
  parseDecomposition,
  DecompositionSchema,
  DECOMPOSE_RESULT_TOOL,
  DECOMPOSE_SYSTEM_PROMPT,
} from './decomposition.js';

describe('sanitizeForPrompt', () => {
  it('escapes HTML angle brackets', () => {
    expect(sanitizeForPrompt('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert("xss")&lt;/script&gt;'
    );
  });

  it('replaces backticks with single quotes', () => {
    expect(sanitizeForPrompt('use `code` here')).toBe("use 'code' here");
  });

  it('replaces newlines with spaces', () => {
    expect(sanitizeForPrompt('line1\nline2\nline3')).toBe('line1 line2 line3');
  });

  it('trims whitespace', () => {
    expect(sanitizeForPrompt('  hello  ')).toBe('hello');
  });
});

describe('parseDecomposition', () => {
  it('parses valid tool_use response', () => {
    const response = {
      content: [{
        type: 'tool_use' as const,
        id: 'test',
        name: 'task_decomposition',
        input: {
          tasks: [{
            id: 1,
            title: 'Add migration',
            description: 'Create migration for new field',
            activeForm: 'Adding migration',
            type: 'migration',
            files: ['prisma/schema.prisma'],
            dependsOn: [],
            estimateMinutes: 15,
          }],
          executionStrategy: 'sequential',
          rationale: 'Simple change',
          totalEstimateMinutes: 15,
          teamRecommendation: 'No team needed',
        },
      }],
    } as unknown as Anthropic.Message;

    const result = parseDecomposition(response);
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
    expect(result!.tasks[0].title).toBe('Add migration');
    expect(result!.executionStrategy).toBe('sequential');
  });

  it('returns null for missing tool_use block', () => {
    const response = {
      content: [{
        type: 'text' as const,
        text: 'No tool use here',
      }],
    } as unknown as Anthropic.Message;

    expect(parseDecomposition(response)).toBeNull();
  });

  it('returns null for invalid schema', () => {
    const response = {
      content: [{
        type: 'tool_use' as const,
        id: 'test',
        name: 'task_decomposition',
        input: {
          tasks: [{ id: 'not-a-number' }], // invalid
          executionStrategy: 'invalid',
        },
      }],
    } as unknown as Anthropic.Message;

    expect(parseDecomposition(response)).toBeNull();
  });
});

describe('DecompositionSchema', () => {
  it('validates a complete decomposition', () => {
    const valid = {
      tasks: [{
        id: 1,
        title: 'Test task',
        description: 'Desc',
        activeForm: 'Testing',
        type: 'test',
        files: ['src/test.ts'],
        dependsOn: [],
        estimateMinutes: 30,
      }],
      executionStrategy: 'sequential',
      rationale: 'Simple',
      totalEstimateMinutes: 30,
      teamRecommendation: 'No team',
    };

    expect(() => DecompositionSchema.parse(valid)).not.toThrow();
  });

  it('rejects invalid task type', () => {
    const invalid = {
      tasks: [{
        id: 1,
        title: 'Test',
        description: 'Desc',
        activeForm: 'Testing',
        type: 'invalid-type',
        files: [],
        dependsOn: [],
        estimateMinutes: 10,
      }],
      executionStrategy: 'sequential',
      rationale: 'Simple',
      totalEstimateMinutes: 10,
      teamRecommendation: 'No team',
    };

    expect(() => DecompositionSchema.parse(invalid)).toThrow();
  });
});

describe('DECOMPOSE_RESULT_TOOL', () => {
  it('has the correct tool name', () => {
    expect(DECOMPOSE_RESULT_TOOL.name).toBe('task_decomposition');
  });

  it('requires all fields', () => {
    const required = (DECOMPOSE_RESULT_TOOL.input_schema as Record<string, unknown>).required;
    expect(required).toContain('tasks');
    expect(required).toContain('executionStrategy');
    expect(required).toContain('rationale');
  });
});

describe('DECOMPOSE_SYSTEM_PROMPT', () => {
  it('contains key instructions', () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain('task_decomposition');
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain('3-7 concrete tasks');
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain('getUser()');
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain('Trace BOTH read and write');
  });
});
