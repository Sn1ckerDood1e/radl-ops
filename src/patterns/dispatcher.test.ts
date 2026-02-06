import { describe, it, expect } from 'vitest';
import { dispatch } from './dispatcher.js';
import type { ExecutionStrategy } from './dispatcher.js';

describe('Dispatcher', () => {
  describe('direct strategy', () => {
    it('routes simple messages to direct', () => {
      const result = dispatch('What is the current project status?');
      expect(result.strategy).toBe('direct');
    });

    it('routes short questions to direct', () => {
      const result = dispatch('How many issues are open?');
      expect(result.strategy).toBe('direct');
    });
  });

  describe('eval-opt strategy', () => {
    it('routes briefing requests to eval-opt', () => {
      const result = dispatch('Generate a daily briefing for today');
      expect(result.strategy).toBe('eval-opt');
      expect(result.evalCriteria).toBeDefined();
      expect(result.evalCriteria!.length).toBeGreaterThan(0);
    });

    it('routes review requests to eval-opt', () => {
      const result = dispatch('Review the latest pull request and check for quality issues');
      expect(result.strategy).toBe('eval-opt');
      expect(result.evalCriteria).toBeDefined();
    });
  });

  describe('sequential strategy', () => {
    it('routes step-by-step tasks to sequential', () => {
      // Needs: hasSequentialSteps=true, complexity > 2, but NOT requiresPlanning
      // Use >500 chars for length complexity bonus
      // Avoid: "implement", "build", "refactor", "feature", "plan",
      //        "database schema", "architect", "system design" (trigger planning/architecture)
      const result = dispatch(
        'First run the migration to add the new columns to the users table, ' +
        'then restart the application servers in the staging environment to pick up the changes, ' +
        'after that run the full integration test suite to verify everything works correctly. ' +
        'The migration should be applied carefully and the servers need to be restarted one by one. ' +
        'The logs after each step should be examined to ensure there are no errors or warnings. ' +
        'The test suite covers API endpoints, queries, and auth flows across all services. ' +
        'Verify that all existing functionality still works as expected after the migration completes.'
      );
      expect(result.strategy).toBe('sequential');
    });
  });

  describe('concurrent strategy', () => {
    it('routes analysis tasks to concurrent', () => {
      const result = dispatch('Compare the different options and analyze multiple approaches for the architecture');
      expect(result.strategy).toBe('concurrent');
    });
  });

  describe('orchestrator strategy', () => {
    it('routes complex implementation tasks to orchestrator', () => {
      // Needs requiresPlanning=true AND complexity >= 4
      // "implement/build/refactor" trigger requiresPlanning
      // >500 chars for length complexity bonus, sequential keywords for step complexity
      const result = dispatch(
        'Implement a comprehensive payment system with Stripe integration. ' +
        'This requires building webhook handlers, subscription management, ' +
        'customer portal integration, and feature gating across the entire app. ' +
        'We need to refactor the existing user model and create new API endpoints. ' +
        'The payment system should handle one-time purchases, recurring subscriptions, ' +
        'and usage-based billing with proper error handling and retry logic. ' +
        'First set up the Stripe SDK, then create the webhook handler, ' +
        'after that build the subscription management flow step by step.'
      );
      expect(result.strategy).toBe('orchestrator');
    });
  });

  describe('decision properties', () => {
    it('always includes taskType', () => {
      const result = dispatch('Hello');
      expect(result.taskType).toBeDefined();
    });

    it('always includes reasoning', () => {
      const result = dispatch('Hello');
      expect(result.reasoning).toBeTruthy();
    });

    it('returns valid strategy type', () => {
      const validStrategies: ExecutionStrategy[] = [
        'direct', 'sequential', 'concurrent', 'eval-opt', 'orchestrator',
      ];
      const result = dispatch('Test message');
      expect(validStrategies).toContain(result.strategy);
    });
  });
});
