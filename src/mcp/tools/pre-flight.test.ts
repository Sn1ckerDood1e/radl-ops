import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

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

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    radlDir: '/tmp/test-radl',
    radlOpsDir: '/tmp/test-ops',
    knowledgeDir: '/tmp/test-knowledge',
    usageLogsDir: '/tmp/test-logs',
    sprintScript: '/tmp/test.sh',
    compoundScript: '/tmp/test-compound.sh',
  })),
}));

async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const { registerPreFlightTools } = await import('./pre-flight.js');
  registerPreFlightTools(mockServer as any);
  return handlers['pre_flight_check'];
}

describe('Pre-Flight Check Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers pre_flight_check tool', async () => {
    const tools: string[] = [];
    const mockServer = {
      tool: (...args: unknown[]) => {
        tools.push(args[0] as string);
      },
    };

    const { registerPreFlightTools } = await import('./pre-flight.js');
    registerPreFlightTools(mockServer as any);

    expect(tools).toContain('pre_flight_check');
  });

  it('all checks pass — returns ALL CHECKS PASSED', async () => {
    // Branch check: feature branch
    // Git status: clean
    // TypeCheck: passes
    // Secrets: no staged files
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('git branch --show-current')) return 'feat/phase-72';
      if (command.includes('git status --porcelain')) return '';
      if (command.includes('tsc --noEmit')) return '';
      if (command.includes('git diff --cached --name-only')) return '';
      if (command.includes('git diff --cached')) return '';
      return '';
    });

    // Sprint check: active sprint
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      phase: 'Phase 72',
      title: 'Engineering Autopilot',
      status: 'in_progress',
    }));

    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('# Pre-Flight Checklist');
    expect(text).toContain('[PASS] Branch: feat/phase-72 (not main/master)');
    expect(text).toContain('[PASS] Sprint: Phase 72');
    expect(text).toContain('[PASS] Clean tree: No uncommitted changes');
    expect(text).toContain('[PASS] TypeCheck: Passed');
    expect(text).toContain('[PASS] Secrets scan:');
    expect(text).toContain('ALL CHECKS PASSED');
  });

  it('branch check fails when on main', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('git branch --show-current')) return 'main';
      if (command.includes('git status --porcelain')) return '';
      if (command.includes('tsc --noEmit')) return '';
      if (command.includes('git diff --cached --name-only')) return '';
      return '';
    });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      phase: 'Phase 72',
      title: 'Test',
      status: 'active',
    }));

    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('[FAIL] Branch: main (BLOCKED');
    expect(text).toContain('FAILED');
  });

  it('branch check fails when on master', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('git branch --show-current')) return 'master';
      if (command.includes('git status --porcelain')) return '';
      if (command.includes('tsc --noEmit')) return '';
      if (command.includes('git diff --cached --name-only')) return '';
      return '';
    });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      phase: 'Phase 72',
      title: 'Test',
      status: 'active',
    }));

    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('[FAIL] Branch: master (BLOCKED');
  });

  it('sprint check fails when no current.json', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('git branch --show-current')) return 'feat/test';
      if (command.includes('git status --porcelain')) return '';
      if (command.includes('tsc --noEmit')) return '';
      if (command.includes('git diff --cached --name-only')) return '';
      return '';
    });

    vi.mocked(existsSync).mockReturnValue(false);

    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('[FAIL] Sprint: No active sprint');
    expect(text).toContain('FAILED');
  });

  it('sprint check fails when status is completed', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('git branch --show-current')) return 'feat/test';
      if (command.includes('git status --porcelain')) return '';
      if (command.includes('tsc --noEmit')) return '';
      if (command.includes('git diff --cached --name-only')) return '';
      return '';
    });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      phase: 'Phase 71',
      title: 'Old Sprint',
      status: 'completed',
    }));

    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('[FAIL] Sprint:');
    expect(text).toContain('completed');
  });

  it('clean tree check fails with uncommitted changes', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('git branch --show-current')) return 'feat/test';
      if (command.includes('git status --porcelain')) return 'M src/file1.ts\nM src/file2.ts\n?? src/new.ts';
      if (command.includes('tsc --noEmit')) return '';
      if (command.includes('git diff --cached --name-only')) return '';
      return '';
    });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      phase: 'Phase 72',
      title: 'Test',
      status: 'active',
    }));

    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('[FAIL] Clean tree: 3 uncommitted files');
  });

  it('typecheck failure is detected', async () => {
    const tscError = new Error('Command failed') as any;
    tscError.stderr = 'src/test.ts(10,5): error TS2304: Cannot find name "foo".\nsrc/test.ts(20,3): error TS2322: Type mismatch.';

    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('git branch --show-current')) return 'feat/test';
      if (command.includes('git status --porcelain')) return '';
      if (command.includes('tsc --noEmit')) throw tscError;
      if (command.includes('git diff --cached --name-only')) return '';
      return '';
    });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      phase: 'Phase 72',
      title: 'Test',
      status: 'active',
    }));

    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('[FAIL] TypeCheck: 2 errors found');
    expect(text).toContain('FAILED');
  });

  it('secret detection catches API_KEY patterns', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('git branch --show-current')) return 'feat/test';
      if (command.includes('git status --porcelain')) return '';
      if (command.includes('tsc --noEmit')) return '';
      if (command.includes('git diff --cached --name-only')) return 'src/config.ts';
      if (command.includes('git diff --cached')) return '+const key = API_KEY=sk-1234\n+const secret = SECRET_KEY=abc';
      return '';
    });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      phase: 'Phase 72',
      title: 'Test',
      status: 'active',
    }));

    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('[FAIL] Secrets scan: Potential secrets detected');
    expect(text).toContain('API_KEY');
    expect(text).toContain('SECRET_KEY');
  });

  it('secret detection passes when no secrets in staged files', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('git branch --show-current')) return 'feat/test';
      if (command.includes('git status --porcelain')) return '';
      if (command.includes('tsc --noEmit')) return '';
      if (command.includes('git diff --cached --name-only')) return 'src/utils.ts';
      if (command.includes('git diff --cached')) return '+export function helper() { return true; }';
      return '';
    });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      phase: 'Phase 72',
      title: 'Test',
      status: 'active',
    }));

    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('[PASS] Secrets scan: No secrets detected');
  });

  it('reports correct number of failed checks', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('git branch --show-current')) return 'main'; // FAIL
      if (command.includes('git status --porcelain')) return 'M file.ts'; // FAIL
      if (command.includes('tsc --noEmit')) {
        const err = new Error('fail') as any;
        err.stderr = 'error TS2304: test';
        throw err;
      }
      if (command.includes('git diff --cached --name-only')) return '';
      return '';
    });

    vi.mocked(existsSync).mockReturnValue(false); // Sprint FAIL

    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('4 CHECKS FAILED');
  });

  it('logs pre-flight start and completion', async () => {
    vi.mocked(execSync).mockReturnValue('feat/test');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      phase: 'Phase 72',
      title: 'Test',
      status: 'active',
    }));

    const handler = await getHandler();
    await handler({});

    const { logger } = await import('../../config/logger.js');
    expect(logger.info).toHaveBeenCalledWith('Pre-flight check started');
    expect(logger.info).toHaveBeenCalledWith(
      'Pre-flight check complete',
      expect.objectContaining({
        results: expect.any(Array),
      })
    );
  });

  it('uses 60 second timeout for typecheck', async () => {
    vi.mocked(execSync).mockReturnValue('');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      phase: 'Phase 72',
      title: 'Test',
      status: 'active',
    }));

    const handler = await getHandler();
    await handler({});

    const calls = vi.mocked(execSync).mock.calls;
    const tscCall = calls.find(c => String(c[0]).includes('tsc --noEmit'));
    expect(tscCall).toBeDefined();
    expect(tscCall![1]).toMatchObject({ timeout: 60000 });
  });
});
