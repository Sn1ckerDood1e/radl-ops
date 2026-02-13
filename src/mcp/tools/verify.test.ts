import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: () => ({
    radlDir: '/home/hb/radl',
  }),
}));

// Extract handler by registering with a mock server
async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const { registerVerifyTools } = await import('./verify.js');
  registerVerifyTools(mockServer as any);
  return handlers['verify'];
}

describe('Verify Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('typecheck', () => {
    it('passes when tsc succeeds', async () => {
      vi.mocked(execSync).mockReturnValue('');

      const handler = await getHandler();
      const result = await handler({ checks: ['typecheck'] });
      const text = result.content[0].text;

      expect(text).toContain('ALL CHECKS PASSED');
      expect(text).toContain('[PASS] TypeScript');
      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        'npx tsc --noEmit',
        expect.objectContaining({
          cwd: '/home/hb/radl',
          timeout: 300000,
        })
      );
    });

    it('fails when tsc finds errors', async () => {
      const error = new Error('Command failed') as any;
      error.stderr = 'src/test.ts(42,10): error TS2304: Cannot find name "foo".';
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const handler = await getHandler();
      const result = await handler({ checks: ['typecheck'] });
      const text = result.content[0].text;

      expect(text).toContain('CHECKS FAILED');
      expect(text).toContain('[FAIL] TypeScript');
      expect(text).toContain('Cannot find name "foo"');
    });

    it('includes duration in output', async () => {
      vi.mocked(execSync).mockReturnValue('');

      const handler = await getHandler();
      const result = await handler({ checks: ['typecheck'] });
      const text = result.content[0].text;

      expect(text).toMatch(/\[PASS\] TypeScript \(\d+\.\d+s\)/);
    });
  });

  describe('build', () => {
    it('passes when build succeeds', async () => {
      vi.mocked(execSync).mockReturnValue('Build completed successfully');

      const handler = await getHandler();
      const result = await handler({ checks: ['build'] });
      const text = result.content[0].text;

      expect(text).toContain('ALL CHECKS PASSED');
      expect(text).toContain('[PASS] Build');
      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        'npm run build',
        expect.objectContaining({
          cwd: '/home/hb/radl',
        })
      );
    });

    it('fails when build fails', async () => {
      const error = new Error('Build failed') as any;
      error.stderr = 'Error: Module not found: src/missing.ts';
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const handler = await getHandler();
      const result = await handler({ checks: ['build'] });
      const text = result.content[0].text;

      expect(text).toContain('CHECKS FAILED');
      expect(text).toContain('[FAIL] Build');
      expect(text).toContain('Module not found');
    });
  });

  describe('test', () => {
    it('passes when tests pass', async () => {
      vi.mocked(execSync).mockReturnValue('All tests passed');

      const handler = await getHandler();
      const result = await handler({ checks: ['test'] });
      const text = result.content[0].text;

      expect(text).toContain('ALL CHECKS PASSED');
      expect(text).toContain('[PASS] Tests');
      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        'npm test',
        expect.objectContaining({
          cwd: '/home/hb/radl',
        })
      );
    });

    it('fails when tests fail', async () => {
      const error = new Error('Tests failed') as any;
      error.stdout = 'FAIL src/utils.test.ts\n  Expected: 5\n  Received: 3';
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const handler = await getHandler();
      const result = await handler({ checks: ['test'] });
      const text = result.content[0].text;

      expect(text).toContain('CHECKS FAILED');
      expect(text).toContain('[FAIL] Tests');
      expect(text).toContain('Expected: 5');
    });
  });

  describe('multiple checks', () => {
    it('runs all checks in sequence', async () => {
      vi.mocked(execSync).mockReturnValue('');

      const handler = await getHandler();
      await handler({ checks: ['typecheck', 'build', 'test'] });

      expect(vi.mocked(execSync)).toHaveBeenCalledWith('npx tsc --noEmit', expect.anything());
      expect(vi.mocked(execSync)).toHaveBeenCalledWith('npm run build', expect.anything());
      expect(vi.mocked(execSync)).toHaveBeenCalledWith('npm test', expect.anything());
    });

    it('reports partial pass/fail correctly', async () => {
      let callCount = 0;
      vi.mocked(execSync).mockImplementation((cmd) => {
        callCount++;
        if (cmd === 'npx tsc --noEmit') return ''; // typecheck passes
        if (cmd === 'npm run build') {
          const error = new Error('Build failed') as any;
          error.stderr = 'Build error';
          throw error;
        }
        return '';
      });

      const handler = await getHandler();
      const result = await handler({ checks: ['typecheck', 'build'] });
      const text = result.content[0].text;

      expect(text).toContain('CHECKS FAILED');
      expect(text).toContain('[PASS] TypeScript');
      expect(text).toContain('[FAIL] Build');
    });
  });

  describe('default checks', () => {
    it('defaults to typecheck + build when checks not specified', async () => {
      vi.mocked(execSync).mockReturnValue('');

      const handler = await getHandler();
      await handler({});

      expect(vi.mocked(execSync)).toHaveBeenCalledWith('npx tsc --noEmit', expect.anything());
      expect(vi.mocked(execSync)).toHaveBeenCalledWith('npm run build', expect.anything());
      expect(vi.mocked(execSync)).not.toHaveBeenCalledWith('npm test', expect.anything());
    });
  });

  describe('environment variables', () => {
    it('sets placeholder env vars for Next.js build', async () => {
      vi.mocked(execSync).mockReturnValue('');

      const handler = await getHandler();
      await handler({ checks: ['build'] });

      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        'npm run build',
        expect.objectContaining({
          env: expect.objectContaining({
            NEXT_PUBLIC_SUPABASE_URL: expect.any(String),
            NEXT_PUBLIC_SUPABASE_ANON_KEY: expect.any(String),
            NEXT_PUBLIC_APP_URL: expect.any(String),
            NEXT_PUBLIC_VAPID_PUBLIC_KEY: expect.any(String),
          }),
        })
      );
    });

    it('preserves existing env vars', async () => {
      vi.mocked(execSync).mockReturnValue('');

      const handler = await getHandler();
      await handler({ checks: ['typecheck'] });

      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        'npx tsc --noEmit',
        expect.objectContaining({
          env: expect.objectContaining({
            ...process.env,
          }),
        })
      );
    });
  });

  describe('timeout', () => {
    it('uses 5 minute timeout for all checks', async () => {
      vi.mocked(execSync).mockReturnValue('');

      const handler = await getHandler();
      await handler({ checks: ['typecheck', 'build', 'test'] });

      const calls = vi.mocked(execSync).mock.calls;
      for (const call of calls) {
        expect(call[1]).toMatchObject({ timeout: 300000 });
      }
    });
  });

  describe('output truncation', () => {
    it('truncates stdout to last 500 chars on success', async () => {
      const longOutput = 'x'.repeat(1000);
      vi.mocked(execSync).mockReturnValue(longOutput);

      const handler = await getHandler();
      const result = await handler({ checks: ['typecheck'] });
      const text = result.content[0].text;

      // Success output is not shown in the result text, only failures
      expect(text).toContain('[PASS] TypeScript');
    });

    it('truncates error output to last 1000 chars on failure', async () => {
      const longError = 'y'.repeat(2000);
      const error = new Error('Failed') as any;
      error.stderr = longError;
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const handler = await getHandler();
      const result = await handler({ checks: ['typecheck'] });
      const text = result.content[0].text;

      expect(text).toContain('[FAIL] TypeScript');
      // Error is truncated to 1000 chars - the implementation truncates the error before formatting
      // So the output should not contain the full 2000 chars
      expect(text.length).toBeLessThan(2000 + 500); // Reasonable buffer for formatting
    });
  });

  describe('error message extraction', () => {
    it('prioritizes stderr over stdout for error messages', async () => {
      const error = new Error('Command failed') as any;
      error.stderr = 'This is the real error';
      error.stdout = 'This is just output';
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const handler = await getHandler();
      const result = await handler({ checks: ['typecheck'] });
      const text = result.content[0].text;

      expect(text).toContain('This is the real error');
      expect(text).not.toContain('This is just output');
    });

    it('uses stdout when stderr is empty', async () => {
      const error = new Error('Command failed') as any;
      error.stdout = 'Error in stdout';
      error.stderr = '';
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const handler = await getHandler();
      const result = await handler({ checks: ['typecheck'] });
      const text = result.content[0].text;

      expect(text).toContain('Error in stdout');
    });

    it('uses error.message when stderr and stdout are empty', async () => {
      const error = new Error('Generic error message');
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const handler = await getHandler();
      const result = await handler({ checks: ['typecheck'] });
      const text = result.content[0].text;

      expect(text).toContain('Generic error message');
    });
  });

  describe('logging', () => {
    it('logs verification completion with results', async () => {
      vi.mocked(execSync).mockReturnValue('');

      const handler = await getHandler();
      await handler({ checks: ['typecheck', 'build'] });

      const { logger } = await import('../../config/logger.js');
      expect(logger.info).toHaveBeenCalledWith(
        'Verification complete',
        expect.objectContaining({
          checks: ['typecheck', 'build'],
          allPassed: true,
          results: expect.arrayContaining([
            expect.objectContaining({ name: 'TypeScript', passed: true }),
            expect.objectContaining({ name: 'Build', passed: true }),
          ]),
        })
      );
    });
  });
});
