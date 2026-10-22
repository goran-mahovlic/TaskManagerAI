#!/usr/bin/env bun
/**
 * REGOC AgentMonitor (A6) — Real-time Agent Monitor
 *
 * Provides a unified API for monitoring running agents in real-time.
 * Designed for TaskWebUI live panel integration.
 *
 * Data sources:
 *   - PID files at ~/.tmp/regoc_pids/ for active detection
 *   - AgentLogger for per-agent log reading
 *   - AgentSignals for BTW sending
 *   - ObservabilityLogger for spawn history
 *   - REGOC_AGENTS.json for agent metadata (model, role)
 *
 * Storage: No own storage — reads from existing sources.
 *
 * Usage:
 *   import { getAgentMonitor } from '~/.claude/regoc/AgentMonitor'
 *   const monitor = getAgentMonitor()
 *   const agents = monitor.getActiveAgents()
 *   const log = monitor.getRecentLog('jelena', 20)
 *   const history = monitor.getSpawnHistory(10)
 *   monitor.sendBTW('jelena', 'Koristi TypeScript')
 *   const stats = monitor.getStats()
 *
 * @version 1.0.0
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs'
import { join, basename } from 'path'

import { AgentLogger, getAgentLogger } from './AgentLogger'
import type { AgentLogEntry } from './AgentLogger'
import { AgentSignals, getAgentSignals } from './AgentSignals'
import { ObservabilityLogger, getObservabilityLogger } from './ObservabilityLogger'
import type { LogEntry } from './ObservabilityLogger'
import { homedir } from 'os'

// ============================================
// Types
// ============================================

export interface ActiveAgent {
  agentId: string
  taskId: string
  taskTitle: string
  startedAt: string
  elapsedMs: number
  model: string
  lastLogLine: string | null
  signalCount: number
}

export interface SpawnHistoryEntry {
  agentId: string
  taskId: string
  startedAt: string
  completedAt: string | null
  status: string
  durationMs: number
}

export interface MonitorStats {
  activeCount: number
  todaySpawns: number
  avgDurationMs: number
}

// ============================================
// Constants
// ============================================

const HOME = process.env.HOME || homedir()
const DEFAULT_PID_DIR = join(HOME, '.tmp/regoc_pids')
const AGENTS_JSON_PATH = join(HOME, '.claude/regoc/REGOC_AGENTS.json')

// Agents recognized by the system (from REGOC_AGENTS.json whitelist)
const AGENT_PID_REGEX = /^([a-z][a-z0-9_]*)\.pid$/

// ============================================
// AgentMonitor
// ============================================

export class AgentMonitor {
  private pidDir: string
  private agentLogger: AgentLogger
  private agentSignals: AgentSignals
  private obsLogger: ObservabilityLogger
  private agentsJsonPath: string

  constructor(options?: {
    pidDir?: string
    agentLogger?: AgentLogger
    agentSignals?: AgentSignals
    obsLogger?: ObservabilityLogger
    agentsJsonPath?: string
  }) {
    this.pidDir = options?.pidDir ?? DEFAULT_PID_DIR
    this.agentLogger = options?.agentLogger ?? getAgentLogger()
    this.agentSignals = options?.agentSignals ?? getAgentSignals()
    this.obsLogger = options?.obsLogger ?? getObservabilityLogger()
    this.agentsJsonPath = options?.agentsJsonPath ?? AGENTS_JSON_PATH
  }

  // ------------------------------------------
  // Public API
  // ------------------------------------------

  /**
   * Get list of currently active agents.
   * Detects agents by PID files in ~/.tmp/regoc_pids/.
   * Cross-references with AgentLogger for log lines and
   * REGOC_AGENTS.json for model info.
   */
  getActiveAgents(): ActiveAgent[] {
    const pidFiles = this.listPidFiles()
    const agentMeta = this.loadAgentMeta()
    const now = Date.now()
    const result: ActiveAgent[] = []

    for (const { agentId, pidFilePath } of pidFiles) {
      // Read PID and check if process is actually running
      const pid = this.readPid(pidFilePath)
      if (pid === null) continue
      if (!this.isProcessRunning(pid)) continue

      // Get the PID file creation time as spawn start
      const startedAt = this.getFileCreatedAt(pidFilePath)
      const elapsedMs = now - new Date(startedAt).getTime()

      // Get model from agent registry
      const model = agentMeta[agentId]?.model ?? 'unknown'

      // Get most recent log session and last log line
      const { taskId, taskTitle, lastLogLine } = this.getLatestSessionInfo(agentId)

      // Count unread signals
      let signalCount = 0
      try {
        const unread = this.agentSignals.readSignals(agentId)
        signalCount = unread.length
      } catch {
        // Agent ID may not match signals whitelist
      }

      result.push({
        agentId,
        taskId,
        taskTitle,
        startedAt,
        elapsedMs,
        model,
        lastLogLine,
        signalCount,
      })
    }

    return result
  }

  /**
   * Get recent log lines for an agent (from AgentLogger).
   * Returns the content strings from the most recent session's log entries.
   */
  getRecentLog(agentId: string, lines: number = 20): string[] {
    const sessions = this.agentLogger.listSessions({ agentId, limit: 1 })
    if (sessions.length === 0) return []

    const entries = this.agentLogger.readLog(sessions[0].logPath, { limit: lines })
    return entries.map(e => `[${e.phase}] ${e.content}`)
  }

  /**
   * Get spawn history from ObservabilityLogger (agent-spawns.jsonl).
   * Returns the last N spawns with duration and completion status.
   */
  getSpawnHistory(limit: number = 20): SpawnHistoryEntry[] {
    // Read all spawn events from ObservabilityLogger
    const allEntries = this.readSpawnLog()

    // Group by agent+taskId to pair SPAWN with COMPLETE/ERROR
    const spawnMap = new Map<string, {
      agentId: string
      taskId: string
      startedAt: string
      completedAt: string | null
      status: string
    }>()

    for (const entry of allEntries) {
      if (entry.event !== 'agent_spawn') continue
      const detail = entry.detail as Record<string, unknown>
      const taskId = String(detail.taskId ?? '')
      const key = `${entry.agent}:${taskId}:${entry.ts}`

      spawnMap.set(key, {
        agentId: entry.agent,
        taskId,
        startedAt: entry.ts,
        completedAt: null,
        status: 'running',
      })
    }

    // Also scan AgentLogger sessions for completion info
    const sessions = this.agentLogger.listSessions({ limit: limit * 2 })
    for (const session of sessions) {
      const summary = this.agentLogger.getSessionSummary(session.logPath)
      // Find matching spawn entry and enrich with completion data
      for (const [key, spawn] of spawnMap) {
        if (spawn.agentId === summary.agentId && spawn.taskId === summary.taskId) {
          if (summary.completedAt) {
            spawn.completedAt = summary.completedAt
            spawn.status = summary.byPhase['ERROR'] ? 'error' : 'completed'
          }
          break
        }
      }
    }

    // Convert to array, sort by startedAt descending
    const history = Array.from(spawnMap.values())
      .map(s => ({
        agentId: s.agentId,
        taskId: s.taskId,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        status: s.status,
        durationMs: s.completedAt
          ? new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()
          : Date.now() - new Date(s.startedAt).getTime(),
      }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)

    return history
  }

  /**
   * Send BTW signal to a running agent.
   * Delegates to AgentSignals.writeSignal().
   * Returns true if the signal was sent successfully.
   */
  sendBTW(agentId: string, message: string): boolean {
    try {
      const signalId = this.agentSignals.writeSignal(agentId, 'BTW', message, 'monitor')
      return !!signalId
    } catch {
      return false
    }
  }

  /**
   * Get overall monitoring stats.
   */
  getStats(): MonitorStats {
    // Active count from PID files
    const active = this.getActiveAgents()
    const activeCount = active.length

    // Today's spawns from ObservabilityLogger
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayCutoff = todayStart.toISOString()

    const allSpawns = this.readSpawnLog()
    const todaySpawns = allSpawns.filter(
      e => e.event === 'agent_spawn' && e.ts >= todayCutoff
    )

    // Average duration from AgentLogger sessions (last 50)
    const sessions = this.agentLogger.listSessions({ limit: 50 })
    let totalDuration = 0
    let completedCount = 0

    for (const session of sessions) {
      const summary = this.agentLogger.getSessionSummary(session.logPath)
      if (summary.startedAt && summary.completedAt) {
        const duration = new Date(summary.completedAt).getTime() - new Date(summary.startedAt).getTime()
        if (duration > 0) {
          totalDuration += duration
          completedCount++
        }
      }
    }

    const avgDurationMs = completedCount > 0
      ? Math.round(totalDuration / completedCount)
      : 0

    return {
      activeCount,
      todaySpawns: todaySpawns.length,
      avgDurationMs,
    }
  }

  // ------------------------------------------
  // Internal helpers
  // ------------------------------------------

  /** List all .pid files in the PID directory */
  private listPidFiles(): Array<{ agentId: string; pidFilePath: string }> {
    if (!existsSync(this.pidDir)) return []

    const files = readdirSync(this.pidDir)
    const result: Array<{ agentId: string; pidFilePath: string }> = []

    for (const file of files) {
      const match = file.match(AGENT_PID_REGEX)
      if (!match) continue

      result.push({
        agentId: match[1],
        pidFilePath: join(this.pidDir, file),
      })
    }

    return result
  }

  /** Read PID number from a .pid file */
  private readPid(filePath: string): number | null {
    try {
      const content = readFileSync(filePath, 'utf-8').trim()
      const pid = parseInt(content, 10)
      return isNaN(pid) ? null : pid
    } catch {
      return null
    }
  }

  /** Check if a process with the given PID is running */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0) // Signal 0 = check existence without killing
      return true
    } catch {
      return false
    }
  }

  /** Get file creation/modification time as ISO string */
  private getFileCreatedAt(filePath: string): string {
    try {
      const stat = statSync(filePath)
      return stat.mtime.toISOString()
    } catch {
      return new Date().toISOString()
    }
  }

  /** Load agent metadata from REGOC_AGENTS.json */
  private loadAgentMeta(): Record<string, { model: string; role: string }> {
    try {
      if (!existsSync(this.agentsJsonPath)) return {}
      const raw = readFileSync(this.agentsJsonPath, 'utf-8')
      const registry = JSON.parse(raw)
      const agents = registry.agents || {}
      const result: Record<string, { model: string; role: string }> = {}

      for (const [id, agent] of Object.entries(agents)) {
        const a = agent as Record<string, unknown>
        result[id] = {
          model: String(a.model || 'unknown'),
          role: String(a.role || 'unknown'),
        }
      }

      return result
    } catch {
      return {}
    }
  }

  /** Get latest session info for an agent from AgentLogger */
  private getLatestSessionInfo(agentId: string): {
    taskId: string
    taskTitle: string
    lastLogLine: string | null
  } {
    const sessions = this.agentLogger.listSessions({ agentId, limit: 1 })
    if (sessions.length === 0) {
      return { taskId: '', taskTitle: '', lastLogLine: null }
    }

    const session = sessions[0]
    const entries = this.agentLogger.readLog(session.logPath)
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null

    // Try to extract task title from SPAWN entry metadata
    let taskTitle = ''
    const spawnEntry = entries.find(e => e.phase === 'SPAWN')
    if (spawnEntry?.metadata?.prompt_preview) {
      taskTitle = String(spawnEntry.metadata.prompt_preview).slice(0, 100)
    }

    return {
      taskId: session.taskId,
      taskTitle,
      lastLogLine: lastEntry ? lastEntry.content : null,
    }
  }

  /** Read all agent_spawn entries from observability log */
  private readSpawnLog(): LogEntry[] {
    // ObservabilityLogger stores spawns in agent-spawns.jsonl
    // We read it directly to get the full list
    const obsDir = (this.obsLogger as unknown as { logDir: string }).logDir
      ?? join(HOME, '.claude/regoc/observability')

    const spawnFile = join(obsDir, 'agent-spawns.jsonl')
    if (!existsSync(spawnFile)) return []

    try {
      const content = readFileSync(spawnFile, 'utf-8').trim()
      if (!content) return []

      const entries: LogEntry[] = []
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          entries.push(JSON.parse(line) as LogEntry)
        } catch {
          // skip malformed lines
        }
      }
      return entries
    } catch {
      return []
    }
  }
}

// ============================================
// Singleton
// ============================================

let _instance: AgentMonitor | null = null

export function getAgentMonitor(options?: ConstructorParameters<typeof AgentMonitor>[0]): AgentMonitor {
  if (!_instance || options) {
    _instance = new AgentMonitor(options)
  }
  return _instance
}
