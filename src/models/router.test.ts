import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRoute,
  setRouteOverride,
  clearRouteOverrides,
  getModelPricing,
  calculateCost,
  detectTaskType,
  getAllRoutes,
} from './router.js';

describe('Model Router', () => {
  beforeEach(() => {
    clearRouteOverrides();
  });

  describe('getRoute', () => {
    it('returns Haiku for briefing tasks', () => {
      const route = getRoute('briefing');
      expect(route.model).toBe('claude-haiku-4-5-20251001');
      expect(route.effort).toBe('low');
    });

    it('returns Sonnet for conversation tasks', () => {
      const route = getRoute('conversation');
      expect(route.model).toBe('claude-sonnet-4-5-20250929');
      expect(route.effort).toBe('medium');
    });

    it('returns Opus for architecture tasks', () => {
      const route = getRoute('architecture');
      expect(route.model).toBe('claude-opus-4-6');
      expect(route.effort).toBe('high');
    });

    it('returns Opus for roadmap tasks', () => {
      const route = getRoute('roadmap');
      expect(route.model).toBe('claude-opus-4-6');
    });

    it('returns Sonnet for planning tasks with high effort', () => {
      const route = getRoute('planning');
      expect(route.model).toBe('claude-sonnet-4-5-20250929');
      expect(route.effort).toBe('high');
    });

    it('returns Sonnet for review tasks', () => {
      const route = getRoute('review');
      expect(route.model).toBe('claude-sonnet-4-5-20250929');
    });

    it('returns Sonnet for tool_execution tasks', () => {
      const route = getRoute('tool_execution');
      expect(route.model).toBe('claude-sonnet-4-5-20250929');
    });
  });

  describe('setRouteOverride', () => {
    it('overrides model for a task type', () => {
      setRouteOverride('briefing', { model: 'claude-opus-4-6' });
      const route = getRoute('briefing');
      expect(route.model).toBe('claude-opus-4-6');
    });

    it('preserves pricing from new model on override', () => {
      setRouteOverride('briefing', { model: 'claude-opus-4-6' });
      const route = getRoute('briefing');
      expect(route.inputCostPer1M).toBe(5);
      expect(route.outputCostPer1M).toBe(25);
    });

    it('preserves other fields when partially overriding', () => {
      setRouteOverride('briefing', { effort: 'high' });
      const route = getRoute('briefing');
      expect(route.model).toBe('claude-haiku-4-5-20251001');
      expect(route.effort).toBe('high');
    });
  });

  describe('clearRouteOverrides', () => {
    it('restores defaults after clearing', () => {
      setRouteOverride('briefing', { model: 'claude-opus-4-6' });
      clearRouteOverrides();
      const route = getRoute('briefing');
      expect(route.model).toBe('claude-haiku-4-5-20251001');
    });
  });

  describe('getModelPricing', () => {
    it('returns correct Haiku pricing', () => {
      const pricing = getModelPricing('claude-haiku-4-5-20251001');
      expect(pricing.input).toBe(0.80);
      expect(pricing.output).toBe(4);
    });

    it('returns correct Sonnet pricing', () => {
      const pricing = getModelPricing('claude-sonnet-4-5-20250929');
      expect(pricing.input).toBe(3);
      expect(pricing.output).toBe(15);
    });

    it('returns correct Opus pricing', () => {
      const pricing = getModelPricing('claude-opus-4-6');
      expect(pricing.input).toBe(5);
      expect(pricing.output).toBe(25);
    });
  });

  describe('calculateCost', () => {
    it('calculates Haiku cost correctly (1M input tokens)', () => {
      const cost = calculateCost('claude-haiku-4-5-20251001', 1_000_000, 0);
      expect(cost).toBe(0.8);
    });

    it('calculates Sonnet cost correctly (1M output tokens)', () => {
      const cost = calculateCost('claude-sonnet-4-5-20250929', 0, 1_000_000);
      expect(cost).toBe(15);
    });

    it('calculates combined input+output cost', () => {
      const cost = calculateCost('claude-opus-4-6', 1_000_000, 1_000_000);
      expect(cost).toBe(30); // 5 + 25
    });

    it('calculates zero cost for zero tokens', () => {
      const cost = calculateCost('claude-haiku-4-5-20251001', 0, 0);
      expect(cost).toBe(0);
    });

    it('handles small token counts without floating point issues', () => {
      const cost = calculateCost('claude-haiku-4-5-20251001', 100, 50);
      // (100/1M * 0.8) + (50/1M * 4) = 0.00008 + 0.0002 = 0.00028
      expect(cost).toBe(0.00028);
    });
  });

  describe('detectTaskType', () => {
    it('detects briefing from "briefing summary"', () => {
      expect(detectTaskType('briefing summary')).toBe('briefing');
    });

    it('detects briefing from "status report"', () => {
      expect(detectTaskType('Give me a status report')).toBe('briefing');
    });

    it('detects architecture from "architect the database"', () => {
      expect(detectTaskType('architect the database')).toBe('architecture');
    });

    it('detects architecture from "system design"', () => {
      expect(detectTaskType('system design for auth')).toBe('architecture');
    });

    it('detects roadmap from "roadmap planning"', () => {
      expect(detectTaskType('roadmap planning')).toBe('roadmap');
    });

    it('detects roadmap from "strategic goals"', () => {
      expect(detectTaskType('strategic goals for Q2')).toBe('roadmap');
    });

    it('detects planning from "plan the implementation"', () => {
      expect(detectTaskType('plan the implementation')).toBe('planning');
    });

    it('detects review from "review this code"', () => {
      expect(detectTaskType('review this code')).toBe('review');
    });

    it('defaults to conversation for unknown text', () => {
      expect(detectTaskType('hello world')).toBe('conversation');
    });

    it('is case insensitive', () => {
      expect(detectTaskType('BRIEFING SUMMARY')).toBe('briefing');
    });
  });

  describe('getAllRoutes', () => {
    it('returns all 7 task types', () => {
      const routes = getAllRoutes();
      const taskTypes = Object.keys(routes);
      expect(taskTypes).toHaveLength(7);
      expect(taskTypes).toContain('briefing');
      expect(taskTypes).toContain('tool_execution');
      expect(taskTypes).toContain('conversation');
      expect(taskTypes).toContain('planning');
      expect(taskTypes).toContain('review');
      expect(taskTypes).toContain('architecture');
      expect(taskTypes).toContain('roadmap');
    });

    it('reflects overrides', () => {
      setRouteOverride('briefing', { model: 'claude-opus-4-6' });
      const routes = getAllRoutes();
      expect(routes.briefing.model).toBe('claude-opus-4-6');
    });
  });
});
