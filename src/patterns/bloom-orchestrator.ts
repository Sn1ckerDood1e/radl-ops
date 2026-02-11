/**
 * Bloom-Style Compound Learning Orchestrator
 *
 * 4-stage pipeline for extracting deep lessons from sprint data:
 * 1. Understanding — Parse sprint data, identify key events (Haiku)
 * 2. Ideation — Generate candidate lessons and patterns (Sonnet)
 * 3. Rollout — Categorize and format for knowledge base (Haiku)
 * 4. Judgment — Score quality and filter weak insights (Sonnet)
 *
 * Each stage sees output of all prior stages for accumulated context.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ModelId } from '../types/index.js';
import { getRoute, calculateCost } from '../models/router.js';
import { trackUsage } from '../models/token-tracker.js';
import { getAnthropicClient } from '../config/anthropic.js';
import { logger } from '../config/logger.js';

/**
 * Tool definitions for structured output stages.
 * Forces the model to return structured JSON via tool_use
 * instead of free-text (eliminates regex parsing).
 */
const ROLLOUT_TOOL: Anthropic.Tool = {
  name: 'submit_lessons',
  description: 'Submit the categorized lessons for the knowledge base',
  input_schema: {
    type: 'object',
    properties: {
      lessons: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['pattern', 'lesson', 'decision', 'estimation', 'blocker'],
            },
            content: { type: 'string', description: 'Clear, actionable statement' },
            confidence: { type: 'number', description: 'Confidence score 1-10' },
          },
          required: ['category', 'content', 'confidence'],
        },
      },
    },
    required: ['lessons'],
  },
};

const JUDGMENT_TOOL: Anthropic.Tool = {
  name: 'submit_judgment',
  description: 'Submit the quality judgment for the extracted lessons',
  input_schema: {
    type: 'object',
    properties: {
      score: { type: 'number', description: 'Overall quality score 0-10' },
      feedback: { type: 'string', description: 'Brief assessment of extraction quality' },
      keep: {
        type: 'array',
        items: { type: 'number' },
        description: '0-based indices of insights worth keeping',
      },
      drop: {
        type: 'array',
        items: { type: 'number' },
        description: '0-based indices of insights to drop',
      },
    },
    required: ['score', 'feedback'],
  },
};

export interface SprintData {
  phase: string;
  title: string;
  status: string;
  completedTasks: Array<string | { description?: string; task?: string }>;
  blockers: Array<{ description: string; resolved?: boolean; resolution?: string }>;
  estimate: string;
  actual: string;
}

export interface CategorizedLesson {
  category: 'pattern' | 'lesson' | 'decision' | 'estimation' | 'blocker';
  content: string;
  confidence: number; // 0-10
}

export interface CompoundResult {
  lessons: CategorizedLesson[];
  qualityScore: number;
  totalCostUsd: number;
  stageOutputs: {
    understanding: string;
    ideation: string;
    rollout: string;
    judgment: string;
  };
  sprintPhase: string;
  sprintTitle: string;
}

interface StageConfig {
  name: string;
  model: ModelId;
  maxTokens: number;
  /** Optional tool for structured output (forces tool_use response) */
  tool?: Anthropic.Tool;
}

const STAGES: StageConfig[] = [
  { name: 'understanding', model: 'claude-haiku-4-5-20251001', maxTokens: 2048 },
  { name: 'ideation', model: 'claude-sonnet-4-5-20250929', maxTokens: 4096 },
  { name: 'rollout', model: 'claude-haiku-4-5-20251001', maxTokens: 2048, tool: ROLLOUT_TOOL },
  { name: 'judgment', model: 'claude-sonnet-4-5-20250929', maxTokens: 2048, tool: JUDGMENT_TOOL },
];

function formatSprintData(data: SprintData): string {
  const tasks = data.completedTasks.map(t =>
    typeof t === 'string' ? t : (t.description ?? t.task ?? '?')
  );

  const resolvedBlockers = data.blockers.filter(b => b.resolved);
  const unresolvedBlockers = data.blockers.filter(b => !b.resolved);

  return `Sprint: ${data.phase} — ${data.title}
Status: ${data.status}
Estimate: ${data.estimate} → Actual: ${data.actual}

Completed Tasks (${tasks.length}):
${tasks.map(t => `- ${t}`).join('\n')}

Resolved Blockers (${resolvedBlockers.length}):
${resolvedBlockers.map(b => `- ${b.description} → ${b.resolution ?? 'resolved'}`).join('\n') || 'None'}

Unresolved Blockers (${unresolvedBlockers.length}):
${unresolvedBlockers.map(b => `- ${b.description}`).join('\n') || 'None'}`;
}

function buildStagePrompt(
  stageName: string,
  sprintText: string,
  priorOutputs: Record<string, string>
): string {
  const priorContext = Object.entries(priorOutputs)
    .map(([stage, output]) => `## ${stage} output\n${output}`)
    .join('\n\n');

  switch (stageName) {
    case 'understanding':
      return `Analyze this sprint data. Identify:
1. Key accomplishments and their significance
2. Estimation accuracy (was estimate realistic?)
3. Blocker patterns (what caused delays?)
4. Technical decisions made
5. Workflow patterns (what worked, what didn't)

<sprint>
${sprintText}
</sprint>

Provide a structured analysis. Be specific about what happened and why.`;

    case 'ideation':
      return `Based on the sprint analysis below, generate candidate lessons and patterns.

${priorContext}

For each insight:
- State the lesson clearly and specifically (not generic advice)
- Categorize as: pattern (reusable approach), lesson (mistake to avoid), decision (choice made and why), estimation (timing insight), or blocker (obstacle pattern)
- Rate confidence 1-10 (how generalizable is this beyond this one sprint?)

Generate 5-15 candidate insights. Quality over quantity.`;

    case 'rollout':
      return `Format these candidate insights for the knowledge base.

${priorContext}

Rules:
- Merge similar insights into single, stronger statements
- Drop insights with confidence < 4
- Content should be self-contained (understandable without sprint context)
- Maximum 10 final insights

Use the submit_lessons tool to submit the categorized lessons.`;

    case 'judgment':
      return `Evaluate the quality of these extracted lessons.

${priorContext}

Score the overall extraction on a 0-10 scale:
- 9-10: Specific, actionable, high-confidence insights that will improve future sprints
- 7-8: Good insights with clear applicability
- 5-6: Mostly generic, some useful specific insights
- 3-4: Too generic or obvious, minimal value
- 0-2: Wrong, misleading, or irrelevant

Use the submit_judgment tool to submit your quality assessment. Include indices of insights to keep or drop.`;

    default:
      return `Process this sprint data:\n${sprintText}`;
  }
}

async function callStage(
  stage: StageConfig,
  prompt: string
): Promise<{ text: string; cost: number; toolInput?: unknown }> {
  const client = getAnthropicClient();

  // Build request params, adding tools if the stage uses structured output
  const requestParams: Anthropic.MessageCreateParams = {
    model: stage.model,
    max_tokens: stage.maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };

  if (stage.tool) {
    requestParams.tools = [stage.tool];
    requestParams.tool_choice = { type: 'tool', name: stage.tool.name };
  }

  const response = await client.messages.create(requestParams);

  const cost = calculateCost(
    stage.model,
    response.usage.input_tokens,
    response.usage.output_tokens
  );

  // Use spot_check for Haiku stages, review for Sonnet stages
  const taskType = stage.model.includes('haiku') ? 'spot_check' as const : 'review' as const;

  trackUsage(
    stage.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    taskType,
    `bloom-${stage.name}`
  );

  // Extract tool_use input if present, otherwise extract text
  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
  );

  if (toolBlock) {
    // For structured stages, return JSON-stringified input as text (for stage output accumulation)
    // and the raw input for direct parsing
    return {
      text: JSON.stringify(toolBlock.input, null, 2),
      cost,
      toolInput: toolBlock.input,
    };
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  return { text, cost };
}

/**
 * Run the Bloom compound learning pipeline on sprint data.
 */
export async function runBloomPipeline(
  sprintData: SprintData
): Promise<CompoundResult> {
  const sprintText = formatSprintData(sprintData);
  const stageOutputs: Record<string, string> = {};
  let totalCost = 0;

  logger.info('Bloom pipeline starting', {
    phase: sprintData.phase,
    title: sprintData.title,
    tasks: sprintData.completedTasks.length,
  });

  // Run stages sequentially — each sees prior outputs
  // Structured stages (rollout, judgment) return toolInput for direct parsing
  const structuredOutputs: Record<string, unknown> = {};

  for (const stage of STAGES) {
    const prompt = buildStagePrompt(stage.name, sprintText, stageOutputs);

    try {
      const result = await callStage(stage, prompt);
      stageOutputs[stage.name] = result.text;
      if (result.toolInput) {
        structuredOutputs[stage.name] = result.toolInput;
      }
      totalCost += result.cost;

      logger.info(`Bloom stage complete: ${stage.name}`, {
        model: stage.model,
        outputLength: result.text.length,
        structured: !!result.toolInput,
        cost: result.cost.toFixed(6),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Bloom stage failed: ${stage.name}`, { error: msg });
      stageOutputs[stage.name] = `ERROR: ${msg}`;
    }
  }

  // Parse rollout output — prefer structured tool input, fall back to regex
  let lessons: CategorizedLesson[] = [];
  const rolloutInput = structuredOutputs.rollout as { lessons?: Array<{ category?: string; content?: string; confidence?: number }> } | undefined;
  if (rolloutInput?.lessons) {
    lessons = rolloutInput.lessons
      .filter(item => item.content && item.category)
      .map(item => ({
        category: (item.category ?? 'lesson') as CategorizedLesson['category'],
        content: String(item.content),
        confidence: Number(item.confidence) || 5,
      }));
  } else {
    // Fallback: regex parse from text output
    try {
      const jsonMatch = stageOutputs.rollout?.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{
          category?: string;
          content?: string;
          confidence?: number;
        }>;
        lessons = parsed
          .filter(item => item.content && item.category)
          .map(item => ({
            category: (item.category ?? 'lesson') as CategorizedLesson['category'],
            content: String(item.content),
            confidence: Number(item.confidence) || 5,
          }));
      }
    } catch {
      logger.warn('Failed to parse rollout JSON, using raw text');
    }
  }

  // Parse judgment output — prefer structured tool input, fall back to regex
  let qualityScore = 5;
  const judgmentInput = structuredOutputs.judgment as { score?: number; keep?: number[]; drop?: number[] } | undefined;
  if (judgmentInput) {
    qualityScore = Number(judgmentInput.score) || 5;

    if (judgmentInput.keep && judgmentInput.keep.length > 0) {
      lessons = lessons.filter((_, i) => judgmentInput.keep!.includes(i));
    } else if (judgmentInput.drop && judgmentInput.drop.length > 0) {
      lessons = lessons.filter((_, i) => !judgmentInput.drop!.includes(i));
    }
  } else {
    // Fallback: regex parse from text output
    try {
      const jsonMatch = stageOutputs.judgment?.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          score?: number;
          keep?: number[];
          drop?: number[];
        };
        qualityScore = Number(parsed.score) || 5;

        if (parsed.keep && parsed.keep.length > 0) {
          lessons = lessons.filter((_, i) => parsed.keep!.includes(i));
        } else if (parsed.drop && parsed.drop.length > 0) {
          lessons = lessons.filter((_, i) => !parsed.drop!.includes(i));
        }
      }
    } catch {
      logger.warn('Failed to parse judgment JSON, using default score');
    }
  }

  logger.info('Bloom pipeline complete', {
    lessonsExtracted: lessons.length,
    qualityScore,
    totalCost: totalCost.toFixed(6),
  });

  return {
    lessons,
    qualityScore,
    totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
    stageOutputs: {
      understanding: stageOutputs.understanding ?? '',
      ideation: stageOutputs.ideation ?? '',
      rollout: stageOutputs.rollout ?? '',
      judgment: stageOutputs.judgment ?? '',
    },
    sprintPhase: sprintData.phase,
    sprintTitle: sprintData.title,
  };
}
