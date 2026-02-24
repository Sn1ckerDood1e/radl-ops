import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Use in-memory DB for tests
let testDb: Database.Database;

vi.mock('./fts-index.js', () => ({
  getDbForGraph: () => testDb,
}));

import {
  addNode, addNodes, getNode, getNodesByType, getNodeCount,
  addEdge, addEdges, getEdgeCount,
  getNeighbors, traverseBFS, findNodesByKeywords,
  getGraphStats, clearGraph,
  type GraphNode, type GraphEdge,
} from './graph.js';

function setupTestDb() {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');

  testDb.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      properties TEXT DEFAULT '{}'
    );
  `);

  testDb.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      relationship TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      PRIMARY KEY (source, target, relationship)
    );
  `);

  testDb.exec('CREATE INDEX IF NOT EXISTS idx_edges_source ON knowledge_edges(source)');
  testDb.exec('CREATE INDEX IF NOT EXISTS idx_edges_target ON knowledge_edges(target)');
}

describe('Knowledge Graph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupTestDb();
  });

  afterEach(() => {
    if (testDb) testDb.close();
  });

  describe('Node Operations', () => {
    it('adds and retrieves a node', () => {
      const node: GraphNode = {
        id: 'pattern-1',
        type: 'pattern',
        label: 'CSRF Protection',
        properties: { example: 'getCsrfHeaders()' },
      };

      addNode(node);
      const retrieved = getNode('pattern-1');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.label).toBe('CSRF Protection');
      expect(retrieved!.properties).toEqual({ example: 'getCsrfHeaders()' });
    });

    it('upserts existing node', () => {
      addNode({ id: 'n1', type: 'concept', label: 'old', properties: {} });
      addNode({ id: 'n1', type: 'concept', label: 'updated', properties: { version: 2 } });

      const node = getNode('n1');
      expect(node!.label).toBe('updated');
      expect(node!.properties).toEqual({ version: 2 });
    });

    it('returns null for missing node', () => {
      expect(getNode('nonexistent')).toBeNull();
    });

    it('adds multiple nodes in batch', () => {
      addNodes([
        { id: 'a', type: 'concept', label: 'Auth', properties: {} },
        { id: 'b', type: 'concept', label: 'CSRF', properties: {} },
        { id: 'c', type: 'concept', label: 'Toast', properties: {} },
      ]);

      expect(getNodeCount()).toBe(3);
    });

    it('gets nodes by type', () => {
      addNodes([
        { id: 'p1', type: 'pattern', label: 'CSRF', properties: {} },
        { id: 'p2', type: 'pattern', label: 'Toast', properties: {} },
        { id: 'l1', type: 'lesson', label: 'listUsers', properties: {} },
      ]);

      const patterns = getNodesByType('pattern');
      expect(patterns).toHaveLength(2);
      expect(patterns.map(p => p.id)).toContain('p1');
      expect(patterns.map(p => p.id)).toContain('p2');
    });
  });

  describe('Edge Operations', () => {
    it('adds and counts edges', () => {
      addNodes([
        { id: 'a', type: 'concept', label: 'A', properties: {} },
        { id: 'b', type: 'concept', label: 'B', properties: {} },
      ]);

      addEdge({ source: 'a', target: 'b', relationship: 'related_to', weight: 0.8 });
      expect(getEdgeCount()).toBe(1);
    });

    it('upserts edge weight', () => {
      addNodes([
        { id: 'a', type: 'concept', label: 'A', properties: {} },
        { id: 'b', type: 'concept', label: 'B', properties: {} },
      ]);

      addEdge({ source: 'a', target: 'b', relationship: 'related_to', weight: 0.5 });
      addEdge({ source: 'a', target: 'b', relationship: 'related_to', weight: 0.9 });

      expect(getEdgeCount()).toBe(1); // Still 1 edge, just updated
    });

    it('adds multiple edges in batch', () => {
      addNodes([
        { id: 'a', type: 'concept', label: 'A', properties: {} },
        { id: 'b', type: 'concept', label: 'B', properties: {} },
        { id: 'c', type: 'concept', label: 'C', properties: {} },
      ]);

      addEdges([
        { source: 'a', target: 'b', relationship: 'related_to', weight: 0.5 },
        { source: 'a', target: 'c', relationship: 'caused_by', weight: 0.7 },
        { source: 'b', target: 'c', relationship: 'prevents', weight: 0.3 },
      ]);

      expect(getEdgeCount()).toBe(3);
    });
  });

  describe('Traversal', () => {
    beforeEach(() => {
      // Build a small graph: A -> B -> C, A -> D
      addNodes([
        { id: 'A', type: 'sprint', label: 'Sprint A', properties: {} },
        { id: 'B', type: 'lesson', label: 'Lesson B', properties: {} },
        { id: 'C', type: 'concept', label: 'Concept C', properties: {} },
        { id: 'D', type: 'pattern', label: 'Pattern D', properties: {} },
      ]);
      addEdges([
        { source: 'A', target: 'B', relationship: 'produced', weight: 0.8 },
        { source: 'B', target: 'C', relationship: 'mentions', weight: 0.5 },
        { source: 'A', target: 'D', relationship: 'produced', weight: 0.6 },
      ]);
    });

    it('gets 1-hop neighbors', () => {
      const neighbors = getNeighbors('A');
      expect(neighbors).toHaveLength(2);

      const labels = neighbors.map(n => n.node.label);
      expect(labels).toContain('Lesson B');
      expect(labels).toContain('Pattern D');
    });

    it('includes incoming edges in neighbors', () => {
      const neighbors = getNeighbors('B');
      // B has: incoming from A, outgoing to C
      expect(neighbors).toHaveLength(2);

      const directions = neighbors.map(n => n.direction);
      expect(directions).toContain('incoming');
      expect(directions).toContain('outgoing');
    });

    it('BFS traversal finds nodes within depth', () => {
      const results = traverseBFS('A', 2);
      // depth 1: B, D; depth 2: C (via B)
      expect(results).toHaveLength(3);
      expect(results.map(r => r.node.label)).toContain('Concept C');
    });

    it('BFS respects max depth', () => {
      const results = traverseBFS('A', 1);
      // Only depth 1: B, D
      expect(results).toHaveLength(2);
      expect(results.map(r => r.node.label)).not.toContain('Concept C');
    });

    it('BFS respects max nodes limit', () => {
      const results = traverseBFS('A', 2, 1);
      expect(results).toHaveLength(1);
    });
  });

  describe('Keyword Search', () => {
    it('finds nodes by label keywords', () => {
      addNodes([
        { id: 'n1', type: 'concept', label: 'CSRF protection headers', properties: {} },
        { id: 'n2', type: 'concept', label: 'Toast notifications', properties: {} },
        { id: 'n3', type: 'concept', label: 'Auth getUser pattern', properties: {} },
      ]);

      const results = findNodesByKeywords(['csrf']);
      expect(results).toHaveLength(1);
      expect(results[0].label).toBe('CSRF protection headers');
    });

    it('matches multiple keywords with OR', () => {
      addNodes([
        { id: 'n1', type: 'concept', label: 'CSRF headers', properties: {} },
        { id: 'n2', type: 'concept', label: 'Auth tokens', properties: {} },
        { id: 'n3', type: 'concept', label: 'Database queries', properties: {} },
      ]);

      const results = findNodesByKeywords(['csrf', 'auth']);
      expect(results).toHaveLength(2);
    });

    it('returns empty for no matches', () => {
      addNodes([
        { id: 'n1', type: 'concept', label: 'CSRF headers', properties: {} },
      ]);

      const results = findNodesByKeywords(['xylophone']);
      expect(results).toHaveLength(0);
    });
  });

  describe('Statistics and Cleanup', () => {
    it('returns correct graph stats', () => {
      addNodes([
        { id: 'p1', type: 'pattern', label: 'A', properties: {} },
        { id: 'p2', type: 'pattern', label: 'B', properties: {} },
        { id: 'c1', type: 'concept', label: 'C', properties: {} },
      ]);
      addEdges([
        { source: 'p1', target: 'c1', relationship: 'mentions', weight: 0.5 },
      ]);

      const stats = getGraphStats();
      expect(stats.nodes).toBe(3);
      expect(stats.edges).toBe(1);
      expect(stats.nodeTypes.pattern).toBe(2);
      expect(stats.nodeTypes.concept).toBe(1);
    });

    it('clears all graph data', () => {
      addNodes([
        { id: 'a', type: 'concept', label: 'A', properties: {} },
        { id: 'b', type: 'concept', label: 'B', properties: {} },
      ]);
      addEdge({ source: 'a', target: 'b', relationship: 'related_to', weight: 1 });

      clearGraph();

      expect(getNodeCount()).toBe(0);
      expect(getEdgeCount()).toBe(0);
    });
  });
});
