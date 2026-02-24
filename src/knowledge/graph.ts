/**
 * Knowledge Graph — Entity-relationship layer over FTS5 index.
 *
 * Provides graph CRUD (addNode, addEdge, getNeighbors, traverse)
 * stored in SQLite tables alongside the existing FTS5 index.
 *
 * Used by:
 * - Bloom pipeline (entity extraction after lesson extraction)
 * - knowledge_query (fusion retrieval: FTS5 + graph neighbors)
 * - inverse_bloom (graph neighbor scoring when no direct FTS5 hit)
 */

import type Database from 'better-sqlite3';
import { logger } from '../config/logger.js';
import { getDbForGraph } from './fts-index.js';

function getDb(): Database.Database {
  return getDbForGraph();
}

// ============================================
// Types
// ============================================

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationship: string;
  weight: number;
}

export interface Neighbor {
  node: GraphNode;
  edge: GraphEdge;
  direction: 'outgoing' | 'incoming';
}

// ============================================
// Node Operations
// ============================================

/**
 * Add or update a node in the knowledge graph.
 * Upserts: if node with same ID exists, updates label and properties.
 */
export function addNode(node: GraphNode): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO knowledge_nodes (id, type, label, properties)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      properties = excluded.properties
  `).run(node.id, node.type, node.label, JSON.stringify(node.properties));
}

/**
 * Add multiple nodes in a single transaction.
 */
export function addNodes(nodes: GraphNode[]): void {
  if (nodes.length === 0) return;
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO knowledge_nodes (id, type, label, properties)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      properties = excluded.properties
  `);

  const batch = db.transaction((items: GraphNode[]) => {
    for (const node of items) {
      insert.run(node.id, node.type, node.label, JSON.stringify(node.properties));
    }
  });
  batch(nodes);
}

/**
 * Get a node by ID. Returns null if not found.
 */
export function getNode(id: string): GraphNode | null {
  const db = getDb();
  const row = db.prepare('SELECT id, type, label, properties FROM knowledge_nodes WHERE id = ?')
    .get(id) as { id: string; type: string; label: string; properties: string } | undefined;

  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    properties: JSON.parse(row.properties),
  };
}

/**
 * Get all nodes of a given type.
 */
export function getNodesByType(type: string): GraphNode[] {
  const db = getDb();
  const rows = db.prepare('SELECT id, type, label, properties FROM knowledge_nodes WHERE type = ?')
    .all(type) as Array<{ id: string; type: string; label: string; properties: string }>;

  return rows.map(row => ({
    id: row.id,
    type: row.type,
    label: row.label,
    properties: JSON.parse(row.properties),
  }));
}

/**
 * Count total nodes in the graph.
 */
export function getNodeCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT count(*) as cnt FROM knowledge_nodes').get() as { cnt: number };
  return row.cnt;
}

// ============================================
// Edge Operations
// ============================================

/**
 * Add or update an edge in the knowledge graph.
 * Upserts: if same (source, target, relationship) exists, updates weight.
 */
export function addEdge(edge: GraphEdge): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO knowledge_edges (source, target, relationship, weight)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source, target, relationship) DO UPDATE SET
      weight = excluded.weight
  `).run(edge.source, edge.target, edge.relationship, edge.weight);
}

/**
 * Add multiple edges in a single transaction.
 */
export function addEdges(edges: GraphEdge[]): void {
  if (edges.length === 0) return;
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO knowledge_edges (source, target, relationship, weight)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source, target, relationship) DO UPDATE SET
      weight = excluded.weight
  `);

  const batch = db.transaction((items: GraphEdge[]) => {
    for (const edge of items) {
      insert.run(edge.source, edge.target, edge.relationship, edge.weight);
    }
  });
  batch(edges);
}

/**
 * Get the edge count in the graph.
 */
export function getEdgeCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT count(*) as cnt FROM knowledge_edges').get() as { cnt: number };
  return row.cnt;
}

// ============================================
// Traversal
// ============================================

/**
 * Get 1-hop neighbors of a node (both incoming and outgoing edges).
 */
export function getNeighbors(nodeId: string): Neighbor[] {
  const db = getDb();
  const neighbors: Neighbor[] = [];

  // Outgoing edges: this node -> target
  const outgoing = db.prepare(`
    SELECT e.source, e.target, e.relationship, e.weight,
           n.id, n.type, n.label, n.properties
    FROM knowledge_edges e
    JOIN knowledge_nodes n ON n.id = e.target
    WHERE e.source = ?
  `).all(nodeId) as Array<{
    source: string; target: string; relationship: string; weight: number;
    id: string; type: string; label: string; properties: string;
  }>;

  for (const row of outgoing) {
    neighbors.push({
      node: { id: row.id, type: row.type, label: row.label, properties: JSON.parse(row.properties) },
      edge: { source: row.source, target: row.target, relationship: row.relationship, weight: row.weight },
      direction: 'outgoing',
    });
  }

  // Incoming edges: source -> this node
  const incoming = db.prepare(`
    SELECT e.source, e.target, e.relationship, e.weight,
           n.id, n.type, n.label, n.properties
    FROM knowledge_edges e
    JOIN knowledge_nodes n ON n.id = e.source
    WHERE e.target = ?
  `).all(nodeId) as Array<{
    source: string; target: string; relationship: string; weight: number;
    id: string; type: string; label: string; properties: string;
  }>;

  for (const row of incoming) {
    neighbors.push({
      node: { id: row.id, type: row.type, label: row.label, properties: JSON.parse(row.properties) },
      edge: { source: row.source, target: row.target, relationship: row.relationship, weight: row.weight },
      direction: 'incoming',
    });
  }

  return neighbors;
}

/**
 * BFS traversal from a starting node up to a given depth.
 * Returns all nodes reachable within `maxDepth` hops.
 * Each result includes the shortest path distance.
 */
export function traverseBFS(
  startId: string,
  maxDepth: number = 2,
  maxNodes: number = 50,
): Array<{ node: GraphNode; depth: number; via: string }> {
  const visited = new Set<string>();
  const results: Array<{ node: GraphNode; depth: number; via: string }> = [];
  const queue: Array<{ nodeId: string; depth: number; via: string }> = [
    { nodeId: startId, depth: 0, via: '' },
  ];

  visited.add(startId);

  while (queue.length > 0 && results.length < maxNodes) {
    const current = queue.shift()!;

    if (current.depth > 0) {
      const node = getNode(current.nodeId);
      if (node) {
        results.push({ node, depth: current.depth, via: current.via });
      }
    }

    if (current.depth >= maxDepth) continue;

    const neighbors = getNeighbors(current.nodeId);
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor.node.id)) {
        visited.add(neighbor.node.id);
        queue.push({
          nodeId: neighbor.node.id,
          depth: current.depth + 1,
          via: neighbor.edge.relationship,
        });
      }
    }
  }

  return results;
}

/**
 * Find nodes whose labels match any of the given keywords.
 * Used as entry points for graph-based retrieval.
 */
export function findNodesByKeywords(keywords: string[], maxResults: number = 10): GraphNode[] {
  if (keywords.length === 0) return [];
  const db = getDb();

  // Build a LIKE query for each keyword on the label field
  const conditions = keywords.map(() => 'LOWER(label) LIKE ?').join(' OR ');
  const params = keywords.map(k => `%${k.toLowerCase()}%`);

  const rows = db.prepare(`
    SELECT id, type, label, properties
    FROM knowledge_nodes
    WHERE ${conditions}
    LIMIT ?
  `).all(...params, maxResults) as Array<{
    id: string; type: string; label: string; properties: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    type: row.type,
    label: row.label,
    properties: JSON.parse(row.properties),
  }));
}

/**
 * Get graph statistics for diagnostics.
 */
export function getGraphStats(): { nodes: number; edges: number; nodeTypes: Record<string, number> } {
  const db = getDb();
  const nodeCount = (db.prepare('SELECT count(*) as cnt FROM knowledge_nodes').get() as { cnt: number }).cnt;
  const edgeCount = (db.prepare('SELECT count(*) as cnt FROM knowledge_edges').get() as { cnt: number }).cnt;

  const typeRows = db.prepare('SELECT type, count(*) as cnt FROM knowledge_nodes GROUP BY type')
    .all() as Array<{ type: string; cnt: number }>;

  const nodeTypes: Record<string, number> = {};
  for (const row of typeRows) {
    nodeTypes[row.type] = row.cnt;
  }

  return { nodes: nodeCount, edges: edgeCount, nodeTypes };
}

/**
 * Clear all graph data (nodes and edges).
 * Used during full rebuild.
 */
export function clearGraph(): void {
  const db = getDb();
  db.exec('DELETE FROM knowledge_edges');
  db.exec('DELETE FROM knowledge_nodes');
  logger.info('Knowledge graph cleared');
}
