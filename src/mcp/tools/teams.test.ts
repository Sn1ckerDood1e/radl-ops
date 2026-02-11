import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

// Extract handler by registering with a mock server
async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: Function) => {
      handlers[_name] = handler;
    },
  };

  const { registerTeamTools } = await import('./teams.js');
  registerTeamTools(mockServer as any);
  return handlers['team_recipe'];
}

describe('Team Recipe Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('review recipe', () => {
    it('returns 3 teammates with correct agent types', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'review' });
      const text = result.content[0].text;

      expect(text).toContain('security-reviewer');
      expect(text).toContain('code-reviewer');
      expect(text).toContain('architect');

      // Parse JSON from output
      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      expect(jsonMatch).toBeTruthy();
      const recipe = JSON.parse(jsonMatch![1]);
      expect(recipe.teammates).toHaveLength(3);
      expect(recipe.teammates[0].subagentType).toBe('security-reviewer');
      expect(recipe.teammates[1].subagentType).toBe('code-reviewer');
      expect(recipe.teammates[2].subagentType).toBe('architect');
    });
  });

  describe('feature recipe', () => {
    it('returns 3 teammates with plan approval note', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'feature' });
      const text = result.content[0].text;

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      expect(recipe.teammates).toHaveLength(3);
      // Setup steps should mention plan approval
      expect(text).toContain('plan approval');
    });
  });

  describe('context interpolation', () => {
    it('interpolates context into task descriptions', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'review', context: 'review the auth module for XSS' });
      const text = result.content[0].text;

      expect(text).toContain('review the auth module for XSS');

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      for (const t of recipe.teammates) {
        expect(t.taskDescription).toContain('review the auth module for XSS');
      }
    });
  });

  describe('files interpolation', () => {
    it('interpolates files into task descriptions', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'review', files: 'src/lib/auth, src/app/api' });
      const text = result.content[0].text;

      expect(text).toContain('src/lib/auth, src/app/api');

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      for (const t of recipe.teammates) {
        expect(t.taskDescription).toContain('src/lib/auth, src/app/api');
      }
    });
  });

  describe('model defaults', () => {
    it('defaults to sonnet model', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'review' });
      const text = result.content[0].text;

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      for (const t of recipe.teammates) {
        expect(t.model).toBe('sonnet');
      }
    });

    it('allows custom model override', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'review', model: 'opus' });
      const text = result.content[0].text;

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      for (const t of recipe.teammates) {
        expect(t.model).toBe('opus');
      }
    });
  });

  describe('migration recipe', () => {
    it('returns 3 teammates with correct names', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'migration' });
      const text = result.content[0].text;

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      expect(recipe.teammates).toHaveLength(3);
      expect(recipe.teammates[0].name).toBe('database-engineer');
      expect(recipe.teammates[1].name).toBe('integration-tester');
      expect(recipe.teammates[2].name).toBe('doc-updater');
    });

    it('includes enum migration tip', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'migration' });
      const text = result.content[0].text;

      expect(text).toContain('enum');
      expect(text).toContain('2 migrations');
    });

    it('includes cleanup with prisma migrate', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'migration' });
      const text = result.content[0].text;

      expect(text).toContain('prisma migrate');
      expect(text).toContain('shutdown_request');
    });

    it('interpolates context into task descriptions', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'migration', context: 'add rack_bay table' });
      const text = result.content[0].text;

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      for (const t of recipe.teammates) {
        expect(t.taskDescription).toContain('add rack_bay table');
      }
    });
  });

  describe('test-coverage recipe', () => {
    it('returns 3 testers', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'test-coverage' });
      const text = result.content[0].text;

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      expect(recipe.teammates).toHaveLength(3);
      expect(recipe.teammates[0].name).toBe('unit-tester');
      expect(recipe.teammates[1].name).toBe('integration-tester');
      expect(recipe.teammates[2].name).toBe('e2e-tester');
    });

    it('mentions parallel work in tips', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'test-coverage' });
      const text = result.content[0].text;

      expect(text).toContain('parallel');
    });

    it('includes cleanup with npm run test', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'test-coverage' });
      const text = result.content[0].text;

      expect(text).toContain('npm run test');
      expect(text).toContain('shutdown_request');
    });
  });

  describe('refactor recipe', () => {
    it('returns 3 code-reviewer teammates', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'refactor' });
      const text = result.content[0].text;

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      expect(recipe.teammates).toHaveLength(3);
      expect(recipe.teammates[0].name).toBe('dead-code-finder');
      expect(recipe.teammates[1].name).toBe('pattern-enforcer');
      expect(recipe.teammates[2].name).toBe('type-improver');
      for (const t of recipe.teammates) {
        expect(t.subagentType).toBe('code-reviewer');
      }
    });

    it('mentions read-only in tips', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'refactor' });
      const text = result.content[0].text;

      expect(text).toContain('read-only');
    });

    it('returns non-empty tips', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'refactor' });
      const text = result.content[0].text;

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      expect(recipe.tips.length).toBeGreaterThan(0);
    });

    it('includes cleanup with shutdown_request', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'refactor' });
      const text = result.content[0].text;

      expect(text).toContain('shutdown_request');
      expect(text).toContain('TeamDelete');
    });
  });

  describe('cleanup steps', () => {
    it.each(['review', 'feature', 'debug', 'research', 'migration', 'test-coverage', 'refactor'] as const)(
      '%s recipe returns cleanup steps',
      async (recipeType) => {
        const handler = await getHandler();
        const result = await handler({ recipe: recipeType });
        const text = result.content[0].text;

        const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
        const recipe = JSON.parse(jsonMatch![1]);
        expect(recipe.cleanupSteps.length).toBeGreaterThan(0);
        expect(text).toContain('shutdown_request');
        expect(text).toContain('TeamDelete');
      }
    );
  });

  describe('tips', () => {
    it.each(['review', 'feature', 'debug', 'research', 'migration', 'test-coverage', 'refactor'] as const)(
      '%s recipe returns non-empty tips',
      async (recipeType) => {
        const handler = await getHandler();
        const result = await handler({ recipe: recipeType });
        const text = result.content[0].text;

        const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
        const recipe = JSON.parse(jsonMatch![1]);
        expect(recipe.tips.length).toBeGreaterThan(0);
      }
    );
  });

  describe('debug recipe', () => {
    it('returns 3 investigators with different hypotheses', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'debug', context: 'login button not responding' });
      const text = result.content[0].text;

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      expect(recipe.teammates).toHaveLength(3);
      expect(recipe.teammates[0].name).toBe('data-investigator');
      expect(recipe.teammates[1].name).toBe('timing-investigator');
      expect(recipe.teammates[2].name).toBe('api-investigator');
    });
  });

  describe('research recipe', () => {
    it('uses read-only agent types', async () => {
      const handler = await getHandler();
      const result = await handler({ recipe: 'research' });
      const text = result.content[0].text;

      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      const recipe = JSON.parse(jsonMatch![1]);
      expect(recipe.teammates).toHaveLength(3);
      expect(recipe.teammates[0].subagentType).toBe('Explore');
      expect(recipe.teammates[1].subagentType).toBe('Plan');
      expect(recipe.teammates[2].subagentType).toBe('Explore');
    });
  });
});
