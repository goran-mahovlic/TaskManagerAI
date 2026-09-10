#!/usr/bin/env bun
/**
 * REGOČ Message Queue
 *
 * SQLite-based message queue for inter-agent communication.
 * Replaces file-based IPC with reliable, persistent storage.
 *
 * Location: ~/.claude/regoc/ (PERSISTENT - survives container restart!)
 *
 * Usage:
 *   import { getMessageQueue } from '~/.claude/regoc/MessageQueue'
 *   const mq = getMessageQueue()
 *   mq.sendMessage('scheduler', 'assistant', 'Hello!')
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { TM_DB } from './paths'
import { randomUUID } from 'crypto'
import { AgentIdSchema, SendMessageInputSchema } from '../zod/schemas/index'
import { dopusteniAgenti } from './AgentIds'

// ============================================
// Configuration
// ============================================

// U6/TASK-4266: `TM_HOME`/`TM_DB` premještaju red poruka izvan `~/.claude/regoc`, a mapa
// se stvara ako je nema. Bez toga poslužitelj NIJE MOGAO krenuti na stroju bez REGOČ
// instalacije: `new Database(...)` nad nepostojećom mapom baca „unable to open database
// file", i to izvan try/catch-a (mjereno 05.09.2026. na praznom $HOME). Bez tih varijabli
// putanja je nepromijenjena.
const LEGACY_DIR = join(process.env.HOME || '', '.claude/regoc')
const REGOC_DIR = (process.env.TM_DB || process.env.TM_HOME) ? dirname(TM_DB) : LEGACY_DIR
const DB_PATH = join(REGOC_DIR, 'messages.db')
const SCHEMA_PATH = join(REGOC_DIR, 'schema.sql')
if (!existsSync(REGOC_DIR)) { try { mkdirSync(REGOC_DIR, { recursive: true }) } catch { /* pada na otvaranju */ } }

/**
 * Tko smije slati i primati poruke (TASK-4809).
 *
 * Do 10.09.2026. je ovdje stajao `VALID_AGENTS` — doslovan popis imena NAŠIH agenata. Bio
 * je i MRTAV: `isValidAgent()` odavno provjerava kroz `AgentIdSchema`, dakle kroz
 * `jeDopustenAgent()` iz `src/core/AgentIds.ts`, koji popis čita iz `config/agents.json`
 * odn. `TM_AGENTS`. Popis je zato maknut, a ime je zadržano kao funkcija koja pita isti
 * izvor istine — dvije istine o tome tko postoji su kvar, ne udobnost.
 */
export function validAgents(): string[] {
  return dopusteniAgenti().popis
}

/** Ime agenta; oblik i pripadnost popisu provjerava `AgentIdSchema` pri upisu. */
type AgentId = string

// ============================================
// Types
// ============================================

export interface Message {
  id: string
  from_agent: string
  to_agent: string
  content: string
  message_type: string
  priority: number
  status: string
  chat_id: number | null
  voice_relay: number
  retry_count: number
  max_retries: number
  created_at: string
  updated_at: string
  processed_at: string | null
  expires_at: string | null
  response: string | null
  error: string | null
  metadata: string | null
}

export interface AgentStatus {
  agent_id: string
  status: string
  last_heartbeat: string | null
  current_task: string | null
  pid: number | null
  created_at: string
  updated_at: string
}

export type MessageType = 'text' | 'voice' | 'upgrade' | 'command' | 'relay'
  | 'task_done' | 'task_done_with_concerns' | 'task_blocked' | 'task_needs_context'
  | 'help_request' | 'help_response'
  | 'direct_ask' | 'direct_response'

export interface SendMessageOptions {
  messageType?: MessageType
  priority?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  chatId?: number
  voiceRelay?: boolean
  maxRetries?: number
  expiresIn?: number  // milliseconds
  metadata?: Record<string, unknown>
}

export interface TaskSignal {
  type: 'DONE' | 'DONE_WITH_CONCERNS' | 'BLOCKED' | 'NEEDS_CONTEXT'
  taskId: string
  verification?: string
  concerns?: string[]
  reason?: string
  helpNeeded?: string
  suggestedHelper?: string
  contextNeeded?: string
}

export function parseTaskSignal(content: string): TaskSignal | null {
  const doneMatch = content.match(/\[TASK_DONE:(\S+)\]/)
  if (doneMatch) {
    const verification = content.replace(doneMatch[0], '').trim()
    return { type: 'DONE', taskId: doneMatch[1], verification }
  }

  const concernsMatch = content.match(/\[TASK_DONE_WITH_CONCERNS:(\S+)\]/)
  if (concernsMatch) {
    const rest = content.replace(concernsMatch[0], '').trim()
    return { type: 'DONE_WITH_CONCERNS', taskId: concernsMatch[1], concerns: [rest], verification: rest }
  }

  const blockedMatch = content.match(/\[TASK_BLOCKED:(\S+)\]/)
  if (blockedMatch) {
    const rest = content.replace(blockedMatch[0], '').trim()
    return { type: 'BLOCKED', taskId: blockedMatch[1], reason: rest, helpNeeded: 'unblock' }
  }

  const contextMatch = content.match(/\[TASK_NEEDS_CONTEXT:(\S+)\]/)
  if (contextMatch) {
    const rest = content.replace(contextMatch[0], '').trim()
    return { type: 'NEEDS_CONTEXT', taskId: contextMatch[1], contextNeeded: rest }
  }

  // Legacy support
  const legacyMatch = content.match(/\[TASK_COMPLETE:(\S+)\]/)
  if (legacyMatch) {
    return { type: 'DONE', taskId: legacyMatch[1], verification: '(legacy signal — no verification)' }
  }

  return null
}

// ============================================
// MessageQueue Class
// ============================================

class MessageQueue {
  private db: Database
  private static instance: MessageQueue | null = null

  private constructor() {
    // Initialize database
    this.db = new Database(DB_PATH)
    this.db.exec("PRAGMA journal_mode = WAL"); this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')

    // Run schema if tables don't exist
    this.initSchema()
  }

  private initSchema(): void {
    if (existsSync(SCHEMA_PATH)) {
      const schema = readFileSync(SCHEMA_PATH, 'utf-8')
      this.db.exec(schema)
    }
  }

  static getInstance(): MessageQueue {
    if (!MessageQueue.instance) {
      MessageQueue.instance = new MessageQueue()
    }
    return MessageQueue.instance
  }

  // ============================================
  // Message Operations
  // ============================================

  /**
   * Send a message from one agent to another
   */
  sendMessage(from: string, to: string, content: string, options: SendMessageOptions = {}): string | null {
    // ZOD validation (TASK-159)
    const validation = SendMessageInputSchema.safeParse({
      from_agent: from,
      to_agent: to,
      content,
      type: options.messageType || 'text',
      priority: options.priority || 3
    })

    if (!validation.success) {
      console.error('[MessageQueue] Validation failed:', validation.error.issues)
      return null
    }

    // Legacy agent validation (backward compatibility)
    if (!this.isValidAgent(from) || !this.isValidAgent(to)) {
      console.error(`[MessageQueue] Invalid agent: from=${from}, to=${to}`)
      return null
    }

    const id = randomUUID()
    const expiresAt = options.expiresIn
      ? new Date(Date.now() + options.expiresIn).toISOString()
      : null

    try {
      const stmt = this.db.prepare(`
        INSERT INTO messages (
          id, from_agent, to_agent, content, message_type, priority,
          chat_id, voice_relay, max_retries, expires_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      stmt.run(
        id,
        from,
        to,
        content,
        options.messageType || 'text',
        options.priority || 5,
        options.chatId || null,
        options.voiceRelay ? 1 : 0,
        options.maxRetries ?? 3,
        expiresAt,
        options.metadata ? JSON.stringify(options.metadata) : null
      )

      this.logEvent('message_sent', from, { messageId: id, to, type: options.messageType })
      return id
    } catch (error) {
      console.error('[MessageQueue] Error sending message:', error)
      return null
    }
  }

  /**
   * Get pending messages for an agent
   */
  getPendingMessages(agent: string, limit: number = 10): Message[] {
    if (!this.isValidAgent(agent)) return []

    try {
      const stmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE to_agent = ?
          AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY priority ASC, created_at ASC
        LIMIT ?
      `)

      return stmt.all(agent, limit) as Message[]
    } catch (error) {
      console.error('[MessageQueue] Error getting messages:', error)
      return []
    }
  }

  /**
   * Claim a message for processing
   */
  claimMessage(messageId: string, agent: string): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE messages
        SET status = 'processing', updated_at = datetime('now')
        WHERE id = ? AND to_agent = ? AND status = 'pending'
      `)

      const result = stmt.run(messageId, agent)
      if (result.changes > 0) {
        this.logEvent('message_claimed', agent, { messageId })
        return true
      }
      return false
    } catch (error) {
      console.error('[MessageQueue] Error claiming message:', error)
      return false
    }
  }

  /**
   * Complete a message with response
   */
  completeMessage(messageId: string, response: string): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE messages
        SET status = 'completed',
            response = ?,
            processed_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `)

      const result = stmt.run(response, messageId)
      if (result.changes > 0) {
        this.logEvent('message_completed', null, { messageId })
        return true
      }
      return false
    } catch (error) {
      console.error('[MessageQueue] Error completing message:', error)
      return false
    }
  }

  /**
   * Fail a message (will retry if retries remain)
   */
  failMessage(messageId: string, error: string): boolean {
    try {
      // Get current retry count
      const msg = this.db.prepare('SELECT retry_count, max_retries FROM messages WHERE id = ?').get(messageId) as Message | null

      if (!msg) return false

      const newRetryCount = msg.retry_count + 1
      const newStatus = newRetryCount >= msg.max_retries ? 'failed' : 'pending'

      const stmt = this.db.prepare(`
        UPDATE messages
        SET status = ?,
            retry_count = ?,
            error = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `)

      stmt.run(newStatus, newRetryCount, error, messageId)
      this.logEvent('message_failed', null, { messageId, error, retryCount: newRetryCount, finalStatus: newStatus })
      return true
    } catch (err) {
      console.error('[MessageQueue] Error failing message:', err)
      return false
    }
  }

  /**
   * Get a specific message by ID
   */
  getMessage(messageId: string): Message | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?')
      return stmt.get(messageId) as Message | null
    } catch (error) {
      console.error('[MessageQueue] Error getting message:', error)
      return null
    }
  }

  // ============================================
  // Agent Status Operations
  // ============================================

  /**
   * Update agent heartbeat
   */
  heartbeat(agent: string, status: 'online' | 'offline' | 'busy' = 'online', pid?: number): boolean {
    if (!this.isValidAgent(agent)) return false

    try {
      const stmt = this.db.prepare(`
        INSERT INTO agent_status (agent_id, status, last_heartbeat, pid)
        VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          status = excluded.status,
          last_heartbeat = datetime('now'),
          pid = excluded.pid,
          updated_at = datetime('now')
      `)

      stmt.run(agent, status, pid || null)
      return true
    } catch (error) {
      console.error('[MessageQueue] Error updating heartbeat:', error)
      return false
    }
  }

  /**
   * Check if an agent is online (heartbeat within last 30 seconds)
   */
  isAgentOnline(agent: string): boolean {
    try {
      const stmt = this.db.prepare(`
        SELECT 1 FROM agent_status
        WHERE agent_id = ?
          AND status = 'online'
          AND last_heartbeat > datetime('now', '-30 seconds')
      `)

      return stmt.get(agent) !== null
    } catch (error) {
      return false
    }
  }

  /**
   * Get agent status
   */
  getAgentStatus(agent: string): AgentStatus | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM agent_status WHERE agent_id = ?')
      return stmt.get(agent) as AgentStatus | null
    } catch (error) {
      return null
    }
  }

  /**
   * Get all agent statuses
   */
  getAllAgentStatuses(): AgentStatus[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM agent_status ORDER BY agent_id')
      return stmt.all() as AgentStatus[]
    } catch (error) {
      return []
    }
  }

  // ============================================
  // Event Logging
  // ============================================

  /**
   * Log an event
   */
  logEvent(eventType: string, agent: string | null, details?: Record<string, unknown>): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO event_log (event_type, agent_id, details)
        VALUES (?, ?, ?)
      `)

      stmt.run(eventType, agent, details ? JSON.stringify(details) : null)
    } catch (error) {
      // Silent fail for logging
    }
  }

  // ============================================
  // Statistics
  // ============================================

  /**
   * Get queue statistics
   */
  getStats(): Record<string, number> {
    try {
      const stats: Record<string, number> = {}

      // Message counts by status
      const statusCounts = this.db.prepare(`
        SELECT status, COUNT(*) as count FROM messages GROUP BY status
      `).all() as { status: string; count: number }[]

      for (const row of statusCounts) {
        stats[`messages_${row.status}`] = row.count
      }

      // Total messages
      const total = this.db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }
      stats['messages_total'] = total.count

      // Online agents
      const online = this.db.prepare(`
        SELECT COUNT(*) as count FROM agent_status
        WHERE status = 'online' AND last_heartbeat > datetime('now', '-30 seconds')
      `).get() as { count: number }
      stats['agents_online'] = online.count

      return stats
    } catch (error) {
      return {}
    }
  }

  // ============================================
  // Utility
  // ============================================

  private isValidAgent(agent: string): boolean {
    // ZOD validation (TASK-158)
    return AgentIdSchema.safeParse(agent).success
  }

  /**
   * Clean up expired and old messages
   */
  cleanup(olderThanDays: number = 7): number {
    try {
      // Mark expired messages
      this.db.prepare(`
        UPDATE messages SET status = 'expired'
        WHERE status = 'pending' AND expires_at < datetime('now')
      `).run()

      // Delete old completed/failed/expired messages
      const result = this.db.prepare(`
        DELETE FROM messages
        WHERE status IN ('completed', 'failed', 'expired')
          AND updated_at < datetime('now', '-' || ? || ' days')
      `).run(olderThanDays)

      return result.changes
    } catch (error) {
      return 0
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close()
    MessageQueue.instance = null
  }
}

// ============================================
// Exports
// ============================================

export function getMessageQueue(): MessageQueue {
  return MessageQueue.getInstance()
}

export { MessageQueue, type AgentId }

// ============================================
// CLI Interface
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const command = args[0]
  const mq = getMessageQueue()

  switch (command) {
    case 'send': {
      const [, from, to, content] = args
      if (!from || !to || !content) {
        console.error('Usage: MessageQueue.ts send <from> <to> <content>')
        process.exit(1)
      }
      const id = mq.sendMessage(from, to, content)
      console.log(id ? `Sent: ${id}` : 'Failed to send')
      break
    }

    case 'pending': {
      const agent = args[1]
      if (!agent) {
        console.error('Usage: MessageQueue.ts pending <agent>')
        process.exit(1)
      }
      const messages = mq.getPendingMessages(agent)
      console.log(JSON.stringify(messages, null, 2))
      break
    }

    case 'stats': {
      const stats = mq.getStats()
      console.log(JSON.stringify(stats, null, 2))
      break
    }

    case 'agents': {
      const agents = mq.getAllAgentStatuses()
      console.log(JSON.stringify(agents, null, 2))
      break
    }

    case 'cleanup': {
      const days = parseInt(args[1] || '7')
      const deleted = mq.cleanup(days)
      console.log(`Cleaned up ${deleted} old messages`)
      break
    }

    case 'help':
    default:
      console.log(`REGOČ Message Queue CLI

Usage:
  bun MessageQueue.ts <command> [args]

Commands:
  send <from> <to> <content>  Send a message
  pending <agent>             Get pending messages for agent
  stats                       Show queue statistics
  agents                      Show all agent statuses
  cleanup [days]              Clean up old messages (default: 7 days)

Examples:
  bun MessageQueue.ts send scheduler assistant "Pozdrav!"
  bun MessageQueue.ts pending assistant
  bun MessageQueue.ts stats
`)
  }
}
