#!/usr/bin/env bun
/**
 * REGOČ Agent Checkpoint (F6.2)
 *
 * Generates CHECKPOINT blocks for agent prompts that include
 * messages from ALL agents (not just REGOC), enabling
 * agent-to-agent direct communication awareness.
 *
 * Location: ~/.claude/regoc/AgentCheckpoint.ts
 *
 * Usage:
 *   import { getAgentCheckpoint } from '~/.claude/regoc/AgentCheckpoint'
 *   const cp = getAgentCheckpoint()
 *   const block = cp.generateCheckpointBlock('jelena', 'Implement parser')
 *   const result = cp.checkMessages('jelena')
 */

import { Database } from 'bun:sqlite'
import { join } from 'path'

// ============================================
// Configuration
// ============================================

const REGOC_DIR = join(process.env.HOME || '', '.claude/regoc')
const DB_PATH = join(REGOC_DIR, 'messages.db')

// Agent display names for CHECKPOINT block
const AGENT_NAMES: Record<string, string> = {
  regoc: 'REGOC',
  klaudio: 'Klaudio',
  stribor: 'Stribor',
  kosjenka: 'Kosjenka',
  jelena: 'Jelena',
  malik: 'Malik',
  manda: 'Manda',
  potjeh: 'Potjeh',
  dora: 'Dora',
  gita: 'Gita',
  grga: 'Grga',
  emard: 'Emard',
}

// ============================================
// Types
// ============================================

export interface CheckpointMessage {
  id: string
  from: string
  content: string
}

export interface CheckpointResult {
  regocMessages: CheckpointMessage[]
  peerMessages: CheckpointMessage[]
  helpRequests: CheckpointMessage[]
  totalPending: number
}

// ============================================
// AgentCheckpoint Class
// ============================================

export class AgentCheckpoint {
  private db: Database
  private static instance: AgentCheckpoint | null = null

  private constructor(dbPath?: string) {
    this.db = new Database(dbPath || DB_PATH)
    this.db.exec("PRAGMA journal_mode = WAL"); this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  static getInstance(dbPath?: string): AgentCheckpoint {
    if (!AgentCheckpoint.instance) {
      AgentCheckpoint.instance = new AgentCheckpoint(dbPath)
    }
    return AgentCheckpoint.instance
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    if (AgentCheckpoint.instance) {
      AgentCheckpoint.instance.close()
      AgentCheckpoint.instance = null
    }
  }

  // ============================================
  // Core Methods
  // ============================================

  /**
   * Generate CHECKPOINT block text for inclusion in agent prompts.
   * Returns a markdown string summarizing pending messages for the agent.
   */
  generateCheckpointBlock(agentId: string, taskDescription: string): string {
    const result = this.checkMessages(agentId)
    const displayName = AGENT_NAMES[agentId.toLowerCase()] || agentId

    const lines: string[] = [
      `## CHECKPOINT -- ${displayName}`,
      `- Task: ${taskDescription}`,
      `- REGOC poruke: ${result.regocMessages.length} pending`,
      `- Peer poruke: ${result.peerMessages.length} pending`,
      `- Help requests: ${result.helpRequests.length} pending`,
      `- Status: in_progress`,
    ]

    return lines.join('\n')
  }

  /**
   * Query pending messages for an agent from REGOC AND peers.
   * Categorizes messages into regocMessages, peerMessages, and helpRequests.
   */
  checkMessages(agentId: string): CheckpointResult {
    const id = agentId.toLowerCase()

    const regocMessages = this.queryMessages(id, 'regoc')
    const peerMessages = this.queryPeerMessages(id)
    const helpRequests = this.queryHelpRequests(id)

    return {
      regocMessages,
      peerMessages,
      helpRequests,
      totalPending: regocMessages.length + peerMessages.length + helpRequests.length,
    }
  }

  // ============================================
  // Private Query Methods
  // ============================================

  /**
   * Get pending messages from a specific agent (typically 'regoc').
   */
  private queryMessages(toAgent: string, fromAgent: string): CheckpointMessage[] {
    try {
      const stmt = this.db.prepare(`
        SELECT id, from_agent, content FROM messages
        WHERE to_agent = ?
          AND from_agent = ?
          AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY priority ASC, created_at ASC
      `)

      const rows = stmt.all(toAgent, fromAgent) as Array<{ id: string; from_agent: string; content: string }>
      return rows.map(r => ({ id: r.id, from: r.from_agent, content: r.content }))
    } catch (error) {
      console.error('[AgentCheckpoint] Error querying messages:', error)
      return []
    }
  }

  /**
   * Get pending peer messages (from any agent except 'regoc').
   */
  private queryPeerMessages(toAgent: string): CheckpointMessage[] {
    try {
      const stmt = this.db.prepare(`
        SELECT id, from_agent, content FROM messages
        WHERE to_agent = ?
          AND from_agent != 'regoc'
          AND status = 'pending'
          AND (message_type IS NULL OR message_type != 'help_request')
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY priority ASC, created_at ASC
      `)

      const rows = stmt.all(toAgent) as Array<{ id: string; from_agent: string; content: string }>
      return rows.map(r => ({ id: r.id, from: r.from_agent, content: r.content }))
    } catch (error) {
      console.error('[AgentCheckpoint] Error querying peer messages:', error)
      return []
    }
  }

  /**
   * Get pending help requests for an agent.
   */
  private queryHelpRequests(toAgent: string): CheckpointMessage[] {
    try {
      const stmt = this.db.prepare(`
        SELECT id, from_agent, content FROM messages
        WHERE to_agent = ?
          AND message_type = 'help_request'
          AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY priority ASC, created_at ASC
      `)

      const rows = stmt.all(toAgent) as Array<{ id: string; from_agent: string; content: string }>
      return rows.map(r => ({ id: r.id, from: r.from_agent, content: r.content }))
    } catch (error) {
      console.error('[AgentCheckpoint] Error querying help requests:', error)
      return []
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

export function getAgentCheckpoint(dbPath?: string): AgentCheckpoint {
  return AgentCheckpoint.getInstance(dbPath)
}

// ============================================
// CLI Interface
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'check': {
      const agent = args[1]
      if (!agent) {
        console.error('Usage: AgentCheckpoint.ts check <agent>')
        process.exit(1)
      }
      const cp = getAgentCheckpoint()
      const result = cp.checkMessages(agent)
      console.log(JSON.stringify(result, null, 2))
      break
    }

    case 'block': {
      const agent = args[1]
      const task = args[2] || 'current task'
      if (!agent) {
        console.error('Usage: AgentCheckpoint.ts block <agent> [task]')
        process.exit(1)
      }
      const cp = getAgentCheckpoint()
      console.log(cp.generateCheckpointBlock(agent, task))
      break
    }

    case 'help':
    default:
      console.log(`REGOC Agent Checkpoint CLI

Usage:
  bun AgentCheckpoint.ts <command> [args]

Commands:
  check <agent>          Check pending messages for agent
  block <agent> [task]   Generate CHECKPOINT block

Examples:
  bun AgentCheckpoint.ts check jelena
  bun AgentCheckpoint.ts block jelena "Implement parser module"
`)
  }
}
