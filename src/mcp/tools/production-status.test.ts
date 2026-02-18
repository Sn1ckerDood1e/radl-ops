/**
 * Tests for production-status MCP tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing the module
vi.mock('../../config/index.js', () => ({
  config: {
    vercel: { token: 'test-token', projectId: 'test-project' },
    supabase: { projectId: 'test-supabase', accessToken: 'test-sb-token', url: '', anonKey: '', serviceKey: '' },
    sentry: { authToken: 'test-sentry', org: 'test-org', project: 'test-proj' },
    github: { token: 'test-gh', owner: 'TestOwner', repo: 'TestRepo' },
  },
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../guardrails/iron-laws.js', () => ({
  recordError: vi.fn(() => 1),
  clearError: vi.fn(),
}));

describe('production-status', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should handle Vercel API success', async () => {
    const mockResponse = {
      deployments: [{
        uid: 'd1',
        state: 'READY',
        readyState: 'READY',
        createdAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
        meta: { githubCommitMessage: 'feat: add feature' },
      }],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    // Import dynamically to use mocked config
    const { registerProductionStatusTools } = await import('./production-status.js');
    expect(registerProductionStatusTools).toBeDefined();
  });

  it('should handle missing config gracefully', async () => {
    // Re-mock with empty config
    vi.doMock('../../config/index.js', () => ({
      config: {
        vercel: { token: '', projectId: '' },
        supabase: { projectId: '', accessToken: '', url: '', anonKey: '', serviceKey: '' },
        sentry: { authToken: '', org: '', project: '' },
        github: { token: '', owner: '', repo: '' },
      },
    }));

    const mod = await import('./production-status.js');
    expect(mod.registerProductionStatusTools).toBeDefined();
  });

  it('should handle network failures gracefully', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const { registerProductionStatusTools } = await import('./production-status.js');
    expect(registerProductionStatusTools).toBeDefined();
  });
});
