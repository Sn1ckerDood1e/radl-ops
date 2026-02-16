/**
 * MCP Causal Sprint Graphs Tool
 *
 * Builds and queries a causal graph of decision->outcome relationships
 * extracted from sprint data. Two tools:
 *
 * 1. causal_extract — Uses Haiku to extract decision->outcome pairs from sprint data
 * 2. causal_query — Zero-cost BFS graph traversal for causal chain analysis
 *
 * The graph is stored as causal-graph.json in the knowledge directory.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';
import Anthropic from '@anthropic-ai/sdk';
import { getRoute, calculateCost } from '../../models/router.js';
import { trackUsage } from '../../models/token-tracker.js';
import { getAnthropicClient } from '../../config/anthropic.js';
import { withRetry } from '../../utils/retry.js';

// ============================================
// Types
// ============================================

export interface CausalNode {
  id: string;
  type: 'decision' | 'outcome' | 'condition';
  label: string;
  sprint: string;
  date: string;
}

export interface CausalEdge {
  from: string;
  to: string;
  strength: number; // 1-10
  evidence: string;
}

export interface CausalGraph {
  nodes: CausalNode[];
  edges: CausalEdge[];
}

// ============================================
// Persistence
// ============================================

function getCausalGraphPath(): string {
  return join(getConfig().knowledgeDir, 'causal-graph.json');
}

export function loadCausalGraph(): CausalGraph {
  const graphPath = getCausalGraphPath();
  if (!existsSync(graphPath)) {
    return { nodes: [], edges: [] };
  }

  try {
    const raw = JSON.parse(readFileSync(graphPath, 'utf-8'));
    return {
      nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
      edges: Array.isArray(raw.edges) ? raw.edges : [],
    };
  } catch (error) {
    logger.warn('Failed to load causal-graph.json', { error: String(error) });
    return { nodes: [], edges: [] };
  }
}

export function saveCausalGraph(graph: CausalGraph): void {
  const graphPath = getCausalGraphPath();
  writeFileSync(graphPath, JSON.stringify(graph, null, 2));
}

// ============================================
// Sprint Data Loading
// ============================================

interface SprintFileData {
  phase: string;
  title: string;
  status: string;
  completedTasks?: unknown[];
  blockers?: unknown[];
  estimate?: string;
  actual?: string;
  actualTime?: string;
}

function getSprintDir(): string {
  return join(getConfig().radlDir, '.planning/sprints');
}

function findSprintData(sprintPhase?: string): { data: SprintFileData; source: string } | null {
  const sprintDir = getSprintDir();

  // If a specific phase is requested, look in archive
  if (sprintPhase) {
    const archiveDir = join(sprintDir, 'archive');
    if (existsSync(archiveDir)) {
      try {
        const files = readdirSync(archiveDir).filter(f => f.endsWith('.json')).sort();
        for (const file of files) {
          const filePath = join(archiveDir, file);
          const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as SprintFileData;
          if (raw.phase && raw.phase.includes(sprintPhase)) {
            return { data: raw, source: filePath };
          }
        }
      } catch (error) {
        logger.warn('Failed to search sprint archive', { error: String(error) });
      }
    }
  }

  // Try archive (latest first)
  const archiveDir = join(sprintDir, 'archive');
  if (existsSync(archiveDir)) {
    try {
      const files = readdirSync(archiveDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();

      if (files.length > 0) {
        const filePath = join(archiveDir, files[0]);
        const data = JSON.parse(readFileSync(filePath, 'utf-8')) as SprintFileData;
        return { data, source: filePath };
      }
    } catch (error) {
      logger.warn('Failed to read sprint archive', { error: String(error) });
    }
  }

  // Fall back to current sprint
  const currentPath = join(sprintDir, 'current.json');
  if (existsSync(currentPath)) {
    try {
      const data = JSON.parse(readFileSync(currentPath, 'utf-8')) as SprintFileData;
      return { data, source: currentPath };
    } catch (error) {
      logger.warn('Failed to read current sprint', { error: String(error) });
    }
  }

  return null;
}

function formatSprintForPrompt(data: SprintFileData): string {
  const lines: string[] = [
    `Phase: ${data.phase ?? 'Unknown'}`,
    `Title: ${data.title ?? 'Unknown'}`,
    `Status: ${data.status ?? 'Unknown'}`,
    `Estimate: ${data.estimate ?? 'Unknown'}`,
    `Actual: ${data.actualTime ?? data.actual ?? 'Unknown'}`,
  ];

  if (Array.isArray(data.completedTasks) && data.completedTasks.length > 0) {
    lines.push('', 'Completed Tasks:');
    for (const task of data.completedTasks) {
      lines.push(`- ${typeof task === 'string' ? task : JSON.stringify(task)}`);
    }
  }

  if (Array.isArray(data.blockers) && data.blockers.length > 0) {
    lines.push('', 'Blockers:');
    for (const blocker of data.blockers) {
      lines.push(`- ${typeof blocker === 'string' ? blocker : JSON.stringify(blocker)}`);
    }
  }

  return lines.join('\n');
}

// ============================================
// AI Extraction
// ============================================

const CAUSAL_EXTRACT_TOOL: Anthropic.Tool = {
  name: 'submit_causal_graph',
  description: 'Submit extracted causal nodes and edges from the sprint data',
  input_schema: {
    type: 'object',
    properties: {
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Node ID: d-<sprint>-<index> for decisions, o-<sprint>-<index> for outcomes, c-<sprint>-<index> for conditions' },
            type: { type: 'string', enum: ['decision', 'outcome', 'condition'] },
            label: { type: 'string', description: 'Short human-readable label for the node' },
            sprint: { type: 'string', description: 'Sprint phase identifier' },
            date: { type: 'string', description: 'ISO date string' },
          },
          required: ['id', 'type', 'label', 'sprint', 'date'],
        },
      },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Source node ID' },
            to: { type: 'string', description: 'Target node ID' },
            strength: { type: 'number', description: 'Causal strength 1-10' },
            evidence: { type: 'string', description: 'Evidence for this causal link' },
          },
          required: ['from', 'to', 'strength', 'evidence'],
        },
      },
    },
    required: ['nodes', 'edges'],
  },
};

const CAUSAL_EXTRACT_SYSTEM = `You are a causal analysis expert. Given sprint data, identify:

1. **Decisions** made during the sprint (technical choices, architectural decisions, process changes)
2. **Outcomes** observed (bugs found, performance improvements, delays, successes)
3. **Conditions** present (team size, tech stack constraints, time pressure)
4. **Causal links** between them (which decisions led to which outcomes, which conditions influenced decisions)

Generate node IDs using these patterns:
- Decisions: d-<sprint>-<index> (e.g., d-phase72-1)
- Outcomes: o-<sprint>-<index> (e.g., o-phase72-1)
- Conditions: c-<sprint>-<index> (e.g., c-phase72-1)

Where <sprint> is a sanitized version of the sprint phase (lowercase, no spaces, no dots).

For edges:
- strength 1-3: Weak/possible causal link
- strength 4-6: Moderate causal link
- strength 7-10: Strong causal link

Extract real, specific relationships — not generic observations. Each edge needs concrete evidence.

Use the submit_causal_graph tool to submit your analysis.`;

function parseExtractResponse(response: Anthropic.Message): { nodes: CausalNode[]; edges: CausalEdge[] } {
  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );

  if (!toolBlock) {
    return { nodes: [], edges: [] };
  }

  const input = toolBlock.input as Record<string, unknown>;
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];

  const nodes: CausalNode[] = rawNodes.map((n: Record<string, unknown>) => ({
    id: String(n.id || ''),
    type: (['decision', 'outcome', 'condition'].includes(String(n.type)) ? String(n.type) : 'decision') as CausalNode['type'],
    label: String(n.label || ''),
    sprint: String(n.sprint || ''),
    date: String(n.date || new Date().toISOString()),
  }));

  const edges: CausalEdge[] = rawEdges.map((e: Record<string, unknown>) => ({
    from: String(e.from || ''),
    to: String(e.to || ''),
    strength: Math.min(10, Math.max(1, Number(e.strength) || 5)),
    evidence: String(e.evidence || ''),
  }));

  return { nodes, edges };
}

function mergeGraphData(
  existing: CausalGraph,
  extracted: { nodes: CausalNode[]; edges: CausalEdge[] }
): { graph: CausalGraph; nodesAdded: number; edgesAdded: number } {
  const existingNodeIds = new Set(existing.nodes.map(n => n.id));
  const existingEdgeKeys = new Set(
    existing.edges.map(e => `${e.from}::${e.to}`)
  );

  let nodesAdded = 0;
  let edgesAdded = 0;

  const newNodes = [...existing.nodes];
  const newEdges = [...existing.edges];

  for (const node of extracted.nodes) {
    if (!node.id || existingNodeIds.has(node.id)) {
      continue;
    }
    newNodes.push(node);
    existingNodeIds.add(node.id);
    nodesAdded++;
  }

  for (const edge of extracted.edges) {
    const key = `${edge.from}::${edge.to}`;
    if (existingEdgeKeys.has(key)) {
      continue;
    }
    newEdges.push(edge);
    existingEdgeKeys.add(key);
    edgesAdded++;
  }

  return {
    graph: { nodes: newNodes, edges: newEdges },
    nodesAdded,
    edgesAdded,
  };
}

// ============================================
// BFS Graph Traversal (Zero-Cost)
// ============================================

function buildAdjacencyList(
  graph: CausalGraph,
  direction: 'forward' | 'backward' | 'both'
): Map<string, string[]> {
  const adj = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (direction === 'forward' || direction === 'both') {
      const existing = adj.get(edge.from) ?? [];
      adj.set(edge.from, [...existing, edge.to]);
    }
    if (direction === 'backward' || direction === 'both') {
      const existing = adj.get(edge.to) ?? [];
      adj.set(edge.to, [...existing, edge.from]);
    }
  }

  return adj;
}

function bfsTraversal(
  startIds: string[],
  adj: Map<string, string[]>,
  maxHops: number
): Set<string> {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [];

  for (const id of startIds) {
    queue.push({ id, depth: 0 });
    visited.add(id);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxHops) {
      continue;
    }

    const neighbors = adj.get(current.id) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ id: neighbor, depth: current.depth + 1 });
      }
    }
  }

  return visited;
}

function extractSubgraph(graph: CausalGraph, nodeIds: Set<string>): { nodes: CausalNode[]; edges: CausalEdge[] } {
  const nodes = graph.nodes.filter(n => nodeIds.has(n.id));
  const edges = graph.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));
  return { nodes, edges };
}

function findNodesByKeywords(graph: CausalGraph, keywords: string): CausalNode[] {
  const terms = keywords.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return [];
  }

  return graph.nodes.filter(node => {
    const labelLower = node.label.toLowerCase();
    return terms.some(term => labelLower.includes(term));
  });
}

// ============================================
// Public API (Zero-Cost)
// ============================================

/**
 * Find nodes matching any keyword, BFS forward+backward 2 hops,
 * return connected subgraph with human-readable chains.
 */
export function findRelevantCauses(
  graph: CausalGraph,
  keywords: string[]
): { nodes: CausalNode[]; edges: CausalEdge[]; chains: string[] } {
  if (graph.nodes.length === 0 || keywords.length === 0) {
    return { nodes: [], edges: [], chains: [] };
  }

  // Find seed nodes matching any keyword
  const seedNodes: CausalNode[] = [];
  for (const keyword of keywords) {
    const matches = findNodesByKeywords(graph, keyword);
    for (const match of matches) {
      if (!seedNodes.some(s => s.id === match.id)) {
        seedNodes.push(match);
      }
    }
  }

  if (seedNodes.length === 0) {
    return { nodes: [], edges: [], chains: [] };
  }

  // BFS 2 hops in both directions
  const adj = buildAdjacencyList(graph, 'both');
  const reachableIds = bfsTraversal(
    seedNodes.map(n => n.id),
    adj,
    2
  );

  const subgraph = extractSubgraph(graph, reachableIds);

  // Build human-readable chains from edges in the subgraph
  const nodeMap = new Map(subgraph.nodes.map(n => [n.id, n]));
  const chains: string[] = subgraph.edges.map(edge => {
    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    const fromLabel = fromNode ? fromNode.label : edge.from;
    const toLabel = toNode ? toNode.label : edge.to;
    return `${fromLabel} -> ${toLabel} (evidence: ${edge.evidence})`;
  });

  return {
    nodes: subgraph.nodes,
    edges: subgraph.edges,
    chains,
  };
}

// ============================================
// Formatting
// ============================================

function formatQueryResult(
  nodes: CausalNode[],
  edges: CausalEdge[],
  graph: CausalGraph
): string {
  if (nodes.length === 0) {
    return 'No matching nodes found in the causal graph.';
  }

  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const lines: string[] = ['## Causal Graph Query Results', ''];

  // Group nodes by type
  const decisions = nodes.filter(n => n.type === 'decision');
  const outcomes = nodes.filter(n => n.type === 'outcome');
  const conditions = nodes.filter(n => n.type === 'condition');

  if (decisions.length > 0) {
    lines.push(`### Decisions (${decisions.length})`);
    for (const d of decisions) {
      lines.push(`- **${d.label}** [${d.sprint}] (${d.id})`);
    }
    lines.push('');
  }

  if (outcomes.length > 0) {
    lines.push(`### Outcomes (${outcomes.length})`);
    for (const o of outcomes) {
      lines.push(`- **${o.label}** [${o.sprint}] (${o.id})`);
    }
    lines.push('');
  }

  if (conditions.length > 0) {
    lines.push(`### Conditions (${conditions.length})`);
    for (const c of conditions) {
      lines.push(`- **${c.label}** [${c.sprint}] (${c.id})`);
    }
    lines.push('');
  }

  if (edges.length > 0) {
    lines.push(`### Causal Links (${edges.length})`);
    for (const e of edges) {
      const fromNode = nodeMap.get(e.from);
      const toNode = nodeMap.get(e.to);
      const fromLabel = fromNode ? fromNode.label : e.from;
      const toLabel = toNode ? toNode.label : e.to;
      lines.push(`- **${fromLabel}** -> **${toLabel}** (strength: ${e.strength}/10)`);
      lines.push(`  _Evidence: ${e.evidence}_`);
    }
    lines.push('');
  }

  lines.push(`_${nodes.length} nodes, ${edges.length} edges in subgraph_`);

  return lines.join('\n');
}

// ============================================
// MCP Registration
// ============================================

export function registerCausalGraphTools(server: McpServer): void {
  // ---- causal_extract ----
  server.tool(
    'causal_extract',
    'Extract decision->outcome causal pairs from sprint data using Haiku. Builds a causal graph for querying with causal_query. Cost: ~$0.002.',
    {
      sprint_phase: z.string().optional()
        .describe('Specific sprint phase to extract from (e.g., "Phase 72"). Defaults to latest sprint.'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('causal_extract', async ({ sprint_phase }) => {
      // Load sprint data
      const sprint = findSprintData(sprint_phase);

      if (!sprint) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No sprint data found. Start a sprint with `sprint_start` first.',
          }],
        };
      }

      logger.info('Causal extract starting', {
        source: sprint.source,
        phase: sprint.data.phase,
      });

      // Load existing graph for context
      const existingGraph = loadCausalGraph();

      // Format sprint data for the prompt
      const sprintText = formatSprintForPrompt(sprint.data);

      // Build existing graph context
      let existingContext = '';
      if (existingGraph.nodes.length > 0) {
        const recentNodes = existingGraph.nodes.slice(-20);
        existingContext = '\n\nExisting nodes in the graph (avoid duplicating these):\n' +
          recentNodes.map(n => `- [${n.type}] ${n.label} (${n.id})`).join('\n');
      }

      const route = getRoute('spot_check');

      const response = await withRetry(
        () => getAnthropicClient().messages.create({
          model: route.model,
          max_tokens: route.maxTokens,
          system: CAUSAL_EXTRACT_SYSTEM,
          messages: [{
            role: 'user',
            content: `Analyze this sprint data and extract causal relationships:\n\n${sprintText}${existingContext}`,
          }],
          tools: [CAUSAL_EXTRACT_TOOL],
          tool_choice: { type: 'tool', name: 'submit_causal_graph' },
        }),
        { maxRetries: 2, baseDelayMs: 1000 },
      );

      const cost = calculateCost(
        route.model,
        response.usage.input_tokens,
        response.usage.output_tokens,
      );

      trackUsage(
        route.model,
        response.usage.input_tokens,
        response.usage.output_tokens,
        'spot_check',
        'causal-extract',
      );

      // Parse AI response
      const extracted = parseExtractResponse(response);

      if (extracted.nodes.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No causal relationships extracted from sprint data.\n\n_Cost: $${cost}_`,
          }],
        };
      }

      // Merge into existing graph
      const { graph: updatedGraph, nodesAdded, edgesAdded } = mergeGraphData(
        existingGraph,
        extracted,
      );

      saveCausalGraph(updatedGraph);

      // Format output
      const lines: string[] = [
        `## Causal Extract: ${sprint.data.phase ?? 'Unknown'} - ${sprint.data.title ?? 'Unknown'}`,
        '',
        `**Nodes Extracted:** ${extracted.nodes.length} (${nodesAdded} new)`,
        `**Edges Extracted:** ${extracted.edges.length} (${edgesAdded} new)`,
        `**Total Graph Size:** ${updatedGraph.nodes.length} nodes, ${updatedGraph.edges.length} edges`,
        `**Cost:** $${cost}`,
        '',
        '### Extracted Nodes',
        '',
      ];

      for (const node of extracted.nodes) {
        const prefix = node.type === 'decision' ? 'D' : node.type === 'outcome' ? 'O' : 'C';
        lines.push(`- [${prefix}] **${node.label}** (${node.id})`);
      }

      if (extracted.edges.length > 0) {
        lines.push('', '### Extracted Edges', '');
        const nodeMap = new Map(extracted.nodes.map(n => [n.id, n]));
        for (const edge of extracted.edges) {
          const fromNode = nodeMap.get(edge.from);
          const toNode = nodeMap.get(edge.to);
          const fromLabel = fromNode ? fromNode.label : edge.from;
          const toLabel = toNode ? toNode.label : edge.to;
          lines.push(`- ${fromLabel} -> ${toLabel} (strength: ${edge.strength}/10)`);
          lines.push(`  _${edge.evidence}_`);
        }
      }

      logger.info('Causal extract complete', {
        nodesExtracted: extracted.nodes.length,
        edgesExtracted: extracted.edges.length,
        nodesAdded,
        edgesAdded,
        cost,
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }),
  );

  // ---- causal_query ----
  server.tool(
    'causal_query',
    'Query the causal graph with BFS traversal. Find causal chains by node ID or keywords. Zero-cost (no AI call).',
    {
      node_id: z.string().optional()
        .describe('Start BFS from a specific node ID'),
      keywords: z.string().optional()
        .describe('Find nodes whose label contains these keywords, then BFS from those'),
      direction: z.enum(['forward', 'backward', 'both']).optional().default('both')
        .describe('BFS direction: forward (effects), backward (causes), or both'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('causal_query', async ({ node_id, keywords, direction }) => {
      const graph = loadCausalGraph();

      if (graph.nodes.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Causal graph is empty. Run `causal_extract` first to populate it.',
          }],
        };
      }

      // Determine seed nodes
      let seedNodeIds: string[] = [];

      if (node_id) {
        const nodeExists = graph.nodes.some(n => n.id === node_id);
        if (!nodeExists) {
          return {
            content: [{
              type: 'text' as const,
              text: `Node "${node_id}" not found in the causal graph. Available nodes:\n` +
                graph.nodes.slice(0, 20).map(n => `- ${n.id}: ${n.label}`).join('\n'),
            }],
          };
        }
        seedNodeIds = [node_id];
      } else if (keywords) {
        const matchingNodes = findNodesByKeywords(graph, keywords);
        if (matchingNodes.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No nodes found matching keywords "${keywords}". Available nodes:\n` +
                graph.nodes.slice(0, 20).map(n => `- ${n.id}: ${n.label}`).join('\n'),
            }],
          };
        }
        seedNodeIds = matchingNodes.map(n => n.id);
      } else {
        // No filter — return full graph summary
        const output = formatQueryResult(graph.nodes, graph.edges, graph);
        return { content: [{ type: 'text' as const, text: output }] };
      }

      // BFS traversal
      const resolvedDirection = direction ?? 'both';
      const adj = buildAdjacencyList(graph, resolvedDirection);
      const reachableIds = bfsTraversal(seedNodeIds, adj, 2);
      const subgraph = extractSubgraph(graph, reachableIds);

      const output = formatQueryResult(subgraph.nodes, subgraph.edges, graph);

      return { content: [{ type: 'text' as const, text: output }] };
    }),
  );
}
