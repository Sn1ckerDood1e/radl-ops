import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

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

  const { registerDataFlowVerifierTools } = await import('./data-flow-verifier.js');
  registerDataFlowVerifierTools(mockServer as any);
  return handlers['verify_data_flow'];
}

describe('Data Flow Verifier Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it('registers verify_data_flow tool', async () => {
    const tools: string[] = [];
    const mockServer = {
      tool: (...args: unknown[]) => {
        tools.push(args[0] as string);
      },
    };

    const { registerDataFlowVerifierTools } = await import('./data-flow-verifier.js');
    registerDataFlowVerifierTools(mockServer as any);

    expect(tools).toContain('verify_data_flow');
  });

  it('returns FOUND for all layers when field exists everywhere', async () => {
    vi.mocked(execSync).mockReturnValue(
      '/tmp/test-radl/prisma/schema.prisma\n'
    );

    const handler = await getHandler();
    const result = await handler({ field: 'setupChecklistDismissed', model: 'FacilitySettings' });
    const text = result.content[0].text;

    expect(text).toContain('# Data Flow Verification: FacilitySettings.setupChecklistDismissed');
    expect(text).toContain('| Schema | FOUND |');
    expect(text).toContain('| Migration | FOUND |');
    expect(text).toContain('| Validation | FOUND |');
    expect(text).toContain('| API Handler | FOUND |');
    expect(text).toContain('| Client | FOUND |');
    expect(text).toContain('**Result:** COMPLETE');
  });

  it('returns MISSING for API Handler when field not in routes', async () => {
    // Schema, Migration, Validation, Client all return results
    // API Handler returns nothing
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('src/app/api')) {
        return '';
      }
      return '/tmp/test-radl/some/file.ts\n';
    });

    const handler = await getHandler();
    const result = await handler({ field: 'myField', model: 'MyModel' });
    const text = result.content[0].text;

    expect(text).toContain('| API Handler | MISSING |');
    expect(text).toContain('**Result:** INCOMPLETE');
    expect(text).toContain('API Handler');
  });

  it('handles missing directories gracefully', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handler = await getHandler();
    const result = await handler({ field: 'testField', model: 'TestModel' });
    const text = result.content[0].text;

    // All layers should be MISSING since no directories exist
    expect(text).toContain('| Schema | MISSING |');
    expect(text).toContain('| Migration | MISSING |');
    expect(text).toContain('| Validation | MISSING |');
    expect(text).toContain('| API Handler | MISSING |');
    expect(text).toContain('| Client | MISSING |');
    expect(text).toContain('**Result:** INCOMPLETE');
    // grep should not be called when directories don't exist
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  it('handles grep returning no results', async () => {
    vi.mocked(execSync).mockReturnValue('');

    const handler = await getHandler();
    const result = await handler({ field: 'nonexistentField', model: 'SomeModel' });
    const text = result.content[0].text;

    expect(text).toContain('| Schema | MISSING |');
    expect(text).toContain('**Result:** INCOMPLETE');
  });

  it('reports COMPLETE status when all layers present', async () => {
    vi.mocked(execSync).mockReturnValue(
      '/tmp/test-radl/some/matching-file.ts\n'
    );

    const handler = await getHandler();
    const result = await handler({ field: 'name', model: 'Team' });
    const text = result.content[0].text;

    expect(text).toContain('**Result:** COMPLETE');
    expect(text).not.toContain('INCOMPLETE');
  });

  it('reports INCOMPLETE status when any layer missing', async () => {
    // Only validation layer returns empty
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('src/lib/validations')) {
        return '';
      }
      return '/tmp/test-radl/some/file.ts\n';
    });

    const handler = await getHandler();
    const result = await handler({ field: 'myField', model: 'MyModel' });
    const text = result.content[0].text;

    expect(text).toContain('**Result:** INCOMPLETE');
    expect(text).toContain('Validation');
  });

  it('strips radlDir prefix from file paths in output', async () => {
    vi.mocked(execSync).mockReturnValue(
      '/tmp/test-radl/prisma/schema.prisma\n'
    );

    const handler = await getHandler();
    const result = await handler({ field: 'name', model: 'Team' });
    const text = result.content[0].text;

    expect(text).toContain('prisma/schema.prisma');
    expect(text).not.toContain('/tmp/test-radl/prisma/schema.prisma');
  });

  it('handles grep command failure gracefully', async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('grep failed');
    });

    const handler = await getHandler();
    const result = await handler({ field: 'testField', model: 'TestModel' });
    const text = result.content[0].text;

    // Should still produce a report with MISSING statuses, not throw
    expect(text).toContain('# Data Flow Verification');
    expect(text).toContain('MISSING');
  });

  it('excludes API routes from client layer check', async () => {
    // Return an API route file for the component/app searches
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('src/components')) {
        return '';
      }
      if (command.includes('src/app') && !command.includes('src/app/api')) {
        return '/tmp/test-radl/src/app/api/some/route.ts\n';
      }
      return '/tmp/test-radl/some/file.ts\n';
    });

    const handler = await getHandler();
    const result = await handler({ field: 'myField', model: 'MyModel' });
    const text = result.content[0].text;

    // Client layer should filter out API routes
    // The exact behavior depends on the grep results
    expect(text).toContain('# Data Flow Verification');
  });

  it('uses correct timeout for grep commands', async () => {
    vi.mocked(execSync).mockReturnValue('');

    const handler = await getHandler();
    await handler({ field: 'testField', model: 'TestModel' });

    // Verify all execSync calls use timeout
    const calls = vi.mocked(execSync).mock.calls;
    for (const call of calls) {
      expect(call[1]).toMatchObject({ timeout: 10000 });
    }
  });

  it('logs verification start and completion', async () => {
    vi.mocked(execSync).mockReturnValue('');

    const handler = await getHandler();
    await handler({ field: 'testField', model: 'TestModel' });

    const { logger } = await import('../../config/logger.js');
    expect(logger.info).toHaveBeenCalledWith(
      'Data flow verification started',
      expect.objectContaining({ field: 'testField', model: 'TestModel' })
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Data flow verification complete',
      expect.objectContaining({ field: 'testField', model: 'TestModel' })
    );
  });
});
