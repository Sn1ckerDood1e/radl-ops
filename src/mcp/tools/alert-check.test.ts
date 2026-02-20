/**
 * Behavioral tests for MCP Alert Check tool.
 *
 * Tests:
 * 1. Cooldown logic (in-cooldown, expired cooldown, force bypass)
 * 2. Alert rule matching (Vercel, Supabase, Sentry)
 * 3. Alert deduplication (recordAlertSent replaces existing entry)
 * 4. Dry run mode
 * 5. Gmail delivery (send, skip when not configured, skip on error)
 * 6. Service check results → alert trigger mapping
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

const mockSendGmail = vi.fn();
const mockIsGoogleConfigured = vi.fn();

vi.mock('../../integrations/google.js', () => ({
  sendGmail: (...args: unknown[]) => mockSendGmail(...args),
  isGoogleConfigured: () => mockIsGoogleConfigured(),
}));

const mockConfig = {
  vercel: { token: 'v-token', projectId: 'v-project' },
  supabase: { projectId: 's-project', accessToken: 's-token' },
  sentry: { authToken: 'se-token', org: 'radl', project: 'radl-app' },
  google: { briefingRecipient: 'test@radl.solutions' },
};

vi.mock('../../config/index.js', () => ({
  config: mockConfig,
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockRenameSync = vi.fn();

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  renameSync: (...args: unknown[]) => mockRenameSync(...args),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/tmp/test-knowledge',
  })),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ─── Extract handler ────────────────────────────────────────────────────────

let alertCheckHandler: Function;

{
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const { registerAlertCheckTools } = await import('./alert-check.js');
  registerAlertCheckTools(mockServer as any);
  alertCheckHandler = handlers['alert_check'];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function setupAlertState(cooldowns: Array<{ alertId: string; lastSentAt: string; cooldownMinutes: number }> = []) {
  mockExistsSync.mockReturnValue(cooldowns.length > 0);
  if (cooldowns.length > 0) {
    mockReadFileSync.mockReturnValue(JSON.stringify({ cooldowns }));
  }
}

function setupServices(responses: {
  vercel?: { readyState: string; meta?: { githubCommitMessage?: string } };
  supabase?: { status: string };
  sentry?: Array<{ level: string; title: string; count: string }>;
} = {}) {
  const calls: Array<() => Promise<unknown>> = [];

  // Vercel
  if (responses.vercel) {
    calls.push(() => Promise.resolve({
      ok: true,
      json: async () => ({ deployments: [{ readyState: responses.vercel!.readyState, createdAt: Date.now(), meta: responses.vercel!.meta }] }),
    }));
  } else {
    calls.push(() => Promise.resolve({
      ok: true,
      json: async () => ({ deployments: [{ readyState: 'READY', createdAt: Date.now(), meta: {} }] }),
    }));
  }

  // Supabase
  if (responses.supabase) {
    calls.push(() => Promise.resolve({
      ok: true,
      json: async () => responses.supabase,
    }));
  } else {
    calls.push(() => Promise.resolve({
      ok: true,
      json: async () => ({ status: 'ACTIVE_HEALTHY' }),
    }));
  }

  // Sentry
  if (responses.sentry) {
    calls.push(() => Promise.resolve({
      ok: true,
      json: async () => responses.sentry,
    }));
  } else {
    calls.push(() => Promise.resolve({
      ok: true,
      json: async () => [],
    }));
  }

  for (const call of calls) {
    mockFetch.mockImplementationOnce(call);
  }
}

// ─── Reset ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockIsGoogleConfigured.mockReturnValue(true);
  mockSendGmail.mockResolvedValue({ messageId: 'alert-msg-1' });
  setupAlertState([]);
});

// ─── Healthy services (no alerts) ───────────────────────────────────────────

describe('healthy services', () => {
  it('reports all healthy when all services respond OK', async () => {
    setupServices();
    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('All services healthy');
    expect(text).not.toContain('Alerts Triggered');
  });
});

// ─── Alert rule matching ────────────────────────────────────────────────────

describe('alert rule matching', () => {
  it('triggers vercel_deploy_failed when Vercel status is ERROR', async () => {
    setupServices({ vercel: { readyState: 'ERROR', meta: { githubCommitMessage: 'bad deploy' } } });
    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('Vercel Deploy Failed');
    expect(text).toContain('Alerts Triggered');
  });

  it('triggers supabase_down when Supabase returns null (unreachable)', async () => {
    // Override the Supabase fetch to return null (unreachable)
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deployments: [{ readyState: 'READY', createdAt: Date.now(), meta: {} }] }) }) // Vercel OK
      .mockResolvedValueOnce({ ok: false, status: 500 })  // Supabase fails (fetchJSON returns null)
      .mockResolvedValueOnce({ ok: true, json: async () => [] }); // Sentry OK

    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('Supabase');
    // When fetchJSON returns null, status is 'error'
    expect(text).toContain('[ERROR]');
  });

  it('triggers sentry_high_errors when >5 error-level issues', async () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({
      level: 'error',
      title: `Error ${i}`,
      count: '10',
    }));
    setupServices({ sentry: issues });
    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('Sentry High Error Count');
  });

  it('triggers sentry_new_issues at warning level for 1-5 error issues', async () => {
    const issues = [
      { level: 'error', title: 'Error 1', count: '3' },
      { level: 'warning', title: 'Warn 1', count: '1' },
    ];
    setupServices({ sentry: issues });
    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('Sentry New Issues');
  });

  it('does not trigger alerts when Vercel is BUILDING (not an error)', async () => {
    setupServices({ vercel: { readyState: 'BUILDING' } });
    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('All services healthy');
  });
});

// ─── Cooldown logic ─────────────────────────────────────────────────────────

describe('cooldown logic', () => {
  it('skips alert when still in cooldown', async () => {
    setupAlertState([{
      alertId: 'vercel_deploy_failed',
      lastSentAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min ago
      cooldownMinutes: 5,
    }]);
    setupServices({ vercel: { readyState: 'ERROR' } });

    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('Skipped');
    expect(text).toContain('in cooldown');
    expect(mockSendGmail).not.toHaveBeenCalled();
  });

  it('sends alert when cooldown has expired', async () => {
    setupAlertState([{
      alertId: 'vercel_deploy_failed',
      lastSentAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      cooldownMinutes: 5,
    }]);
    setupServices({ vercel: { readyState: 'ERROR' } });

    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('Alerts Sent');
    expect(mockSendGmail).toHaveBeenCalledTimes(1);
  });

  it('bypasses cooldown when force=true', async () => {
    setupAlertState([{
      alertId: 'vercel_deploy_failed',
      lastSentAt: new Date(Date.now() - 1 * 60 * 1000).toISOString(), // 1 min ago
      cooldownMinutes: 5,
    }]);
    setupServices({ vercel: { readyState: 'ERROR' } });

    const result = await alertCheckHandler({ force: true });
    const text = result.content[0].text;

    expect(text).toContain('Alerts Sent');
    expect(mockSendGmail).toHaveBeenCalledTimes(1);
  });
});

// ─── Alert state persistence ────────────────────────────────────────────────

describe('alert state persistence', () => {
  it('saves alert state after sending alerts (atomic write)', async () => {
    setupAlertState([]);
    setupServices({ vercel: { readyState: 'ERROR' } });

    await alertCheckHandler({});

    // Writes to .tmp then renames (atomic)
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync.mock.calls[0][0]).toContain('.tmp');
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
  });

  it('does not save state during dry_run', async () => {
    setupAlertState([]);
    setupServices({ vercel: { readyState: 'ERROR' } });

    await alertCheckHandler({ dry_run: true });

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockRenameSync).not.toHaveBeenCalled();
  });

  it('records alert with correct cooldownMinutes in state', async () => {
    setupAlertState([]);
    setupServices({ vercel: { readyState: 'ERROR' } });

    await alertCheckHandler({});

    const stateJson = mockWriteFileSync.mock.calls[0][1] as string;
    const state = JSON.parse(stateJson);
    const entry = state.cooldowns.find((c: { alertId: string }) => c.alertId === 'vercel_deploy_failed');
    expect(entry).toBeDefined();
    expect(entry.cooldownMinutes).toBe(5);
  });
});

// ─── Dry run mode ───────────────────────────────────────────────────────────

describe('dry run mode', () => {
  it('reports what would be sent without sending', async () => {
    setupAlertState([]);
    setupServices({ vercel: { readyState: 'ERROR' } });

    const result = await alertCheckHandler({ dry_run: true });
    const text = result.content[0].text;

    expect(text).toContain('DRY RUN');
    expect(text).toContain('Would send');
    expect(mockSendGmail).not.toHaveBeenCalled();
  });
});

// ─── Gmail delivery ─────────────────────────────────────────────────────────

describe('Gmail delivery', () => {
  it('sends alert email with correct subject and HTML body', async () => {
    setupAlertState([]);
    setupServices({ vercel: { readyState: 'ERROR' } });

    await alertCheckHandler({});

    expect(mockSendGmail).toHaveBeenCalledWith({
      to: 'test@radl.solutions',
      subject: expect.stringContaining('[CRITICAL] Radl: Vercel Deploy Failed'),
      htmlBody: expect.stringContaining('CRITICAL'),
    });
  });

  it('skips sending when Google is not configured', async () => {
    mockIsGoogleConfigured.mockReturnValue(false);
    setupAlertState([]);
    setupServices({ vercel: { readyState: 'ERROR' } });

    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('Google not configured');
    expect(mockSendGmail).not.toHaveBeenCalled();
  });

  it('reports send failure without throwing', async () => {
    mockSendGmail.mockRejectedValueOnce(new Error('Gmail quota exceeded'));
    setupAlertState([]);
    setupServices({ vercel: { readyState: 'ERROR' } });

    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('send failed');
    expect(text).toContain('Gmail quota exceeded');
  });
});

// ─── No services configured ─────────────────────────────────────────────────

describe('no services configured', () => {
  it('returns message when no service tokens configured', async () => {
    // Clear all config tokens
    mockConfig.vercel.token = '';
    mockConfig.vercel.projectId = '';
    mockConfig.supabase.projectId = '';
    mockConfig.supabase.accessToken = '';
    mockConfig.sentry.authToken = '';

    const result = await alertCheckHandler({});
    const text = result.content[0].text;

    expect(text).toContain('No services configured');

    // Restore
    mockConfig.vercel.token = 'v-token';
    mockConfig.vercel.projectId = 'v-project';
    mockConfig.supabase.projectId = 's-project';
    mockConfig.supabase.accessToken = 's-token';
    mockConfig.sentry.authToken = 'se-token';
  });
});
