import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock dependencies before imports
vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getConfig } from '../../config/paths.js';
import { runInverseBloom } from './inverse-bloom.js';

let tempDir: string;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'inverse-bloom-test-'));
}

function mockConfig(knowledgeDir: string): void {
  vi.mocked(getConfig).mockReturnValue({
    radlDir: '/tmp/radl',
    radlOpsDir: '/tmp/radl-ops',
    knowledgeDir,
    usageLogsDir: '/tmp/usage-logs',
    sprintScript: '/tmp/radl-ops/scripts/sprint.sh',
    compoundScript: '/tmp/radl-ops/scripts/compound.sh',
  });
}

function writeKnowledge(dir: string, filename: string, data: unknown): void {
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2));
}

describe('runInverseBloom', () => {
  beforeEach(() => {
    tempDir = makeTempDir();
    mockConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns relevant items for matching tasks', () => {
    writeKnowledge(tempDir, 'patterns.json', {
      patterns: [
        { name: 'CSRF Protection', description: 'Include CSRF header in authenticated API calls', category: 'security' },
        { name: 'Toast Notifications', description: 'Use sonner toast for user feedback on mutations', category: 'ux' },
      ],
    });
    writeKnowledge(tempDir, 'lessons.json', {
      lessons: [
        { situation: 'Missing CSRF header on fetch', learning: 'Always add CSRF headers to authenticated requests' },
      ],
    });
    writeKnowledge(tempDir, 'antibodies.json', { antibodies: [] });
    writeKnowledge(tempDir, 'crystallized.json', { checks: [] });
    writeKnowledge(tempDir, 'causal-graph.json', { nodes: [], edges: [] });

    const results = runInverseBloom([
      { title: 'Add CSRF protection to new API endpoint', description: 'Implement authenticated API call with proper security headers' },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].taskTitle).toBe('Add CSRF protection to new API endpoint');
    expect(results[0].matchedItems.length).toBeGreaterThan(0);

    const sources = results[0].matchedItems.map(m => m.source);
    expect(sources).toContain('Pattern');
    expect(results[0].watchOutSection).toContain('Watch out for');
    expect(results[0].watchOutSection).toContain('CSRF');
  });

  it('handles empty knowledge gracefully', () => {
    // No knowledge files at all — directory exists but is empty
    const results = runInverseBloom([
      { title: 'Build login page', description: 'Create user authentication flow' },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].matchedItems).toHaveLength(0);
    expect(results[0].watchOutSection).toContain('No relevant knowledge items found');
  });

  it('filters inactive antibodies', () => {
    writeKnowledge(tempDir, 'patterns.json', { patterns: [] });
    writeKnowledge(tempDir, 'lessons.json', { lessons: [] });
    writeKnowledge(tempDir, 'antibodies.json', {
      antibodies: [
        { trigger: 'Prisma field missing in API handler', triggerKeywords: ['prisma', 'field', 'handler', 'api'], check: 'Verify handler processes new field', active: true },
        { trigger: 'Inactive auth bug', triggerKeywords: ['prisma', 'field', 'migration', 'schema'], check: 'This should not appear', active: false },
      ],
    });
    writeKnowledge(tempDir, 'crystallized.json', { checks: [] });
    writeKnowledge(tempDir, 'causal-graph.json', { nodes: [], edges: [] });

    const results = runInverseBloom([
      { title: 'Add prisma field to API handler', description: 'New field for schema migration' },
    ]);

    expect(results).toHaveLength(1);
    const antibodyMatches = results[0].matchedItems.filter(m => m.source === 'Antibody');
    expect(antibodyMatches).toHaveLength(1);
    expect(antibodyMatches[0].item).toBe('Prisma field missing in API handler');
  });

  it('filters inactive crystallized checks', () => {
    writeKnowledge(tempDir, 'patterns.json', { patterns: [] });
    writeKnowledge(tempDir, 'lessons.json', { lessons: [] });
    writeKnowledge(tempDir, 'antibodies.json', { antibodies: [] });
    writeKnowledge(tempDir, 'crystallized.json', {
      checks: [
        { trigger: 'Active enum check', triggerKeywords: ['enum', 'migration', 'prisma'], check: 'Split enum into 2 migrations', status: 'active' },
        { trigger: 'Proposed check', triggerKeywords: ['enum', 'migration', 'database'], check: 'Should not appear', status: 'proposed' },
        { trigger: 'Demoted check', triggerKeywords: ['enum', 'migration', 'sql'], check: 'Should not appear', status: 'demoted' },
      ],
    });
    writeKnowledge(tempDir, 'causal-graph.json', { nodes: [], edges: [] });

    const results = runInverseBloom([
      { title: 'Add enum migration for prisma', description: 'Database enum type change' },
    ]);

    const crystallizedMatches = results[0].matchedItems.filter(m => m.source === 'Crystallized');
    expect(crystallizedMatches).toHaveLength(1);
    expect(crystallizedMatches[0].item).toBe('Active enum check');
  });

  it('returns top 5 per task', () => {
    writeKnowledge(tempDir, 'patterns.json', {
      patterns: [
        { name: 'Pattern auth one', description: 'Auth security pattern for API endpoints' },
        { name: 'Pattern auth two', description: 'Auth validation for API routes' },
        { name: 'Pattern auth three', description: 'Auth middleware API protection' },
        { name: 'Pattern auth four', description: 'Auth token API verification' },
        { name: 'Pattern auth five', description: 'Auth session API management' },
        { name: 'Pattern auth six', description: 'Auth RBAC API permissions' },
        { name: 'Pattern auth seven', description: 'Auth rate limiting API calls' },
      ],
    });
    writeKnowledge(tempDir, 'lessons.json', { lessons: [] });
    writeKnowledge(tempDir, 'antibodies.json', { antibodies: [] });
    writeKnowledge(tempDir, 'crystallized.json', { checks: [] });
    writeKnowledge(tempDir, 'causal-graph.json', { nodes: [], edges: [] });

    const results = runInverseBloom([
      { title: 'Implement auth API endpoint', description: 'Build authentication API with security validation' },
    ]);

    expect(results[0].matchedItems.length).toBeLessThanOrEqual(5);
  });

  it('scores antibody triggerKeywords higher than generic word overlap', () => {
    writeKnowledge(tempDir, 'patterns.json', {
      patterns: [
        { name: 'Generic pattern', description: 'Something about prisma and fields in general' },
      ],
    });
    writeKnowledge(tempDir, 'lessons.json', { lessons: [] });
    writeKnowledge(tempDir, 'antibodies.json', {
      antibodies: [
        {
          trigger: 'Missing field in API handler',
          triggerKeywords: ['prisma', 'field', 'handler', 'api', 'route', 'schema'],
          check: 'Verify handler processes new field',
          active: true,
        },
      ],
    });
    writeKnowledge(tempDir, 'crystallized.json', { checks: [] });
    writeKnowledge(tempDir, 'causal-graph.json', { nodes: [], edges: [] });

    const results = runInverseBloom([
      {
        title: 'Add prisma field to API route handler',
        description: 'New schema field must be processed by the route handler',
      },
    ]);

    expect(results[0].matchedItems.length).toBeGreaterThan(0);

    // The antibody with 6 matching keywords should score higher than the
    // pattern with fewer overlapping words
    const antibodyMatch = results[0].matchedItems.find(m => m.source === 'Antibody');
    const patternMatch = results[0].matchedItems.find(m => m.source === 'Pattern');

    expect(antibodyMatch).toBeDefined();
    if (patternMatch) {
      expect(antibodyMatch!.score).toBeGreaterThanOrEqual(patternMatch.score);
    }
  });

  it('handles multiple tasks independently', () => {
    writeKnowledge(tempDir, 'patterns.json', {
      patterns: [
        { name: 'CSRF Protection', description: 'CSRF header in API calls', category: 'security' },
        { name: 'Database Migration', description: 'Prisma migration enum split', category: 'database' },
      ],
    });
    writeKnowledge(tempDir, 'lessons.json', { lessons: [] });
    writeKnowledge(tempDir, 'antibodies.json', { antibodies: [] });
    writeKnowledge(tempDir, 'crystallized.json', { checks: [] });
    writeKnowledge(tempDir, 'causal-graph.json', { nodes: [], edges: [] });

    const results = runInverseBloom([
      { title: 'Add CSRF header', description: 'Security API call protection' },
      { title: 'Create prisma migration', description: 'Database enum migration split' },
    ]);

    expect(results).toHaveLength(2);

    // First task should match CSRF pattern
    expect(results[0].taskTitle).toBe('Add CSRF header');
    const csrfMatches = results[0].matchedItems.filter(m => m.item.includes('CSRF'));
    expect(csrfMatches.length).toBeGreaterThan(0);

    // Second task should match migration pattern
    expect(results[1].taskTitle).toBe('Create prisma migration');
    const migrationMatches = results[1].matchedItems.filter(m => m.item.includes('Migration'));
    expect(migrationMatches.length).toBeGreaterThan(0);
  });

  it('includes files in token matching', () => {
    writeKnowledge(tempDir, 'patterns.json', {
      patterns: [
        { name: 'Middleware auth', description: 'Protect routes with middleware authentication checks' },
      ],
    });
    writeKnowledge(tempDir, 'lessons.json', { lessons: [] });
    writeKnowledge(tempDir, 'antibodies.json', { antibodies: [] });
    writeKnowledge(tempDir, 'crystallized.json', { checks: [] });
    writeKnowledge(tempDir, 'causal-graph.json', { nodes: [], edges: [] });

    // The title/description alone don't mention "middleware" or "auth",
    // but the files list does
    const results = runInverseBloom([
      {
        title: 'Update route handler',
        description: 'Add new endpoint logic',
        files: ['src/middleware.ts', 'src/lib/auth/authorize.ts'],
      },
    ]);

    // Should pick up "middleware" and "auth" from the file paths
    const middlewareMatches = results[0].matchedItems.filter(m =>
      m.item.includes('Middleware'),
    );
    expect(middlewareMatches.length).toBeGreaterThan(0);
  });

  it('scores causal graph nodes', () => {
    writeKnowledge(tempDir, 'patterns.json', { patterns: [] });
    writeKnowledge(tempDir, 'lessons.json', { lessons: [] });
    writeKnowledge(tempDir, 'antibodies.json', { antibodies: [] });
    writeKnowledge(tempDir, 'crystallized.json', { checks: [] });
    writeKnowledge(tempDir, 'causal-graph.json', {
      nodes: [
        { id: '1', type: 'bug', label: 'Missing validation on equipment form', sprint: 'Phase 62' },
      ],
      edges: [],
    });

    const results = runInverseBloom([
      { title: 'Add equipment form validation', description: 'Validate equipment input fields' },
    ]);

    const causalMatches = results[0].matchedItems.filter(m => m.source === 'CausalNode');
    expect(causalMatches.length).toBeGreaterThan(0);
    expect(causalMatches[0].item).toContain('validation');
  });
});

describe('Tool registration', () => {
  beforeEach(() => {
    tempDir = makeTempDir();
    mockConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers inverse_bloom tool', async () => {
    const tools: string[] = [];
    const mockServer = {
      tool: (...args: unknown[]) => {
        tools.push(args[0] as string);
      },
    };

    const { registerInverseBloomTools } = await import('./inverse-bloom.js');
    registerInverseBloomTools(mockServer as never);

    expect(tools).toContain('inverse_bloom');
  });

  it('formats output as markdown sections', async () => {
    writeKnowledge(tempDir, 'patterns.json', {
      patterns: [
        { name: 'Auth Pattern', description: 'Authentication security for API routes', category: 'security' },
      ],
    });
    writeKnowledge(tempDir, 'lessons.json', {
      lessons: [
        { situation: 'Auth bypass found', learning: 'Always verify auth middleware on new routes' },
      ],
    });
    writeKnowledge(tempDir, 'antibodies.json', { antibodies: [] });
    writeKnowledge(tempDir, 'crystallized.json', { checks: [] });
    writeKnowledge(tempDir, 'causal-graph.json', { nodes: [], edges: [] });

    const { createMockServer } = await import('../test-utils.js');
    const { server, handlers } = createMockServer();

    const { registerInverseBloomTools } = await import('./inverse-bloom.js');
    registerInverseBloomTools(server as never);

    const result = await handlers['inverse_bloom']({
      tasks: [
        { title: 'Build auth API route', description: 'Create authentication endpoint with security checks' },
      ],
    });

    const text = result.content[0].text;
    expect(text).toContain('# Inverse Bloom: Knowledge Surfacing');
    expect(text).toContain('**Tasks analyzed:** 1');
    expect(text).toContain('### Watch out for: Build auth API route');
    expect(text).toContain('**[Pattern]**');
  });
});
