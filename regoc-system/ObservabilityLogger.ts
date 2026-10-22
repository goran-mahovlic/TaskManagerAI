#!/usr/bin/env bun
/**
 * REGOC ObservabilityLogger (F5.1)
 *
 * JSONL-based structured logging for tool activity, agent spawns,
 * task updates, and security events.
 *
 * Storage: ~/.claude/regoc/observability/
 *   - tool-activity.jsonl
 *   - agent-spawns.jsonl
 *   - task-progress.jsonl
 *   - security-events.jsonl
 *
 * Log rotation: max 5MB per file, rotates to .jsonl.1 (keeps last 2)
 *
 * Usage:
 *   import { getObservabilityLogger } from '~/.claude/regoc/ObservabilityLogger'
 *   const logger = getObservabilityLogger()
 *   logger.logToolCall('jelena', 'Bash', 'ls -la', 120, 'ok')
 */

import { existsSync, mkdirSync, statSync, renameSync, appendFileSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'

// ============================================
// Types
// ============================================

export interface LogEntry {
  ts: string         // ISO timestamp
  agent: string
  event: string      // 'tool_call' | 'agent_spawn' | 'task_update' | 'security_event'
  detail: Record<string, unknown>
}

type EventType = 'tool_call' | 'agent_spawn' | 'task_update' | 'security_event'

// ============================================
// Constants
// ============================================

const DEFAULT_LOG_DIR = join(process.env.HOME || '', '.claude/regoc/observability')
const MAX_FILE_SIZE = 5 * 1024 * 1024  // 5MB
const MAX_ROTATIONS = 2

const EVENT_FILES: Record<EventType, string> = {
  tool_call: 'tool-activity.jsonl',
  agent_spawn: 'agent-spawns.jsonl',
  task_update: 'task-progress.jsonl',
  security_event: 'security-events.jsonl',
}

// ============================================
// ObservabilityLogger
// ============================================

export class ObservabilityLogger {
  private logDir: string

  constructor(logDir?: string) {
    this.logDir = logDir || DEFAULT_LOG_DIR
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true })
    }
  }

  // --- Public API ---

  logToolCall(agent: string, tool: string, command: string, durationMs: number, result: 'ok' | 'error'): void {
    this.append('tool_call', {
      ts: new Date().toISOString(),
      agent,
      event: 'tool_call',
      detail: { tool, command, durationMs, result },
    })
  }

  logAgentSpawn(agent: string, taskId: string, effort: string, model: string): void {
    this.append('agent_spawn', {
      ts: new Date().toISOString(),
      agent,
      event: 'agent_spawn',
      detail: { taskId, effort, model },
    })
  }

  logTaskUpdate(taskId: string, oldStatus: string, newStatus: string, agent: string): void {
    this.append('task_update', {
      ts: new Date().toISOString(),
      agent,
      event: 'task_update',
      detail: { taskId, oldStatus, newStatus },
    })
  }

  logSecurityEvent(agent: string, action: string, result: string, details: string): void {
    this.append('security_event', {
      ts: new Date().toISOString(),
      agent,
      event: 'security_event',
      detail: { action, result, details },
    })
  }

  getRecent(count: number = 20): LogEntry[] {
    const allEntries: LogEntry[] = []

    for (const eventType of Object.keys(EVENT_FILES) as EventType[]) {
      const filePath = join(this.logDir, EVENT_FILES[eventType])
      if (!existsSync(filePath)) continue

      const content = readFileSync(filePath, 'utf-8').trim()
      if (!content) continue

      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          allEntries.push(JSON.parse(line) as LogEntry)
        } catch {
          // skip malformed lines
        }
      }
    }

    // Sort by timestamp descending, return last N
    allEntries.sort((a, b) => b.ts.localeCompare(a.ts))
    return allEntries.slice(0, count)
  }

  getStats(): { totalEvents: number; byEvent: Record<string, number>; last24h: number } {
    const byEvent: Record<string, number> = {}
    let totalEvents = 0
    let last24h = 0
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    for (const eventType of Object.keys(EVENT_FILES) as EventType[]) {
      const filePath = join(this.logDir, EVENT_FILES[eventType])
      if (!existsSync(filePath)) continue

      const content = readFileSync(filePath, 'utf-8').trim()
      if (!content) continue

      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as LogEntry
          totalEvents++
          byEvent[entry.event] = (byEvent[entry.event] || 0) + 1
          if (entry.ts >= cutoff) {
            last24h++
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    return { totalEvents, byEvent, last24h }
  }

  // --- Internal ---

  private append(eventType: EventType, entry: LogEntry): void {
    const filePath = join(this.logDir, EVENT_FILES[eventType])
    this.rotateIfNeeded(filePath)
    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8')
  }

  private rotateIfNeeded(filePath: string): void {
    if (!existsSync(filePath)) return

    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      return
    }

    if (size < MAX_FILE_SIZE) return

    // Rotate: .jsonl.1 -> .jsonl.2, .jsonl -> .jsonl.1
    const rot2 = filePath + '.2'
    const rot1 = filePath + '.1'

    // Delete oldest rotation beyond MAX_ROTATIONS
    if (existsSync(rot2)) {
      try { unlinkSync(rot2) } catch { /* ignore */ }
    }

    if (existsSync(rot1)) {
      try { renameSync(rot1, rot2) } catch { /* ignore */ }
    }

    try { renameSync(filePath, rot1) } catch { /* ignore */ }
  }
}

// ============================================
// Singleton
// ============================================

let _instance: ObservabilityLogger | null = null

export function getObservabilityLogger(logDir?: string): ObservabilityLogger {
  if (!_instance || logDir) {
    _instance = new ObservabilityLogger(logDir)
  }
  return _instance
}
