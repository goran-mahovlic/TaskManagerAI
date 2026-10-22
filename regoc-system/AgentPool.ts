#!/usr/bin/env bun
/**
 * REGOČ Warm Agent Pool (F6.3)
 *
 * Maintains a pool of recently-used agents with cached context summaries,
 * enabling warm-start re-spawns instead of cold-start from scratch.
 *
 * Location: ~/.claude/regoc/AgentPool.ts
 *
 * Usage:
 *   import { getAgentPool } from '~/.claude/regoc/AgentPool'
 *   const pool = getAgentPool()
 *   pool.addToPool('jelena', 'Worked on parser module. Key decisions: ...')
 *   if (pool.isWarm('jelena')) {
 *     const ctx = pool.getWarmContext('jelena')
 *     // Use ctx in agent prompt for warm start
 *   }
 */

import { Database } from 'bun:sqlite'
import { join } from 'path'

// ============================================
// Configuration
// ============================================

const REGOC_DIR = join(process.env.HOME || '', '.claude/regoc')
const DB_PATH = join(REGOC_DIR, 'messages.db')

/** Only opus agents can be pooled (they're expensive to spawn) */
const POOLABLE_AGENTS = new Set([
  'kosjenka', 'jelena', 'malik', 'manda', 'dora', 'emard',
])

const MAX_CONTEXT_LENGTH = 2000

// ============================================
// Types
// ============================================

export type PoolStatus = 'idle' | 'active' | 'warming' | 'expired'

export interface PoolEntry {
  agentId: string
  status: PoolStatus
  lastActive: string
  contextSummary: string
  currentTask: string | null
  warmUntil: string
  spawnCount: number
}

// ============================================
// AgentPool Class
// ============================================

export class AgentPool {
  private db: Database
  private static instance: AgentPool | null = null

  readonly MAX_POOL_SIZE = 3
  readonly DEFAULT_WARM_MINUTES = 15

  private constructor(dbPath?: string) {
    this.db = new Database(dbPath || DB_PATH)
    this.db.exec("PRAGMA journal_mode = WAL"); this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec('PRAGMA journal_mode = WAL')
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_pool (
        agent_id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'idle',
        last_active TEXT NOT NULL,
        context_summary TEXT,
        current_task TEXT,
        warm_until TEXT NOT NULL,
        spawn_count INTEGER DEFAULT 0
      );
    `)
  }

  static getInstance(dbPath?: string): AgentPool {
    if (!AgentPool.instance) {
      AgentPool.instance = new AgentPool(dbPath)
    }
    return AgentPool.instance
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    if (AgentPool.instance) {
      AgentPool.instance.close()
      AgentPool.instance = null
    }
  }

  // ============================================
  // Core Methods
  // ============================================

  /**
   * Add agent to pool after task completion.
   * Returns true if added, false if agent is not poolable or pool constraints prevent it.
   */
  addToPool(agentId: string, contextSummary: string, warmMinutes?: number): boolean {
    const id = agentId.toLowerCase()

    // Only opus agents are poolable
    if (!POOLABLE_AGENTS.has(id)) {
      return false
    }

    // Truncate context summary
    const truncatedContext = contextSummary.length > MAX_CONTEXT_LENGTH
      ? contextSummary.slice(0, MAX_CONTEXT_LENGTH)
      : contextSummary

    const minutes = warmMinutes ?? this.DEFAULT_WARM_MINUTES
    const now = new Date().toISOString()
    const warmUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString()

    // Check if agent already in pool — update instead of insert
    const existing = this.getEntry(id)
    if (existing) {
      try {
        this.db.prepare(`
          UPDATE agent_pool
          SET status = 'idle',
              last_active = ?,
              context_summary = ?,
              current_task = NULL,
              warm_until = ?,
              spawn_count = spawn_count + 1
          WHERE agent_id = ?
        `).run(now, truncatedContext, warmUntil, id)
        return true
      } catch (error) {
        console.error('[AgentPool] Error updating pool entry:', error)
        return false
      }
    }

    // Enforce MAX_POOL_SIZE — evict oldest idle if full
    this.enforcePoolSize()

    // Re-check after eviction — if still full (all active), reject
    const currentSize = this.getCurrentSize()
    if (currentSize >= this.MAX_POOL_SIZE) {
      return false
    }

    try {
      this.db.prepare(`
        INSERT INTO agent_pool (agent_id, status, last_active, context_summary, current_task, warm_until, spawn_count)
        VALUES (?, 'idle', ?, ?, NULL, ?, 1)
      `).run(id, now, truncatedContext, warmUntil)
      return true
    } catch (error) {
      console.error('[AgentPool] Error adding to pool:', error)
      return false
    }
  }

  /**
   * Check if agent is in pool and still warm (not expired).
   */
  isWarm(agentId: string): boolean {
    const id = agentId.toLowerCase()
    try {
      const row = this.db.prepare(`
        SELECT 1 FROM agent_pool
        WHERE agent_id = ?
          AND status IN ('idle', 'warming')
          AND warm_until > datetime('now')
      `).get(id)
      return row !== null
    } catch (error) {
      return false
    }
  }

  /**
   * Get warm context for agent (for warm start prompt).
   * Returns null if agent is not in pool or has expired.
   */
  getWarmContext(agentId: string): string | null {
    const id = agentId.toLowerCase()
    try {
      const row = this.db.prepare(`
        SELECT context_summary FROM agent_pool
        WHERE agent_id = ?
          AND status IN ('idle', 'warming')
          AND warm_until > datetime('now')
      `).get(id) as { context_summary: string } | null

      return row?.context_summary ?? null
    } catch (error) {
      return null
    }
  }

  /**
   * Mark agent as active (taken from pool for new task).
   * Returns true if activated, false if not in pool or expired.
   */
  activate(agentId: string, taskId: string): boolean {
    const id = agentId.toLowerCase()
    try {
      const result = this.db.prepare(`
        UPDATE agent_pool
        SET status = 'active',
            current_task = ?,
            last_active = datetime('now')
        WHERE agent_id = ?
          AND status IN ('idle', 'warming')
          AND warm_until > datetime('now')
      `).run(taskId, id)

      return result.changes > 0
    } catch (error) {
      console.error('[AgentPool] Error activating agent:', error)
      return false
    }
  }

  /**
   * Remove expired agents from pool.
   * Returns the number of entries removed.
   */
  cleanup(): number {
    try {
      // Mark expired entries
      this.db.prepare(`
        UPDATE agent_pool
        SET status = 'expired'
        WHERE status IN ('idle', 'warming')
          AND warm_until <= datetime('now')
      `).run()

      // Delete expired entries
      const result = this.db.prepare(`
        DELETE FROM agent_pool
        WHERE status = 'expired'
      `).run()

      return result.changes
    } catch (error) {
      console.error('[AgentPool] Error during cleanup:', error)
      return 0
    }
  }

  /**
   * Get pool status — all entries including expired.
   */
  getStatus(): PoolEntry[] {
    try {
      const rows = this.db.prepare(`
        SELECT agent_id, status, last_active, context_summary, current_task, warm_until, spawn_count
        FROM agent_pool
        ORDER BY last_active DESC
      `).all() as Array<{
        agent_id: string
        status: string
        last_active: string
        context_summary: string
        current_task: string | null
        warm_until: string
        spawn_count: number
      }>

      return rows.map(r => ({
        agentId: r.agent_id,
        status: r.status as PoolStatus,
        lastActive: r.last_active,
        contextSummary: r.context_summary || '',
        currentTask: r.current_task,
        warmUntil: r.warm_until,
        spawnCount: r.spawn_count,
      }))
    } catch (error) {
      console.error('[AgentPool] Error getting status:', error)
      return []
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  private getEntry(agentId: string): PoolEntry | null {
    try {
      const row = this.db.prepare(`
        SELECT agent_id, status, last_active, context_summary, current_task, warm_until, spawn_count
        FROM agent_pool
        WHERE agent_id = ?
      `).get(agentId) as any | null

      if (!row) return null
      return {
        agentId: row.agent_id,
        status: row.status as PoolStatus,
        lastActive: row.last_active,
        contextSummary: row.context_summary || '',
        currentTask: row.current_task,
        warmUntil: row.warm_until,
        spawnCount: row.spawn_count,
      }
    } catch (error) {
      return null
    }
  }

  private getCurrentSize(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM agent_pool').get() as { count: number }
      return row.count
    } catch (error) {
      return 0
    }
  }

  /**
   * Enforce MAX_POOL_SIZE by evicting the oldest idle agent.
   */
  private enforcePoolSize(): void {
    const size = this.getCurrentSize()
    if (size < this.MAX_POOL_SIZE) return

    try {
      // Find the oldest idle agent to evict
      const oldest = this.db.prepare(`
        SELECT agent_id FROM agent_pool
        WHERE status = 'idle'
        ORDER BY last_active ASC
        LIMIT 1
      `).get() as { agent_id: string } | null

      if (oldest) {
        this.db.prepare('DELETE FROM agent_pool WHERE agent_id = ?').run(oldest.agent_id)
      }
    } catch (error) {
      console.error('[AgentPool] Error evicting agent:', error)
    }
  }

  // ============================================
  // Utility
  // ============================================

  /**
   * Close database connection.
   */
  close(): void {
    this.db.close()
  }
}

// ============================================
// Singleton Export
// ============================================

export function getAgentPool(dbPath?: string): AgentPool {
  return AgentPool.getInstance(dbPath)
}

// ============================================
// CLI Interface
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'status': {
      const pool = getAgentPool()
      const entries = pool.getStatus()
      if (entries.length === 0) {
        console.log('Pool is empty.')
      } else {
        console.log(JSON.stringify(entries, null, 2))
      }
      break
    }

    case 'add': {
      const [, agent, context] = args
      if (!agent || !context) {
        console.error('Usage: AgentPool.ts add <agent> <context>')
        process.exit(1)
      }
      const pool = getAgentPool()
      const ok = pool.addToPool(agent, context)
      console.log(ok ? `Added ${agent} to pool` : `Failed to add ${agent} (not poolable or pool full)`)
      break
    }

    case 'warm': {
      const agent = args[1]
      if (!agent) {
        console.error('Usage: AgentPool.ts warm <agent>')
        process.exit(1)
      }
      const pool = getAgentPool()
      console.log(pool.isWarm(agent) ? `${agent} is warm` : `${agent} is NOT warm`)
      break
    }

    case 'cleanup': {
      const pool = getAgentPool()
      const removed = pool.cleanup()
      console.log(`Cleaned up ${removed} expired entries`)
      break
    }

    case 'help':
    default:
      console.log(`REGOC Warm Agent Pool CLI

Usage:
  bun AgentPool.ts <command> [args]

Commands:
  status                      Show pool status
  add <agent> <context>       Add agent to pool
  warm <agent>                Check if agent is warm
  cleanup                     Remove expired agents

Examples:
  bun AgentPool.ts status
  bun AgentPool.ts add jelena "Worked on parser. Key: async BRAM pattern."
  bun AgentPool.ts warm jelena
  bun AgentPool.ts cleanup
`)
  }
}
