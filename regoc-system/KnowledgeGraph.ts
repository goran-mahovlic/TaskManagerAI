#!/usr/bin/env bun
/**
 * REGOČ Knowledge Graph (F7.1)
 *
 * SQLite-based relational knowledge graph stored in regoc.db.
 * Complements ChromaDB RAG (semantic search) with structured relations.
 *
 * Location: ~/.claude/regoc/data/regoc.db (shared with TaskManager)
 *
 * Usage:
 *   import { getKnowledgeGraph } from '~/.claude/regoc/KnowledgeGraph'
 *   const kg = getKnowledgeGraph()
 *   const id = kg.addNode({ title: 'GateMate', type: 'tool', content: 'FPGA toolchain' })
 *   kg.addRelation(id, otherId, 'related')
 */

import Database from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ============================================
// Types
// ============================================

export const KNOWLEDGE_TYPES = [
  'person', 'company', 'idea', 'research',
  'tool', 'project', 'lesson', 'decision'
] as const;
export type KnowledgeType = typeof KNOWLEDGE_TYPES[number];

export const RELATION_TYPES = [
  'supports', 'contradicts', 'extends', 'part-of',
  'instance-of', 'caused-by', 'preceded-by', 'related'
] as const;
export type RelationType = typeof RELATION_TYPES[number];

export interface KnowledgeNode {
  id: string;
  title: string;
  type: KnowledgeType;
  content: string;
  tags: string[];
  source: string | null;
  ragDocId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRelation {
  id: number;
  fromId: string;
  toId: string;
  relationType: RelationType;
  weight: number;
  createdAt: string;
}

export interface AddNodeInput {
  title: string;
  type: KnowledgeType;
  content: string;
  tags?: string[];
  source?: string;
  ragDocId?: string;
}

export interface SearchQuery {
  type?: KnowledgeType;
  tags?: string[];
  text?: string;
  limit?: number;
}

export interface TraversalResult {
  node: KnowledgeNode;
  depth: number;
  path: string[];
}

export interface KnowledgeStats {
  totalNodes: number;
  totalRelations: number;
  byType: Record<string, number>;
}

// ============================================
// Helpers
// ============================================

function generateId(): string {
  const ts = Date.now();
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rand = '';
  for (let i = 0; i < 4; i++) {
    rand += chars[Math.floor(Math.random() * chars.length)];
  }
  return `kg-${ts}-${rand}`;
}

function rowToNode(row: any): KnowledgeNode {
  return {
    id: row.id,
    title: row.title,
    type: row.type as KnowledgeType,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source || null,
    ragDocId: row.rag_doc_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRelation(row: any): KnowledgeRelation {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    relationType: row.relation_type as RelationType,
    weight: row.weight,
    createdAt: row.created_at,
  };
}

// ============================================
// KnowledgeGraph Class
// ============================================

export class KnowledgeGraph {
  private db: Database;

  constructor(dbPath?: string) {
    const defaultPath = join(
      process.env.HOME || '',
      '.claude', 'regoc', 'data', 'regoc.db'
    );
    const resolvedPath = dbPath || defaultPath;

    // Ensure parent directory exists
    const dir = resolvedPath.substring(0, resolvedPath.lastIndexOf('/'));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.exec("PRAGMA journal_mode = WAL"); this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        source TEXT,
        rag_doc_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS knowledge_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL REFERENCES knowledge(id),
        to_id TEXT NOT NULL REFERENCES knowledge(id),
        relation_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(from_id, to_id, relation_type)
      );
    `);
  }

  // ============================================
  // CRUD
  // ============================================

  addNode(input: AddNodeInput): string {
    const id = generateId();
    const tags = input.tags ? JSON.stringify(input.tags) : null;

    this.db.run(
      `INSERT INTO knowledge (id, title, type, content, tags, source, rag_doc_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.title, input.type, input.content, tags, input.source || null, input.ragDocId || null]
    );

    return id;
  }

  getNode(id: string): KnowledgeNode | null {
    const row = this.db.query(
      'SELECT * FROM knowledge WHERE id = ?'
    ).get(id) as any;

    return row ? rowToNode(row) : null;
  }

  updateNode(id: string, updates: Partial<Omit<KnowledgeNode, 'id' | 'createdAt'>>): boolean {
    const existing = this.getNode(id);
    if (!existing) return false;

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.type !== undefined) {
      fields.push('type = ?');
      values.push(updates.type);
    }
    if (updates.content !== undefined) {
      fields.push('content = ?');
      values.push(updates.content);
    }
    if (updates.tags !== undefined) {
      fields.push('tags = ?');
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.source !== undefined) {
      fields.push('source = ?');
      values.push(updates.source);
    }
    if (updates.ragDocId !== undefined) {
      fields.push('rag_doc_id = ?');
      values.push(updates.ragDocId);
    }

    if (fields.length === 0) return true;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db.run(
      `UPDATE knowledge SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return true;
  }

  deleteNode(id: string): boolean {
    const existing = this.getNode(id);
    if (!existing) return false;

    // Delete related relations first (cascade manually since SQLite FK cascade
    // only works on DELETE if configured, and we want explicit control)
    this.db.run('DELETE FROM knowledge_relations WHERE from_id = ? OR to_id = ?', [id, id]);
    this.db.run('DELETE FROM knowledge WHERE id = ?', [id]);

    return true;
  }

  // ============================================
  // Relations
  // ============================================

  addRelation(fromId: string, toId: string, relationType: RelationType, weight: number = 1.0): boolean {
    // Verify both nodes exist
    const fromNode = this.getNode(fromId);
    const toNode = this.getNode(toId);
    if (!fromNode || !toNode) return false;

    try {
      this.db.run(
        `INSERT INTO knowledge_relations (from_id, to_id, relation_type, weight)
         VALUES (?, ?, ?, ?)`,
        [fromId, toId, relationType, weight]
      );
      return true;
    } catch (error: any) {
      // UNIQUE constraint violation means duplicate relation
      if (error.message?.includes('UNIQUE constraint')) {
        return false;
      }
      throw error;
    }
  }

  getRelations(nodeId: string, direction: 'from' | 'to' | 'both' = 'both'): KnowledgeRelation[] {
    let rows: any[];

    if (direction === 'from') {
      rows = this.db.query(
        'SELECT * FROM knowledge_relations WHERE from_id = ?'
      ).all(nodeId) as any[];
    } else if (direction === 'to') {
      rows = this.db.query(
        'SELECT * FROM knowledge_relations WHERE to_id = ?'
      ).all(nodeId) as any[];
    } else {
      rows = this.db.query(
        'SELECT * FROM knowledge_relations WHERE from_id = ? OR to_id = ?'
      ).all(nodeId, nodeId) as any[];
    }

    return rows.map(rowToRelation);
  }

  removeRelation(fromId: string, toId: string, relationType: RelationType): boolean {
    const result = this.db.run(
      'DELETE FROM knowledge_relations WHERE from_id = ? AND to_id = ? AND relation_type = ?',
      [fromId, toId, relationType]
    );
    return result.changes > 0;
  }

  // ============================================
  // Traversal
  // ============================================

  getRelated(nodeId: string, options?: { depth?: number; types?: KnowledgeType[] }): KnowledgeNode[] {
    const depth = options?.depth ?? 1;
    const types = options?.types;
    const visited = new Set<string>([nodeId]);
    let currentIds = [nodeId];

    for (let d = 0; d < depth; d++) {
      const nextIds: string[] = [];

      for (const id of currentIds) {
        const relations = this.getRelations(id, 'both');
        for (const rel of relations) {
          const neighborId = rel.fromId === id ? rel.toId : rel.fromId;
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nextIds.push(neighborId);
          }
        }
      }

      currentIds = nextIds;
      if (currentIds.length === 0) break;
    }

    // Remove starting node from results
    visited.delete(nodeId);

    const result: KnowledgeNode[] = [];
    for (const id of visited) {
      const node = this.getNode(id);
      if (node) {
        if (!types || types.includes(node.type)) {
          result.push(node);
        }
      }
    }

    return result;
  }

  traverse(startId: string, maxDepth: number = 3): Map<string, TraversalResult> {
    const results = new Map<string, TraversalResult>();
    const queue: Array<{ id: string; depth: number; path: string[] }> = [
      { id: startId, depth: 0, path: [startId] }
    ];

    const startNode = this.getNode(startId);
    if (!startNode) return results;

    results.set(startId, { node: startNode, depth: 0, path: [startId] });

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.depth >= maxDepth) continue;

      const relations = this.getRelations(current.id, 'both');
      for (const rel of relations) {
        const neighborId = rel.fromId === current.id ? rel.toId : rel.fromId;

        if (!results.has(neighborId)) {
          const neighborNode = this.getNode(neighborId);
          if (neighborNode) {
            const newPath = [...current.path, neighborId];
            results.set(neighborId, {
              node: neighborNode,
              depth: current.depth + 1,
              path: newPath,
            });
            queue.push({ id: neighborId, depth: current.depth + 1, path: newPath });
          }
        }
      }
    }

    return results;
  }

  // ============================================
  // Search
  // ============================================

  search(query: SearchQuery): KnowledgeNode[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (query.type) {
      conditions.push('type = ?');
      params.push(query.type);
    }

    if (query.text) {
      conditions.push('(title LIKE ? OR content LIKE ?)');
      const likePattern = `%${query.text}%`;
      params.push(likePattern, likePattern);
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const limit = query.limit ?? 50;

    const sql = `SELECT * FROM knowledge ${whereClause} ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);

    let rows = this.db.query(sql).all(...params) as any[];

    // Tag filtering done in JS since tags are stored as JSON array
    if (query.tags && query.tags.length > 0) {
      rows = rows.filter(row => {
        if (!row.tags) return false;
        const nodeTags: string[] = JSON.parse(row.tags);
        return query.tags!.some(tag => nodeTags.includes(tag));
      });
    }

    return rows.map(rowToNode);
  }

  // ============================================
  // Stats
  // ============================================

  getStats(): KnowledgeStats {
    const totalNodes = (this.db.query(
      'SELECT COUNT(*) as count FROM knowledge'
    ).get() as any).count;

    const totalRelations = (this.db.query(
      'SELECT COUNT(*) as count FROM knowledge_relations'
    ).get() as any).count;

    const typeRows = this.db.query(
      'SELECT type, COUNT(*) as count FROM knowledge GROUP BY type'
    ).all() as any[];

    const byType: Record<string, number> = {};
    for (const row of typeRows) {
      byType[row.type] = row.count;
    }

    return { totalNodes, totalRelations, byType };
  }

  // ============================================
  // Lifecycle
  // ============================================

  close(): void {
    this.db.close();
  }
}

// ============================================
// Singleton
// ============================================

let _instance: KnowledgeGraph | null = null;

export function getKnowledgeGraph(): KnowledgeGraph {
  if (!_instance) {
    _instance = new KnowledgeGraph();
  }
  return _instance;
}
