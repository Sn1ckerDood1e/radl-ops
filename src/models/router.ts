/**
 * Model Router - Selects the optimal model and effort level per task
 *
 * Based on Opus 4.6 research:
 * - Opus: Deep reasoning, architecture, strategic decisions
 * - Sonnet: Best coding model, orchestration, general tasks
 * - Haiku: Fast lightweight tasks, 90% of Sonnet capability at 3x savings
 */

import type { ModelId, EffortLevel, ModelRoute, TaskType, ModelGateway, ChatParams, ChatResponse } from '../types/index.js';
import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../config/logger.js';

/**
 * Model pricing per 1M tokens (USD)
 */
const MODEL_PRICING: Record<ModelId, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4 },
};

/**
 * Default routing table: task type → model + effort + max tokens
 */
const DEFAULT_ROUTES: Record<TaskType, ModelRoute> = {
  briefing: {
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    maxTokens: 1024,
    inputCostPer1M: MODEL_PRICING['claude-haiku-4-5-20251001'].input,
    outputCostPer1M: MODEL_PRICING['claude-haiku-4-5-20251001'].output,
  },
  tool_execution: {
    model: 'claude-sonnet-4-5-20250929',
    effort: 'medium',
    maxTokens: 4096,
    inputCostPer1M: MODEL_PRICING['claude-sonnet-4-5-20250929'].input,
    outputCostPer1M: MODEL_PRICING['claude-sonnet-4-5-20250929'].output,
  },
  conversation: {
    model: 'claude-sonnet-4-5-20250929',
    effort: 'medium',
    maxTokens: 4096,
    inputCostPer1M: MODEL_PRICING['claude-sonnet-4-5-20250929'].input,
    outputCostPer1M: MODEL_PRICING['claude-sonnet-4-5-20250929'].output,
  },
  planning: {
    model: 'claude-sonnet-4-5-20250929',
    effort: 'high',
    maxTokens: 8192,
    inputCostPer1M: MODEL_PRICING['claude-sonnet-4-5-20250929'].input,
    outputCostPer1M: MODEL_PRICING['claude-sonnet-4-5-20250929'].output,
  },
  review: {
    model: 'claude-sonnet-4-5-20250929',
    effort: 'high',
    maxTokens: 4096,
    inputCostPer1M: MODEL_PRICING['claude-sonnet-4-5-20250929'].input,
    outputCostPer1M: MODEL_PRICING['claude-sonnet-4-5-20250929'].output,
  },
  architecture: {
    model: 'claude-opus-4-6',
    effort: 'high',
    maxTokens: 8192,
    inputCostPer1M: MODEL_PRICING['claude-opus-4-6'].input,
    outputCostPer1M: MODEL_PRICING['claude-opus-4-6'].output,
  },
  roadmap: {
    model: 'claude-opus-4-6',
    effort: 'high',
    maxTokens: 8192,
    inputCostPer1M: MODEL_PRICING['claude-opus-4-6'].input,
    outputCostPer1M: MODEL_PRICING['claude-opus-4-6'].output,
  },
  spot_check: {
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    maxTokens: 1024,
    inputCostPer1M: MODEL_PRICING['claude-haiku-4-5-20251001'].input,
    outputCostPer1M: MODEL_PRICING['claude-haiku-4-5-20251001'].output,
  },
  social_generation: {
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    maxTokens: 2048,
    inputCostPer1M: MODEL_PRICING['claude-haiku-4-5-20251001'].input,
    outputCostPer1M: MODEL_PRICING['claude-haiku-4-5-20251001'].output,
  },
};

/**
 * Custom route overrides (can be set at runtime)
 */
let routeOverrides: Partial<Record<TaskType, Partial<ModelRoute>>> = {};

/**
 * Get the model route for a task type
 */
export function getRoute(taskType: TaskType): ModelRoute {
  const base = DEFAULT_ROUTES[taskType];
  const override = routeOverrides[taskType];

  if (!override) return base;

  const model = override.model ?? base.model;
  const pricing = MODEL_PRICING[model];

  return {
    ...base,
    ...override,
    inputCostPer1M: pricing.input,
    outputCostPer1M: pricing.output,
  };
}

/**
 * Override a route at runtime (e.g., force opus for a specific task)
 */
export function setRouteOverride(
  taskType: TaskType,
  override: Partial<ModelRoute>
): void {
  routeOverrides = {
    ...routeOverrides,
    [taskType]: override,
  };
  logger.info('Model route override set', { taskType, override });
}

/**
 * Clear all route overrides
 */
export function clearRouteOverrides(): void {
  routeOverrides = {};
  logger.info('Model route overrides cleared');
}

/**
 * Get model pricing info
 */
export function getModelPricing(model: ModelId): { input: number; output: number } {
  return MODEL_PRICING[model];
}

/**
 * Calculate cost for a given token usage
 */
export function calculateCost(
  model: ModelId,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model];
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

/**
 * Detect task type from message content (heuristic)
 */
export function detectTaskType(message: string): TaskType {
  const lower = message.toLowerCase();

  if (lower.includes('briefing') || lower.includes('summary') || lower.includes('status report')) {
    return 'briefing';
  }
  if (lower.includes('architect') || lower.includes('system design') || lower.includes('database schema')) {
    return 'architecture';
  }
  if (lower.includes('roadmap') || lower.includes('strategic') || lower.includes('long-term')) {
    return 'roadmap';
  }
  if (lower.includes('plan') || lower.includes('implement') || lower.includes('feature')) {
    return 'planning';
  }
  if (lower.includes('review') || lower.includes('audit') || lower.includes('check')) {
    return 'review';
  }

  return 'conversation';
}

/**
 * Model fallback chains for rate-limit resilience.
 * Each model maps to its next-best alternative.
 */
const FALLBACK_CHAINS: Record<ModelId, ModelId[]> = {
  'claude-opus-4-6': ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
  'claude-sonnet-4-5-20250929': ['claude-haiku-4-5-20251001'],
  'claude-haiku-4-5-20251001': [], // No fallback for cheapest model
};

/**
 * Get a route with fallback model if the primary is rate-limited.
 * Returns the route for the next available model in the chain.
 */
export function getRouteWithFallback(
  taskType: TaskType,
  unavailableModels: ModelId[] = [],
): ModelRoute {
  const base = getRoute(taskType);

  if (!unavailableModels.includes(base.model)) {
    return base;
  }

  // Try fallback chain
  const fallbacks = FALLBACK_CHAINS[base.model] ?? [];
  for (const fallbackModel of fallbacks) {
    if (!unavailableModels.includes(fallbackModel)) {
      const pricing = MODEL_PRICING[fallbackModel];
      logger.info('Model fallback activated', {
        taskType,
        original: base.model,
        fallback: fallbackModel,
      });
      return {
        ...base,
        model: fallbackModel,
        inputCostPer1M: pricing.input,
        outputCostPer1M: pricing.output,
      };
    }
  }

  // All models unavailable — return base (will fail at API call)
  logger.warn('All models in fallback chain unavailable', { taskType, base: base.model });
  return base;
}

/**
 * Route a task to a higher-tier model if the initial attempt scored below threshold.
 *
 * Cascade: Haiku → Sonnet → Opus. Only escalates one tier at a time.
 * Tracks cascade events for cost analysis.
 */
export function routeByConfidence(
  taskType: TaskType,
  currentScore: number,
  confidenceThreshold: number = 5,
): ModelRoute {
  const base = getRoute(taskType);

  if (currentScore >= confidenceThreshold) {
    return base;
  }

  const escalationChain: Record<ModelId, ModelId | null> = {
    'claude-haiku-4-5-20251001': 'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-5-20250929': 'claude-opus-4-6',
    'claude-opus-4-6': null, // Already at top tier
  };

  const nextModel = escalationChain[base.model];
  if (!nextModel) {
    logger.info('Cascade routing: already at top tier', { taskType, model: base.model, score: currentScore });
    return base;
  }

  const pricing = MODEL_PRICING[nextModel];
  logger.info('Cascade routing: escalating model', {
    taskType,
    from: base.model,
    to: nextModel,
    score: currentScore,
    threshold: confidenceThreshold,
  });

  return {
    ...base,
    model: nextModel,
    inputCostPer1M: pricing.input,
    outputCostPer1M: pricing.output,
  };
}

/**
 * Get all routes for display/debugging
 */
export function getAllRoutes(): Record<TaskType, ModelRoute> {
  const result = {} as Record<TaskType, ModelRoute>;
  for (const taskType of Object.keys(DEFAULT_ROUTES) as TaskType[]) {
    result[taskType] = getRoute(taskType);
  }
  return result;
}

// ============================================
// Model Gateway
// ============================================

/**
 * Default gateway: routes directly to the Anthropic API.
 * Can be swapped for LiteLLM, Bedrock, or Vertex gateways.
 */
export class AnthropicDirectGateway implements ModelGateway {
  readonly name = 'anthropic-direct';
  private getClient: () => import('@anthropic-ai/sdk').default;

  constructor(clientFactory: () => import('@anthropic-ai/sdk').default) {
    this.getClient = clientFactory;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const client = this.getClient();

    const response = await client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: response.model,
    };
  }
}

let activeGateway: ModelGateway | null = null;

/**
 * Set the active model gateway. Falls back to AnthropicDirectGateway
 * if none is set (lazy-initialized on first getGateway() call).
 */
export function setGateway(gateway: ModelGateway): void {
  activeGateway = gateway;
  logger.info('Model gateway set', { name: gateway.name });
}

/**
 * Get the active model gateway.
 * Lazy-initializes to AnthropicDirectGateway if none set.
 */
export function getGateway(): ModelGateway {
  if (!activeGateway) {
    // Lazy import to avoid circular dependency
    const { getAnthropicClient } = require('../config/anthropic.js') as { getAnthropicClient: () => import('@anthropic-ai/sdk').default };
    activeGateway = new AnthropicDirectGateway(getAnthropicClient);
    logger.info('Default Anthropic gateway initialized');
  }
  return activeGateway;
}
