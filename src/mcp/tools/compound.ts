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
import { getConfig } from '../../config/paths.js';

function getSprintDir(): string {
  return join(getConfig().radlDir, '.planning/sprints');
}
function getKnowledgeDir(): string {
  return getConfig().knowledgeDir;
}
function getCompoundDir(): string {
  return join(getKnowledgeDir(), 'compounds');
}

function ensureDirs(): void {
  if (!existsSync(getCompoundDir())) {
    mkdirSync(getCompoundDir(), { recursive: true });
  }
}

function findLatestSprint(): { path: string; data: SprintData } | null {
  // Try archive first
  const archiveDir = join(getSprintDir(), 'archive');
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
  const currentPath = join(getSprintDir(), 'current.json');
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

interface PatternsFile {
  patterns: Array<{
    id: number;
    name: string;
    description: string;
    example: string;
    date: string;
    category: string;
  }>;
}

interface DecisionsFile {
  decisions: Array<{
    id: number;
    title: string;
    context: string;
    alternatives: string;
    rationale: string;
    phase: string;
    date: string;
    status: string;
    supersededBy: string | null;
  }>;
}

interface DeferredFile {
  items: Array<{
    id: number;
    title: string;
    reason: string;
    effort: string;
    sprintPhase: string;
    date: string;
    resolved: boolean;
  }>;
}

interface MergeResult {
  lessonsAdded: number;
  patternsAdded: number;
  decisionsAdded: number;
  estimationsAdded: number;
  blockersAdded: number;
}

function mergePattern(content: string): { name: string; description: string } {
  // Extract a name from the content (first 5-8 words or up to first punctuation)
  const words = content.split(/\s+/);
  const nameWords = words.slice(0, Math.min(8, words.length));
  const name = nameWords.join(' ').replace(/[.,:;]$/, '');

  return {
    name: name.length > 60 ? name.substring(0, 57) + '...' : name,
    description: content,
  };
}

function mergeDecision(content: string, phase: string): { title: string; context: string } {
  // Extract title from content (first sentence or first 10 words)
  const firstSentence = content.match(/^[^.!?]+[.!?]/)?.[0] || content;
  const words = firstSentence.split(/\s+/);
  const title = words.slice(0, Math.min(10, words.length)).join(' ').replace(/[.,:;]$/, '');

  return {
    title: title.length > 80 ? title.substring(0, 77) + '...' : title,
    context: `${phase}: ${content}`,
  };
}

function mergeIntoKnowledge(lessons: CategorizedLesson[], phase: string): MergeResult {
  const knowledgeDir = getKnowledgeDir();
  const result: MergeResult = {
    lessonsAdded: 0,
    patternsAdded: 0,
    decisionsAdded: 0,
    estimationsAdded: 0,
    blockersAdded: 0,
  };

  // Route each lesson to the appropriate knowledge store
  for (const lesson of lessons) {
    switch (lesson.category) {
      case 'pattern': {
        const patternsPath = join(knowledgeDir, 'patterns.json');
        const patternsFile: PatternsFile = existsSync(patternsPath)
          ? JSON.parse(readFileSync(patternsPath, 'utf-8'))
          : { patterns: [] };

        // Check for duplicates
        const isDuplicate = patternsFile.patterns.some(
          p => p.description.includes(lesson.content.substring(0, 50)) ||
               lesson.content.includes(p.description.substring(0, 50))
        );
        if (isDuplicate) break;

        const nextId = patternsFile.patterns.reduce((max, p) => Math.max(max, p.id), 0) + 1;
        const { name, description } = mergePattern(lesson.content);

        patternsFile.patterns.push({
          id: nextId,
          name,
          description,
          example: '', // Will be filled in manually later
          date: new Date().toISOString(),
          category: 'general', // Will be categorized manually later
        });

        writeFileSync(patternsPath, JSON.stringify(patternsFile, null, 2));
        result.patternsAdded++;
        break;
      }

      case 'decision': {
        const decisionsPath = join(knowledgeDir, 'decisions.json');
        const decisionsFile: DecisionsFile = existsSync(decisionsPath)
          ? JSON.parse(readFileSync(decisionsPath, 'utf-8'))
          : { decisions: [] };

        // Check for duplicates
        const isDuplicate = decisionsFile.decisions.some(
          d => d.context.includes(lesson.content.substring(0, 50)) ||
               lesson.content.includes(d.context.substring(0, 50))
        );
        if (isDuplicate) break;

        const nextId = decisionsFile.decisions.reduce((max, d) => Math.max(max, d.id), 0) + 1;
        const { title, context } = mergeDecision(lesson.content, phase);

        decisionsFile.decisions.push({
          id: nextId,
          title,
          context,
          alternatives: '', // Will be filled in manually later
          rationale: '', // Will be filled in manually later
          phase,
          date: new Date().toISOString(),
          status: 'accepted',
          supersededBy: null,
        });

        writeFileSync(decisionsPath, JSON.stringify(decisionsFile, null, 2));
        result.decisionsAdded++;
        break;
      }

      case 'blocker': {
        const deferredPath = join(knowledgeDir, 'deferred.json');
        const deferredFile: DeferredFile = existsSync(deferredPath)
          ? JSON.parse(readFileSync(deferredPath, 'utf-8'))
          : { items: [] };

        // Check for duplicates
        const isDuplicate = deferredFile.items.some(
          item => item.title.includes(lesson.content.substring(0, 50)) ||
                  lesson.content.includes(item.title.substring(0, 50))
        );
        if (isDuplicate) break;

        const nextId = deferredFile.items.reduce((max, item) => Math.max(max, item.id), 0) + 1;

        deferredFile.items.push({
          id: nextId,
          title: lesson.content.substring(0, 80),
          reason: lesson.content,
          effort: 'small', // Default, can be adjusted manually
          sprintPhase: phase,
          date: new Date().toISOString(),
          resolved: false,
        });

        writeFileSync(deferredPath, JSON.stringify(deferredFile, null, 2));
        result.blockersAdded++;
        break;
      }

      case 'estimation':
      case 'lesson':
      default: {
        const lessonsPath = join(knowledgeDir, 'lessons.json');
        const lessonsFile: LessonsFile = existsSync(lessonsPath)
          ? JSON.parse(readFileSync(lessonsPath, 'utf-8'))
          : { lessons: [] };

        // Check for duplicates
        const isDuplicate = lessonsFile.lessons.some(
          l => l.learning.includes(lesson.content.substring(0, 50)) ||
               lesson.content.includes(l.learning.substring(0, 50))
        );
        if (isDuplicate) break;

        const nextId = lessonsFile.lessons.reduce((max, l) => Math.max(max, l.id), 0) + 1;

        lessonsFile.lessons.push({
          id: nextId,
          situation: `[${lesson.category}] ${phase}`,
          learning: lesson.content,
          date: new Date().toISOString(),
        });

        writeFileSync(lessonsPath, JSON.stringify(lessonsFile, null, 2));

        if (lesson.category === 'estimation') {
          result.estimationsAdded++;
        } else {
          result.lessonsAdded++;
        }
        break;
      }
    }
  }

  return result;
}

function loadExistingKnowledge(): string {
  const knowledgeDir = getKnowledgeDir();
  const lines: string[] = [];

  // Load patterns
  const patternsPath = join(knowledgeDir, 'patterns.json');
  if (existsSync(patternsPath)) {
    try {
      const patternsFile: PatternsFile = JSON.parse(readFileSync(patternsPath, 'utf-8'));
      if (patternsFile.patterns.length > 0) {
        lines.push('## Existing Patterns');
        for (const pattern of patternsFile.patterns.slice(0, 15)) { // Limit to 15 most recent
          lines.push(`- ${pattern.name}: ${pattern.description}`);
        }
        lines.push('');
      }
    } catch (error) {
      logger.warn('Failed to load patterns.json', { error: String(error) });
    }
  }

  // Load lessons
  const lessonsPath = join(knowledgeDir, 'lessons.json');
  if (existsSync(lessonsPath)) {
    try {
      const lessonsFile: LessonsFile = JSON.parse(readFileSync(lessonsPath, 'utf-8'));
      if (lessonsFile.lessons.length > 0) {
        lines.push('## Existing Lessons');
        for (const lesson of lessonsFile.lessons.slice(-15)) { // Last 15
          lines.push(`- ${lesson.situation}: ${lesson.learning}`);
        }
        lines.push('');
      }
    } catch (error) {
      logger.warn('Failed to load lessons.json', { error: String(error) });
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

export function registerCompoundTools(server: McpServer): void {
  const sourceSchema = z.object({
    source: z.enum(['latest', 'current']).optional().default('latest')
      .describe('Sprint data source: latest archived sprint or current in-progress sprint'),
  });

  server.tool(
    'compound_extract',
    'Extract compound learnings from the latest sprint using AI-powered Bloom pipeline (4-stage: Understanding → Ideation → Rollout → Judgment). Reads sprint data, generates categorized lessons, merges into knowledge base. Example: { "source": "latest" }',
    sourceSchema.shape,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('compound_extract', async ({ source }) => {
      ensureDirs();

      // Find sprint data
      let sprint: { path: string; data: SprintData } | null = null;
      if (source === 'current') {
        const currentPath = join(getSprintDir(), 'current.json');
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

      // Load existing knowledge to feed into Bloom pipeline
      const existingKnowledge = loadExistingKnowledge();

      // Run Bloom pipeline
      const result = await runBloomPipeline(sprint.data, existingKnowledge);

      // Save compound file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const compoundFile = join(getCompoundDir(), `bloom-${timestamp}.json`);
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
      const mergeResult = mergeIntoKnowledge(
        result.lessons,
        sprint.data.phase
      );

      // Mark as merged
      const compoundData = JSON.parse(readFileSync(compoundFile, 'utf-8'));
      writeFileSync(compoundFile, JSON.stringify({
        ...compoundData,
        merged: true,
        mergedAt: new Date().toISOString(),
        mergeResult,
      }, null, 2));

      // Format output
      const totalAdded = mergeResult.lessonsAdded + mergeResult.patternsAdded +
                         mergeResult.decisionsAdded + mergeResult.estimationsAdded +
                         mergeResult.blockersAdded;

      const lines: string[] = [
        `## Compound Extract: ${sprint.data.phase} — ${sprint.data.title}`,
        '',
        `**Quality Score:** ${result.qualityScore}/10`,
        `**Lessons Extracted:** ${result.lessons.length}`,
        `**Total Added to Knowledge Base:** ${totalAdded}`,
        `  - Patterns: ${mergeResult.patternsAdded}`,
        `  - Decisions: ${mergeResult.decisionsAdded}`,
        `  - Lessons: ${mergeResult.lessonsAdded}`,
        `  - Estimations: ${mergeResult.estimationsAdded}`,
        `  - Blockers: ${mergeResult.blockersAdded}`,
        `**Extraction Cost:** $${result.totalCostUsd}`,
        '',
        '### Extracted Insights',
        '',
      ];

      for (const lesson of result.lessons) {
        lines.push(`- **[${lesson.category}]** (confidence: ${lesson.confidence}/10) ${lesson.content}`);
      }

      lines.push('');
      lines.push(`_Saved to: ${compoundFile}_`);

      logger.info('Compound extract complete', {
        lessonsExtracted: result.lessons.length,
        totalAdded,
        mergeResult,
        qualityScore: result.qualityScore,
        cost: result.totalCostUsd,
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );
}
