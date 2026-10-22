/**
 * REGOČ HealthSnapshot — Automatic System Health Monitoring
 *
 * Takes periodic health snapshots of all services and triggers alerts.
 * Designed to integrate with RegocPulse (port 17780) or work standalone.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ollamaUrl, chromaUrl } from './lib/okolina-sustava' // TASK-5700 (K3a)

const HOME = process.env.HOME || homedir()
const SNAPSHOT_DIR = join(HOME, '.claude/regoc/observability')
const SNAPSHOT_FILE = join(SNAPSHOT_DIR, 'health-snapshots.jsonl')
const MAX_SNAPSHOTS = 288 // 24h at 5min intervals

export interface ServiceHealth {
  name: string
  status: 'running' | 'stopped' | 'error' | 'unknown'
  responseMs?: number
  details?: string
}

export interface HealthSnapshotData {
  timestamp: string
  services: Record<string, ServiceHealth>
  databases: Record<string, { sizeMb: number; exists: boolean }>
  system: {
    platform: string
    uptimeSeconds: number
    memoryUsageMb: number
  }
  alerts: string[]
}

const SERVICE_CHECKS: Array<{ name: string; type: 'url' | 'pid'; target: string }> = [
  { name: 'TaskWebUI', type: 'url', target: 'http://localhost:17781/health' },
  { name: 'VoiceServer', type: 'url', target: 'http://localhost:8888/health' },
  { name: 'RegocPulse', type: 'url', target: 'http://localhost:17780/health' },
  { name: 'ChromaDB', type: 'url', target: `${chromaUrl()}/api/v1/heartbeat` },
  { name: 'Ollama', type: 'url', target: `${ollamaUrl()}/api/tags` },
]

const DB_PATHS: Array<{ name: string; path: string }> = [
  { name: 'messages.db', path: join(HOME, '.claude/regoc/messages.db') },
  { name: 'regoc.db', path: join(HOME, '.claude/regoc/data/regoc.db') },
  { name: 'audit.db', path: join(HOME, '.claude/regoc/security/audit.db') },
]

const ALERT_THRESHOLDS = {
  memoryMb: 2048,
  dbSizeMb: 500,
}

export class HealthSnapshot {
  private snapshotDir: string
  private snapshotFile: string

  constructor(snapshotDir?: string) {
    this.snapshotDir = snapshotDir || SNAPSHOT_DIR
    this.snapshotFile = snapshotDir ? join(snapshotDir, 'health-snapshots.jsonl') : SNAPSHOT_FILE
    if (!existsSync(this.snapshotDir)) {
      mkdirSync(this.snapshotDir, { recursive: true })
    }
  }

  async takeSnapshot(): Promise<HealthSnapshotData> {
    const services: Record<string, ServiceHealth> = {}
    const alerts: string[] = []

    // Check services
    for (const check of SERVICE_CHECKS) {
      const start = Date.now()
      try {
        if (check.type === 'url') {
          const resp = await fetch(check.target, { signal: AbortSignal.timeout(3000) })
          services[check.name] = {
            name: check.name,
            status: resp.ok ? 'running' : 'error',
            responseMs: Date.now() - start,
            details: resp.ok ? 'OK' : `HTTP ${resp.status}`,
          }
        }
      } catch (err) {
        services[check.name] = {
          name: check.name,
          status: 'stopped',
          responseMs: Date.now() - start,
          details: err instanceof Error ? err.message : 'Connection failed',
        }
        alerts.push(`${check.name} is DOWN`)
      }
    }

    // Check databases
    const databases: Record<string, { sizeMb: number; exists: boolean }> = {}
    for (const db of DB_PATHS) {
      try {
        if (existsSync(db.path)) {
          const stats = Bun.file(db.path)
          const sizeMb = Math.round((stats.size / 1024 / 1024) * 100) / 100
          databases[db.name] = { sizeMb, exists: true }
          if (sizeMb > ALERT_THRESHOLDS.dbSizeMb) {
            alerts.push(`${db.name} is ${sizeMb}MB (threshold: ${ALERT_THRESHOLDS.dbSizeMb}MB)`)
          }
        } else {
          databases[db.name] = { sizeMb: 0, exists: false }
        }
      } catch {
        databases[db.name] = { sizeMb: 0, exists: false }
      }
    }

    // System info
    const memUsage = process.memoryUsage()
    const memoryUsageMb = Math.round(memUsage.heapUsed / 1024 / 1024)
    if (memoryUsageMb > ALERT_THRESHOLDS.memoryMb) {
      alerts.push(`Memory usage ${memoryUsageMb}MB exceeds threshold ${ALERT_THRESHOLDS.memoryMb}MB`)
    }

    const snapshot: HealthSnapshotData = {
      timestamp: new Date().toISOString(),
      services,
      databases,
      system: {
        platform: `${process.platform} ${process.arch}`,
        uptimeSeconds: Math.round(process.uptime()),
        memoryUsageMb,
      },
      alerts,
    }

    // Save
    this.saveSnapshot(snapshot)

    return snapshot
  }

  private saveSnapshot(snapshot: HealthSnapshotData): void {
    try {
      appendFileSync(this.snapshotFile, JSON.stringify(snapshot) + '\n')
    } catch {
      // Graceful — don't crash if can't write
    }
  }

  getHistory(count?: number): HealthSnapshotData[] {
    const limit = count || 10
    try {
      if (!existsSync(this.snapshotFile)) return []
      const content = readFileSync(this.snapshotFile, 'utf-8')
      const lines = content.trim().split('\n').filter(l => l)
      return lines
        .slice(-limit)
        .map(line => {
          try { return JSON.parse(line) as HealthSnapshotData } catch { return null }
        })
        .filter((s): s is HealthSnapshotData => s !== null)
        .reverse()
    } catch {
      return []
    }
  }

  getLastSnapshot(): HealthSnapshotData | null {
    const history = this.getHistory(1)
    return history[0] || null
  }

  hasAlerts(): boolean {
    const last = this.getLastSnapshot()
    return (last?.alerts?.length || 0) > 0
  }
}

let _instance: HealthSnapshot | null = null

export function getHealthSnapshot(): HealthSnapshot {
  if (!_instance) _instance = new HealthSnapshot()
  return _instance
}
