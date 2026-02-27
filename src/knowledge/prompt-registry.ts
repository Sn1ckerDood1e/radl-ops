/**
 * Prompt Registry with Version Tracking
 *
 * Tracks prompt template versions and associates issue outcomes
 * with the prompt version that produced them.
 *
 * On each watcher run, the prompt content is hashed. If the hash
 * changes, a new version entry is created. Issue outcomes are
 * associated with the active version for success rate analysis.
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../config/logger.js';
import { getConfig } from '../config/paths.js';

// ============================================
// Types
// ============================================

export interface PromptVersion {
  id: string;          // SHA256 of template content (first 12 chars)
  template: string;    // template name (e.g., "watcher-prompt")
  version: number;     // auto-incremented
  createdAt: string;
  contentHash: string; // full SHA256 hash
  metrics: {
    issuesProcessed: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    avgCostUsd: number;
    totalCostUsd: number;
  };
}

interface PromptRegistryFile {
  versions: PromptVersion[];
  activeVersionId: string | null;
}

// ============================================
// File I/O
// ============================================

function getRegistryPath(): string {
  const knowledgeDir = getConfig().knowledgeDir;
  if (!existsSync(knowledgeDir)) {
    mkdirSync(knowledgeDir, { recursive: true });
  }
  return join(knowledgeDir, 'prompt-registry.json');
}

function loadRegistry(): PromptRegistryFile {
  const path = getRegistryPath();
  if (!existsSync(path)) {
    return { versions: [], activeVersionId: null };
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PromptRegistryFile;
  } catch (error) {
    logger.warn('Failed to load prompt registry', { error: String(error) });
    return { versions: [], activeVersionId: null };
  }
}

function saveRegistry(registry: PromptRegistryFile): void {
  writeFileSync(getRegistryPath(), JSON.stringify(registry, null, 2));
}

// ============================================
// Core Functions
// ============================================

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Register or update a prompt template version.
 * Returns the version ID (existing if content unchanged, new if changed).
 */
export function registerPromptVersion(templateName: string, content: string): string {
  const fullHash = hashContent(content);
  const shortId = fullHash.substring(0, 12);

  const registry = loadRegistry();

  // Check if this version already exists
  const existing = registry.versions.find(v => v.contentHash === fullHash && v.template === templateName);
  if (existing) {
    // Content unchanged — just ensure it's the active version
    const updatedRegistry: PromptRegistryFile = {
      ...registry,
      activeVersionId: existing.id,
    };
    saveRegistry(updatedRegistry);
    return existing.id;
  }

  // New version — create entry
  const templateVersions = registry.versions.filter(v => v.template === templateName);
  const nextVersion = templateVersions.length > 0
    ? Math.max(...templateVersions.map(v => v.version)) + 1
    : 1;

  const newVersion: PromptVersion = {
    id: shortId,
    template: templateName,
    version: nextVersion,
    createdAt: new Date().toISOString(),
    contentHash: fullHash,
    metrics: {
      issuesProcessed: 0,
      successCount: 0,
      failureCount: 0,
      successRate: 0,
      avgCostUsd: 0,
      totalCostUsd: 0,
    },
  };

  const updatedRegistry: PromptRegistryFile = {
    versions: [...registry.versions, newVersion],
    activeVersionId: shortId,
  };
  saveRegistry(updatedRegistry);

  logger.info('New prompt version registered', {
    template: templateName,
    version: nextVersion,
    id: shortId,
  });

  return shortId;
}

/**
 * Record an issue outcome against the active prompt version.
 */
export function recordIssueOutcome(
  success: boolean,
  costUsd: number = 0,
): void {
  const registry = loadRegistry();
  if (!registry.activeVersionId) return;

  const versionIdx = registry.versions.findIndex(v => v.id === registry.activeVersionId);
  if (versionIdx === -1) return;

  const existing = registry.versions[versionIdx];
  const newProcessed = existing.metrics.issuesProcessed + 1;
  const newSuccess = existing.metrics.successCount + (success ? 1 : 0);
  const newFailure = existing.metrics.failureCount + (success ? 0 : 1);
  const newTotalCost = existing.metrics.totalCostUsd + costUsd;

  const updatedVersion: PromptVersion = {
    ...existing,
    metrics: {
      issuesProcessed: newProcessed,
      successCount: newSuccess,
      failureCount: newFailure,
      successRate: newProcessed > 0 ? Math.round((newSuccess / newProcessed) * 100) / 100 : 0,
      avgCostUsd: newProcessed > 0 ? Math.round((newTotalCost / newProcessed) * 1_000_000) / 1_000_000 : 0,
      totalCostUsd: Math.round(newTotalCost * 1_000_000) / 1_000_000,
    },
  };

  const updatedVersions = registry.versions.map((v, i) =>
    i === versionIdx ? updatedVersion : v,
  );

  saveRegistry({ ...registry, versions: updatedVersions });

  logger.debug('Issue outcome recorded', {
    versionId: registry.activeVersionId,
    success,
    costUsd,
    successRate: updatedVersion.metrics.successRate,
  });
}

/**
 * Get all prompt versions with their metrics.
 */
export function getPromptVersions(templateName?: string): PromptVersion[] {
  const registry = loadRegistry();
  if (templateName) {
    return registry.versions.filter(v => v.template === templateName);
  }
  return registry.versions;
}

/**
 * Get the currently active version ID.
 */
export function getActiveVersionId(): string | null {
  return loadRegistry().activeVersionId;
}

/**
 * Format prompt versions for display.
 */
export function formatVersionReport(templateName?: string): string {
  const versions = getPromptVersions(templateName);
  const registry = loadRegistry();

  if (versions.length === 0) {
    return 'No prompt versions registered.';
  }

  const lines = [
    '## Prompt Version History',
    '',
    `**Active:** ${registry.activeVersionId ?? 'none'}`,
    `**Total versions:** ${versions.length}`,
    '',
  ];

  for (const v of versions.sort((a, b) => b.version - a.version)) {
    const isActive = v.id === registry.activeVersionId;
    const status = isActive ? ' (ACTIVE)' : '';
    lines.push(
      `### v${v.version} [${v.id}]${status}`,
      `Template: ${v.template} | Created: ${v.createdAt.split('T')[0]}`,
      `Issues: ${v.metrics.issuesProcessed} | Success: ${(v.metrics.successRate * 100).toFixed(0)}% | Avg cost: $${v.metrics.avgCostUsd}`,
      '',
    );
  }

  return lines.join('\n');
}
