/**
 * MCP Compound Learning Tool
 *
 * Reads sprint data, runs Bloom orchestrator to extract deep lessons,
 * writes results to knowledge/compounds/ and merges into lessons.json.
 * Replaces the shell-based compound.sh extract with API-powered extraction.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { runBloomPipeline } from '../../patterns/bloom-orchestrator.js';
import type { SprintData, CategorizedLesson } from '../../patterns/bloom-orchestrator.js';

const RADL_DIR = '/home/hb/radl';
const SPRINT_DIR = join(RADL_DIR, '.planning/sprints');
const KNOWLEDGE_DIR = '/home/hb/radl-ops/knowledge';
const COMPOUND_DIR = join(KNOWLEDGE_DIR, 'compounds');

function ensureDirs(): void {
  if (!existsSync(COMPOUND_DIR)) {
    mkdirSync(COMPOUND_DIR, { recursive: true });
  }
}

function findLatestSprint(): { path: string; data: SprintData } | null {
  // Try archive first
  const archiveDir = join(SPRINT_DIR, 'archive');
  if (existsSync(archiveDir)) {
    try {
      const files = readdirSync(archiveDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();

      if (files.length > 0) {
        const filePath = join(archiveDir, files[0]);
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        return { path: filePath, data: normalizeSprintData(data) };
      }
    } catch (error) {
      logger.warn('Failed to read sprint archive', { error: String(error) });
    }
  }

  // Fall back to current sprint
  const currentPath = join(SPRINT_DIR, 'current.json');
  if (existsSync(currentPath)) {
    try {
      const data = JSON.parse(readFileSync(currentPath, 'utf-8'));
      return { path: currentPath, data: normalizeSprintData(data) };
    } catch (error) {
      logger.warn('Failed to read current sprint', { error: String(error) });
    }
  }

  return null;
}

function normalizeSprintData(raw: Record<string, unknown>): SprintData {
  return {
    phase: String(raw.phase ?? 'Unknown'),
    title: String(raw.title ?? 'Unknown'),
    status: String(raw.status ?? 'Unknown'),
    completedTasks: Array.isArray(raw.completedTasks) ? raw.completedTasks : [],
    blockers: Array.isArray(raw.blockers) ? raw.blockers : [],
    estimate: String(raw.estimate ?? 'Unknown'),
    actual: String(raw.actualTime ?? raw.actual ?? 'Unknown'),
  };
}

interface LessonsFile {
  lessons: Array<{
    id: number;
    situation: string;
    learning: string;
    date: string;
  }>;
}

function mergeIntoKnowledge(lessons: CategorizedLesson[], phase: string): number {
  const lessonsPath = join(KNOWLEDGE_DIR, 'lessons.json');
  const existing: LessonsFile = existsSync(lessonsPath)
    ? JSON.parse(readFileSync(lessonsPath, 'utf-8'))
    : { lessons: [] };

  const nextId = existing.lessons.reduce(
    (max, l) => Math.max(max, l.id),
    0
  ) + 1;

  let added = 0;
  for (const lesson of lessons) {
    // Skip duplicates (content similarity check)
    const isDuplicate = existing.lessons.some(
      l => l.learning.includes(lesson.content.substring(0, 50)) ||
           lesson.content.includes(l.learning.substring(0, 50))
    );
    if (isDuplicate) continue;

    existing.lessons.push({
      id: nextId + added,
      situation: `[${lesson.category}] ${phase}`,
      learning: lesson.content,
      date: new Date().toISOString(),
    });
    added++;
  }

  if (added > 0) {
    writeFileSync(lessonsPath, JSON.stringify(existing, null, 2));
  }

  return added;
}

export function registerCompoundTools(server: McpServer): void {
  server.tool(
    'compound_extract',
    'Extract compound learnings from the latest sprint using AI-powered Bloom pipeline (4-stage: Understanding → Ideation → Rollout → Judgment). Reads sprint data, generates categorized lessons, merges into knowledge base. Example: { "source": "latest" }',
    {
      source: z.enum(['latest', 'current']).optional().default('latest')
        .describe('Sprint data source: latest archived sprint or current in-progress sprint'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('compound_extract', async ({ source }) => {
      ensureDirs();

      // Find sprint data
      let sprint: { path: string; data: SprintData } | null = null;
      if (source === 'current') {
        const currentPath = join(SPRINT_DIR, 'current.json');
        if (existsSync(currentPath)) {
          const data = JSON.parse(readFileSync(currentPath, 'utf-8'));
          sprint = { path: currentPath, data: normalizeSprintData(data) };
        }
      } else {
        sprint = findLatestSprint();
      }

      if (!sprint) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No sprint data found. Start a sprint with `sprint_start` first.',
          }],
        };
      }

      logger.info('Compound extract starting', {
        source,
        path: sprint.path,
        phase: sprint.data.phase,
        title: sprint.data.title,
      });

      // Run Bloom pipeline
      const result = await runBloomPipeline(sprint.data);

      // Save compound file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const compoundFile = join(COMPOUND_DIR, `bloom-${timestamp}.json`);
      writeFileSync(compoundFile, JSON.stringify({
        extractedAt: new Date().toISOString(),
        method: 'bloom-pipeline',
        sprintPhase: result.sprintPhase,
        sprintTitle: result.sprintTitle,
        qualityScore: result.qualityScore,
        lessons: result.lessons,
        totalCostUsd: result.totalCostUsd,
        merged: false,
      }, null, 2));

      // Merge into knowledge base
      const newLessons = mergeIntoKnowledge(
        result.lessons,
        sprint.data.phase
      );

      // Mark as merged
      const compoundData = JSON.parse(readFileSync(compoundFile, 'utf-8'));
      writeFileSync(compoundFile, JSON.stringify({
        ...compoundData,
        merged: true,
        mergedAt: new Date().toISOString(),
        lessonsAdded: newLessons,
      }, null, 2));

      // Format output
      const lines: string[] = [
        `## Compound Extract: ${sprint.data.phase} — ${sprint.data.title}`,
        '',
        `**Quality Score:** ${result.qualityScore}/10`,
        `**Lessons Extracted:** ${result.lessons.length}`,
        `**New Lessons Added:** ${newLessons}`,
        `**Extraction Cost:** $${result.totalCostUsd}`,
        '',
        '### Lessons',
        '',
      ];

      for (const lesson of result.lessons) {
        lines.push(`- **[${lesson.category}]** (confidence: ${lesson.confidence}/10) ${lesson.content}`);
      }

      lines.push('');
      lines.push(`_Saved to: ${compoundFile}_`);

      logger.info('Compound extract complete', {
        lessonsExtracted: result.lessons.length,
        newLessonsAdded: newLessons,
        qualityScore: result.qualityScore,
        cost: result.totalCostUsd,
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );
}
