#!/usr/bin/env bun
/**
 * REGOČ Client
 *
 * Simplified interface for agents to communicate through the REGOČ message queue.
 * Use this in Klaudio, Stribor, and other agents instead of direct MessageQueue access.
 *
 * Location: ~/.claude/regoc/ (PERSISTENT!)
 *
 * Usage:
 *   import { RegocClient } from '~/.claude/regoc/RegocClient'
 *   const client = new RegocClient('klaudio')
 *   await client.sendToAgent('stribor', 'Hello!')
 */

import { getMessageQueue, type Message, type SendMessageOptions, type AgentStatus } from './MessageQueue'

// ============================================
// Types
// ============================================

// TASK-5547: imena agenata dolaze iz REGOC_AGENTS.json (AgentIds.ts), ne iz koda.
export type AgentId = string

export interface IncomingMessage {
  id: string
  from: AgentId
  content: string
  type: string
  priority: number
  chatId?: number
  voiceRelay: boolean
  createdAt: Date
  metadata?: Record<string, unknown>
}

export interface SendOptions {
  type?: 'text' | 'voice' | 'upgrade' | 'command' | 'relay'
  priority?: number
  chatId?: number
  voiceRelay?: boolean
  expiresInMs?: number
  metadata?: Record<string, unknown>
}

// ============================================
// Client Class
// ============================================

export class RegocClient {
  private agentId: AgentId
  private mq = getMessageQueue()
  private heartbeatInterval?: ReturnType<typeof setInterval>

  constructor(agentId: AgentId) {
    this.agentId = agentId
  }

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Start the client with automatic heartbeats
   */
  start(heartbeatMs: number = 10000): void {
    // Send initial heartbeat
    this.heartbeat('online')

    // Set up periodic heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.heartbeat('online')
    }, heartbeatMs)
  }

  /**
   * Stop the client and mark agent as offline
   */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = undefined
    }
    this.heartbeat('offline')
  }

  /**
   * Send heartbeat
   */
  heartbeat(status: 'online' | 'offline' | 'busy' = 'online'): boolean {
    return this.mq.heartbeat(this.agentId, status, process.pid)
  }

  // ============================================
  // Messaging
  // ============================================

  /**
   * Send a message to another agent
   */
  sendToAgent(to: AgentId, content: string, options: SendOptions = {}): string | null {
    return this.mq.sendMessage(this.agentId, to, content, {
      messageType: options.type,
      priority: options.priority as any,
      chatId: options.chatId,
      voiceRelay: options.voiceRelay,
      expiresIn: options.expiresInMs,
      metadata: options.metadata
    })
  }

  /**
   * Send a relay message (for Telegram/TeamSpeak forwarding)
   */
  sendRelay(to: AgentId, content: string, chatId: number, options: SendOptions = {}): string | null {
    return this.sendToAgent(to, content, {
      ...options,
      type: 'relay',
      chatId
    })
  }

  /**
   * Send an upgrade request to REGOČ
   */
  sendUpgradeRequest(content: string, options: SendOptions = {}): string | null {
    return this.sendToAgent('regoc', content, {
      ...options,
      type: 'upgrade',
      priority: 2  // High priority
    })
  }

  /**
   * Send a command to another agent
   */
  sendCommand(to: AgentId, command: string, options: SendOptions = {}): string | null {
    return this.sendToAgent(to, command, {
      ...options,
      type: 'command',
      priority: 1  // Critical priority
    })
  }

  /**
   * Get pending messages for this agent
   */
  getMessages(limit: number = 10): IncomingMessage[] {
    const messages = this.mq.getPendingMessages(this.agentId, limit)
    return messages.map(this.transformMessage)
  }

  /**
   * Claim a message (mark as processing)
   */
  claimMessage(messageId: string): boolean {
    return this.mq.claimMessage(messageId, this.agentId)
  }

  /**
   * Complete a message with response
   */
  completeMessage(messageId: string, response: string): boolean {
    return this.mq.completeMessage(messageId, response)
  }

  /**
   * Fail a message (will retry if retries remain)
   */
  failMessage(messageId: string, error: string): boolean {
    return this.mq.failMessage(messageId, error)
  }

  /**
   * Process messages with a handler function
   */
  async processMessages(
    handler: (message: IncomingMessage) => Promise<string | null>,
    options: { limit?: number; continuous?: boolean; intervalMs?: number } = {}
  ): Promise<void> {
    const { limit = 10, continuous = false, intervalMs = 3000 } = options

    const processOnce = async () => {
      const messages = this.getMessages(limit)

      for (const msg of messages) {
        // Claim the message
        if (!this.claimMessage(msg.id)) {
          continue  // Already claimed by another process
        }

        try {
          const response = await handler(msg)

          if (response !== null) {
            this.completeMessage(msg.id, response)
          } else {
            // Handler returned null - mark as failed
            this.failMessage(msg.id, 'Handler returned null')
          }
        } catch (error) {
          this.failMessage(msg.id, String(error))
        }
      }
    }

    if (continuous) {
      // Run continuously
      await processOnce()
      setInterval(processOnce, intervalMs)
    } else {
      // Run once
      await processOnce()
    }
  }

  // ============================================
  // Status
  // ============================================

  /**
   * Check if another agent is online
   */
  isAgentOnline(agent: AgentId): boolean {
    return this.mq.isAgentOnline(agent)
  }

  /**
   * Get status of another agent
   */
  getAgentStatus(agent: AgentId): AgentStatus | null {
    return this.mq.getAgentStatus(agent)
  }

  /**
   * Get all agent statuses
   */
  getAllStatuses(): AgentStatus[] {
    return this.mq.getAllAgentStatuses()
  }

  /**
   * Get queue statistics
   */
  getStats(): Record<string, number> {
    return this.mq.getStats()
  }

  // ============================================
  // Utility
  // ============================================

  /**
   * Log an event
   */
  logEvent(eventType: string, details?: Record<string, unknown>): void {
    this.mq.logEvent(eventType, this.agentId, details)
  }

  /**
   * Get agent ID
   */
  getAgentId(): AgentId {
    return this.agentId
  }

  // ============================================
  // Task Completion Reporting (BUG-002 FIX)
  // ============================================

  /**
   * Report task completion to REGOČ and Klaudio (Telegram)
   *
   * Format: "Task [ID] COMPLETED: [opis]. Next: [sljedeći]"
   *
   * @param taskId - The task ID that was completed (e.g., "F8-003")
   * @param description - Brief description of what was done
   * @param nextTask - Optional next task ID or description
   */
  reportTaskCompletion(taskId: string, description: string, nextTask?: string): void {
    const message = nextTask
      ? `Task ${taskId} COMPLETED: ${description}. Next: ${nextTask}`
      : `Task ${taskId} COMPLETED: ${description}. No next task specified.`

    // Send to REGOČ queue
    this.sendToAgent('regoc', message, {
      type: 'text',
      priority: 3,
      metadata: {
        reportType: 'task_completion',
        taskId,
        timestamp: new Date().toISOString()
      }
    })

    // Send to Klaudio (Telegram) for user notification
    this.sendToAgent('klaudio', message, {
      type: 'relay',
      priority: 3,
      metadata: {
        reportType: 'task_completion',
        taskId
      }
    })

    this.logEvent('task_completed', {
      taskId,
      description,
      nextTask: nextTask || null
    })
  }

  /**
   * Report task start
   */
  reportTaskStart(taskId: string, description: string): void {
    const message = `Task ${taskId} STARTED: ${description}`

    this.sendToAgent('regoc', message, {
      type: 'text',
      priority: 4,
      metadata: {
        reportType: 'task_start',
        taskId,
        timestamp: new Date().toISOString()
      }
    })

    this.logEvent('task_started', { taskId, description })
  }

  /**
   * Report task blocked
   */
  reportTaskBlocked(taskId: string, reason: string, blockedBy?: string[]): void {
    const blockedByStr = blockedBy?.length ? ` (blocked by: ${blockedBy.join(', ')})` : ''
    const message = `Task ${taskId} BLOCKED: ${reason}${blockedByStr}`

    this.sendToAgent('regoc', message, {
      type: 'text',
      priority: 2,
      metadata: {
        reportType: 'task_blocked',
        taskId,
        reason,
        blockedBy: blockedBy || []
      }
    })

    // Also notify Klaudio for urgent attention
    this.sendToAgent('klaudio', message, {
      type: 'relay',
      priority: 2
    })

    this.logEvent('task_blocked', { taskId, reason, blockedBy })
  }

  /**
   * Report task progress
   */
  reportTaskProgress(taskId: string, progressPct: number, note: string): void {
    const message = `Task ${taskId} PROGRESS: ${progressPct}% - ${note}`

    this.sendToAgent('regoc', message, {
      type: 'text',
      priority: 5,
      metadata: {
        reportType: 'task_progress',
        taskId,
        progressPct,
        note
      }
    })

    this.logEvent('task_progress', { taskId, progressPct, note })
  }

  /**
   * Send a bug fix completion report (specific helper for BUG-002)
   */
  reportBugFix(bugId: string, description: string): void {
    const message = `BUG FIX COMPLETED: ${bugId} - ${description}`

    // Send to REGOČ
    this.sendToAgent('regoc', message, {
      type: 'text',
      priority: 2,
      metadata: {
        reportType: 'bug_fix',
        bugId,
        timestamp: new Date().toISOString()
      }
    })

    // Send to Klaudio
    this.sendToAgent('klaudio', message, {
      type: 'relay',
      priority: 2
    })

    this.logEvent('bug_fixed', { bugId, description })
  }

  /**
   * Transform raw message to IncomingMessage
   */
  private transformMessage(msg: Message): IncomingMessage {
    return {
      id: msg.id,
      from: msg.from_agent as AgentId,
      content: msg.content,
      type: msg.message_type,
      priority: msg.priority,
      chatId: msg.chat_id || undefined,
      voiceRelay: Boolean(msg.voice_relay),
      createdAt: new Date(msg.created_at),
      metadata: msg.metadata ? JSON.parse(msg.metadata) : undefined
    }
  }
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Create a client for an agent
 */
export function createClient(agentId: AgentId): RegocClient {
  return new RegocClient(agentId)
}

// ============================================
// CLI Interface
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const command = args[0]
  const agent = args[1] as AgentId

  if (!agent && command !== 'help') {
    console.error('Usage: RegocClient.ts <command> <agent> [args]')
    process.exit(1)
  }

  const client = agent ? new RegocClient(agent) : null

  switch (command) {
    case 'send': {
      const [, , to, content] = args
      if (!to || !content) {
        console.error('Usage: RegocClient.ts send <from> <to> <content>')
        process.exit(1)
      }
      const id = client!.sendToAgent(to as AgentId, content)
      console.log(id ? `Sent: ${id}` : 'Failed to send')
      break
    }

    case 'messages': {
      const messages = client!.getMessages()
      console.log(JSON.stringify(messages, null, 2))
      break
    }

    case 'start': {
      console.log(`Starting client for ${agent}...`)
      client!.start()
      console.log('Client started with heartbeat. Press Ctrl+C to stop.')

      // Keep alive
      process.on('SIGINT', () => {
        client!.stop()
        console.log('\nClient stopped.')
        process.exit(0)
      })

      // Keep process running
      await new Promise(() => {})
      break
    }

    case 'online': {
      const target = args[2] as AgentId
      if (!target) {
        console.error('Usage: RegocClient.ts online <agent> <target>')
        process.exit(1)
      }
      console.log(`${target} is ${client!.isAgentOnline(target) ? 'ONLINE' : 'OFFLINE'}`)
      break
    }

    case 'help':
    default:
      console.log(`REGOČ Client CLI

Usage:
  bun RegocClient.ts <command> <agent> [args]

Commands:
  send <from> <to> <content>   Send message from agent to another
  messages <agent>             Get pending messages for agent
  start <agent>                Start client with heartbeat
  online <agent> <target>      Check if target agent is online

Examples:
  bun RegocClient.ts send klaudio stribor "Pozdrav!"
  bun RegocClient.ts messages stribor
  bun RegocClient.ts online klaudio stribor
`)
  }
}
