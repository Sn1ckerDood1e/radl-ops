/**
 * Formal Evaluation Suite for Knowledge Search
 *
 * Curated query→expected-result pairs for measuring search quality.
 * Computes Recall@5, Precision@5, and MRR (Mean Reciprocal Rank).
 * Runs against BM25-only and hybrid scoring configurations.
 *
 * Usage: import and call runSearchEval() — returns structured metrics.
 */

import { searchFts, isFtsAvailable, type SearchOptions } from './fts-index.js';
import { logger } from '../config/logger.js';

// ============================================
// Types
// ============================================

export interface EvalCase {
  query: string;
  expectedTerms: string[];  // keywords that should appear in top results
  category: string;         // for grouping results
}

export interface EvalResult {
  query: string;
  category: string;
  recall5: number;     // fraction of expected terms found in top 5
  precision5: number;  // fraction of top 5 results that match an expected term
  reciprocalRank: number;  // 1/rank of first relevant result (0 if not found)
  topResults: string[];    // first 5 result texts (truncated)
}

export interface EvalSummary {
  config: string;
  caseCount: number;
  avgRecall5: number;
  avgPrecision5: number;
  avgMRR: number;
  byCategory: Record<string, { count: number; avgRecall5: number; avgMRR: number }>;
  results: EvalResult[];
}

// ============================================
// Curated Eval Cases
// ============================================

export const EVAL_CASES: EvalCase[] = [
  // Security patterns
  { query: 'CSRF protection', expectedTerms: ['csrf', 'header', 'token', 'x-csrf'], category: 'security' },
  { query: 'auth getUser not getSession', expectedTerms: ['getuser', 'getsession', 'auth', 'cookie'], category: 'security' },
  { query: 'secrets detection', expectedTerms: ['secret', 'api key', 'commit', 'pattern'], category: 'security' },

  // Database patterns
  { query: 'enum migration', expectedTerms: ['enum', 'migration', 'transaction', 'postgresql'], category: 'database' },
  { query: 'Prisma team scoped queries', expectedTerms: ['prisma', 'team', 'where', 'teamid'], category: 'database' },
  { query: 'nullable foreign key backfill', expectedTerms: ['nullable', 'backfill', 'update', 'migration'], category: 'database' },

  // Architecture patterns
  { query: 'evaluator optimizer loop', expectedTerms: ['evaluator', 'optimizer', 'loop', 'quality'], category: 'architecture' },
  { query: 'Bloom pipeline extraction', expectedTerms: ['bloom', 'pipeline', 'lesson', 'extraction'], category: 'architecture' },
  { query: 'model routing cascade', expectedTerms: ['model', 'routing', 'haiku', 'sonnet'], category: 'architecture' },

  // Workflow patterns
  { query: 'feature branch workflow', expectedTerms: ['branch', 'main', 'feature', 'push'], category: 'workflow' },
  { query: 'sprint tracking lifecycle', expectedTerms: ['sprint', 'start', 'progress', 'complete'], category: 'workflow' },
  { query: 'compound learning extraction', expectedTerms: ['compound', 'learning', 'lesson', 'extract'], category: 'workflow' },

  // Data flow
  { query: 'new field lifecycle', expectedTerms: ['field', 'schema', 'api', 'client'], category: 'data-flow' },
  { query: 'API handler destructure', expectedTerms: ['api', 'handler', 'destructure', 'body'], category: 'data-flow' },
  { query: 'server component props', expectedTerms: ['server', 'component', 'props', 'client'], category: 'data-flow' },

  // Agent patterns
  { query: 'parallel code review', expectedTerms: ['parallel', 'review', 'agent', 'team'], category: 'agent' },
  { query: 'file ownership conflicts', expectedTerms: ['file', 'ownership', 'conflict', 'agent'], category: 'agent' },

  // Estimation
  { query: 'sprint time estimate accuracy', expectedTerms: ['estimate', 'actual', 'time', 'sprint'], category: 'estimation' },

  // Crystallization
  { query: 'crystallized check proposal', expectedTerms: ['crystallize', 'check', 'proposal', 'lesson'], category: 'intelligence' },
  { query: 'antibody immune system', expectedTerms: ['antibody', 'immune', 'pattern', 'match'], category: 'intelligence' },
];

// ============================================
// Evaluation Logic
// ============================================

function isRelevant(text: string, expectedTerms: string[]): boolean {
  const lower = text.toLowerCase();
  return expectedTerms.some(term => lower.includes(term.toLowerCase()));
}

function evaluateCase(evalCase: EvalCase, searchOpts: Partial<SearchOptions>): EvalResult {
  const results = searchFts({
    query: evalCase.query,
    maxResults: 5,
    ...searchOpts,
  });

  const resultTexts = results.map(r => r.text);

  // Recall@5: fraction of expected terms found in any top-5 result
  const allText = resultTexts.join(' ').toLowerCase();
  const foundTerms = evalCase.expectedTerms.filter(term =>
    allText.includes(term.toLowerCase())
  );
  const recall5 = evalCase.expectedTerms.length > 0
    ? foundTerms.length / evalCase.expectedTerms.length
    : 0;

  // Precision@5: fraction of top-5 results that contain any expected term
  const relevantCount = resultTexts.filter(text =>
    isRelevant(text, evalCase.expectedTerms)
  ).length;
  const precision5 = resultTexts.length > 0
    ? relevantCount / resultTexts.length
    : 0;

  // MRR: 1/rank of first relevant result
  let reciprocalRank = 0;
  for (let i = 0; i < resultTexts.length; i++) {
    if (isRelevant(resultTexts[i], evalCase.expectedTerms)) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }

  return {
    query: evalCase.query,
    category: evalCase.category,
    recall5: Math.round(recall5 * 100) / 100,
    precision5: Math.round(precision5 * 100) / 100,
    reciprocalRank: Math.round(reciprocalRank * 100) / 100,
    topResults: resultTexts.map(t => t.substring(0, 80)),
  };
}

/**
 * Run the full evaluation suite with a specific search configuration.
 */
export function runSearchEval(config: {
  label: string;
  searchOpts: Partial<SearchOptions>;
  cases?: EvalCase[];
}): EvalSummary {
  const cases = config.cases ?? EVAL_CASES;

  if (!isFtsAvailable()) {
    return {
      config: config.label,
      caseCount: 0,
      avgRecall5: 0,
      avgPrecision5: 0,
      avgMRR: 0,
      byCategory: {},
      results: [],
    };
  }

  const results = cases.map(c => evaluateCase(c, config.searchOpts));

  // Aggregate metrics
  const avgRecall5 = results.length > 0
    ? results.reduce((s, r) => s + r.recall5, 0) / results.length
    : 0;
  const avgPrecision5 = results.length > 0
    ? results.reduce((s, r) => s + r.precision5, 0) / results.length
    : 0;
  const avgMRR = results.length > 0
    ? results.reduce((s, r) => s + r.reciprocalRank, 0) / results.length
    : 0;

  // Group by category
  const byCategory: Record<string, { count: number; avgRecall5: number; avgMRR: number }> = {};
  for (const result of results) {
    if (!byCategory[result.category]) {
      byCategory[result.category] = { count: 0, avgRecall5: 0, avgMRR: 0 };
    }
    byCategory[result.category] = {
      count: byCategory[result.category].count + 1,
      avgRecall5: byCategory[result.category].avgRecall5 + result.recall5,
      avgMRR: byCategory[result.category].avgMRR + result.reciprocalRank,
    };
  }

  // Compute averages per category
  for (const cat of Object.values(byCategory)) {
    cat.avgRecall5 = cat.count > 0 ? Math.round((cat.avgRecall5 / cat.count) * 100) / 100 : 0;
    cat.avgMRR = cat.count > 0 ? Math.round((cat.avgMRR / cat.count) * 100) / 100 : 0;
  }

  logger.info('Search eval complete', {
    config: config.label,
    cases: results.length,
    avgRecall5: avgRecall5.toFixed(2),
    avgMRR: avgMRR.toFixed(2),
  });

  return {
    config: config.label,
    caseCount: results.length,
    avgRecall5: Math.round(avgRecall5 * 100) / 100,
    avgPrecision5: Math.round(avgPrecision5 * 100) / 100,
    avgMRR: Math.round(avgMRR * 100) / 100,
    byCategory,
    results,
  };
}

/**
 * Format eval summary for display.
 */
export function formatEvalReport(summary: EvalSummary): string {
  const lines = [
    `## Search Eval: ${summary.config}`,
    '',
    `**Cases:** ${summary.caseCount}`,
    `**Avg Recall@5:** ${(summary.avgRecall5 * 100).toFixed(0)}%`,
    `**Avg Precision@5:** ${(summary.avgPrecision5 * 100).toFixed(0)}%`,
    `**Avg MRR:** ${summary.avgMRR.toFixed(2)}`,
    '',
    '### By Category',
  ];

  for (const [cat, metrics] of Object.entries(summary.byCategory)) {
    lines.push(`- **${cat}** (${metrics.count}): Recall ${(metrics.avgRecall5 * 100).toFixed(0)}%, MRR ${metrics.avgMRR.toFixed(2)}`);
  }

  // Show worst-performing queries
  const sorted = [...summary.results].sort((a, b) => a.reciprocalRank - b.reciprocalRank);
  const worst = sorted.slice(0, 5).filter(r => r.reciprocalRank < 0.5);
  if (worst.length > 0) {
    lines.push('', '### Needs Improvement (MRR < 0.5)');
    for (const r of worst) {
      lines.push(`- "${r.query}" — MRR: ${r.reciprocalRank}, Recall: ${(r.recall5 * 100).toFixed(0)}%`);
    }
  }

  return lines.join('\n');
}
