#!/usr/bin/env bun
/**
 * REGOC Agent Communication Bridge (A5: Agent-to-Agent Live Communication)
 *
 * Connects HelpPipeline responses back to running agents via AgentSignals.
 * When Agent A sends a help_request and helper Agent B completes, the response
 * is routed through MessageQueue. This bridge picks up help_response and
 * direct_ask messages from MessageQueue and writes them as signals to the
 * target agent's signal file, enabling live communication with running agents.
 *
 * Location: ~/.claude/regoc/AgentCommunicationBridge.ts
 *
 * Usage:
 *   import { getAgentCommunicationBridge } from '~/.claude/regoc/AgentCommunicationBridge'
 *   const bridge = getAgentCommunicationBridge()
 *   bridge.routeHelpResponse({ fromAgent: 'kosjenka', toAgent: 'jelena', content: 'Use async BRAM' })
 *   const processed = bridge.processPendingResponses()
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { AgentSignals, type SignalType } from './AgentSignals'

// ============================================
// Configuration
// ============================================

const REGOC_DIR = join(process.env.HOME || '', '.claude/regoc')
const DB_PATH = join(REGOC_DIR, 'messages.db')

/** Valid REGOC agents */
const ALL_AGENTS = new Set([
  'regoc', 'klaudio', 'stribor', 'kosjenka', 'jelena',
  'malik', 'manda', 'potjeh', 'dora', 'gita', 'grga',
  'emard',
])

// ============================================
// Types
// ============================================

export interface RouteMessage {
  fromAgent: string
  toAgent: string
  content: string
}

// ============================================
// AgentCommunicationBridge Class
// ============================================

export class AgentCommunicationBridge {
  private db: Database
  private signals: AgentSignals
  private static instance: AgentCommunicationBridge | null = null

  constructor(dbPath?: string, signalDir?: string) {
    this.db = new Database(dbPath || DB_PATH)
    this.db.exec("PRAGMA journal_mode = WAL"); this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec('PRAGMA journal_mode = WAL')
    this.signals = new AgentSignals(signalDir)
  }

  static getInstance(dbPath?: string, signalDir?: string): AgentCommunicationBridge {
    if (!AgentCommunicationBridge.instance) {
      AgentCommunicationBridge.instance = new AgentCommunicationBridge(dbPath, signalDir)
    }
    return AgentCommunicationBridge.instance
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    if (AgentCommunicationBridge.instance) {
      AgentCommunicationBridge.instance.close()
      AgentCommunicationBridge.instance = null
    }
  }

  // ============================================
  // Core Routing
  // ============================================

  /**
   * When a help_response arrives in MessageQueue, write it as a
   * HELP_RESPONSE signal to the requesting agent's signal file.
   *
   * Returns true if the signal was written successfully.
   */
  routeHelpResponse(response: RouteMessage): boolean {
    const toAgent = response.toAgent.toLowerCase()
    const fromAgent = response.fromAgent.toLowerCase()

    if (!this.isValidAgent(toAgent) || !this.isValidAgent(fromAgent)) {
      return false
    }

    if (!response.content || response.content.trim().length === 0) {
      return false
    }

    try {
      const signalMessage = `[HELP_RESPONSE from ${fromAgent}]\n${response.content.trim()}`
      this.signals.writeSignal(toAgent, 'HELP_RESPONSE', signalMessage, fromAgent)
      return true
    } catch (error) {
      console.error('[AgentCommunicationBridge] Error routing help response:', error)
      return false
    }
  }

  /**
   * When an agent sends a direct_ask message, write a CONTEXT signal
   * to the target agent if they're currently active.
   *
   * Returns true if the signal was written (agent was active), false otherwise.
   */
  routeDirectAsk(msg: RouteMessage): boolean {
    const toAgent = msg.toAgent.toLowerCase()
    const fromAgent = msg.fromAgent.toLowerCase()

    if (!this.isValidAgent(toAgent) || !this.isValidAgent(fromAgent)) {
      return false
    }

    if (!msg.content || msg.content.trim().length === 0) {
      return false
    }

    // Only route if target agent is currently active
    if (!this.isAgentActive(toAgent)) {
      return false
    }

    try {
      const signalMessage = `[DIRECT_ASK from ${fromAgent}]\n${msg.content.trim()}`
      this.signals.writeSignal(toAgent, 'CONTEXT', signalMessage, fromAgent)
      return true
    } catch (error) {
      console.error('[AgentCommunicationBridge] Error routing direct ask:', error)
      return false
    }
  }

  /**
   * Check if an agent is currently active (has a running process).
   * Uses agent_status table PID check and process existence verification.
   */
  isAgentActive(agentId: string): boolean {
    const id = agentId.toLowerCase()

    try {
      const row = this.db.prepare(`
        SELECT pid, status FROM agent_status
        WHERE agent_id = ?
          AND status IN ('online', 'busy')
          AND last_heartbeat > datetime('now', '-60 seconds')
      `).get(id) as { pid: number | null; status: string } | null

      if (!row) return false

      // If we have a PID, verify the process is still running
      if (row.pid) {
        try {
          process.kill(row.pid, 0)  // Signal 0 = existence check
          return true
        } catch {
          // Process doesn't exist — stale entry
          return false
        }
      }

      // No PID but status is online/busy with recent heartbeat — consider active
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Generate the communication instructions block for agent prompt.
   * Tells agent HOW to request help and HOW to send direct messages.
   */
  generateCommInstructions(agentId: string, taskId: string): string {
    const id = agentId.toLowerCase()
    const signalPath = `~/.tmp/agent_signals/${id}.jsonl`

    return `## KOMUNIKACIJA S DRUGIM AGENTIMA

### Ako trebas pomoc:
Posalji help_request u MessageQueue:
\`\`\`sql
INSERT INTO messages (id, from_agent, to_agent, content, message_type, priority, status, created_at)
VALUES ('help-' || strftime('%s','now') || '-' || abs(random() % 10000), '${id}', 'regoc', 'HELP_REQUEST: [opis problema]', 'help_request', 3, 'pending', datetime('now'));
\`\`\`
REGOC ce spawnati helper agenta. Odgovor ces dobiti kao HELP_RESPONSE signal u:
${signalPath}

### Ako trebas pitati peer agenta:
\`\`\`sql
INSERT INTO messages (id, from_agent, to_agent, content, message_type, priority, status, created_at)
VALUES ('ask-' || strftime('%s','now') || '-' || abs(random() % 10000), '${id}', '[target_agent]', '[pitanje]', 'direct_ask', 2, 'pending', datetime('now'));
\`\`\`

### Provjera signala (radi ovo prije svakog veceg koraka):
\`\`\`bash
cat ${signalPath} 2>/dev/null | tail -5
\`\`\`

### Task ID: ${taskId}
Koristi ovaj task ID u svim porukama za tracanje.`
  }

  /**
   * Process all pending help_responses and direct_ask messages in MessageQueue
   * and route them to signal files. Called by daemon on each poll cycle.
   *
   * Returns the count of messages processed.
   */
  processPendingResponses(): number {
    let processed = 0

    try {
      // 1. Process help_response messages
      const helpResponses = this.db.prepare(`
        SELECT id, from_agent, to_agent, content FROM messages
        WHERE message_type = 'help_response'
          AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY priority ASC, created_at ASC
      `).all() as Array<{ id: string; from_agent: string; to_agent: string; content: string }>

      for (const msg of helpResponses) {
        const routed = this.routeHelpResponse({
          fromAgent: msg.from_agent,
          toAgent: msg.to_agent,
          content: msg.content,
        })

        if (routed) {
          // Mark message as completed in MessageQueue
          this.db.prepare(`
            UPDATE messages
            SET status = 'completed',
                response = 'Routed to signal file',
                processed_at = datetime('now'),
                updated_at = datetime('now')
            WHERE id = ?
          `).run(msg.id)
          processed++
        }
      }

      // 2. Process direct_ask messages
      const directAsks = this.db.prepare(`
        SELECT id, from_agent, to_agent, content FROM messages
        WHERE message_type = 'direct_ask'
          AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY priority ASC, created_at ASC
      `).all() as Array<{ id: string; from_agent: string; to_agent: string; content: string }>

      for (const msg of directAsks) {
        const routed = this.routeDirectAsk({
          fromAgent: msg.from_agent,
          toAgent: msg.to_agent,
          content: msg.content,
        })

        if (routed) {
          this.db.prepare(`
            UPDATE messages
            SET status = 'completed',
                response = 'Routed to signal file (agent active)',
                processed_at = datetime('now'),
                updated_at = datetime('now')
            WHERE id = ?
          `).run(msg.id)
          processed++
        }
        // If agent is not active, leave message as pending for next poll cycle
      }
    } catch (error) {
      console.error('[AgentCommunicationBridge] Error processing pending responses:', error)
    }

    return processed
  }

  // ============================================
  // Internal Helpers
  // ============================================

  private isValidAgent(agent: string): boolean {
    return ALL_AGENTS.has(agent.toLowerCase())
  }

  /**
   * Close database connection.
   */
  close(): void {
    this.db.close()
  }

  /**
   * Expose signals instance for testing.
   */
  getSignals(): AgentSignals {
    return this.signals
  }
}

// ============================================
// Singleton Export
// ============================================

export function getAgentCommunicationBridge(dbPath?: string, signalDir?: string): AgentCommunicationBridge {
  return AgentCommunicationBridge.getInstance(dbPath, signalDir)
}

// ============================================
// CLI Interface
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'process': {
      const bridge = getAgentCommunicationBridge()
      const count = bridge.processPendingResponses()
      console.log(`Processed ${count} pending response(s)`)
      break
    }

    case 'route-help': {
      const [, from, to, ...contentParts] = args
      if (!from || !to || contentParts.length === 0) {
        console.error('Usage: AgentCommunicationBridge.ts route-help <from> <to> <content>')
        process.exit(1)
      }
      const bridge = getAgentCommunicationBridge()
      const ok = bridge.routeHelpResponse({
        fromAgent: from,
        toAgent: to,
        content: contentParts.join(' '),
      })
      console.log(ok ? 'Help response routed to signal file' : 'Failed to route help response')
      break
    }

    case 'route-ask': {
      const [, from, to, ...contentParts] = args
      if (!from || !to || contentParts.length === 0) {
        console.error('Usage: AgentCommunicationBridge.ts route-ask <from> <to> <content>')
        process.exit(1)
      }
      const bridge = getAgentCommunicationBridge()
      const ok = bridge.routeDirectAsk({
        fromAgent: from,
        toAgent: to,
        content: contentParts.join(' '),
      })
      console.log(ok ? 'Direct ask routed to signal file' : 'Failed to route (agent not active?)')
      break
    }

    case 'check-active': {
      const agent = args[1]
      if (!agent) {
        console.error('Usage: AgentCommunicationBridge.ts check-active <agent>')
        process.exit(1)
      }
      const bridge = getAgentCommunicationBridge()
      console.log(bridge.isAgentActive(agent) ? `${agent} is ACTIVE` : `${agent} is NOT active`)
      break
    }

    case 'comm-instructions': {
      const agent = args[1]
      const taskId = args[2] || 'TASK-000'
      if (!agent) {
        console.error('Usage: AgentCommunicationBridge.ts comm-instructions <agent> [taskId]')
        process.exit(1)
      }
      const bridge = getAgentCommunicationBridge()
      console.log(bridge.generateCommInstructions(agent, taskId))
      break
    }

    case 'help':
    default:
      console.log(`REGOC Agent Communication Bridge CLI (A5)

Usage:
  bun AgentCommunicationBridge.ts <command> [args]

Commands:
  process                              Process pending help_responses and direct_asks
  route-help <from> <to> <content>     Route a help response to agent signal file
  route-ask <from> <to> <content>      Route a direct ask to agent signal file (if active)
  check-active <agent>                 Check if an agent is currently active
  comm-instructions <agent> [taskId]   Generate communication instructions for agent prompt

Examples:
  bun AgentCommunicationBridge.ts process
  bun AgentCommunicationBridge.ts route-help kosjenka jelena "Use async BRAM pattern"
  bun AgentCommunicationBridge.ts route-ask jelena malik "Review security?"
  bun AgentCommunicationBridge.ts check-active jelena
  bun AgentCommunicationBridge.ts comm-instructions jelena TASK-405
`)
  }
}
