#!/usr/bin/env bun
import { TM_ROOT } from './core/paths'
import os from 'os'
/**
 * Regoč TaskManagerMD - Task Web UI Server
 *
 * Dedicated web server for task management visualization
 * Port: 17779
 *
 * Features:
 * - REST API for task CRUD
 * - WebSocket for real-time updates
 * - File watcher for markdown changes
 * - Health check endpoint
 *
 * Autor: Grga (Designer Agent), implementirala Kosjenka
 * Verzija: 1.0.0
 */

import { watch, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
// SQL-Only TaskManager (v2.0) - replaces MD+SQLite dual-write
import { getTaskManagerSQL } from './core/TaskManagerSQL'
// TASK-3047: ručna kočnica — globalna pauza dijeljena s RegocDaemonom preko datoteke stanja.
import { readPauseState, writePauseState, describePause } from './core/PauseControl'
import { formatLocalTime } from './core/QuotaWakeup'
import { getProjectManager } from './core/ProjectManager'
import { getMessageQueue } from './core/MessageQueue'
import { getRAGService } from './RAGService'
import type { Task, AgentId, TaskFilter } from './types/task-types'
import { CreateTaskInputSchema, UpdateTaskInputSchema, TaskFilterSchema } from './zod/schemas/task'
import { isRecycledAgentReport } from './core/DispatchGuard'
// K7/TASK-2986: potrošnja na ploči dolazi iz cost_loga koji puni svaki spawn.
import { getCostTracker } from './core/CostTracker'
import {
  normalizeTaskFields,
  unknownFieldResponseBody,
  UPDATE_TASK_FIELDS,
  CREATE_TASK_FIELDS,
} from './core/TaskFieldAliases'
import {
  evaluateCompletion, formatVerdictLog, formatShadowLog, loadGateConfig, shouldEnforce,
} from './core/CompletionGuard'
import {
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  ProjectFilterSchema,
  AddAgentInputSchema,
  LinkRAGInputSchema
} from './zod/schemas/project'
import { RAGFilterSchema, RAGDeleteRequestSchema } from './zod/schemas/rag'
import { resolveSessionUsage, createDefaultDeps, type UsageState } from './SessionUsage'
// TASK-2989/2991: traka više ne vjeruje status datoteci na riječ — stanje se izvodi.
import { resolveDaemonLiveness, type LivenessDeps } from './DaemonLiveness'

// ============================================
// CONFIGURATION
// ============================================

// NOTE: Using reserved port 17781 which is mapped 1:1 in Docker
// docker-compose.yml has: "17781:17781" (host:container same)
// Old mapping 17779->3001 conflicts with Claude Code internal task server
const EXTERNAL_PORT = Number(process.env.TM_EXTERNAL_PORT) || Number(process.env.TM_PORT) || 17781  // vrata koja korisnik otvara izvana
// REGOC_TASKWEBUI_PORT: override SAMO za testove/alat (produkcija ga ne postavlja, pa je
// ponašanje nepromijenjeno). Uz HOME override daje potpuno izoliranu instancu s vlastitom
// bazom — E2E se tako vozi bez ijednog fixture-zapisa u živoj regoc.db (usp. TASK-2701).
const PORT = Number(process.env.TM_PORT) || Number(process.env.REGOC_TASKWEBUI_PORT) || 17781  // vrata na kojima poslužitelj sluša
const HOST = '0.0.0.0'       // Bind to all interfaces for external access
const TASKS_DIR = process.env.TM_TASKS_DIR || join(TM_ROOT, 'tasks')
const AGENTS_DIR = join(TASKS_DIR, 'agents')

// Allowed hosts for external access (both internal and external ports)
// Also allow old port 17779 for backwards compatibility during migration
const ALLOWED_HOSTS = [
  'localhost',
  '127.0.0.1',
  process.env.TM_EXTERNAL_HOST || 'localhost',
  'dell-home',
  'dell-home.tailc98738.ts.net',
  // Internal ports (inside Docker)
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  // External ports (from outside Docker)
  `localhost:${EXTERNAL_PORT}`,
  `127.0.0.1:${EXTERNAL_PORT}`,
  `${process.env.TM_EXTERNAL_HOST || 'localhost'}:${EXTERNAL_PORT}`,
  `dell-home:${EXTERNAL_PORT}`,
  `dell-home.tailc98738.ts.net:${EXTERNAL_PORT}`,
  // Legacy port 17779 - will not work externally but allow for local testing
  'localhost:17779',
  '127.0.0.1:17779'
]

function isHostAllowed(req: Request): boolean {
  const host = req.headers.get('host') || ''
  const hostWithoutPort = host.split(':')[0]
  return ALLOWED_HOSTS.includes(host) || ALLOWED_HOSTS.includes(hostWithoutPort)
}

// WebSocket clients
const wsClients = new Set<any>()

// Task Manager (SQL-Only v2.0)
const taskManager = getTaskManagerSQL()

// Project Manager
const projectManager = getProjectManager()

// RAG Service
const ragService = getRAGService()

// Message Queue
const messageQueue = getMessageQueue()

// Read-only DB for konzola streaming (MQ + event_log)
import { Database } from 'bun:sqlite'
const MESSAGES_DB_PATH = join(TM_ROOT, 'messages.db')
let konzolaDb: Database | null = null
try {
  konzolaDb = new Database(MESSAGES_DB_PATH, { readonly: true })
  konzolaDb.exec('PRAGMA journal_mode = WAL')
} catch { konzolaDb = null }

// ============================================
// KONZOLA STATE
// ============================================

let konzolaMode: 'plan' | 'work' = 'plan'

const DAEMON_LOG_FILE = join(process.env.HOME || os.homedir(), '.tmp/regoc_daemon.log')
const STATUS_FILE = join(process.env.HOME || os.homedir(), '.tmp/regoc_status.json')
/** Zamrznut 23.02.2026. — od K7 samo fallback dok se `cost_log` ne napuni. */
const STATS_CACHE_FILE = join(process.env.HOME || os.homedir(), '.claude/stats-cache.json')
/** Prozor za prikaz potrošnje na ploči (dana). */
const TOKEN_WINDOW_DAYS = 30
const SCHEDULER_STATE_FILE = join(process.env.HOME || os.homedir(), '.tmp/regoc_scheduler_state.json')
const REGOC_SERVICES_SCRIPT = join(process.env.HOME || os.homedir(), 'app/regoc_system/regoc-services.sh')
/** PID koji piše RegocDaemon — tvrdi signal živosti uz (meku) starost status datoteke. */
const DAEMON_PID_FILE = join(TM_ROOT, 'daemon.pid')

/**
 * Produkcijske ovisnosti za DaemonLiveness (TASK-2991). Sama logika resolvera je bez I/O
 * (da se rubni slučajevi testiraju bez pravog daemona), pa čitanje datoteka i provjera
 * procesa žive ovdje — isti obrazac kao `createDefaultDeps` u SessionUsage.
 */
const daemonLivenessDeps: LivenessDeps = {
  readStatusFile: () => Bun.file(STATUS_FILE).text(),
  statusFileMtimeMs: async () => {
    try { return statSync(STATUS_FILE).mtimeMs } catch { return null }
  },
  readPidFile: () => Bun.file(DAEMON_PID_FILE).text(),
  processExists: (pid: number) => {
    // signal 0 ne šalje ništa, samo provjerava postoji li proces i smijemo li ga dirati
    try { process.kill(pid, 0); return true } catch { return false }
  },
  processCmdline: (pid: number) => {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim() } catch { return null }
  },
  now: () => Date.now(),
}

/** Zadano stanje kad se o daemonu ne zna ništa — polja koja konzola oduvijek čita. */
const DAEMON_FALLBACK = {
  status: 'Unknown', currentTask: null, pendingMessages: 0, processedToday: 0, uptime: 0, contextPct: 0,
}

/**
 * Daemon blok za `/api/konzola/status` i `/api/status-dashboard`.
 *
 * Stara polja (status, currentTask, uptime, mode…) ostaju netaknuta radi kompatibilnosti
 * sa svime što ih već čita; izvedena istina dolazi u novim poljima
 * (`state`, `alive`, `ageS`, `statusAgeS`, `reason`, `display`, `pid`, `lastSeen`).
 *
 * Starost se računa OVDJE, na poslužitelju: preglednikov sat i vremenska zona nisu
 * pouzdani, pa bi pomak sata izgledao kao mrtav daemon. `serverTime` je uz to da klijent
 * može prikazati apsolutno vrijeme bez vlastite aritmetike.
 */
async function buildDaemonBlock(): Promise<Record<string, unknown>> {
  try {
    const live = await resolveDaemonLiveness(daemonLivenessDeps)
    return {
      ...DAEMON_FALLBACK,
      ...live.status,
      state: live.state,
      alive: live.alive,
      pid: live.pid,
      ageS: live.ageS,
      statusAgeS: live.statusAgeS,
      lastSeen: live.lastSeen,
      reason: live.reason,
      display: live.display,
      serverTime: new Date().toISOString(),
    }
  } catch (err) {
    // Resolver ne baca, ali ni ovdje ne smije pasti cijeli endpoint zbog statusne trake.
    return {
      ...DAEMON_FALLBACK,
      state: 'offline', alive: false, pid: null, ageS: null, statusAgeS: null, lastSeen: null,
      reason: `provjera živosti nije uspjela: ${err instanceof Error ? err.message : String(err)}`,
      display: 'OFFLINE',
      serverTime: new Date().toISOString(),
    }
  }
}

let logFilePosition = 0
let logStreamInterval: ReturnType<typeof setInterval> | null = null

// Command execution allowlist
const ALLOWED_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find',
  'git', 'bun', 'node',
  'date', 'uptime', 'whoami', 'hostname', 'df', 'free',
  'ps', 'top',
])

// Commands allowed ONLY in work mode
const WORK_MODE_COMMANDS = new Set(['bun', 'node'])

// Blocked patterns (security)
const BLOCKED_PATTERNS = [
  /rm\s+-rf/i,
  /sudo/i,
  /chmod/i,
  /chown/i,
  /curl.*\|\s*(bash|sh)/i,
  /wget.*\|\s*(bash|sh)/i,
  />\s*\/etc\//i,
  /\.\.\/\.\.\//,
  /\$\(/,
  /`[^`]+`/,
  /[;&|]{2,}/,
]

// Command aliases
const COMMAND_ALIASES: Record<string, string[]> = {
  'services': [REGOC_SERVICES_SCRIPT, 'status'],
  'services status': [REGOC_SERVICES_SCRIPT, 'status'],
  'services health': [REGOC_SERVICES_SCRIPT, 'health'],
  'services start': [REGOC_SERVICES_SCRIPT, 'start'],
  'services stop': [REGOC_SERVICES_SCRIPT, 'stop'],
  'services restart': [REGOC_SERVICES_SCRIPT, 'restart'],
  'services logs daemon': [REGOC_SERVICES_SCRIPT, 'logs', 'daemon'],
  'services logs voiceserver': [REGOC_SERVICES_SCRIPT, 'logs', 'voiceserver'],
}

// Health cache
let cachedHealth: any = null
let cachedHealthTime = 0
const HEALTH_CACHE_TTL = 30000

async function getCachedHealthCheck(): Promise<any> {
  if (Date.now() - cachedHealthTime < HEALTH_CACHE_TTL && cachedHealth) {
    return cachedHealth
  }
  try {
    const proc = Bun.spawn([REGOC_SERVICES_SCRIPT, 'health'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { HOME: process.env.HOME || os.homedir(), PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', USER: process.env.USER || 'taskmanager' }
    })
    const output = await new Response(proc.stdout).text()
    cachedHealth = JSON.parse(output)
    cachedHealthTime = Date.now()
    return cachedHealth
  } catch {
    return cachedHealth || { services: {}, status: 'unknown' }
  }
}

// ============================================
// FILE WATCHER
// ============================================

let watcherReady = false

function startFileWatcher() {
  try {
    // Watch agents directory for changes
    const watcher = watch(AGENTS_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename?.endsWith('.md')) return

      console.log(`[FileWatcher] ${eventType}: ${filename}`)

      // Broadcast update to all WebSocket clients
      const message = JSON.stringify({
        type: 'file_changed',
        filename,
        timestamp: new Date().toISOString()
      })

      wsClients.forEach(client => {
        try {
          client.send(message)
        } catch (err) {
          wsClients.delete(client)
        }
      })
    })

    watcherReady = true
    console.log(`[FileWatcher] Watching ${AGENTS_DIR}`)

    return watcher
  } catch (error) {
    console.error('[FileWatcher] Failed to start:', error)
    return null
  }
}

// ============================================
// HTML TEMPLATE
// ============================================

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="hr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Regoč TaskManagerMD</title>
  <style>
    :root {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-tertiary: #334155;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --accent-blue: #3b82f6;
      --accent-green: #22c55e;
      --accent-yellow: #eab308;
      --accent-red: #ef4444;
      --accent-purple: #a855f7;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      padding: 1rem;
    }

    .container { max-width: 1400px; margin: 0 auto; }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      background: var(--bg-secondary);
      border-radius: 0.5rem;
      margin-bottom: 1rem;
    }

    h1 { font-size: 1.5rem; color: var(--accent-blue); }
    .status { display: flex; gap: 1rem; align-items: center; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-green); }
    .status-dot.disconnected { background: var(--accent-red); }

    .grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
    }

    .column {
      background: var(--bg-secondary);
      border-radius: 0.5rem;
      padding: 1rem;
    }

    .column h2 {
      font-size: 1rem;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid var(--bg-tertiary);
    }

    .column.in-progress h2 { border-color: var(--accent-blue); }
    .column.pending h2 { border-color: var(--accent-yellow); }
    .column.blocked h2 { border-color: var(--accent-red); }
    .column.completed h2 { border-color: var(--accent-green); }

    .task-card {
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.75rem;
      margin-bottom: 0.5rem;
      cursor: pointer;
      transition: transform 0.1s;
    }

    .task-card:hover { transform: translateY(-2px); }

    .task-id {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: monospace;
    }

    .task-title {
      font-weight: 500;
      margin: 0.25rem 0;
    }

    .task-meta {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .priority-1 { border-left: 3px solid var(--accent-red); }
    .priority-2 { border-left: 3px solid var(--accent-yellow); }
    .priority-3 { border-left: 3px solid var(--accent-blue); }
    .priority-4 { border-left: 3px solid var(--accent-purple); }
    .priority-5 { border-left: 3px solid var(--text-secondary); }

    .agent-filter {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-bottom: 1rem;
    }

    .agent-btn {
      padding: 0.25rem 0.75rem;
      background: var(--bg-secondary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 1rem;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 0.875rem;
    }

    .agent-btn.active {
      background: var(--accent-blue);
      color: white;
      border-color: var(--accent-blue);
    }

    .stats {
      display: flex;
      gap: 1rem;
      margin-bottom: 1rem;
    }

    .stat {
      background: var(--bg-secondary);
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      text-align: center;
    }

    .stat-value { font-size: 1.5rem; font-weight: bold; }
    .stat-label { font-size: 0.75rem; color: var(--text-secondary); }

    .empty { color: var(--text-secondary); font-style: italic; text-align: center; padding: 2rem; }

    /* ============================================ */
    /* PROJECT FILTER & BADGE */
    /* ============================================ */
    .filter-row {
      display: flex;
      gap: 1rem;
      align-items: center;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }

    .filter-select {
      padding: 0.5rem 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.875rem;
      cursor: pointer;
      min-width: 150px;
    }

    .filter-select:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .project-badge {
      display: inline-block;
      padding: 2px 8px;
      background: rgba(100, 100, 100, 0.2);
      border-radius: 4px;
      font-size: 0.75rem;
      color: #888;
      cursor: pointer;
      margin-left: 8px;
    }

    .project-badge:hover {
      background: rgba(100, 100, 100, 0.3);
    }

    /* ============================================ */
    /* TAB NAVIGATION */
    /* ============================================ */
    .tab-nav {
      display: flex;
      gap: 0.5rem;
      background: var(--bg-secondary);
      padding: 0.5rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
      justify-content: space-between;
      align-items: center;
    }

    .tab-nav-left {
      display: flex;
      gap: 0.5rem;
    }

    .tab-nav-right {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }

    .tab-nav-right .filter-select {
      padding: 0.5rem 1rem;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.875rem;
      cursor: pointer;
    }

    .tab-btn {
      padding: 0.75rem 1.5rem;
      background: transparent;
      border: none;
      border-radius: 0.375rem;
      color: var(--text-secondary);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    .tab-btn:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .tab-btn.active {
      background: var(--accent-blue);
      color: white;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    /* ============================================ */
    /* PROJECTS KANBAN */
    /* ============================================ */
    .projects-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }

    .projects-filter {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .project-card {
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.75rem;
      margin-bottom: 0.5rem;
      cursor: pointer;
      transition: transform 0.1s;
      border-left: 3px solid var(--accent-blue);
    }

    .project-card:hover { transform: translateY(-2px); }

    .project-card.p1 { border-left-color: var(--accent-red); }
    .project-card.p2 { border-left-color: var(--accent-yellow); }
    .project-card.p3 { border-left-color: var(--accent-blue); }
    .project-card.p4 { border-left-color: var(--accent-purple); }
    .project-card.p5 { border-left-color: var(--text-secondary); }

    .project-id {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: monospace;
    }

    .project-name {
      font-weight: 500;
      margin: 0.25rem 0;
    }

    .project-meta {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .project-agents {
      display: flex;
      gap: 0.25rem;
      flex-wrap: wrap;
      margin-top: 0.25rem;
    }

    .agent-chip {
      background: var(--bg-secondary);
      color: var(--text-secondary);
      padding: 0.125rem 0.5rem;
      border-radius: 1rem;
      font-size: 0.625rem;
    }

    /* Project columns */
    .column.active-projects h2 { border-color: var(--accent-green); }
    .column.on-hold h2 { border-color: var(--accent-yellow); }
    .column.completed-projects h2 { border-color: var(--accent-blue); }
    .column.archived h2 { border-color: var(--text-secondary); }

    /* ============================================ */
    /* RAG PAGE */
    /* ============================================ */
    .rag-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .rag-filters {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: center;
    }

    .rag-filters select {
      background: var(--bg-tertiary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.5rem 1rem;
      color: var(--text-primary);
      font-size: 0.875rem;
      cursor: pointer;
    }

    .rag-filters select:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .rag-filters input[type="text"] {
      background: var(--bg-tertiary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.5rem 1rem;
      color: var(--text-primary);
      font-size: 0.875rem;
      transition: border-color 0.2s ease;
    }

    .rag-filters input[type="text"]:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .rag-filters input[type="text"]::placeholder {
      color: var(--text-secondary);
    }

    .rag-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .rag-entry {
      background: var(--bg-secondary);
      border-radius: 0.375rem;
      padding: 1rem;
      cursor: pointer;
      transition: background 0.2s;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
    }

    .rag-entry:hover {
      background: var(--bg-tertiary);
    }

    .rag-entry-main {
      flex: 1;
      min-width: 0;
    }

    .rag-entry-header {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
    }

    .rag-entry-id {
      font-family: monospace;
      font-size: 0.75rem;
      color: var(--accent-blue);
      background: var(--bg-primary);
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
    }

    .rag-entry-collection {
      font-size: 0.75rem;
      color: var(--accent-purple);
      background: rgba(168, 85, 247, 0.1);
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
    }

    .rag-entry-type {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .rag-entry-date {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .rag-entry-preview {
      color: var(--text-secondary);
      font-size: 0.875rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }

    .rag-entry-actions {
      display: flex;
      gap: 0.5rem;
    }

    .rag-delete-btn {
      background: transparent;
      border: 1px solid var(--accent-red);
      color: var(--accent-red);
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .rag-delete-btn:hover {
      background: var(--accent-red);
      color: white;
    }

    .load-more-btn {
      display: block;
      width: 100%;
      padding: 0.75rem;
      background: var(--bg-secondary);
      border: 1px dashed var(--bg-tertiary);
      border-radius: 0.375rem;
      color: var(--text-secondary);
      font-size: 0.875rem;
      cursor: pointer;
      transition: all 0.2s;
      margin-top: 1rem;
    }

    .load-more-btn:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border-style: solid;
    }

    /* RAG Detail Modal */
    .rag-modal {
      background: var(--bg-secondary);
      border-radius: 0.5rem;
      padding: 1.5rem;
      max-width: 800px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
      animation: slideUp 0.3s;
    }

    .rag-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--bg-tertiary);
    }

    .rag-modal-meta {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .rag-modal-content {
      background: var(--bg-primary);
      border-radius: 0.375rem;
      padding: 1rem;
      font-family: monospace;
      font-size: 0.875rem;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 400px;
      overflow-y: auto;
    }

    .rag-modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--bg-tertiary);
    }

    .btn-danger {
      background: var(--accent-red);
      color: white;
    }

    /* ============================================ */
    /* PROJECT DETAIL PANEL */
    /* ============================================ */
    .project-detail-panel {
      position: fixed;
      top: 0;
      right: -500px;
      width: 480px;
      height: 100vh;
      background: var(--bg-secondary);
      border-left: 1px solid var(--bg-tertiary);
      box-shadow: -4px 0 20px rgba(0,0,0,0.3);
      z-index: 1500;
      transition: right 0.3s ease;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }

    .project-detail-panel.open {
      right: 0;
    }

    .project-section {
      margin-bottom: 1.5rem;
    }

    .project-section h4 {
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 0.5rem;
    }

    .agents-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .agent-item {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      background: var(--bg-tertiary);
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
    }

    .agent-item .remove-agent {
      cursor: pointer;
      color: var(--accent-red);
      font-weight: bold;
    }

    .task-list-compact {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .task-list-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem;
      background: var(--bg-tertiary);
      border-radius: 0.25rem;
      font-size: 0.75rem;
    }

    .task-list-item .task-status {
      padding: 0.125rem 0.375rem;
      border-radius: 0.125rem;
      font-size: 0.625rem;
      text-transform: uppercase;
    }

    .task-status.pending { background: var(--accent-yellow); color: var(--bg-primary); }
    .task-status.in_progress { background: var(--accent-blue); color: white; }
    .task-status.completed { background: var(--accent-green); color: white; }
    .task-status.blocked { background: var(--accent-red); color: white; }

    @media (max-width: 800px) {
      .project-detail-panel {
        width: 100%;
        right: -100%;
      }
    }

    /* Task Detail Panel */
    .detail-panel {
      position: fixed;
      top: 0;
      right: -420px;  /* Hidden by default */
      width: 400px;
      height: 100vh;
      background: var(--bg-secondary);
      border-left: 1px solid var(--bg-tertiary);
      box-shadow: -4px 0 20px rgba(0,0,0,0.3);
      z-index: 1500;
      transition: right 0.3s ease;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }

    .detail-panel.open {
      right: 0;
    }

    .detail-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      border-bottom: 1px solid var(--bg-tertiary);
      position: sticky;
      top: 0;
      background: var(--bg-secondary);
    }

    .detail-panel-body {
      padding: 1rem;
      flex: 1;
    }

    .detail-panel-footer {
      padding: 1rem;
      border-top: 1px solid var(--bg-tertiary);
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
      position: sticky;
      bottom: 0;
      background: var(--bg-secondary);
    }

    .detail-field {
      margin-bottom: 1rem;
    }

    .detail-field label {
      display: block;
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .detail-field input,
    .detail-field textarea,
    .detail-field select {
      width: 100%;
      background: var(--bg-tertiary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.5rem;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 0.875rem;
    }

    .detail-field input:focus,
    .detail-field textarea:focus,
    .detail-field select:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .detail-field textarea {
      min-height: 150px;
      resize: vertical;
    }

    /* Progress Notes */
    .progress-notes {
      margin-top: 0.5rem;
    }

    .progress-note {
      padding: 0.5rem;
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
      margin-bottom: 0.5rem;
      font-size: 0.875rem;
    }

    .progress-note-meta {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
    }

    /* Tags Input */
    .tags-container {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      padding: 0.25rem;
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
      min-height: 36px;
    }

    .tag {
      background: var(--accent-blue);
      color: white;
      padding: 0.125rem 0.5rem;
      border-radius: 1rem;
      font-size: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .tag-remove {
      cursor: pointer;
      opacity: 0.7;
    }

    .tag-remove:hover {
      opacity: 1;
    }

    /* Blocked By selector */
    .blocked-by-list {
      margin-top: 0.5rem;
    }

    .blocked-by-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.25rem 0.5rem;
      background: var(--accent-red);
      color: white;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      margin-bottom: 0.25rem;
    }

    /* Close button */
    .close-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0.25rem;
      line-height: 1;
    }

    .close-btn:hover {
      color: var(--text-primary);
    }

    /* Timestamps display */
    .timestamps {
      font-size: 0.75rem;
      color: var(--text-secondary);
      padding: 0.5rem;
      background: var(--bg-primary);
      border-radius: 0.375rem;
      margin-top: 1rem;
    }

    .timestamps div {
      margin-bottom: 0.25rem;
    }

    /* Responsive */
    @media (max-width: 800px) {
      .detail-panel {
        width: 100%;
        right: -100%;
      }
    }

    /* When panel is open, shrink grid */
    .container.panel-open {
      margin-right: 420px;
      transition: margin-right 0.3s ease;
    }

    @media (max-width: 800px) {
      .container.panel-open {
        margin-right: 0;
      }
    }

    /* Priority Dropdown */
    .priority-badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      position: relative;
      user-select: none;
    }

    .priority-badge.p1 { background: var(--accent-red); color: white; }
    .priority-badge.p2 { background: var(--accent-yellow); color: var(--bg-primary); }
    .priority-badge.p3 { background: var(--accent-blue); color: white; }

    .priority-dropdown {
      position: absolute;
      top: calc(100% + 0.25rem);
      right: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.25rem;
      z-index: 1000;
      min-width: 100px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }

    .priority-option {
      padding: 0.5rem 0.75rem;
      cursor: pointer;
      border-radius: 0.25rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: background 0.1s;
    }

    .priority-option:hover { background: var(--bg-tertiary); }

    .priority-option.delete { color: var(--accent-red); border-top: 1px solid var(--bg-tertiary); margin-top: 0.25rem; }

    .priority-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .priority-dot.red { background: var(--accent-red); }
    .priority-dot.yellow { background: var(--accent-yellow); }
    .priority-dot.blue { background: var(--accent-blue); }

    /* TASK-3047: ručna kočnica (globalna + po zadatku) */
    .global-pause-btn {
      background: var(--accent-yellow, #eab308);
      color: #1a1a1a;
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      margin-right: 0.75rem;
      transition: background 0.15s, transform 0.1s;
    }
    .global-pause-btn:hover { transform: translateY(-1px); }
    .global-pause-btn.paused {
      background: var(--accent-red, #ef4444);
      color: #fff;
      animation: pause-pulse 1.6s ease-in-out infinite;
    }
    @keyframes pause-pulse { 0%,100% { opacity: 1 } 50% { opacity: .6 } }
    .global-pause-info {
      font-size: 0.75rem;
      color: var(--accent-red, #ef4444);
      margin-right: 0.75rem;
    }

    /* Pauzirana kartica mora biti prepoznatljiva IZ DALJINE — pauza je iznimno stanje
       i ne smije se stopiti s ostalima na ploči. */
    .task-card.paused {
      opacity: 0.6;
      border-left: 4px solid var(--accent-yellow, #eab308);
    }
    .task-pause-btn {
      background: transparent;
      border: 1px solid var(--border-color, #333);
      color: var(--text-secondary, #999);
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 0.72rem;
      cursor: pointer;
      margin-left: auto;
    }
    .task-pause-btn:hover { border-color: var(--accent-yellow, #eab308); color: var(--accent-yellow, #eab308); }
    .task-pause-btn.resume { border-color: var(--accent-green, #22c55e); color: var(--accent-green, #22c55e); }
    .paused-badge {
      font-size: 0.68rem;
      background: var(--accent-yellow, #eab308);
      color: #1a1a1a;
      border-radius: 3px;
      padding: 1px 5px;
      margin-left: 6px;
      font-weight: 600;
    }

    /* Add Task Button */
    .add-task-btn {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--accent-blue);
      color: white;
      border: none;
      font-size: 2rem;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
      transition: transform 0.2s, box-shadow 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .add-task-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 16px rgba(59, 130, 246, 0.6);
    }

    .add-task-btn:active { transform: scale(0.95); }

    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
      animation: fadeIn 0.2s;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal {
      background: var(--bg-secondary);
      border-radius: 0.5rem;
      padding: 1.5rem;
      max-width: 500px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
      animation: slideUp 0.3s;
    }

    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .modal h3 {
      font-size: 1.25rem;
      margin-bottom: 1rem;
      color: var(--text-primary);
    }

    .form-group {
      margin-bottom: 1rem;
    }

    .form-group label {
      display: block;
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
    }

    .form-group input,
    .form-group textarea,
    .form-group select {
      width: 100%;
      background: var(--bg-tertiary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.5rem;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 0.875rem;
    }

    .form-group textarea {
      min-height: 100px;
      resize: vertical;
    }

    .form-group input:focus,
    .form-group textarea:focus,
    .form-group select:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .modal-actions {
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
      margin-top: 1.5rem;
    }

    .btn {
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      border: none;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      transition: opacity 0.2s;
    }

    .btn:hover { opacity: 0.8; }

    .btn-primary {
      background: var(--accent-blue);
      color: white;
    }

    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    /* Progress Bar - Color-coded based on progress */
    .progress-bar-container {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.5rem;
      margin-bottom: 0.25rem;
    }

    .progress-bar {
      flex: 1;
      height: 10px;
      background: var(--bg-primary);
      border-radius: 5px;
      overflow: hidden;
      position: relative;
    }

    .progress-bar-fill {
      height: 100%;
      border-radius: 5px;
      transition: width 0.3s ease, background-color 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    /* Color coding: red < 30%, yellow 30-70%, green > 70% */
    .progress-bar-fill.progress-low {
      background: linear-gradient(90deg, var(--accent-red), #f87171);
    }

    .progress-bar-fill.progress-medium {
      background: linear-gradient(90deg, var(--accent-yellow), #fbbf24);
    }

    .progress-bar-fill.progress-high {
      background: linear-gradient(90deg, var(--accent-green), #4ade80);
    }

    .progress-bar-fill::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
      animation: shimmer 2s infinite;
    }

    @keyframes shimmer {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }

    .progress-text {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-secondary);
      min-width: 35px;
      text-align: right;
    }

    .progress-text.progress-low { color: var(--accent-red); }
    .progress-text.progress-medium { color: var(--accent-yellow); }
    .progress-text.progress-high { color: var(--accent-green); }

    /* ============================================ */
    /* KONZOLA TAB                                  */
    /* ============================================ */
    .konzola-status-bar {
      display: flex; flex-wrap: wrap; gap: 0.75rem; padding: 0.75rem 1rem;
      background: var(--bg-secondary); border-radius: 0.5rem; margin-bottom: 0.5rem;
      border: 1px solid var(--border-color);
      font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 0.8rem;
    }
    .konzola-status-item { display: flex; align-items: center; gap: 0.25rem; }
    .konzola-status-label { color: var(--text-secondary); }
    .konzola-status-value { color: var(--accent-green); font-weight: 600; }
    .konzola-status-value.s-error { color: var(--accent-red); }
    .konzola-status-value.s-warn { color: var(--accent-yellow); }
    .konzola-mode-toggle { margin-left: auto; }
    .konzola-mode-btn {
      padding: 0.25rem 0.75rem; border: 1px solid var(--accent-blue); border-radius: 0.25rem;
      background: transparent; color: var(--accent-blue); font-size: 0.75rem; font-weight: 700;
      font-family: monospace; cursor: pointer; letter-spacing: 0.05em; transition: all 0.2s;
    }
    .konzola-mode-btn.plan-mode { border-color: var(--accent-yellow); color: var(--accent-yellow); }
    .konzola-mode-btn.work-mode { border-color: var(--accent-green); color: var(--accent-green); background: rgba(34,197,94,0.1); }
    .konzola-output-wrapper {
      background: #0a0e17; border: 1px solid var(--border-color); border-radius: 0.5rem;
      height: calc(100vh - 320px); overflow-y: auto; margin-bottom: 0.5rem;
    }
    .konzola-output {
      padding: 0.75rem;
      font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.8rem; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; color: #c8d6e5;
    }
    .konzola-output .log-ts { color: var(--text-secondary); font-size: 0.75rem; }
    .konzola-output .log-info { color: #3b82f6; }
    .konzola-output .log-warn { color: #f59e0b; }
    .konzola-output .log-error { color: #ef4444; }
    .konzola-output .log-success { color: #22c55e; }
    .konzola-output .log-cmd { color: #a78bfa; }
    .konzola-output .log-thinking { color: #c084fc; font-style: italic; opacity: 0.9; }
    .konzola-output .log-text { color: #67e8f9; }
    .konzola-output .log-system { color: var(--text-secondary); font-style: italic; }
    .konzola-output .konzola-welcome { color: #3b82f6; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border-color); margin-bottom: 0.5rem; }
    .konzola-input-wrapper {
      display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem;
      background: #0a0e17; border: 1px solid var(--border-color); border-radius: 0.5rem;
    }
    .konzola-prompt { color: var(--accent-green); font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; font-weight: 700; white-space: nowrap; }
    .konzola-input { flex: 1; background: transparent; border: none; outline: none; color: var(--text-primary); font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; caret-color: var(--accent-green); }

    /* ============================================ */
    /* STATUS TAB                                   */
    /* ============================================ */
    .status-header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
    .status-section {
      background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 0.5rem;
      padding: 1rem; margin-bottom: 0.75rem;
    }
    .status-section-title {
      font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--text-secondary); border-bottom: 1px solid var(--border-color);
      padding-bottom: 0.5rem; margin-bottom: 0.75rem;
    }
    .service-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.5rem; }
    .service-badge {
      display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem;
      background: var(--bg-primary); border-radius: 0.375rem; border: 1px solid var(--border-color);
      font-size: 0.8rem; font-family: monospace;
    }
    .service-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .service-dot.running { background: #22c55e; box-shadow: 0 0 4px #22c55e; }
    .service-dot.stopped { background: #ef4444; box-shadow: 0 0 4px #ef4444; }
    .service-dot.disabled { background: #6b7280; }
    .service-dot.ok { background: #22c55e; box-shadow: 0 0 4px #22c55e; }
    .service-dot.down { background: #ef4444; box-shadow: 0 0 4px #ef4444; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.75rem; }
    .stat-box {
      text-align: center; padding: 0.75rem; background: var(--bg-primary); border-radius: 0.375rem;
      border: 1px solid var(--border-color);
    }
    .stat-value { font-size: 1.5rem; font-weight: 700; color: var(--accent-blue); font-family: monospace; }
    .stat-label { font-size: 0.7rem; color: var(--text-secondary); margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .token-table { width: 100%; border-collapse: collapse; font-family: monospace; font-size: 0.8rem; }
    .token-table th { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 0.7rem; text-transform: uppercase; }
    .token-table td { padding: 0.5rem; border-bottom: 1px solid var(--border-color); }
    .token-table td:not(:first-child) { text-align: right; }
    .token-table .total-row { font-weight: 700; border-top: 2px solid var(--border-color); }
    .progress-bar-sm { height: 6px; background: var(--bg-primary); border-radius: 3px; overflow: hidden; margin-top: 0.5rem; }
    .progress-bar-sm-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
    .project-progress-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color); }
    .project-progress-item:last-child { border-bottom: none; }
    .project-progress-name { flex: 0 0 200px; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .project-progress-bar { flex: 1; }
    .project-progress-pct { flex: 0 0 45px; text-align: right; font-family: monospace; font-size: 0.8rem; font-weight: 600; }

    /* Info Tab */
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    @media (max-width: 900px) { .info-grid { grid-template-columns: 1fr; } }
    .info-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; }
    .info-card-title { font-size: 0.85rem; font-weight: 700; color: var(--accent-blue); margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 0.5rem; }
    .info-card-title .icon { font-size: 1rem; }
    .info-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    .info-table th { text-align: left; padding: 0.4rem 0.5rem; color: var(--text-secondary); font-size: 0.7rem; text-transform: uppercase; border-bottom: 1px solid var(--border-color); }
    .info-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
    .info-table tr:last-child td { border-bottom: none; }
    .info-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
    .info-badge.frontier { background: rgba(139,92,246,0.2); color: #a78bfa; }
    .info-badge.strong { background: rgba(59,130,246,0.2); color: #60a5fa; }
    .info-badge.good { background: rgba(34,197,94,0.2); color: #4ade80; }
    .info-badge.basic { background: rgba(250,204,21,0.2); color: #facc15; }
    .info-badge.classifier { background: rgba(148,163,184,0.2); color: #94a3b8; }
    .info-badge.enabled { background: rgba(34,197,94,0.2); color: #22c55e; }
    .info-badge.disabled { background: rgba(148,163,184,0.15); color: #64748b; }
    .info-badge.required { background: rgba(239,68,68,0.2); color: #f87171; }
    .info-version { font-size: 1.5rem; font-weight: 800; color: var(--text-primary); margin-bottom: 0.25rem; }
    .info-subtitle { color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 1rem; }
    .info-kv { display: flex; justify-content: space-between; padding: 0.3rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 0.8rem; }
    .info-kv:last-child { border-bottom: none; }
    .info-kv-label { color: var(--text-secondary); }
    .info-kv-value { color: var(--text-primary); font-weight: 600; font-family: monospace; }
    .info-full { grid-column: 1 / -1; }
    .info-provider-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .info-provider-row:last-child { border-bottom: none; }
    .info-dot { width: 8px; height: 8px; border-radius: 50%; }
    .info-dot.online { background: #22c55e; }
    .info-dot.offline { background: #64748b; }
    .wf-step { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 0.75rem; margin-bottom: 0.5rem; }
    .wf-step-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
    .wf-step-title { font-weight: 700; font-size: 0.85rem; color: var(--accent-blue); }
    .wf-step-actions { display: flex; gap: 0.25rem; }
    .wf-step-actions button { background: transparent; border: 1px solid var(--border-color); color: var(--text-secondary); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 0.7rem; }
    .wf-step-actions button:hover { color: var(--text-primary); border-color: var(--accent-blue); }
    .wf-step-actions button.btn-del:hover { border-color: var(--accent-red); color: var(--accent-red); }
    .wf-step textarea { width: 100%; min-height: 80px; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; padding: 0.5rem; font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; resize: vertical; }
    .wf-toolbar { display: flex; gap: 0.5rem; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border-color); }
    .wf-toolbar button { padding: 6px 14px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; border: 1px solid var(--border-color); }
    .wf-toolbar .btn-save { background: var(--accent-green); color: #000; border-color: var(--accent-green); font-weight: 600; }
    .wf-toolbar .btn-add { background: transparent; color: var(--accent-blue); border-color: var(--accent-blue); }
    .wf-toolbar .btn-close { background: transparent; color: var(--text-secondary); }
    .wf-item { padding: 0.35rem 0.5rem; cursor: pointer; border-radius: 4px; font-size: 0.8rem; display: flex; justify-content: space-between; }
    .wf-item:hover { background: rgba(59,130,246,0.1); }
    .wf-item .wf-skill { color: var(--text-secondary); font-size: 0.7rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Regoč TaskManagerMD</h1>
      <div class="status">
        <!-- TASK-3047: ručna kočnica. Stoji u zaglavlju jer mora biti dohvatljiva s bilo
             kojeg taba — kad nešto krene po zlu, ne traži se gumb po karticama. -->
        <button id="global-pause-btn" class="global-pause-btn" title="Zaustavi sav automatski rad">&#9208; Pauza</button>
        <span id="global-pause-info" class="global-pause-info"></span>
        <span id="connection-status" class="status-dot"></span>
        <span id="status-text">Connecting...</span>
      </div>
    </header>

    <!-- Tab Navigation -->
    <nav class="tab-nav">
      <div class="tab-nav-left">
        <button class="tab-btn active" data-tab="tasks">Tasks</button>
        <button class="tab-btn" data-tab="projects">Projects</button>
        <button class="tab-btn" data-tab="rag">RAG</button>
        <button class="tab-btn" data-tab="konzola">Konzola</button>
        <button class="tab-btn" data-tab="status">Status</button>
        <button class="tab-btn" data-tab="info">Config</button>
      </div>
      <div class="tab-nav-right">
        <select id="tasks-project-filter" class="filter-select">
          <option value="">All Projects</option>
        </select>
      </div>
    </nav>

    <!-- TASKS TAB -->
    <div id="tab-tasks" class="tab-content active">
      <div class="stats" id="stats">
        <div class="stat"><div class="stat-value" id="total-count">-</div><div class="stat-label">Total</div></div>
        <div class="stat"><div class="stat-value" id="progress-count">-</div><div class="stat-label">In Progress</div></div>
        <div class="stat"><div class="stat-value" id="pending-count">-</div><div class="stat-label">Pending</div></div>
        <div class="stat"><div class="stat-value" id="blocked-count">-</div><div class="stat-label">Blocked</div></div>
        <div class="stat"><div class="stat-value" id="completed-count">-</div><div class="stat-label">Completed</div></div>
        <div class="stat"><div class="stat-value" id="cancelled-count">-</div><div class="stat-label">Cancelled</div></div>
        <div class="stat"><div class="stat-value" id="overall-progress">-</div><div class="stat-label">Overall Progress</div></div>
      </div>

      <div class="agent-filter" id="agent-filter">
        <button class="agent-btn active" data-agent="all">All Agents</button>
      </div>

      <div class="grid">
        <div class="column in-progress">
          <h2>In Progress</h2>
          <div id="in-progress-tasks"></div>
        </div>
        <div class="column pending">
          <h2>Pending</h2>
          <div id="pending-tasks"></div>
        </div>
        <div class="column blocked">
          <h2>Blocked</h2>
          <div id="blocked-tasks"></div>
        </div>
        <div class="column completed">
          <h2>Completed (Recent)</h2>
          <div id="completed-tasks"></div>
        </div>
      </div>
    </div>

    <!-- PROJECTS TAB -->
    <div id="tab-projects" class="tab-content">
      <div class="projects-header">
        <div class="projects-filter" id="projects-agent-filter">
          <button class="agent-btn active" data-agent="all">All Agents</button>
        </div>
        <button class="btn btn-primary" id="add-project-btn">+ New Project</button>
      </div>

      <div class="grid">
        <div class="column active-projects">
          <h2>Active</h2>
          <div id="active-projects"></div>
        </div>
        <div class="column on-hold">
          <h2>On Hold</h2>
          <div id="on-hold-projects"></div>
        </div>
        <div class="column completed-projects">
          <h2>Completed</h2>
          <div id="completed-projects"></div>
        </div>
        <div class="column archived">
          <h2>Archived</h2>
          <div id="archived-projects"></div>
        </div>
      </div>
    </div>

    <!-- RAG TAB -->
    <div id="tab-rag" class="tab-content">
      <div class="rag-header">
        <h2>RAG Entries</h2>
        <div class="rag-filters">
          <input type="text" id="rag-search-input" placeholder="Pretraži RAG..." style="padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.875rem; flex: 1; margin-right: 12px;">
          <select id="rag-collection-filter">
            <option value="">All Collections</option>
          </select>
          <span id="rag-total-count" style="color: var(--text-secondary); font-size: 0.875rem;">Loading...</span>
        </div>
      </div>

      <div class="rag-list" id="rag-list">
        <div class="empty">Loading RAG entries...</div>
      </div>

      <button class="load-more-btn" id="rag-load-more" style="display: none;">Load More</button>
    </div>

    <!-- KONZOLA TAB -->
    <div id="tab-konzola" class="tab-content">
      <div class="konzola-status-bar" id="konzola-status-bar">
        <div class="konzola-status-item">
          <span class="konzola-status-label">Daemon:</span>
          <span id="konzola-daemon-status" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label">Uptime:</span>
          <span id="konzola-uptime" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label">Task:</span>
          <span id="konzola-current-task" class="konzola-status-value" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label">Pending:</span>
          <span id="konzola-pending" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label">Processed:</span>
          <span id="konzola-processed" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label">Context:</span>
          <span id="konzola-context" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label">Services:</span>
          <span id="konzola-services" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item" title="Potrošnja trenutne Claude sesije (5h prozor) / tjedna (7d)">
          <span class="konzola-status-label">Sesija:</span>
          <span id="konzola-session" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item konzola-mode-toggle">
          <button id="konzola-mode-btn" class="konzola-mode-btn plan-mode">PLAN</button>
          <button id="persistent-btn" class="konzola-mode-btn" style="border-color:#6b7280;color:#6b7280;margin-left:4px" title="Persistent agents config">AGENTS</button>
        </div>
        <!-- Persistent agents panel (hidden by default) -->
        <div id="persistent-panel" style="display:none;background:#0d1117;border:1px solid #1e293b;border-radius:0.5rem;padding:0.75rem;margin:0.5rem 0;font-family:monospace;font-size:0.8rem">
          <div style="color:#93c5fd;margin-bottom:0.5rem;font-weight:700">PERSISTENT AGENTS</div>
          <div id="persistent-agent-list" style="color:#c8d6e5"></div>
          <div style="margin-top:0.5rem;display:flex;gap:4px">
            <button id="persistent-all-btn" class="konzola-mode-btn" style="border-color:#22c55e;color:#22c55e;font-size:0.7rem">ALL ON</button>
            <button id="persistent-off-btn" class="konzola-mode-btn" style="border-color:#ef4444;color:#ef4444;font-size:0.7rem">ALL OFF</button>
          </div>
        </div>
      </div>
      <div class="konzola-output-wrapper">
        <div class="konzola-output" id="konzola-output">
          <div class="konzola-welcome">Konzola ready. Type 'help' for commands.</div>
        </div>
      </div>
      <div class="konzola-input-wrapper">
        <span class="konzola-prompt" id="konzola-prompt">regoc $</span>
        <input type="text" id="konzola-input" class="konzola-input" placeholder="Type a command..." autocomplete="off" spellcheck="false">
      </div>
    </div>

    <!-- STATUS TAB -->
    <div id="tab-status" class="tab-content">
      <div class="status-header-bar">
        <h2 style="margin:0;font-size:1.1rem;">System Status</h2>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <span id="status-last-updated" style="color:var(--text-secondary);font-size:0.75rem;">--</span>
          <button id="status-refresh-btn" class="konzola-mode-btn plan-mode" style="border-color:var(--accent-blue);color:var(--accent-blue);">Refresh</button>
        </div>
      </div>

      <div class="status-section" id="status-services-section">
        <div class="status-section-title">Service Health</div>
        <div class="service-grid" id="status-service-grid">
          <div class="empty">Loading...</div>
        </div>
      </div>

      <div class="status-section" id="status-overview-section">
        <div class="status-section-title">System Overview</div>
        <div class="stat-grid" id="status-overview-grid"></div>
      </div>

      <div class="status-section" id="status-tokens-section">
        <div class="status-section-title">Token Usage</div>
        <div id="status-token-content"></div>
      </div>

      <div class="status-section" id="status-projects-section">
        <div class="status-section-title">Projects &amp; Tasks</div>
        <div id="status-projects-content"></div>
      </div>

      <div class="status-section" id="status-queue-section">
        <div class="status-section-title">Scheduler &amp; Queue</div>
        <div id="status-queue-content"></div>
      </div>
    </div>

    <!-- INFO TAB -->
    <div id="tab-info" class="tab-content">
      <div class="status-header-bar">
        <h2 style="margin:0;font-size:1.1rem;">REGO&#268; Config</h2>
        <button id="info-refresh-btn" class="konzola-mode-btn plan-mode" style="border-color:var(--accent-blue);color:var(--accent-blue);">Refresh</button>
      </div>
      <div class="info-grid" id="info-grid">
        <div class="info-card" id="info-system-card">
          <div class="info-card-title"><span class="icon">&#9646;</span> System</div>
          <div id="info-system-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card" id="info-providers-card">
          <div class="info-card-title"><span class="icon">&#9881;</span> AI Providers</div>
          <div id="info-providers-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-agents-card">
          <div class="info-card-title"><span class="icon">&#9733;</span> Agents &amp; Model Requirements</div>
          <div id="info-agents-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-login-card">
          <div class="info-card-title"><span class="icon">&#128273;</span> Prijave (login preko linka)</div>
          <div id="info-login-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-modelsetup-card">
          <div class="info-card-title"><span class="icon">&#9881;</span> Podržani modeli &amp; postavke providera</div>
          <div id="info-modelsetup-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-modules-card">
          <div class="info-card-title"><span class="icon">&#9670;</span> Modules</div>
          <div id="info-modules-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card" id="info-infra-card">
          <div class="info-card-title"><span class="icon">&#9729;</span> Infrastructure</div>
          <div id="info-infra-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card" id="info-databases-card">
          <div class="info-card-title"><span class="icon">&#9744;</span> Databases</div>
          <div id="info-databases-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card" id="info-metrics-card">
          <div class="info-card-title"><span class="icon">&#9776;</span> Metrics Summary</div>
          <div id="info-metrics-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-components-card">
          <div class="info-card-title"><span class="icon">&#9881;</span> Core Components (v4.4.0)</div>
          <div id="info-components-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-skills-card">
          <div class="info-card-title"><span class="icon">&#9733;</span> Skills &amp; Workflows</div>
          <div id="info-skills-content"><div class="empty">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-rules-card">
          <div class="info-card-title"><span class="icon">&#9888;</span> Critical Rules (27)</div>
          <div id="info-rules-content"><div class="empty">Loading...</div></div>
        </div>
      </div>
    </div>

    <!-- Add Task Button -->
    <button class="add-task-btn" id="add-task-btn" title="Create New Task">+</button>

    <!-- Task Detail Panel -->
    <div id="detail-panel" class="detail-panel">
      <div class="detail-panel-header">
        <span id="detail-task-id" style="font-family: monospace; color: var(--text-secondary);"></span>
        <button class="close-btn" id="close-detail-btn">&times;</button>
      </div>

      <div class="detail-panel-body">
        <div class="detail-field">
          <label>Title</label>
          <input type="text" id="detail-title" placeholder="Task title">
        </div>

        <div class="detail-field">
          <label>Status</label>
          <select id="detail-status">
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="blocked">Blocked</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        <div class="detail-field">
          <label>Priority</label>
          <select id="detail-priority">
            <option value="1">P1 - Critical</option>
            <option value="2">P2 - High</option>
            <option value="3">P3 - Normal</option>
            <option value="4">P4 - Low</option>
            <option value="5">P5 - Backlog</option>
          </select>
        </div>

        <div class="detail-field">
          <label>Assignee</label>
          <select id="detail-assignee">
            <option value="">Unassigned</option>
            <option value="regoc">regoc</option>
            <option value="klaudio">klaudio</option>
            <option value="stribor">stribor</option>
            <option value="kosjenka">kosjenka</option>
            <option value="jelena">jelena</option>
            <option value="malik">malik</option>
            <option value="manda">manda</option>
            <option value="potjeh">potjeh</option>
            <option value="dora">dora</option>
            <option value="gita">gita</option>
            <option value="grga">grga</option>
          </select>
        </div>

        <div class="detail-field">
          <label>Description</label>
          <textarea id="detail-description" placeholder="Task description (markdown supported)"></textarea>
        </div>

        <div class="detail-field">
          <label>Blocked By</label>
          <select id="detail-blocked-by-select">
            <option value="">+ Add blocking task...</option>
          </select>
          <div id="detail-blocked-by-list" class="blocked-by-list"></div>
        </div>

        <div class="detail-field">
          <label>Blocked Reason</label>
          <input type="text" id="detail-blocked-reason" placeholder="Why is this blocked?">
        </div>

        <div class="detail-field">
          <label>Tags</label>
          <div id="detail-tags" class="tags-container"></div>
          <input type="text" id="detail-tag-input" placeholder="Add tag (press Enter)" style="margin-top: 0.25rem;">
        </div>

        <div class="detail-field">
          <label>Progress Notes</label>
          <div id="detail-progress-notes" class="progress-notes"></div>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
            <input type="text" id="detail-new-note" placeholder="Add progress note..." style="flex: 1;">
            <button class="btn btn-secondary" id="add-note-btn">Add</button>
          </div>
        </div>

        <div class="detail-field" id="detail-result-field" style="display:none;">
          <label>Rezultat / Odgovor agenta</label>
          <div id="detail-result-summary" class="progress-notes" style="white-space:pre-wrap;word-break:break-word;"></div>
        </div>

        <div class="timestamps" id="detail-timestamps"></div>
      </div>

      <div class="detail-panel-footer">
        <button class="btn btn-secondary" id="delete-task-btn" style="margin-right: auto; background: var(--accent-red);">Delete</button>
        <button class="btn btn-secondary" id="cancel-edit-btn">Cancel</button>
        <button class="btn btn-primary" id="save-task-btn">Save Changes</button>
      </div>
    </div>

    <!-- Modal for Creating Task -->
    <div id="modal-overlay" class="modal-overlay" style="display: none;">
      <div class="modal">
        <h3>Create New Task</h3>
        <form id="task-form">
          <div class="form-group">
            <label for="task-title">Title *</label>
            <input type="text" id="task-title" required placeholder="Task title">
          </div>
          <div class="form-group">
            <label for="task-description">Description</label>
            <textarea id="task-description" placeholder="Task description (optional)"></textarea>
          </div>
          <div class="form-group">
            <label for="task-priority">Priority</label>
            <select id="task-priority">
              <option value="1">P1 - High (Red)</option>
              <option value="2" selected>P2 - Medium (Yellow)</option>
              <option value="3">P3 - Low (Blue)</option>
            </select>
          </div>
          <div class="form-group">
            <label for="task-assignee">Assignee</label>
            <select id="task-assignee">
              <option value="">Unassigned</option>
              <option value="regoc">regoc</option>
              <option value="klaudio">klaudio</option>
              <option value="stribor">stribor</option>
              <option value="kosjenka">kosjenka</option>
              <option value="jelena">jelena</option>
              <option value="malik">malik</option>
              <option value="manda">manda</option>
              <option value="potjeh">potjeh</option>
              <option value="dora">dora</option>
              <option value="gita">gita</option>
              <option value="grga">grga</option>
            </select>
          </div>
          <div class="form-group">
            <label for="new-task-project">Project (optional)</label>
            <select id="new-task-project" class="form-select">
              <option value="">No Project</option>
            </select>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" id="cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-primary">Create Task</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal for Creating Project -->
    <div id="project-modal-overlay" class="modal-overlay" style="display: none;">
      <div class="modal">
        <h3 id="project-modal-title">Create New Project</h3>
        <form id="project-form">
          <input type="hidden" id="project-edit-id">
          <div class="form-group">
            <label for="project-name">Name *</label>
            <input type="text" id="project-name" required placeholder="Project name">
          </div>
          <div class="form-group">
            <label for="project-description">Description</label>
            <textarea id="project-description" placeholder="Project description (optional)"></textarea>
          </div>
          <div class="form-group">
            <label for="project-status">Status</label>
            <select id="project-status">
              <option value="active">Active</option>
              <option value="on_hold">On Hold</option>
              <option value="completed">Completed</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div class="form-group">
            <label for="project-priority">Priority</label>
            <select id="project-priority">
              <option value="1">P1 - Critical</option>
              <option value="2">P2 - High</option>
              <option value="3" selected>P3 - Normal</option>
              <option value="4">P4 - Low</option>
              <option value="5">P5 - Backlog</option>
            </select>
          </div>
          <div class="form-group">
            <label for="project-lead">Lead Agent</label>
            <select id="project-lead">
              <option value="">No Lead</option>
              <option value="regoc">regoc</option>
              <option value="klaudio">klaudio</option>
              <option value="stribor">stribor</option>
              <option value="kosjenka">kosjenka</option>
              <option value="jelena">jelena</option>
              <option value="malik">malik</option>
              <option value="manda">manda</option>
              <option value="potjeh">potjeh</option>
              <option value="dora">dora</option>
              <option value="gita">gita</option>
              <option value="grga">grga</option>
            </select>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" id="project-cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-primary" id="project-submit-btn">Create Project</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Project Detail Panel -->
    <div id="project-detail-panel" class="project-detail-panel">
      <div class="detail-panel-header">
        <span id="project-detail-id" style="font-family: monospace; color: var(--text-secondary);"></span>
        <button class="close-btn" id="close-project-detail-btn">&times;</button>
      </div>

      <div class="detail-panel-body">
        <div class="detail-field">
          <label>Name</label>
          <input type="text" id="project-detail-name" placeholder="Project name">
        </div>

        <div class="detail-field">
          <label>Status</label>
          <select id="project-detail-status">
            <option value="active">Active</option>
            <option value="on_hold">On Hold</option>
            <option value="completed">Completed</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        <div class="detail-field">
          <label>Priority</label>
          <select id="project-detail-priority">
            <option value="1">P1 - Critical</option>
            <option value="2">P2 - High</option>
            <option value="3">P3 - Normal</option>
            <option value="4">P4 - Low</option>
            <option value="5">P5 - Backlog</option>
          </select>
        </div>

        <div class="detail-field">
          <label>Lead Agent</label>
          <select id="project-detail-lead">
            <option value="">No Lead</option>
            <option value="regoc">regoc</option>
            <option value="klaudio">klaudio</option>
            <option value="stribor">stribor</option>
            <option value="kosjenka">kosjenka</option>
            <option value="jelena">jelena</option>
            <option value="malik">malik</option>
            <option value="manda">manda</option>
            <option value="potjeh">potjeh</option>
            <option value="dora">dora</option>
            <option value="gita">gita</option>
            <option value="grga">grga</option>
          </select>
        </div>

        <div class="detail-field">
          <label>Description</label>
          <textarea id="project-detail-description" placeholder="Project description"></textarea>
        </div>

        <!-- SPECIFIKACIJA + dispatch "Nadogradi po specifikacijama" -->
        <div class="project-section">
          <h4>Specifikacija</h4>
          <div class="detail-field">
            <textarea id="project-detail-spec" placeholder="Što treba isporučiti, zašto, koji fajlovi, kriterij za done..." style="min-height: 180px; font-family: monospace; font-size: 0.85rem;"></textarea>
          </div>
          <div style="display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem;">
            <select id="spec-upgrade-agent" style="flex: 1;">
              <option value="">Odaberi agenta...</option>
            </select>
            <button class="btn btn-primary" id="spec-upgrade-btn" disabled title="Odaberi agenta i upiši specifikaciju">⟳ Nadogradi po specifikacijama</button>
          </div>
          <div style="margin-top: 0.5rem;">
            <a href="#" id="spec-template-toggle" style="font-size: 0.8rem; color: var(--text-secondary);">▸ Template poruke</a>
            <div id="spec-template-editor" style="display: none; margin-top: 0.5rem;">
              <textarea id="spec-template-content" style="min-height: 140px; font-family: monospace; font-size: 0.8rem; width: 100%;"></textarea>
              <div style="font-size: 0.75rem; color: var(--text-secondary); margin: 0.25rem 0;">Placeholderi: <code>$agent</code> <code>$projekt</code> <code>$spec</code></div>
              <button class="btn btn-secondary" id="spec-template-save-btn" style="font-size: 0.8rem;">Spremi template</button>
            </div>
          </div>
        </div>

        <div class="project-section">
          <h4>Team Agents</h4>
          <div id="project-detail-agents" class="agents-grid"></div>
          <select id="project-add-agent-select" style="margin-top: 0.5rem; width: 100%;">
            <option value="">+ Add agent to project...</option>
            <option value="regoc">regoc</option>
            <option value="klaudio">klaudio</option>
            <option value="stribor">stribor</option>
            <option value="kosjenka">kosjenka</option>
            <option value="jelena">jelena</option>
            <option value="malik">malik</option>
            <option value="manda">manda</option>
            <option value="potjeh">potjeh</option>
            <option value="dora">dora</option>
            <option value="gita">gita</option>
            <option value="grga">grga</option>
          </select>
        </div>

        <div class="project-section">
          <h4>Linked Tasks</h4>
          <div id="project-detail-tasks" class="task-list-compact">
            <div class="empty">No tasks linked</div>
          </div>
        </div>

        <div class="timestamps" id="project-detail-timestamps"></div>
      </div>

      <div class="detail-panel-footer">
        <button class="btn btn-secondary" id="delete-project-btn" style="margin-right: auto; background: var(--accent-red);">Delete</button>
        <button class="btn btn-secondary" id="cancel-project-edit-btn">Cancel</button>
        <button class="btn btn-primary" id="save-project-btn">Save Changes</button>
      </div>
    </div>

    <!-- RAG Detail Modal -->
    <div id="rag-modal-overlay" class="modal-overlay" style="display: none;">
      <div class="rag-modal">
        <div class="rag-modal-header">
          <div class="rag-modal-meta">
            <span id="rag-modal-id" class="rag-entry-id"></span>
            <span id="rag-modal-collection" class="rag-entry-collection"></span>
            <span id="rag-modal-type" class="rag-entry-type"></span>
            <span id="rag-modal-date" class="rag-entry-date"></span>
          </div>
          <button class="close-btn" id="close-rag-modal-btn">&times;</button>
        </div>
        <div class="rag-modal-content" id="rag-modal-content">
          Loading...
        </div>
        <div class="rag-modal-footer">
          <button class="btn btn-danger" id="rag-modal-delete-btn">Delete Entry</button>
          <button class="btn btn-secondary" id="rag-modal-close-btn">Close</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let ws;
    let currentFilter = 'all';
    let currentProjectFilter = '';
    let tasks = [];
    let projectsCache = [];

    function connect() {
      // TASK-3053: shema se izvodi iz stranice. Tvrdo kodiran ws:// na HTTPS stranici je
      // mijesani sadrzaj — preglednik ga blokira tako da new WebSocket BACI iznimku.
      const wsScheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(wsScheme + location.host + '/stream');

      ws.onopen = () => {
        document.getElementById('connection-status').classList.remove('disconnected');
        document.getElementById('status-text').textContent = 'Connected';
        fetchProjectsForFilter();
        fetchTasks();
      };

      ws.onclose = () => {
        document.getElementById('connection-status').classList.add('disconnected');
        document.getElementById('status-text').textContent = 'Disconnected - Reconnecting...';
        // TASK-3053: i ponovni pokusaj ide u try — inace iznimka iz new WebSocket ubije
        // lanac ponovnog spajanja, pa traka zauvijek stoji na „Reconnecting...".
        setTimeout(() => { try { connect() } catch (e) { console.error('[WS] ponovno spajanje palo:', e) } }, 3000);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'file_changed' || data.type === 'task_created' || data.type === 'task_updated') {
          fetchTasks();
        }
        if (data.type && data.type.startsWith('console_')) {
          handleKonzolaWSMessage(data);
        }
        // TASK-3047: kočnicu može pritisnuti drugi preglednik ili curl — svi ekrani
        // moraju istog trena pokazivati isto stanje.
        if (data.type === 'pause_changed') {
          renderGlobalPause(data.pause);
        }
      };
    }

    // Send WebSocket message
    function sendWSMessage(message) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    }

    async function fetchTasks() {
      try {
        let url = '/api/tasks';
        if (currentProjectFilter) {
          url += '?projectId=' + encodeURIComponent(currentProjectFilter);
        }
        const response = await fetch(url);
        tasks = await response.json();
        renderTasks();
        updateStats();
        updateAgentFilter();
      } catch (err) {
        console.error('Failed to fetch tasks:', err);
      }
    }

    function renderTasks() {
      const filtered = currentFilter === 'all' ? tasks : tasks.filter(t => t.assignee === currentFilter);

      const containers = {
        'in_progress': document.getElementById('in-progress-tasks'),
        'pending': document.getElementById('pending-tasks'),
        'blocked': document.getElementById('blocked-tasks'),
        'completed': document.getElementById('completed-tasks')
      };

      Object.values(containers).forEach(c => c.innerHTML = '');

      filtered.forEach(task => {
        const container = containers[task.status];
        if (!container) return;

        const card = document.createElement('div');
        card.className = 'task-card priority-' + task.priority;

        // Calculate progress for all tasks
        // Priority: 1) Use progressPercent if set, 2) Calculate based on status/time
        let progress = 0;
        if (typeof task.progressPercent === 'number') {
          // Use explicitly set progressPercent (0-100)
          progress = Math.min(Math.max(task.progressPercent, 0), 100);
        } else if (task.status === 'in_progress') {
          if (task.estimatedMinutes && task.actualMinutes) {
            // Calculate based on estimated vs actual
            progress = Math.min(Math.round((task.actualMinutes / task.estimatedMinutes) * 100), 100);
          } else if (task.startedAt) {
            // Calculate based on time elapsed (demo: 1% per hour, max 90%)
            const hoursElapsed = (Date.now() - new Date(task.startedAt).getTime()) / (1000 * 60 * 60);
            progress = Math.min(Math.round(hoursElapsed * 10), 90);
          } else {
            // Default progress for new in_progress tasks
            progress = 25;
          }
        } else if (task.status === 'completed') {
          progress = 100;
        } else if (task.status === 'pending') {
          progress = 0;
        } else if (task.status === 'blocked') {
          progress = 0; // Blocked with no progressPercent
        }

        // Determine color class based on progress (red < 30%, yellow 30-70%, green > 70%)
        let progressClass = 'progress-low';
        if (progress > 70) {
          progressClass = 'progress-high';
        } else if (progress >= 30) {
          progressClass = 'progress-medium';
        }

        // Build progress bar HTML for all tasks with color coding
        const progressHTML = \`
          <div class="progress-bar-container">
            <div class="progress-bar">
              <div class="progress-bar-fill \${progressClass}" style="width: \${progress}%"></div>
            </div>
            <div class="progress-text \${progressClass}">\${progress}%</div>
          </div>
        \`;

        // Build priority badge with dropdown
        const priorityClass = task.priority === 1 ? 'p1' : task.priority === 2 ? 'p2' : 'p3';

        // Build project badge if task has projectId
        let projectBadgeHTML = '';
        if (task.projectId) {
          const project = projectsCache.find(p => p.id === task.projectId);
          const projectName = project ? project.name : task.projectId;
          projectBadgeHTML = \`<span class="project-badge" data-project-id="\${task.projectId}" title="Filter by project">\${projectName}</span>\`;
        }

        // TASK-3047: pauza je zastavica uz status, pa pauzirani zadatak ostaje u svom
        // stupcu (Pending/In Progress) — samo je vizualno prigušen i nosi gumb „Nastavi".
        if (task.paused) card.classList.add('paused');
        const pausedBadge = task.paused ? '<span class="paused-badge">&#9208; PAUZA</span>' : '';
        const pauseBtnHTML = task.paused
          ? \`<button class="task-pause-btn resume" data-pause-id="\${task.id}" data-pause-to="0" title="Nastavi rad na zadatku">&#9654; Nastavi</button>\`
          : \`<button class="task-pause-btn" data-pause-id="\${task.id}" data-pause-to="1" title="Pauziraj zadatak (prekida i agenta koji radi)">&#9208;</button>\`;

        card.innerHTML = \`
          <div class="task-id">\${task.id}\${projectBadgeHTML}\${pausedBadge}</div>
          <div class="task-title">\${task.title}</div>
          \${progressHTML}
          <div class="task-meta">
            <span>\${task.assignee || 'Unassigned'}</span>
            <span class="priority-badge \${priorityClass}" data-task-id="\${task.id}">P\${task.priority}</span>
            \${pauseBtnHTML}
          </div>
        \`;

        container.appendChild(card);

        const pauseBtn = card.querySelector('.task-pause-btn');
        if (pauseBtn) {
          pauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();   // klik na gumb ne smije otvoriti detalje
            setTaskPaused(task.id, pauseBtn.dataset.pauseTo === '1');
          });
        }

        // Add click handler for task card (opens detail panel)
        card.addEventListener('click', (e) => {
          // If click was on priority badge or project badge, don't open detail panel
          if (e.target.closest('.priority-badge')) return;
          if (e.target.closest('.project-badge')) return;
          openTaskDetail(task.id);
        });

        // Add click handler for priority badge
        const badge = card.querySelector('.priority-badge');
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          showPriorityDropdown(badge, task.id);
        });

        // Add click handler for project badge
        const projectBadge = card.querySelector('.project-badge');
        if (projectBadge) {
          projectBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            const projectId = projectBadge.dataset.projectId;
            filterByProject(projectId);
          });
        }
      });

      Object.entries(containers).forEach(([status, container]) => {
        if (container.children.length === 0) {
          container.innerHTML = '<div class="empty">No tasks</div>';
        }
      });
    }

    function updateStats() {
      // REGOC_STATS_FIX (TASK-3091): zbroj kategorija MORA dati Total. Prije se prikazivalo
      // samo in_progress+pending+blocked+completed, a cancelled nigdje — pa je na ploci
      // nedostajala razlika (npr. 129 total, a 0+0+18+97=115). Sada se cancelled prikazuje.
      document.getElementById('total-count').textContent = tasks.length;
      const cancelledTasks = tasks.filter(t => t.status === 'cancelled');
      const cc = document.getElementById('cancelled-count');
      if (cc) cc.textContent = cancelledTasks.length;
      document.getElementById('progress-count').textContent = tasks.filter(t => t.status === 'in_progress').length;
      document.getElementById('pending-count').textContent = tasks.filter(t => t.status === 'pending').length;
      document.getElementById('blocked-count').textContent = tasks.filter(t => t.status === 'blocked').length;
      document.getElementById('completed-count').textContent = tasks.filter(t => t.status === 'completed').length;

      // REGOC_STATS_FIX (TASK-3091): postotak se racuna nad RELEVANTNIM poslom — otkazani
      // zadaci se ne broje ni u brojnik ni u nazivnik. Prije su ulazili kao 0 % i vukli
      // ukupni napredak dolje, iako otkazan zadatak nije nezavrsen posao nego posao kojeg
      // vise nema. Primjer: 97 gotovih / 129 ukupno = 75 %, a posteno je 97 / 115 = 84 %.
      const relevantTasks = tasks.filter(t => t.status !== 'cancelled');
      if (relevantTasks.length === 0) {
        document.getElementById('overall-progress').textContent = '0%';
      } else {
        const totalProgress = relevantTasks.reduce((sum, task) => {
          // Priority: Use progressPercent if explicitly set
          if (typeof task.progressPercent === 'number') {
            return sum + Math.min(Math.max(task.progressPercent, 0), 100);
          }
          // Fallback: Calculate based on status
          if (task.status === 'completed') return sum + 100;
          if (task.status === 'in_progress') {
            if (task.estimatedMinutes && task.actualMinutes) {
              return sum + Math.min(Math.round((task.actualMinutes / task.estimatedMinutes) * 100), 100);
            } else if (task.startedAt) {
              const hoursElapsed = (Date.now() - new Date(task.startedAt).getTime()) / (1000 * 60 * 60);
              return sum + Math.min(Math.round(hoursElapsed * 10), 90);
            } else {
              return sum + 25;
            }
          }
          return sum; // pending and blocked tasks with no progressPercent = 0
        }, 0);
        const overallProgress = Math.round(totalProgress / relevantTasks.length);
        document.getElementById('overall-progress').textContent = overallProgress + '%';
      }
    }

    function updateAgentFilter() {
      const agents = [...new Set(tasks.map(t => t.assignee).filter(Boolean))];
      const container = document.getElementById('agent-filter');
      container.innerHTML = '<button class="agent-btn active" data-agent="all">All Agents</button>';

      agents.forEach(agent => {
        const btn = document.createElement('button');
        btn.className = 'agent-btn' + (currentFilter === agent ? ' active' : '');
        btn.dataset.agent = agent;
        btn.textContent = agent;
        container.appendChild(btn);
      });

      container.querySelectorAll('.agent-btn').forEach(btn => {
        btn.onclick = () => {
          currentFilter = btn.dataset.agent;
          container.querySelectorAll('.agent-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderTasks();
        };
      });
    }

    // ============================================
    // PROJECT FILTER FUNCTIONS
    // ============================================

    async function fetchProjectsForFilter() {
      try {
        const response = await fetch('/api/projects');
        projectsCache = await response.json();
        updateProjectFilter();
        updateNewTaskProjectDropdown();
      } catch (err) {
        console.error('Failed to fetch projects for filter:', err);
      }
    }

    function updateProjectFilter() {
      const select = document.getElementById('tasks-project-filter');
      if (!select) return;

      // Preserve current selection
      const currentValue = select.value;

      select.innerHTML = '<option value="">All Projects</option>';
      projectsCache.forEach(project => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name;
        if (project.id === currentValue) {
          option.selected = true;
        }
        select.appendChild(option);
      });

      // Add change listener (only once)
      if (!select.dataset.listenerAdded) {
        select.addEventListener('change', () => {
          currentProjectFilter = select.value;
          fetchTasks();
        });
        select.dataset.listenerAdded = 'true';
      }
    }

    function updateNewTaskProjectDropdown() {
      const select = document.getElementById('new-task-project');
      if (!select) return;

      select.innerHTML = '<option value="">No Project</option>';
      projectsCache.forEach(project => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name;
        select.appendChild(option);
      });
    }

    function filterByProject(projectId) {
      currentProjectFilter = projectId;
      const select = document.getElementById('tasks-project-filter');
      if (select) {
        select.value = projectId;
      }
      fetchTasks();
    }

    // Priority Dropdown
    let currentDropdown = null;

    function showPriorityDropdown(badge, taskId) {
      // Close existing dropdown
      if (currentDropdown) {
        currentDropdown.remove();
        currentDropdown = null;
      }

      const dropdown = document.createElement('div');
      dropdown.className = 'priority-dropdown';
      dropdown.innerHTML = \`
        <div class="priority-option" data-priority="1">
          <span class="priority-dot red"></span>
          <span>P1 - High</span>
        </div>
        <div class="priority-option" data-priority="2">
          <span class="priority-dot yellow"></span>
          <span>P2 - Medium</span>
        </div>
        <div class="priority-option" data-priority="3">
          <span class="priority-dot blue"></span>
          <span>P3 - Low</span>
        </div>
        <div class="priority-option delete" data-action="delete">
          <span>Delete Task</span>
        </div>
      \`;

      badge.style.position = 'relative';
      badge.appendChild(dropdown);
      currentDropdown = dropdown;

      // Handle priority change
      dropdown.querySelectorAll('.priority-option').forEach(option => {
        option.addEventListener('click', async (e) => {
          e.stopPropagation();
          const priority = option.dataset.priority;
          const action = option.dataset.action;

          if (action === 'delete') {
            if (confirm('Are you sure you want to delete this task?')) {
              await deleteTask(taskId);
            }
          } else if (priority) {
            await updateTaskPriority(taskId, parseInt(priority));
          }

          dropdown.remove();
          currentDropdown = null;
        });
      });

      // Close on click outside
      setTimeout(() => {
        document.addEventListener('click', function closeDropdown() {
          if (currentDropdown) {
            currentDropdown.remove();
            currentDropdown = null;
          }
          document.removeEventListener('click', closeDropdown);
        });
      }, 0);
    }

    async function updateTaskPriority(taskId, newPriority) {
      try {
        console.log(\`[Priority Update] Task: \${taskId}, New Priority: \${newPriority}\`);

        const response = await fetch(\`/api/tasks/\${taskId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ priority: newPriority })
        });

        if (response.ok) {
          console.log(\`[Priority Update] Success for task \${taskId}\`);
          sendWSMessage({ action: 'update_priority', taskId, newPriority });
          fetchTasks();
        } else {
          console.error(\`[Priority Update] Failed with status: \${response.status}\`);
        }
      } catch (err) {
        console.error('[Priority Update] Error:', err);
      }
    }

    // ─── Ručna kočnica (TASK-3047) ────────────────────────────────────────────
    async function setTaskPaused(taskId, paused) {
      try {
        const res = await fetch(\`/api/tasks/\${taskId}/\${paused ? 'pause' : 'resume'}\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ by: 'goran' })
        });
        if (!res.ok) { console.error('[Pause] HTTP', res.status); return; }
        fetchTasks();
      } catch (err) {
        console.error('[Pause] Greška:', err);
      }
    }

    let globalPauseState = { paused: false };

    function renderGlobalPause(state) {
      globalPauseState = state || { paused: false };
      const btn = document.getElementById('global-pause-btn');
      const info = document.getElementById('global-pause-info');
      if (!btn) return;
      if (globalPauseState.paused) {
        btn.classList.add('paused');
        btn.innerHTML = '&#9654; Nastavi';
        btn.title = 'Rad je zaustavljen — klikni za nastavak';
        info.textContent = globalPauseState.description || 'SVE PAUZIRANO';
      } else {
        btn.classList.remove('paused');
        btn.innerHTML = '&#9208; Pauza';
        btn.title = 'Zaustavi sav automatski rad';
        info.textContent = '';
      }
    }

    async function fetchGlobalPause() {
      try {
        const res = await fetch('/api/pause');
        if (res.ok) renderGlobalPause(await res.json());
      } catch { /* traka stanja nije kritična */ }
    }

    async function toggleGlobalPause() {
      const next = !globalPauseState.paused;
      // Potvrda samo za zaustavljanje — „Nastavi" je bezopasno i mora biti jedan klik.
      if (next && !confirm('Zaustaviti SAV automatski rad?\\n\\nAuto-exec staje, a svi agenti koji trenutno rade bit će prekinuti. Zadaci ostaju gdje jesu i nastavljaju kad pritisneš „Nastavi".')) return;
      const reason = next ? (prompt('Razlog (nije obavezno):') || '') : '';
      try {
        const res = await fetch('/api/pause', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: next, by: 'goran', reason })
        });
        if (res.ok) renderGlobalPause(await res.json());
      } catch (err) {
        console.error('[Pause] Globalna kočnica pala:', err);
      }
    }

    async function deleteTask(taskId) {
      try {
        const response = await fetch(\`/api/tasks/\${taskId}\`, {
          method: 'DELETE'
        });

        if (response.ok) {
          sendWSMessage({ action: 'delete_task', taskId });
          fetchTasks();
        }
      } catch (err) {
        console.error('Failed to delete task:', err);
      }
    }

    // TASK-3047: kočnica se veže i osvježava odmah pri učitavanju — stanje pauze mora biti
    // vidljivo prije nego korisnik bilo što klikne.
    document.getElementById('global-pause-btn').addEventListener('click', toggleGlobalPause);
    fetchGlobalPause();
    setInterval(fetchGlobalPause, 15000);   // zaštita ako WS padne

    // Modal for creating tasks
    const modal = document.getElementById('modal-overlay');
    const addTaskBtn = document.getElementById('add-task-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const taskForm = document.getElementById('task-form');

    addTaskBtn.addEventListener('click', () => {
      modal.style.display = 'flex';
      document.getElementById('task-title').focus();
    });

    cancelBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      taskForm.reset();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
        taskForm.reset();
      }
    });

    taskForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const title = document.getElementById('task-title').value;
      const description = document.getElementById('task-description').value;
      const priority = parseInt(document.getElementById('task-priority').value);
      const assignee = document.getElementById('task-assignee').value;
      const projectId = document.getElementById('new-task-project').value;

      try {
        const response = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            description: description || undefined,
            priority,
            assignee: assignee || undefined,
            projectId: projectId || undefined
            // polje status je maknuto — POST ga ne poznaje (novi zadatak je ionako
            // pending), pa je samo punio log upozorenjem o ignoriranom polju (D6).
          })
        });

        if (response.ok) {
          const task = await response.json();
          sendWSMessage({ action: 'create_task', task });
          modal.style.display = 'none';
          taskForm.reset();
          fetchTasks();
        }
      } catch (err) {
        console.error('Failed to create task:', err);
        alert('Failed to create task. Please try again.');
      }
    });

    // ============================================
    // TASK DETAIL PANEL
    // ============================================

    let selectedTaskId = null;
    let selectedTaskData = null;
    let editedBlockedBy = [];
    let editedTags = [];

    // Panel elements
    const detailPanel = document.getElementById('detail-panel');
    const containerEl = document.querySelector('.container');

    // Open detail panel
    async function openTaskDetail(taskId) {
      try {
        const response = await fetch(\`/api/tasks/\${taskId}\`);
        if (!response.ok) throw new Error('Task not found');

        const task = await response.json();
        selectedTaskId = taskId;
        selectedTaskData = task;
        editedBlockedBy = [...(task.blockedBy || [])];
        editedTags = [...(task.tags || [])];

        renderDetailPanel(task);
        detailPanel.classList.add('open');
        containerEl.classList.add('panel-open');
      } catch (err) {
        console.error('Failed to load task:', err);
        alert('Failed to load task details');
      }
    }

    // Close detail panel
    function closeDetailPanel() {
      detailPanel.classList.remove('open');
      containerEl.classList.remove('panel-open');
      selectedTaskId = null;
      selectedTaskData = null;
    }

    // Render task details in panel
    function renderDetailPanel(task) {
      document.getElementById('detail-task-id').textContent = task.id;
      document.getElementById('detail-title').value = task.title;
      document.getElementById('detail-status').value = task.status;
      document.getElementById('detail-priority').value = task.priority;
      document.getElementById('detail-assignee').value = task.assignee || '';
      document.getElementById('detail-description').value = task.description || '';
      document.getElementById('detail-blocked-reason').value = task.blockedReason || '';

      // Render blocked by list
      renderBlockedByList();

      // Populate blocked by select with available tasks
      populateBlockedBySelect();

      // Render tags
      renderTagsList();

      // Render progress notes
      renderProgressNotes(task.progressNotes || []);

      // Render result summary (agentov odgovor apendan prije zatvaranja) — linkovi klikabilni (dokumenti)
      var rsField = document.getElementById('detail-result-field');
      var rsBox = document.getElementById('detail-result-summary');
      var rs = task.resultSummary || '';
      if (rs && rsBox && rsField) {
        var esc = rs.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var out = esc.split(' ').map(function(tok){
          if (tok.indexOf('http')===0) return '<a href="'+tok+'" target="_blank" rel="noopener">'+tok+'</a>';
          if (tok.charAt(0)==='/' || tok.substring(0,2)==='~/') return '<a href="/api/files/download?path='+encodeURIComponent(tok)+'" target="_blank" rel="noopener">'+tok+'</a>';
          return tok;
        }).join(' ');
        rsBox.innerHTML = out;
        rsField.style.display = '';
      } else if (rsField) {
        rsField.style.display = 'none';
      }

      // Render timestamps
      renderTimestamps(task);
    }

    // Render blocked by list
    function renderBlockedByList() {
      const list = document.getElementById('detail-blocked-by-list');
      list.innerHTML = editedBlockedBy.map(taskId => \`
        <div class="blocked-by-item">
          <span>\${taskId}</span>
          <span class="tag-remove" onclick="removeBlockedBy('\${taskId}')">&times;</span>
        </div>
      \`).join('');
    }

    // Populate blocked by select
    function populateBlockedBySelect() {
      const select = document.getElementById('detail-blocked-by-select');
      const availableTasks = tasks.filter(t =>
        t.id !== selectedTaskId &&
        !editedBlockedBy.includes(t.id) &&
        t.status !== 'completed'
      );

      select.innerHTML = '<option value="">+ Add blocking task...</option>' +
        availableTasks.map(t => \`<option value="\${t.id}">\${t.id} - \${t.title.substring(0, 30)}</option>\`).join('');
    }

    // Add blocked by
    document.getElementById('detail-blocked-by-select').addEventListener('change', (e) => {
      if (e.target.value) {
        editedBlockedBy.push(e.target.value);
        renderBlockedByList();
        populateBlockedBySelect();
        e.target.value = '';
      }
    });

    // Remove blocked by
    function removeBlockedBy(taskId) {
      editedBlockedBy = editedBlockedBy.filter(id => id !== taskId);
      renderBlockedByList();
      populateBlockedBySelect();
    }

    // Render tags
    function renderTagsList() {
      const tagsContainer = document.getElementById('detail-tags');
      tagsContainer.innerHTML = editedTags.map(tag => \`
        <span class="tag">
          \${tag}
          <span class="tag-remove" onclick="removeTag('\${tag}')">&times;</span>
        </span>
      \`).join('');
    }

    // Add tag
    document.getElementById('detail-tag-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        let tag = e.target.value.trim();
        if (tag && !tag.startsWith('#')) tag = '#' + tag;
        if (tag && !editedTags.includes(tag)) {
          editedTags.push(tag);
          renderTagsList();
        }
        e.target.value = '';
      }
    });

    // Remove tag
    function removeTag(tag) {
      editedTags = editedTags.filter(t => t !== tag);
      renderTagsList();
    }

    // Render progress notes
    function renderProgressNotes(notes) {
      const notesContainer = document.getElementById('detail-progress-notes');
      if (!notes || notes.length === 0) {
        notesContainer.innerHTML = '<div class="empty">No progress notes</div>';
        return;
      }

      notesContainer.innerHTML = notes.map(note => {
        const date = new Date(note.timestamp);
        return \`
          <div class="progress-note">
            <div class="progress-note-meta">
              \${date.toLocaleDateString()} \${date.toLocaleTimeString()} - \${note.agent || 'unknown'}
            </div>
            <div>\${note.note}</div>
          </div>
        \`;
      }).join('');
    }

    // Render timestamps
    function renderTimestamps(task) {
      const timestampsContainer = document.getElementById('detail-timestamps');
      const format = (d) => d ? new Date(d).toLocaleString() : '-';

      timestampsContainer.innerHTML = \`
        <div><strong>Created:</strong> \${format(task.createdAt)} by \${task.createdBy || 'unknown'}</div>
        <div><strong>Updated:</strong> \${format(task.updatedAt)}</div>
        \${task.startedAt ? \`<div><strong>Started:</strong> \${format(task.startedAt)}</div>\` : ''}
        \${task.completedAt ? \`<div><strong>Completed:</strong> \${format(task.completedAt)}</div>\` : ''}
      \`;
    }

    // Add progress note
    document.getElementById('add-note-btn').addEventListener('click', async () => {
      const input = document.getElementById('detail-new-note');
      const note = input.value.trim();
      if (!note || !selectedTaskId) return;

      try {
        const response = await fetch(\`/api/tasks/\${selectedTaskId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            progressNotes: [note]
          })
        });

        if (response.ok) {
          input.value = '';
          // Refresh task
          openTaskDetail(selectedTaskId);
        }
      } catch (err) {
        console.error('Failed to add note:', err);
      }
    });

    // Save task changes
    document.getElementById('save-task-btn').addEventListener('click', async () => {
      if (!selectedTaskId) return;

      const updates = {
        title: document.getElementById('detail-title').value,
        status: document.getElementById('detail-status').value,
        priority: parseInt(document.getElementById('detail-priority').value),
        assignee: document.getElementById('detail-assignee').value || undefined,
        description: document.getElementById('detail-description').value,
        blockedBy: editedBlockedBy,
        blockedReason: document.getElementById('detail-blocked-reason').value || undefined,
        tags: editedTags,
        // CompletionGuard (TASK-2954): ovaj PUT dolazi od ČOVJEKA s ploče. Guard čuva
        // od agenata koji zatvaraju neizvršeno; ručna odluka je mjerodavna i loga se.
        force: true
      };

      try {
        const response = await fetch(\`/api/tasks/\${selectedTaskId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
        });

        if (response.ok) {
          sendWSMessage({ action: 'task_updated', taskId: selectedTaskId });
          fetchTasks();
          closeDetailPanel();
        } else {
          const error = await response.json();
          alert('Failed to save: ' + (error.error || 'Unknown error'));
        }
      } catch (err) {
        console.error('Failed to save task:', err);
        alert('Failed to save task');
      }
    });

    // Delete task from detail panel
    document.getElementById('delete-task-btn').addEventListener('click', async () => {
      if (!selectedTaskId) return;
      if (!confirm(\`Are you sure you want to delete \${selectedTaskId}?\`)) return;

      try {
        const response = await fetch(\`/api/tasks/\${selectedTaskId}\`, {
          method: 'DELETE'
        });

        if (response.ok) {
          sendWSMessage({ action: 'task_deleted', taskId: selectedTaskId });
          closeDetailPanel();
          fetchTasks();
        }
      } catch (err) {
        console.error('Failed to delete task:', err);
        alert('Failed to delete task');
      }
    });

    // Cancel edit
    document.getElementById('cancel-edit-btn').addEventListener('click', closeDetailPanel);

    // Close button
    document.getElementById('close-detail-btn').addEventListener('click', closeDetailPanel);

    // ESC key closes panel
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (detailPanel.classList.contains('open')) {
          closeDetailPanel();
        }
        if (projectDetailPanel.classList.contains('open')) {
          closeProjectDetailPanel();
        }
        if (ragModalOverlay.style.display !== 'none') {
          closeRAGModal();
        }
      }
    });

    // ============================================
    // TAB NAVIGATION
    // ============================================

    let currentTab = 'tasks';

    function initTabNavigation() {
      const tabBtns = document.querySelectorAll('.tab-btn');
      const tabContents = document.querySelectorAll('.tab-content');

      tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const tabId = btn.dataset.tab;
          switchTab(tabId);
        });
      });
    }

    function switchTab(tabId) {
      currentTab = tabId;

      // Update tab buttons
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
      });

      // Update tab content
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === 'tab-' + tabId);
      });

      // Load data for the tab
      if (tabId === 'projects') {
        fetchProjects();
      } else if (tabId === 'rag') {
        initRAGPage();
      } else if (tabId === 'konzola') {
        initKonzola();
      } else if (tabId === 'status') {
        initStatus();
      } else if (tabId === 'info') {
        initInfo();
      }

      // Stop intervals for inactive tabs
      if (tabId !== 'konzola' && konzolaStatusInterval) { clearInterval(konzolaStatusInterval); konzolaStatusInterval = null; }
      if (tabId !== 'konzola' && sessionUsageInterval) { clearInterval(sessionUsageInterval); sessionUsageInterval = null; }
      if (tabId !== 'status' && statusRefreshInterval) { clearInterval(statusRefreshInterval); statusRefreshInterval = null; }

      // Update add button visibility
      const addTaskBtn = document.getElementById('add-task-btn');
      addTaskBtn.style.display = tabId === 'tasks' ? 'flex' : 'none';
    }

    // ============================================
    // PROJECTS FUNCTIONALITY
    // ============================================

    let projects = [];
    let projectsFilter = 'all';
    let selectedProjectId = null;
    let selectedProjectData = null;
    let projectAgents = [];

    const projectDetailPanel = document.getElementById('project-detail-panel');
    const projectModal = document.getElementById('project-modal-overlay');
    const projectForm = document.getElementById('project-form');

    async function fetchProjects() {
      try {
        const response = await fetch('/api/projects');
        projects = await response.json();
        renderProjects();
        updateProjectsAgentFilter();
      } catch (err) {
        console.error('Failed to fetch projects:', err);
      }
    }

    function renderProjects() {
      const filtered = projectsFilter === 'all' ? projects : projects.filter(p => p.lead_agent === projectsFilter);

      const containers = {
        'active': document.getElementById('active-projects'),
        'on_hold': document.getElementById('on-hold-projects'),
        'completed': document.getElementById('completed-projects'),
        'archived': document.getElementById('archived-projects')
      };

      Object.values(containers).forEach(c => c.innerHTML = '');

      filtered.forEach(project => {
        const container = containers[project.status];
        if (!container) return;

        const card = document.createElement('div');
        card.className = 'project-card p' + project.priority;

        card.innerHTML = \`
          <div class="project-id">\${project.id}</div>
          <div class="project-name">\${project.name}</div>
          <div class="project-meta">
            <span>\${project.lead_agent || 'No Lead'}</span>
            <span>P\${project.priority}</span>
          </div>
        \`;

        container.appendChild(card);

        card.addEventListener('click', () => {
          openProjectDetail(project.id);
        });
      });

      Object.entries(containers).forEach(([status, container]) => {
        if (container.children.length === 0) {
          container.innerHTML = '<div class="empty">No projects</div>';
        }
      });
    }

    function updateProjectsAgentFilter() {
      const agents = [...new Set(projects.map(p => p.lead_agent).filter(Boolean))];
      const container = document.getElementById('projects-agent-filter');
      container.innerHTML = '<button class="agent-btn active" data-agent="all">All Agents</button>';

      agents.forEach(agent => {
        const btn = document.createElement('button');
        btn.className = 'agent-btn' + (projectsFilter === agent ? ' active' : '');
        btn.dataset.agent = agent;
        btn.textContent = agent;
        container.appendChild(btn);
      });

      container.querySelectorAll('.agent-btn').forEach(btn => {
        btn.onclick = () => {
          projectsFilter = btn.dataset.agent;
          container.querySelectorAll('.agent-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderProjects();
        };
      });
    }

    // Project Create/Edit Modal
    document.getElementById('add-project-btn').addEventListener('click', () => {
      document.getElementById('project-modal-title').textContent = 'Create New Project';
      document.getElementById('project-submit-btn').textContent = 'Create Project';
      document.getElementById('project-edit-id').value = '';
      projectForm.reset();
      projectModal.style.display = 'flex';
      document.getElementById('project-name').focus();
    });

    document.getElementById('project-cancel-btn').addEventListener('click', () => {
      projectModal.style.display = 'none';
      projectForm.reset();
    });

    projectModal.addEventListener('click', (e) => {
      if (e.target === projectModal) {
        projectModal.style.display = 'none';
        projectForm.reset();
      }
    });

    projectForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const editId = document.getElementById('project-edit-id').value;
      const isEdit = !!editId;

      const data = {
        name: document.getElementById('project-name').value,
        description: document.getElementById('project-description').value || undefined,
        status: document.getElementById('project-status').value,
        priority: parseInt(document.getElementById('project-priority').value),
        lead_agent: document.getElementById('project-lead').value || undefined
      };

      try {
        const url = isEdit ? \`/api/projects/\${editId}\` : '/api/projects';
        const method = isEdit ? 'PUT' : 'POST';

        const response = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });

        if (response.ok) {
          projectModal.style.display = 'none';
          projectForm.reset();
          fetchProjects();
        } else {
          const error = await response.json();
          alert('Failed: ' + (error.error || 'Unknown error'));
        }
      } catch (err) {
        console.error('Failed to save project:', err);
        alert('Failed to save project');
      }
    });

    // Project Detail Panel
    async function openProjectDetail(projectId) {
      try {
        const response = await fetch(\`/api/projects/\${projectId}\`);
        if (!response.ok) throw new Error('Project not found');

        const project = await response.json();
        selectedProjectId = projectId;
        selectedProjectData = project;
        projectAgents = project.agents || [];

        renderProjectDetailPanel(project);
        projectDetailPanel.classList.add('open');
      } catch (err) {
        console.error('Failed to load project:', err);
        alert('Failed to load project details');
      }
    }

    function closeProjectDetailPanel() {
      projectDetailPanel.classList.remove('open');
      selectedProjectId = null;
      selectedProjectData = null;
      projectAgents = [];
    }

    function renderProjectDetailPanel(project) {
      document.getElementById('project-detail-id').textContent = project.id;
      document.getElementById('project-detail-name').value = project.name;
      document.getElementById('project-detail-status').value = project.status;
      document.getElementById('project-detail-priority').value = project.priority;
      document.getElementById('project-detail-lead').value = project.lead_agent || '';
      document.getElementById('project-detail-description').value = project.description || '';
      // Spec u <textarea>.value (sigurno — bez innerHTML, nema XSS rizika)
      document.getElementById('project-detail-spec').value = project.specification || '';
      // Napuni dropdown agenata + osvježi disabled stanje dispatch gumba
      loadSpecUpgradeAgents();
      updateSpecUpgradeBtnState();

      // Render agents
      renderProjectAgents();

      // Render tasks
      renderProjectTasks(project.tasks || []);

      // Render timestamps
      const timestampsContainer = document.getElementById('project-detail-timestamps');
      const format = (d) => d ? new Date(d).toLocaleString() : '-';
      timestampsContainer.innerHTML = \`
        <div><strong>Created:</strong> \${format(project.created_at)}</div>
        <div><strong>Updated:</strong> \${format(project.updated_at)}</div>
        \${project.target_date ? \`<div><strong>Target:</strong> \${format(project.target_date)}</div>\` : ''}
      \`;
    }

    function renderProjectAgents() {
      const container = document.getElementById('project-detail-agents');
      if (!projectAgents || projectAgents.length === 0) {
        container.innerHTML = '<div class="empty" style="padding: 0.5rem;">No agents assigned</div>';
        return;
      }

      container.innerHTML = projectAgents.map(agent => \`
        <div class="agent-item">
          <span>\${agent.agent_id}</span>
          <span class="remove-agent" data-agent="\${agent.agent_id}">&times;</span>
        </div>
      \`).join('');

      container.querySelectorAll('.remove-agent').forEach(btn => {
        btn.addEventListener('click', () => removeProjectAgent(btn.dataset.agent));
      });
    }

    function renderProjectTasks(tasks) {
      const container = document.getElementById('project-detail-tasks');
      if (!tasks || tasks.length === 0) {
        container.innerHTML = '<div class="empty">No tasks linked</div>';
        return;
      }

      container.innerHTML = tasks.map(task => \`
        <div class="task-list-item">
          <span>\${task.id} - \${task.title}</span>
          <span class="task-status \${task.status}">\${task.status}</span>
        </div>
      \`).join('');
    }

    // Add agent to project
    document.getElementById('project-add-agent-select').addEventListener('change', async (e) => {
      if (!e.target.value || !selectedProjectId) return;

      const agentId = e.target.value;
      e.target.value = '';

      // Check if already added
      if (projectAgents.some(a => a.agent_id === agentId)) {
        alert('Agent already on project');
        return;
      }

      try {
        const response = await fetch(\`/api/projects/\${selectedProjectId}/agents\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agentId, role: 'member' })
        });

        if (response.ok) {
          projectAgents.push({ agent_id: agentId, role: 'member' });
          renderProjectAgents();
        } else {
          const error = await response.json();
          alert('Failed: ' + (error.error || 'Unknown error'));
        }
      } catch (err) {
        console.error('Failed to add agent:', err);
      }
    });

    async function removeProjectAgent(agentId) {
      if (!selectedProjectId) return;

      try {
        const response = await fetch(\`/api/projects/\${selectedProjectId}/agents/\${agentId}\`, {
          method: 'DELETE'
        });

        if (response.ok) {
          projectAgents = projectAgents.filter(a => a.agent_id !== agentId);
          renderProjectAgents();
        }
      } catch (err) {
        console.error('Failed to remove agent:', err);
      }
    }

    // Save project changes
    document.getElementById('save-project-btn').addEventListener('click', async () => {
      if (!selectedProjectId) return;

      const updates = {
        name: document.getElementById('project-detail-name').value,
        status: document.getElementById('project-detail-status').value,
        priority: parseInt(document.getElementById('project-detail-priority').value),
        lead_agent: document.getElementById('project-detail-lead').value || undefined,
        description: document.getElementById('project-detail-description').value,
        specification: document.getElementById('project-detail-spec').value
      };

      try {
        const response = await fetch(\`/api/projects/\${selectedProjectId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
        });

        if (response.ok) {
          fetchProjects();
          closeProjectDetailPanel();
        } else {
          const error = await response.json();
          alert('Failed to save: ' + (error.error || 'Unknown error'));
        }
      } catch (err) {
        console.error('Failed to save project:', err);
        alert('Failed to save project');
      }
    });

    // ============================================
    // SPEC DISPATCH-UPGRADE (frontend)
    // ============================================

    // Napuni dropdown agenata iz /api/agents s oznakom [PERMANENT]/[spawn] po persistent.
    // Prikazuje SVE agente koje API vrati (uklj. emard ako ga vrati). BEZ preselekcije.
    async function loadSpecUpgradeAgents() {
      const sel = document.getElementById('spec-upgrade-agent');
      if (!sel) return;
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        const agents = (data.agents || []);
        sel.innerHTML = '<option value="">Odaberi agenta...</option>';
        agents.forEach(a => {
          const opt = document.createElement('option');  // textContent → bez XSS
          opt.value = a.id;
          opt.textContent = \`\${a.name || a.id} — \${a.persistent ? '[PERMANENT]' : '[spawn]'}\`;
          sel.appendChild(opt);
        });
      } catch (err) {
        console.error('Failed to load agents for spec-upgrade:', err);
      }
    }

    // Gumb disabled dok je spec prazna ILI agent nije odabran (R1/R8 — dispatch-in-flight zasebno).
    function updateSpecUpgradeBtnState() {
      const btn = document.getElementById('spec-upgrade-btn');
      if (!btn || btn.dataset.busy === '1') return;
      const spec = (document.getElementById('project-detail-spec').value || '').trim();
      const agent = document.getElementById('spec-upgrade-agent').value;
      btn.disabled = !spec || !agent;
    }

    document.getElementById('project-detail-spec').addEventListener('input', updateSpecUpgradeBtnState);
    document.getElementById('spec-upgrade-agent').addEventListener('change', updateSpecUpgradeBtnState);

    // Dispatch: confirm → POST → toast → refresh. Gumb busy dok traje request (R8 double-dispatch).
    document.getElementById('spec-upgrade-btn').addEventListener('click', async () => {
      if (!selectedProjectId) return;
      const agent = document.getElementById('spec-upgrade-agent').value;
      const spec = (document.getElementById('project-detail-spec').value || '').trim();
      if (!agent || !spec) return;
      if (!confirm(\`Poslati projekt \${selectedProjectId} agentu "\${agent}" na nadogradnju po specifikacijama?\\n\\nSpec se snima i task se kreira (in_progress).\`)) return;

      const btn = document.getElementById('spec-upgrade-btn');
      btn.dataset.busy = '1';
      btn.disabled = true;
      const origLabel = btn.textContent;
      btn.textContent = '⟳ Šaljem...';
      try {
        // Prvo spremi aktualnu spec (da dispatch koristi zadnji upisani tekst)
        await fetch(\`/api/projects/\${selectedProjectId}\`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specification: spec })
        });
        const res = await fetch(\`/api/projects/\${selectedProjectId}/dispatch-upgrade\`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent })
        });
        const data = await res.json();
        if (res.ok) {
          if (data.messageId === null) {
            alert(\`Task \${data.taskId} kreiran, ali poruka nije poslana: \${data.warning || ''}\`);
          } else {
            alert(\`✓ Dispatch poslan agentu \${agent}. Task: \${data.taskId}\`);
          }
          openProjectDetail(selectedProjectId);  // refresh
        } else {
          alert('Dispatch nije uspio: ' + (data.error || res.status));
        }
      } catch (err) {
        console.error('dispatch-upgrade failed:', err);
        alert('Dispatch nije uspio (mreža).');
      } finally {
        btn.dataset.busy = '';
        btn.textContent = origLabel;
        updateSpecUpgradeBtnState();
      }
    });

    // Template editor (toggle + load + save) — GET/PUT /api/templates/spec-upgrade
    document.getElementById('spec-template-toggle').addEventListener('click', async (e) => {
      e.preventDefault();
      const ed = document.getElementById('spec-template-editor');
      const toggle = document.getElementById('spec-template-toggle');
      if (ed.style.display === 'none') {
        ed.style.display = 'block';
        toggle.textContent = '▾ Template poruke';
        try {
          const res = await fetch('/api/templates/spec-upgrade');
          if (res.ok) {
            const data = await res.json();
            document.getElementById('spec-template-content').value = data.content || '';
          }
        } catch (err) { console.error('load template failed:', err); }
      } else {
        ed.style.display = 'none';
        toggle.textContent = '▸ Template poruke';
      }
    });

    document.getElementById('spec-template-save-btn').addEventListener('click', async () => {
      const content = document.getElementById('spec-template-content').value;
      try {
        const res = await fetch('/api/templates/spec-upgrade', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
        alert(res.ok ? '✓ Template spremljen.' : 'Spremanje template-a nije uspjelo.');
      } catch (err) {
        console.error('save template failed:', err);
        alert('Spremanje template-a nije uspjelo.');
      }
    });

    // Delete project
    document.getElementById('delete-project-btn').addEventListener('click', async () => {
      if (!selectedProjectId) return;
      if (!confirm(\`Are you sure you want to delete \${selectedProjectId}?\`)) return;

      try {
        const response = await fetch(\`/api/projects/\${selectedProjectId}\`, {
          method: 'DELETE'
        });

        if (response.ok) {
          closeProjectDetailPanel();
          fetchProjects();
        }
      } catch (err) {
        console.error('Failed to delete project:', err);
        alert('Failed to delete project');
      }
    });

    // Cancel and close buttons
    document.getElementById('cancel-project-edit-btn').addEventListener('click', closeProjectDetailPanel);
    document.getElementById('close-project-detail-btn').addEventListener('click', closeProjectDetailPanel);

    // ============================================
    // RAG FUNCTIONALITY
    // ============================================

    let ragEntries = [];
    let ragCollections = [];
    let ragFilter = '';
    let ragOffset = 0;
    const RAG_LIMIT = 50;
    let ragTotal = 0;
    let currentRAGEntry = null;

    const ragModalOverlay = document.getElementById('rag-modal-overlay');

    async function initRAGPage() {
      await fetchRAGCollections();
      ragOffset = 0;
      ragEntries = [];
      await fetchRAGEntries();
    }

    async function fetchRAGCollections() {
      try {
        const response = await fetch('/api/rag/collections');
        ragCollections = await response.json();

        const select = document.getElementById('rag-collection-filter');
        select.innerHTML = '<option value="">All Collections</option>' +
          ragCollections.map(c => \`<option value="\${c.name}">\${c.name} (\${c.count})</option>\`).join('');
      } catch (err) {
        console.error('Failed to fetch RAG collections:', err);
      }
    }

    async function fetchRAGEntries(append = false) {
      try {
        const params = new URLSearchParams({
          limit: RAG_LIMIT.toString(),
          offset: ragOffset.toString()
        });

        if (ragFilter) {
          params.append('collection', ragFilter);
        }

        // Add search parameter for server-side filtering
        if (ragSearchQuery) {
          params.append('search', ragSearchQuery);
        }

        const response = await fetch(\`/api/rag/entries?\${params}\`);
        const result = await response.json();

        if (append) {
          ragEntries = [...ragEntries, ...result.entries];
        } else {
          ragEntries = result.entries;
        }

        ragTotal = result.total;
        renderRAGEntries();
        updateRAGCount();
        updateLoadMoreButton();
      } catch (err) {
        console.error('Failed to fetch RAG entries:', err);
        document.getElementById('rag-list').innerHTML = '<div class="empty">Failed to load RAG entries</div>';
      }
    }

    function renderRAGEntries() {
      const container = document.getElementById('rag-list');

      if (ragEntries.length === 0) {
        container.innerHTML = '<div class="empty">No RAG entries found</div>';
        return;
      }

      container.innerHTML = ragEntries.map(entry => \`
        <div class="rag-entry" data-id="\${entry.id}" data-collection="\${entry.collection}">
          <div class="rag-entry-main">
            <div class="rag-entry-header">
              <span class="rag-entry-id">\${entry.id.substring(0, 12)}...</span>
              <span class="rag-entry-collection">\${entry.collection}</span>
              <span class="rag-entry-type">\${entry.type || 'unknown'}</span>
              <span class="rag-entry-date">\${new Date(entry.stored_at).toLocaleDateString()}</span>
            </div>
            <div class="rag-entry-preview">\${(entry.content || entry.document || '').substring(0, 150)}...</div>
          </div>
          <div class="rag-entry-actions">
            <button class="rag-delete-btn" data-id="\${entry.id}" data-collection="\${entry.collection}">Delete</button>
          </div>
        </div>
      \`).join('');

      // Add click handlers
      container.querySelectorAll('.rag-entry').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('.rag-delete-btn')) return;
          openRAGModal(el.dataset.id, el.dataset.collection);
        });
      });

      container.querySelectorAll('.rag-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteRAGEntry(btn.dataset.id, btn.dataset.collection);
        });
      });

      // Apply search filter to newly rendered entries
      if (ragSearchQuery) {
        filterRAGEntries();
      }
    }

    function updateRAGCount() {
      document.getElementById('rag-total-count').textContent = \`\${ragEntries.length} of \${ragTotal} entries\`;
    }

    function updateLoadMoreButton() {
      const btn = document.getElementById('rag-load-more');
      btn.style.display = ragEntries.length < ragTotal ? 'block' : 'none';
      btn.textContent = \`Load More (\${ragTotal - ragEntries.length} remaining)\`;
    }

    // Collection filter
    document.getElementById('rag-collection-filter').addEventListener('change', (e) => {
      ragFilter = e.target.value;
      ragOffset = 0;
      ragEntries = [];
      fetchRAGEntries();
    });

    // RAG Search filter with debounce for server-side search
    let ragSearchQuery = '';
    let ragSearchDebounce = null;
    document.getElementById('rag-search-input').addEventListener('keyup', (e) => {
      ragSearchQuery = e.target.value;

      // Clear previous debounce
      if (ragSearchDebounce) clearTimeout(ragSearchDebounce);

      // Immediate client-side filter for responsiveness
      filterRAGEntries();

      // Debounced server-side search for full results
      ragSearchDebounce = setTimeout(() => {
        ragOffset = 0;
        ragEntries = [];
        fetchRAGEntries();
      }, 400);
    });

    function filterRAGEntries() {
      const container = document.getElementById('rag-list');
      const entries = container.querySelectorAll('.rag-entry');
      let visibleCount = 0;

      entries.forEach(entry => {
        const id = entry.querySelector('.rag-entry-id')?.textContent || '';
        const collection = entry.querySelector('.rag-entry-collection')?.textContent || '';
        const type = entry.querySelector('.rag-entry-type')?.textContent || '';
        const preview = entry.querySelector('.rag-entry-preview')?.textContent || '';

        const searchText = (id + ' ' + collection + ' ' + type + ' ' + preview).toLowerCase();
        const isMatch = !ragSearchQuery || searchText.includes(ragSearchQuery.toLowerCase());

        entry.style.display = isMatch ? '' : 'none';
        if (isMatch) visibleCount++;
      });

      if (visibleCount === 0 && ragEntries.length > 0) {
        container.innerHTML += '<div class="empty" style="grid-column: 1/-1;">No RAG entries match your search</div>';
      }
    }

    // Load more
    document.getElementById('rag-load-more').addEventListener('click', () => {
      ragOffset += RAG_LIMIT;
      fetchRAGEntries(true);
    });

    // RAG Modal
    async function openRAGModal(id, collection) {
      try {
        const response = await fetch(\`/api/rag/entries/\${encodeURIComponent(collection)}/\${encodeURIComponent(id)}\`);
        if (!response.ok) throw new Error('Entry not found');

        const entry = await response.json();
        currentRAGEntry = { id, collection };

        document.getElementById('rag-modal-id').textContent = entry.id;
        document.getElementById('rag-modal-collection').textContent = entry.collection;
        document.getElementById('rag-modal-type').textContent = entry.type || 'unknown';
        document.getElementById('rag-modal-date').textContent = new Date(entry.stored_at).toLocaleString();
        document.getElementById('rag-modal-content').textContent = entry.content || entry.document || JSON.stringify(entry.metadata, null, 2);

        ragModalOverlay.style.display = 'flex';
      } catch (err) {
        console.error('Failed to load RAG entry:', err);
        alert('Failed to load entry details');
      }
    }

    function closeRAGModal() {
      ragModalOverlay.style.display = 'none';
      currentRAGEntry = null;
    }

    document.getElementById('close-rag-modal-btn').addEventListener('click', closeRAGModal);
    document.getElementById('rag-modal-close-btn').addEventListener('click', closeRAGModal);

    ragModalOverlay.addEventListener('click', (e) => {
      if (e.target === ragModalOverlay) {
        closeRAGModal();
      }
    });

    // Delete from modal
    document.getElementById('rag-modal-delete-btn').addEventListener('click', async () => {
      if (!currentRAGEntry) return;
      if (!confirm('Are you sure you want to delete this entry? This is permanent!')) return;

      await deleteRAGEntry(currentRAGEntry.id, currentRAGEntry.collection);
      closeRAGModal();
    });

    async function deleteRAGEntry(id, collection) {
      if (!confirm('Are you sure you want to delete this RAG entry? This is permanent!')) return;

      try {
        const response = await fetch('/api/rag/entries', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entries: [{ id, collection }]
          })
        });

        if (response.ok) {
          // Remove from local array and re-render
          ragEntries = ragEntries.filter(e => !(e.id === id && e.collection === collection));
          ragTotal--;
          renderRAGEntries();
          updateRAGCount();
          updateLoadMoreButton();
        } else {
          const error = await response.json();
          alert('Failed to delete: ' + (error.error || 'Unknown error'));
        }
      } catch (err) {
        console.error('Failed to delete RAG entry:', err);
        alert('Failed to delete entry');
      }
    }

    // ============================================
    // KONZOLA FUNCTIONALITY
    // ============================================

    let konzolaMode = 'plan';
    let konzolaStatusInterval = null;
    let konzolaCommandHistory = [];
    let konzolaHistoryIndex = -1;
    const KONZOLA_MAX_LINES = 5000;

    function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    function formatUptime(s) {
      if (!s) return '--';
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
      return (h > 0 ? h + 'h ' : '') + m + 'm ' + sec + 's';
    }

    // ── Prikaz živosti daemona (TASK-2992) ───────────────────────────────────
    // Traka je do sada ispisivala sadržaj status datoteke doslovno, pa je mrtav daemon
    // satima izgledao kao da nešto radi. Stanje (online/stale/offline), starost zapisa,
    // PID i razlog računa POSLUŽITELJ (DaemonLiveness, TASK-2989/2991) — preglednikov sat
    // nije pouzdan pa se ovdje ništa ne izvodi iz vremena, samo prikazuje.
    // Odgovor bez polja 'state' (starije izdanje API-ja) prikazuje se kao i prije:
    // NB: ovaj blok živi unutar HTML template-literala — obrnuti navodnik ovdje
    // prekida string i ruši build (dogodilo se 28.07., TASK-2992).
    // radije ništa ne tvrdimo o živosti nego da izmislimo lažni OFFLINE.
    function fmtAgeShort(s) {
      if (s === null || s === undefined || !isFinite(s)) return '?';
      if (s < 60) return Math.round(s) + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    }

    function fmtClock(iso) {
      if (!iso) return null;
      const dt = new Date(iso);
      return isNaN(dt.getTime()) ? null : dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function firstNum() {
      for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (typeof v === 'number' && isFinite(v)) return v;
      }
      return null;
    }

    // Vraća sve što traka i nadzorna ploča trebaju za prikaz daemona.
    // Čista funkcija (bez DOM-a) — pokriva je tests/unit/DaemonStatusBar.test.ts.
    function buildDaemonView(d) {
      const dm = (d && d.daemon) || {};
      const lv = (d && d.liveness) || dm.liveness || {};
      const state = dm.state || lv.state || (d && d.state) || null;
      const ageS = firstNum(dm.ageS, lv.ageS, d && d.ageS);
      const statusAgeS = firstNum(dm.statusAgeS, lv.statusAgeS, d && d.statusAgeS);
      const pid = firstNum(dm.pid, lv.pid);
      const reason = dm.reason || lv.reason || '';
      const lastSeen = dm.lastSeen || lv.lastSeen || dm.lastUpdate || null;
      // Status iz same datoteke — kad je daemon mrtav, poslužitelj u polju 'display'
      // šalje 'OFFLINE', pa bi „zadnje: OFFLINE" bilo besmisleno.
      const fileStatus = (lv.status && typeof lv.status.status === 'string') ? lv.status.status : null;
      const shown = dm.display || (typeof dm.status === 'string' ? dm.status : null) || fileStatus || '--';
      const lastKnown = fileStatus
        || (typeof dm.status === 'string' && dm.status !== 'OFFLINE' ? dm.status : null)
        || 'nepoznato';
      const task = dm.currentTask || '--';

      const tip = [];
      if (reason) tip.push(reason);
      if (pid !== null) tip.push('PID ' + pid);
      if (ageS !== null) tip.push('zadnji zapis prije ' + fmtAgeShort(ageS));
      const title = tip.join(' · ');

      if (state === 'offline') {
        const clock = fmtClock(lastSeen);
        return {
          state: 'offline',
          statusText: 'OFFLINE',
          statusClass: ' s-error',
          uptimeText: '--',
          taskText: 'zadnje: ' + lastKnown + (clock ? ' u ' + clock : ' (vrijeme nepoznato)'),
          title: title || 'daemon ne odgovara'
        };
      }

      if (state === 'stale') {
        return {
          state: 'stale',
          statusText: shown + ' ⚠',
          statusClass: ' s-warn',
          uptimeText: formatUptime(dm.uptime),
          taskText: task + ' · zapis star ' + fmtAgeShort(ageS),
          title: title || 'zapis je zastario — daemon je živ, ali ne piše status'
        };
      }

      // online + legacy: trajanje trenutnog stanja razlikuje dugu obradu od zaglavljene
      const dur = (state === 'online' && statusAgeS !== null && statusAgeS >= 60)
        ? ' (' + fmtAgeShort(statusAgeS) + ')' : '';
      return {
        state: state || 'unknown',
        statusText: shown,
        statusClass: shown === 'Idle' ? '' : shown === 'Stopping' ? ' s-error' : ' s-warn',
        uptimeText: formatUptime(dm.uptime),
        taskText: task + dur,
        title: title
      };
    }

    async function fetchKonzolaStatus() {
      try {
        const r = await fetch('/api/konzola/status');
        const d = await r.json();
        const dv = buildDaemonView(d);
        const de = document.getElementById('konzola-daemon-status');
        de.textContent = dv.statusText;
        de.className = 'konzola-status-value' + dv.statusClass;
        de.title = dv.title;
        const up = document.getElementById('konzola-uptime');
        up.textContent = dv.uptimeText;
        up.title = dv.title;
        const ct = document.getElementById('konzola-current-task');
        ct.textContent = dv.taskText;
        // Task je odrezan na 200px, pa puni tekst (i razlog) mora biti u tooltipu.
        ct.title = dv.taskText + (dv.title ? ' — ' + dv.title : '');
        document.getElementById('konzola-pending').textContent = d.daemon.pendingMessages ?? '--';
        document.getElementById('konzola-processed').textContent = d.daemon.processedToday ?? '--';
        const cx = document.getElementById('konzola-context');
        cx.textContent = (d.daemon.contextPct || 0) + '%';
        cx.className = 'konzola-status-value' + (d.daemon.contextPct > 75 ? ' s-error' : d.daemon.contextPct > 50 ? ' s-warn' : '');
        const sv = d.services || {};
        const running = Object.values(sv).filter(s => s && (s.status === 'running' || s.status === 'ok')).length;
        const total = Object.keys(sv).length;
        const se = document.getElementById('konzola-services');
        se.textContent = running + '/' + total;
        se.className = 'konzola-status-value' + (running === total ? '' : running > total/2 ? ' s-warn' : ' s-error');
        // Read system-wide mode (not just console mode)
        konzolaMode = (d.daemon?.mode || d.mode || 'WORK').toLowerCase();
        updateModeButton();
      } catch(e) { console.error('Konzola status fetch failed:', e); }
    }

    // Potrošnja trenutne Claude sesije (5h) / tjedna (7d) — izvor session_usage cache.
    let _sessionUsageLast = 0;
    let sessionUsageInterval = null;
    async function fetchSessionUsage(force) {
      try {
        const r = await fetch('/api/session-usage' + (force ? '?force=1' : ''));
        const d = await r.json();
        const el = document.getElementById('konzola-session');
        if (!el) return;
        if (d.session_percent == null) { el.textContent = 'n/a'; el.className = 'konzola-status-value s-warn'; el.title = d.error || 'nedostupno'; return; }
        const sp = Math.round(d.session_percent), wp = (d.weekly_percent == null ? null : Math.round(d.weekly_percent));
        el.textContent = sp + '%' + (wp != null ? ' · 7d ' + wp + '%' : '') + (d.stale ? ' ⚠' : '');
        el.className = 'konzola-status-value' + (sp >= 90 ? ' s-error' : sp >= 75 ? ' s-warn' : '');
        el.title = 'Sesija 5h: ' + sp + '% · Tjedan 7d: ' + (wp == null ? '?' : wp) + '%'
          + (d.session_reset_local ? ' · reset ' + d.session_reset_local : '')
          + (d.age_s != null ? ' · očitano prije ' + d.age_s + ' s' : '')
          + (d.stale ? ' · ZASTARJELO: ' + (d.error || 'osvježavanje ne uspijeva') : '');
      } catch(e) {}
    }
    // Na I/O u konzoli osvježi, ali najviše svakih 5 s (da ne spama pri brzom logu).
    // Server ima svoju branu (probe najviše jednom u 10 s), pa je force ovdje siguran.
    function fetchSessionUsageThrottled() {
      const now = Date.now();
      if (now - _sessionUsageLast < 5000) return;
      _sessionUsageLast = now; fetchSessionUsage(true);
    }

    function updateModeButton() {
      const btn = document.getElementById('konzola-mode-btn');
      const prompt = document.getElementById('konzola-prompt');
      if (konzolaMode === 'work') {
        btn.textContent = 'WORK'; btn.className = 'konzola-mode-btn work-mode';
        prompt.textContent = 'regoc #'; prompt.style.color = 'var(--accent-red)';
      } else {
        btn.textContent = 'PLAN'; btn.className = 'konzola-mode-btn plan-mode';
        prompt.textContent = 'regoc $'; prompt.style.color = 'var(--accent-green)';
      }
    }

    function appendToKonzolaLog(text, cssClass) {
      const output = document.getElementById('konzola-output');
      const line = document.createElement('div');
      const ts = new Date().toLocaleTimeString();
      line.innerHTML = '<span class="log-ts">[' + ts + ']</span> <span class="' + (cssClass || '') + '">' + escapeHtml(text) + '</span>';
      output.appendChild(line);
      while (output.children.length > KONZOLA_MAX_LINES) output.removeChild(output.firstChild);
      output.parentElement.scrollTop = output.parentElement.scrollHeight;
      fetchSessionUsageThrottled();  // osvježi potrošnju sesije na svaki I/O u konzoli
    }

    function handleBuiltinCommand(cmd) {
      if (cmd === 'help') {
        appendToKonzolaLog('Available commands:', 'log-info');
        appendToKonzolaLog('  help                    Show this help', 'log-system');
        appendToKonzolaLog('  status                  Refresh status line', 'log-system');
        appendToKonzolaLog('  verbose / info          Detailed system status', 'log-system');
        appendToKonzolaLog('  clear                   Clear console', 'log-system');
        appendToKonzolaLog('  mode [plan|work]        Switch mode', 'log-system');
        appendToKonzolaLog('  services [cmd]          Service management', 'log-system');
        appendToKonzolaLog('  logs [source] [lines]   Tail log (daemon|klaudio|voiceserver)', 'log-system');
        appendToKonzolaLog('  history                 Command history', 'log-system');
        appendToKonzolaLog('  ls, cat, head, tail     File reading', 'log-system');
        appendToKonzolaLog('  git status/log/diff     Git operations', 'log-system');
        appendToKonzolaLog('', '');
        appendToKonzolaLog('Live streams (auto):', 'log-info');
        appendToKonzolaLog('  🧠 Agent reasoning/thinking (session JSONL)', 'log-thinking');
        appendToKonzolaLog('  🔧 Tool calls (Read, Edit, Bash, Grep...)', 'log-info');
        appendToKonzolaLog('  💭 Agent text responses', 'log-text');
        appendToKonzolaLog('  📨 Message queue activity', 'log-info');
        appendToKonzolaLog('  📋 Event log audit trail', 'log-system');
        appendToKonzolaLog('  📊 Token usage per inference', 'log-system');
        appendToKonzolaLog('', '');
        appendToKonzolaLog('Natural language → REGOČ message queue:', 'log-info');
        appendToKonzolaLog('  Sve sto ne pocinje poznatom komandom salje se', 'log-system');
        appendToKonzolaLog('  kao poruka REGOČ-u (kao Telegram/terminal).', 'log-system');
        appendToKonzolaLog('  Prefix /cmd za forsiranje kao komandu.', 'log-system');
        return true;
      }
      if (cmd === 'clear') {
        document.getElementById('konzola-output').innerHTML = '<div class="konzola-welcome">Console cleared.</div>';
        return true;
      }
      if (cmd === 'status') { fetchKonzolaStatus(); appendToKonzolaLog('Status refreshed', 'log-info'); return true; }
      if (cmd === 'history') {
        konzolaCommandHistory.forEach((c, i) => appendToKonzolaLog('  ' + (i+1) + '  ' + c, 'log-system'));
        return true;
      }
      if (cmd.startsWith('mode ')) {
        const m = cmd.split(' ')[1];
        if (m === 'plan' || m === 'work') { toggleKonzolaMode(m); return true; }
      }
      if (cmd === 'logs' || cmd.startsWith('logs ')) {
        const parts = cmd.split(' ');
        const source = parts[1] || 'daemon';
        const n = parseInt(parts[2]) || 50;
        fetchLogs(source, n);
        return true;
      }
      if (cmd === 'verbose' || cmd === 'info') {
        fetchVerboseStatus();
        return true;
      }
      return false;
    }

    async function fetchLogs(source, lines) {
      try {
        appendToKonzolaLog('Fetching ' + lines + ' lines from ' + source + '...', 'log-info');
        const r = await fetch('/api/konzola/logs?source=' + source + '&lines=' + lines);
        const d = await r.json();
        if (d.error) { appendToKonzolaLog(d.error, 'log-error'); return; }
        (d.lines || []).forEach(l => appendToKonzolaLog(l, detectLogLevel(l)));
      } catch(e) { appendToKonzolaLog('Failed to fetch logs: ' + e.message, 'log-error'); }
    }

    function detectLogLevel(line) {
      if (!line) return '';
      if (line.includes('ERROR') || line.includes('FAILED')) return 'log-error';
      if (line.includes('WARN') || line.includes('⚠️')) return 'log-warn';
      if (line.includes('✅') || line.includes('success')) return 'log-success';
      if (line.includes('Processing') || line.includes('AI inference') || line.includes('📨')) return 'log-info';
      return '';
    }

    async function fetchVerboseStatus() {
      try {
        const r = await fetch('/api/konzola/status');
        const d = await r.json();
        appendToKonzolaLog('=== VERBOSE STATUS ===', 'log-info');
        appendToKonzolaLog('Daemon: ' + (d.daemon.status || '--') + ' | Uptime: ' + formatUptime(d.daemon.uptime), 'log-info');
        appendToKonzolaLog('Current Task: ' + (d.daemon.currentTask || 'None'), '');
        appendToKonzolaLog('Context: ' + (d.daemon.contextPct || 0) + '% | Pending: ' + (d.daemon.pendingMessages || 0) + ' | Processed: ' + (d.daemon.processedToday || 0), '');
        appendToKonzolaLog('RAG Saves: ' + (d.daemon.contextSavedToRAG || 0) + ' | Last: ' + (d.daemon.lastContextSave || 'Never'), '');
        appendToKonzolaLog('Last Activity: ' + (d.daemon.lastActivity || 'None'), '');
        appendToKonzolaLog('--- Services ---', 'log-info');
        const sv = d.services || {};
        Object.entries(sv).forEach(([name, s]) => {
          const st = s && s.status ? s.status : 'unknown';
          const cls = (st === 'running' || st === 'ok') ? 'log-success' : st === 'disabled' ? 'log-system' : 'log-error';
          const extra = s && s.pid ? ' (PID:' + s.pid + ')' : s && s.port ? ' (:' + s.port + ')' : '';
          appendToKonzolaLog('  ' + name + ': ' + st + extra, cls);
        });
        appendToKonzolaLog('WS Clients: ' + (d.wsClients || 0), '');
        appendToKonzolaLog('Mode: ' + (d.mode || '--').toUpperCase(), '');
        appendToKonzolaLog('=== END STATUS ===', 'log-info');
      } catch(e) { appendToKonzolaLog('Failed: ' + e.message, 'log-error'); }
    }

    async function toggleKonzolaMode(newMode) {
      try {
        const targetMode = (newMode || (konzolaMode === 'plan' ? 'work' : 'plan')).toUpperCase();
        // System-wide mode change — affects ALL agents, not just console
        const r = await fetch('/api/system/mode', {
          method: 'PUT', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ mode: targetMode, reason: 'UI toggle' })
        });
        const d = await r.json();
        konzolaMode = (d.mode || 'WORK').toLowerCase(); updateModeButton();
        appendToKonzolaLog('SYSTEM MODE switched to: ' + (d.mode || targetMode) + ' (system-wide — all agents)', 'log-info');
        // Also update old konzola mode for backward compat
        fetch('/api/konzola/mode', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ mode: konzolaMode })
        }).catch(() => {});
      } catch(e) { appendToKonzolaLog('Mode switch failed: ' + e.message, 'log-error'); }
    }

    // Known command prefixes for smart routing
    const KNOWN_COMMANDS = ['ls','cat','head','tail','wc','grep','find','git','bun','node',
      'date','uptime','whoami','hostname','df','free','ps','top',
      'help','clear','status','verbose','info','mode','services','logs','history',
      'regoc-services','regoc-services.sh'];

    function isCommand(input) {
      const firstWord = input.split(/\s+/)[0].toLowerCase();
      // Starts with / = explicit command prefix
      if (input.startsWith('/')) return true;
      // Starts with known command
      if (KNOWN_COMMANDS.includes(firstWord)) return true;
      // Starts with ./ or ~/ or / = path/command
      if (/^[.~\/]/.test(input)) return true;
      // Otherwise it's natural language → message to REGOČ
      return false;
    }

    async function sendKonzolaMessage(text) {
      try {
        appendToKonzolaLog('📨 → REGOČ: ' + text, 'log-info');
        const r = await fetch('/api/konzola/message', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ message: text })
        });
        const d = await r.json();
        if (d.error) { appendToKonzolaLog('❌ ' + d.error, 'log-error'); }
        else if (d.success) { appendToKonzolaLog('✅ Queued (' + d.messageId.substring(0,8) + '). Daemon ce obraditi poruku.', 'log-success'); }
      } catch(e) { appendToKonzolaLog('Error: ' + e.message, 'log-error'); }
    }

    function initKonzolaInput() {
      const input = document.getElementById('konzola-input');
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          const cmd = input.value.trim();
          if (!cmd) return;
          konzolaCommandHistory.push(cmd);
          konzolaHistoryIndex = konzolaCommandHistory.length;
          input.value = '';

          // Smart routing: command or message?
          if (isCommand(cmd)) {
            // Shell command path
            appendToKonzolaLog('$ ' + cmd, 'log-cmd');
            if (handleBuiltinCommand(cmd)) return;
            // Strip leading / for explicit command prefix
            const execCmd = cmd.startsWith('/') ? cmd.substring(1) : cmd;
            try {
              const r = await fetch('/api/konzola/exec', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ command: execCmd })
              });
              const d = await r.json();
              if (d.error) { appendToKonzolaLog(d.error, 'log-error'); }
              else {
                if (d.stdout) appendToKonzolaLog(d.stdout, '');
                if (d.stderr) appendToKonzolaLog(d.stderr, 'log-warn');
              }
            } catch(e) { appendToKonzolaLog('Error: ' + e.message, 'log-error'); }
          } else {
            // Natural language → send to REGOČ message queue
            await sendKonzolaMessage(cmd);
          }
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (konzolaHistoryIndex > 0) { konzolaHistoryIndex--; input.value = konzolaCommandHistory[konzolaHistoryIndex]; }
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (konzolaHistoryIndex < konzolaCommandHistory.length - 1) { konzolaHistoryIndex++; input.value = konzolaCommandHistory[konzolaHistoryIndex]; }
          else { konzolaHistoryIndex = konzolaCommandHistory.length; input.value = ''; }
        }
      });
    }

    function handleKonzolaWSMessage(data) {
      if (data.type === 'console_output') appendToKonzolaLog(data.text, data.level || '');
      if (data.type === 'console_mode_changed') { konzolaMode = data.mode; updateModeButton(); }
    }

    // ── Persistent agents panel ──
    async function loadPersistentPanel() {
      try {
        const [agentsRes, configRes] = await Promise.all([
          fetch('/api/agents').then(r => r.json()),
          fetch('/api/system/persistent').then(r => r.json())
        ]);
        const agents = agentsRes.agents || agentsRes.data || agentsRes;
        const config = configRes;
        const list = document.getElementById('persistent-agent-list');
        if (!list) return;
        const toggleable = agents.filter(a => !['klaudio','stribor','regoc'].includes(a.id));
        list.innerHTML = toggleable.map(a => {
          const isPersistent = a.persistent || (config.enabledAgents || []).includes(a.id);
          const color = isPersistent ? '#22c55e' : '#6b7280';
          const label = isPersistent ? 'PERSISTENT' : 'ON-DEMAND';
          const dot = a.alive ? '●' : '○';
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;cursor:pointer" data-agent-id="' + a.id + '" onclick="toggleAgentPersistent(\\'' + a.id + '\\')">'
            + '<span>' + dot + ' ' + (a.name || a.id) + ' <span style="color:#475569;font-size:0.7rem">(' + (a.role || '') + ')</span></span>'
            + '<span style="color:' + color + ';font-size:0.7rem;font-weight:700">' + label + '</span>'
            + '</div>';
        }).join('');
        // Update button color
        const btn = document.getElementById('persistent-btn');
        if (config.persistentMode === 'off') { btn.style.borderColor = '#6b7280'; btn.style.color = '#6b7280'; btn.textContent = 'AGENTS'; }
        else if (config.persistentMode === 'selective') { btn.style.borderColor = '#f59e0b'; btn.style.color = '#f59e0b'; btn.textContent = 'AGENTS (' + (config.enabledAgents || []).length + ')'; }
        else { btn.style.borderColor = '#22c55e'; btn.style.color = '#22c55e'; btn.textContent = 'AGENTS (ALL)'; }
      } catch(e) { console.error('Persistent panel load failed:', e); }
    }

    window.toggleAgentPersistent = async function(agentId) {
      try {
        const configRes = await fetch('/api/system/persistent').then(r => r.json());
        const enabled = !(configRes.enabledAgents || []).includes(agentId);
        await fetch('/api/agents/' + agentId + '/persistent', {
          method: 'PUT', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ enabled })
        });
        appendToKonzolaLog(agentId + ' → ' + (enabled ? 'PERSISTENT' : 'ON-DEMAND'), 'log-info');
        loadPersistentPanel();
      } catch(e) { appendToKonzolaLog('Toggle failed: ' + e.message, 'log-error'); }
    };

    function initKonzola() {
      initKonzolaInput();
      fetchKonzolaStatus();
      if (konzolaStatusInterval) clearInterval(konzolaStatusInterval);
      konzolaStatusInterval = setInterval(fetchKonzolaStatus, 30000);
      fetchSessionUsage();                                 // potrošnja sesije: odmah…
      if (sessionUsageInterval) clearInterval(sessionUsageInterval);
      sessionUsageInterval = setInterval(fetchSessionUsage, 60000);  // …pa svake minute (+ na I/O u konzoli)
      document.getElementById('konzola-mode-btn').onclick = () => toggleKonzolaMode();
      document.getElementById('persistent-btn').onclick = () => {
        const panel = document.getElementById('persistent-panel');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        if (panel.style.display === 'block') loadPersistentPanel();
      };
      document.getElementById('persistent-all-btn').onclick = async () => {
        await fetch('/api/system/persistent', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({persistentMode:'full',enabledAgents:[]}) });
        appendToKonzolaLog('All agents → PERSISTENT', 'log-info');
        loadPersistentPanel();
      };
      document.getElementById('persistent-off-btn').onclick = async () => {
        await fetch('/api/system/persistent', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({persistentMode:'off',enabledAgents:[]}) });
        appendToKonzolaLog('All agents → ON-DEMAND', 'log-info');
        loadPersistentPanel();
      };
      document.getElementById('konzola-input').focus();
    }

    // ============================================
    // STATUS FUNCTIONALITY
    // ============================================

    let statusRefreshInterval = null;

    const MODEL_NAMES = {
      'claude-opus-4-5-20251101': 'Opus 4.5',
      'claude-opus-4-6-20250514': 'Opus 4.6',
      'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
      'claude-sonnet-4-6-20250514': 'Sonnet 4.6',
      'claude-haiku-4-5-20251001': 'Haiku 4.5'
    };

    function fmtTokens(n) {
      if (!n) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }
    function fmtCost(usd) { return usd ? '$' + Number(usd).toFixed(2) : '$0.00'; }

    async function fetchStatusDashboard() {
      try {
        const r = await fetch('/api/status/dashboard');
        const d = await r.json();
        renderServiceHealth(d.services);
        renderSystemOverview(d.daemon, d);
        renderTokenUsage(d.tokens);
        renderProjectsAndTasks(d.tasks, d.projects);
        renderSchedulerQueue(d.scheduler);
        document.getElementById('status-last-updated').textContent = 'Updated: ' + new Date().toLocaleTimeString();
      } catch(e) { console.error('Status dashboard fetch failed:', e); }
    }

    function renderServiceHealth(services) {
      const grid = document.getElementById('status-service-grid');
      if (!services || Object.keys(services).length === 0) { grid.innerHTML = '<div class="empty">No service data</div>'; return; }
      grid.innerHTML = Object.entries(services).map(([name, s]) => {
        const st = (s && s.status) || 'unknown';
        return '<div class="service-badge"><span class="service-dot ' + st + '"></span><span>' + escapeHtml(name) + '</span><span style="margin-left:auto;font-size:0.7rem;color:var(--text-secondary)">' + st + '</span></div>';
      }).join('');
    }

    function renderSystemOverview(daemon, data) {
      const grid = document.getElementById('status-overview-grid');
      // Ista logika kao u konzolnoj traci — ploča i traka ne smiju tvrditi različito stanje.
      const dv = buildDaemonView(data && data.daemon ? data : { daemon: daemon || {} });
      const stateColor = dv.state === 'offline' ? 'var(--accent-red)' : dv.state === 'stale' ? 'var(--accent-yellow)' : null;
      const daemonTip = dv.taskText + (dv.title ? ' — ' + dv.title : '');
      const items = [
        { v: dv.uptimeText, l: 'Uptime', c: stateColor, t: daemonTip },
        { v: dv.statusText, l: 'Daemon', c: stateColor, t: daemonTip },
        { v: (daemon?.contextPct || 0) + '%', l: 'Context' },
        { v: String(daemon?.pendingMessages ?? 0), l: 'Pending' },
        { v: String(daemon?.processedToday ?? 0), l: 'Processed' },
        { v: String(data?.wsClients ?? 0), l: 'WS Clients' },
        { v: String(data?.tokens?.totalSessions ?? 0), l: 'Sessions' },
        { v: String(data?.tokens?.totalMessages ?? 0), l: 'Spawns' },
      ];
      grid.innerHTML = items.map(i => '<div class="stat-box"><div class="stat-value"' + (i.c ? ' style="color:' + i.c + '"' : '') + '>' + escapeHtml(String(i.v)) + '</div><div class="stat-label">' + i.l + '</div></div>').join('');
      // Tooltip se postavlja svojstvom, ne atributom: escapeHtml ne bježi navodnike,
      // pa bi razlog s navodnikom razbio atribut.
      const boxes = grid.querySelectorAll('.stat-box');
      items.forEach((i, ix) => { if (i.t && boxes[ix]) boxes[ix].title = i.t; });
    }

    function renderTokenUsage(tokens) {
      const el = document.getElementById('status-token-content');
      if (!tokens?.byModel || Object.keys(tokens.byModel).length === 0) { el.innerHTML = '<div class="empty">No token data</div>'; return; }
      // Izvor se ISPISUJE — ploča koja tiho servira mrtav keš je gora od prazne ploče.
      const src = tokens.source === 'cost_log'
        ? 'cost_log &middot; zadnjih ' + (tokens.windowDays || 30) + ' dana &middot; ' + (tokens.totalTasks ?? 0) + ' zadataka'
        : tokens.source
          ? escapeHtml(String(tokens.source)) + (tokens.lastAt ? ' &middot; zadnji izračun ' + escapeHtml(String(tokens.lastAt)) : '')
          : 'nepoznat izvor';
      let totalIn = 0, totalOut = 0, totalCost = 0, totalCache = 0;
      let rows = '';
      for (const [model, d] of Object.entries(tokens.byModel)) {
        const name = MODEL_NAMES[model] || model.replace('claude-','').replace(/-\\d+$/,'');
        const inp = d.inputTokens || 0; const out = d.outputTokens || 0;
        const cost = d.costUSD || 0; const cache = d.cacheReadInputTokens || 0;
        totalIn += inp; totalOut += out; totalCost += cost; totalCache += cache;
        rows += '<tr><td>' + escapeHtml(name) + '</td><td>' + fmtTokens(inp) + '</td><td>' + fmtTokens(out) + '</td><td>' + fmtTokens(cache) + '</td><td>' + fmtCost(cost) + '</td></tr>';
      }
      rows += '<tr class="total-row"><td>TOTAL</td><td>' + fmtTokens(totalIn) + '</td><td>' + fmtTokens(totalOut) + '</td><td>' + fmtTokens(totalCache) + '</td><td>' + fmtCost(totalCost) + '</td></tr>';
      el.innerHTML = '<table class="token-table"><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cost</th></tr></thead><tbody>' + rows + '</tbody></table>'
        + '<div style="margin-top:0.4rem;font-size:0.72rem;opacity:0.6;">izvor: ' + src + '</div>';
    }

    function renderProjectsAndTasks(tasks, projects) {
      const el = document.getElementById('status-projects-content');
      let html = '';

      // Task summary
      if (tasks && tasks.byStatus) {
        const bs = tasks.byStatus;
        html += '<div style="margin-bottom:0.75rem;font-size:0.85rem;">';
        html += '<strong>Tasks:</strong> ';
        const statuses = ['pending','in_progress','blocked','completed','cancelled'];
        const colors = {'pending':'#f59e0b','in_progress':'#3b82f6','blocked':'#ef4444','completed':'#22c55e','cancelled':'#6b7280'};
        html += statuses.filter(s => bs[s]).map(s => '<span style="color:' + colors[s] + '">' + (bs[s] || 0) + ' ' + s.replace('_',' ') + '</span>').join(' &middot; ');
        html += '</div>';
      }

      // Project summary
      if (projects?.stats?.byStatus) {
        const ps = projects.stats.byStatus;
        html += '<div style="margin-bottom:0.75rem;font-size:0.85rem;">';
        html += '<strong>Projects:</strong> ';
        html += Object.entries(ps).filter(([,v]) => v > 0).map(([k,v]) => v + ' ' + k).join(' &middot; ');
        html += '</div>';
      }

      // Active projects progress
      if (projects?.active?.length > 0) {
        html += '<div style="margin-top:0.5rem;">';
        for (const p of projects.active) {
          const pct = p.calculated_progress || 0;
          const color = pct >= 80 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#3b82f6';
          html += '<div class="project-progress-item">';
          html += '<div class="project-progress-name">' + escapeHtml(p.id + ' ' + (p.name || '')) + '</div>';
          html += '<div class="project-progress-bar"><div class="progress-bar-sm"><div class="progress-bar-sm-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
          html += '<div class="project-progress-pct" style="color:' + color + '">' + pct + '%</div>';
          html += '</div>';
        }
        html += '</div>';
      }

      el.innerHTML = html || '<div class="empty">No data</div>';
    }

    function renderSchedulerQueue(scheduler) {
      const el = document.getElementById('status-queue-content');
      if (!scheduler || Object.keys(scheduler).length === 0) { el.innerHTML = '<div class="empty">No scheduler data</div>'; return; }
      let html = '<div style="font-size:0.85rem;">';
      if (scheduler.activeTasks) html += '<div><strong>Active:</strong> ' + (scheduler.activeTasks?.length || 0) + ' &middot; <strong>Queued:</strong> ' + (scheduler.queuedTasks?.length || 0) + ' &middot; <strong>Completed:</strong> ' + (scheduler.completedTasks?.length || 0) + '</div>';
      if (scheduler.lastCheck) html += '<div style="color:var(--text-secondary);font-size:0.75rem;margin-top:0.25rem;">Last check: ' + new Date(scheduler.lastCheck).toLocaleTimeString() + '</div>';
      html += '</div>';
      el.innerHTML = html;
    }

    function initStatus() {
      fetchStatusDashboard();
      if (statusRefreshInterval) clearInterval(statusRefreshInterval);
      statusRefreshInterval = setInterval(fetchStatusDashboard, 30000);
      document.getElementById('status-refresh-btn').onclick = fetchStatusDashboard;
    }

    // ============================================
    // INFO TAB
    // ============================================

    function initInfo() {
      fetchInfoData();
      document.getElementById('info-refresh-btn').onclick = fetchInfoData;
    }

    async function fetchInfoData() {
      try {
        const [r, rAgents, rMetrics, rModels] = await Promise.all([
          fetch('/api/info'),
          fetch('/api/agents').catch(function() { return null; }),
          fetch('/api/metrics').catch(function() { return null; }),
          fetch('/api/models/available').catch(function() { return null; }),
        ]);
        if (!r.ok) throw new Error('API error');
        const d = await r.json();
        const agentsData = rAgents && rAgents.ok ? await rAgents.json() : null;
        const metricsData = rMetrics && rMetrics.ok ? await rMetrics.json() : null;
        const modelsData = rModels && rModels.ok ? await rModels.json() : null;
        renderInfoSystem(d);
        renderInfoProviders(d, agentsData);
        renderInfoAgents(d, modelsData);
        renderModelSetup(modelsData);
        loadLoginProviders();
        renderInfoModules(d);
        renderInfoInfra(d);
        renderInfoDatabases(d);
        renderInfoComponents(d);
        renderInfoSkillsAndWorkflows(d);
        renderInfoRules(d);
        renderInfoMetrics(metricsData);
      } catch(e) {
        document.getElementById('info-system-content').innerHTML = '<div class="empty">Error loading info: ' + e.message + '</div>';
      }
    }

    function renderInfoSystem(d) {
      const s = d.system || {};
      document.getElementById('info-system-content').innerHTML =
        '<div class="info-version">REGOČ v' + (s.version||'?') + '</div>' +
        '<div class="info-subtitle">' + (s.fullName||'') + '</div>' +
        '<div class="info-kv"><span class="info-kv-label">Princip</span><span class="info-kv-value">' + (s.principle||'') + '</span></div>' +
        '<div class="info-kv"><span class="info-kv-label">Orchestrator Model</span><span class="info-kv-value">' + (s.orchestratorModel||'') + '</span></div>' +
        '<div class="info-kv"><span class="info-kv-label">Agenti</span><span class="info-kv-value">' + (s.agentCount||0) + '</span></div>' +
        '<div class="info-kv"><span class="info-kv-label">Moduli</span><span class="info-kv-value">' + (s.moduleCount||0) + ' (' + (s.modulesEnabled||0) + ' enabled)</span></div>' +
        '<div class="info-kv"><span class="info-kv-label">Provideri</span><span class="info-kv-value">' + (s.providerCount||0) + ' active</span></div>' +
        '<div class="info-kv"><span class="info-kv-label">Platform</span><span class="info-kv-value">' + (s.platform||'') + '</span></div>';
    }

    function renderInfoProviders(d, agentsData) {
      const providers = d.providers || [];
      let h = '';
      providers.forEach(function(p) {
        const dot = p.online ? 'online' : 'offline';
        const badge = p.enabled ? (p.online ? 'enabled' : 'disabled') : 'disabled';
        const models = (p.models||[]).map(function(m){ return m.id + ' <span class="info-badge ' + m.tier + '">' + m.tier + '</span>'; }).join(', ');
        h += '<div class="info-provider-row">' +
          '<div class="info-dot ' + dot + '"></div>' +
          '<strong style="min-width:80px">' + p.name + '</strong>' +
          '<span class="info-badge ' + badge + '">' + (p.enabled ? (p.online ? 'online' : 'offline') : 'disabled') + '</span>' +
          '</div>';
        if (p.models && p.models.length > 0) {
          h += '<div style="padding-left:1.5rem;font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.5rem">' + models + '</div>';
        }
      });
      if (agentsData && agentsData.agents) {
        var modelCounts = {};
        agentsData.agents.forEach(function(a) {
          var m = a.model || 'unknown';
          modelCounts[m] = (modelCounts[m] || 0) + 1;
        });
        h += '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--border-color);font-size:0.75rem">' +
          '<strong style="color:var(--accent-blue)">Model Health</strong> &mdash; ' +
          agentsData.totalAgents + ' agents (' + agentsData.activeCount + ' active)';
        Object.keys(modelCounts).forEach(function(m) {
          h += ' &middot; <span style="font-family:monospace">' + m + '</span>: ' + modelCounts[m];
        });
        h += '</div>';
      }
      document.getElementById('info-providers-content').innerHTML = h || '<div class="empty">No providers</div>';
    }

    function modelSelectHTML(a, models) {
      if (a.fixed) {
        return '<span title="Trajni interface/glavna petlja (npr. Telegram servis, orkestrator) — model se ne bira ovdje; override se ne primjenjuje." ' +
          'style="font-size:0.72rem;color:#8aa0b2;border:1px dashed #3a4a55;border-radius:4px;padding:2px 8px;background:#12283a;white-space:nowrap">' +
          '&#128274; interface — fiksno <span style="color:#6b7d8c">(' + (a.currentModel||'?') + ')</span></span>';
      }
      var cur = a.override || '';
      var opts = '<option value="">⭐ zadano (' + (a.currentModel||'?') + ')</option>';
      (models||[]).forEach(function(m){
        var sel = (cur === m.spec) ? ' selected' : '';
        var tag = m.spawnable ? '' : ' · lokalno';
        opts += '<option value="' + m.spec + '"' + sel + '>' + m.label + ' [' + m.tier + ']' + tag + '</option>';
      });
      var isLocal = cur && (models||[]).some(function(m){return m.spec===cur && !m.spawnable;});
      var ttl = isLocal ? ' title="Lokalni model (Ollama) preko API spawna — radi, ali tekstualno (bez alata: Bash/datoteke/MCP)."' : '';
      var style = 'font-size:0.72rem;padding:2px 4px;border-radius:4px;background:var(--bg-primary,#111);color:var(--text-primary,#ddd);border:1px solid var(--border-color,#333)';
      if (cur) style += ';border-color:' + (isLocal ? '#f59e0b' : 'var(--accent-blue,#3b82f6)');
      return '<select style="' + style + '"' + ttl + ' onchange="setAgentModel(\\'' + a.id + '\\', this.value, this)">' + opts + '</select>' +
        (cur ? ' <span style="font-size:0.65rem;color:' + (isLocal?'#f59e0b':'var(--accent-blue)') + '">override' + (isLocal?' (lokalno)':'')+ '</span>' : '');
    }

    async function setAgentModel(agentId, spec, el) {
      try {
        if (el) el.disabled = true;
        var res = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/model', {
          method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ model: spec })
        });
        var d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error || 'save failed');
        fetchInfoData();
      } catch(e) {
        alert('Greska pri spremanju modela: ' + e.message);
        if (el) el.disabled = false;
      }
    }

    async function loadLoginProviders() {
      var el = document.getElementById('info-login-content');
      if (!el) return;
      try {
        var d = await (await fetch('/api/providers/login/status')).json();
        el.innerHTML = '<div style="font-size:.7rem;color:var(--text-secondary);margin-bottom:.5rem">Klikni <b>Login</b> → <b>Copy link</b> → otvori link na bilo kojem računalu i prijavi se. Ako login traži kod, zalijepi ga natrag. Nakon prijave provider se pojavi u listi modela agenata.</div>'
          + (d.providers||[]).map(renderLoginRow).join('');
      } catch(e){ el.innerHTML = '<div class="empty">Greška: '+e.message+'</div>'; }
    }
    function renderLoginRow(p) {
      var badge = p.loggedIn ? '<span class="info-badge enabled">prijavljen</span>'
        : (p.installed ? '<span class="info-badge disabled">nije prijavljen</span>' : '<span class="info-badge disabled">nije instaliran</span>');
      var h = '<div style="border:1px solid var(--border-color);border-radius:6px;padding:0.6rem;margin-bottom:0.5rem">';
      h += '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap"><strong>'+p.name+'</strong>'+badge+'<span style="margin-left:auto;display:flex;gap:6px">';
      if (p.loggedIn) h += '<button onclick="doLogout(\\''+p.id+'\\')" style="font-size:.72rem;padding:4px 8px">Odjava</button>';
      else if (p.kind==='oauth-cli' && p.installed) h += '<button onclick="doLoginStart(\\''+p.id+'\\')" style="font-size:.72rem;padding:4px 8px">Login</button>';
      h += '</span></div><div id="login-body-'+p.id+'" style="margin-top:.4rem"></div>';
      if (p.id==='geminicli') h += '<div style="font-size:.66rem;color:#f59e0b;margin-top:.3rem">Google je ukinuo besplatni OAuth (Code Assist) za CLI — koristi <b>API ključ</b> s aistudio.google.com/apikey (besplatan tier).</div>';
      if (p.apikey && !p.loggedIn) {
        var _ph = p.id==='geminicli' ? 'GEMINI_API_KEY (AIza...)' : 'API ključ (sk-or-...)';
        h += '<div style="display:flex;gap:6px;margin-top:.4rem"><input id="login-key-'+p.id+'" type="password" placeholder="'+_ph+'" style="flex:1;font-size:.72rem;padding:3px 5px"><button onclick="doApikey(\\''+p.id+'\\')" style="font-size:.72rem;padding:4px 8px">Spremi ključ</button></div>';
      }
      if (!p.installed && p.installCmd) h += '<div style="font-size:.66rem;color:var(--text-secondary);margin-top:.3rem">Nije instaliran. Instaliraj (Sigurnost→internet ON): <code>'+p.installCmd+'</code></div>';
      h += '</div>';
      return h;
    }
    async function doLoginStart(id) {
      var body = document.getElementById('login-body-'+id); if(!body) return;
      body.innerHTML = 'Pokrećem prijavu…';
      try {
        var d = await (await fetch('/api/providers/login/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})).json();
        if (d.error){ body.innerHTML='<span style="color:var(--accent-red)">'+(d.error==='not-installed'?'Nije instaliran.':d.error)+'</span>'; return; }
        renderLoginActive(id, d.url); pollLogin(id);
      } catch(e){ body.innerHTML='<span style="color:var(--accent-red)">'+e.message+'</span>'; }
    }
    function renderLoginActive(id, urlv) {
      var body = document.getElementById('login-body-'+id); if(!body) return;
      var h = '';
      if (urlv) {
        h += '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><input id="login-url-'+id+'" value="'+urlv+'" readonly style="flex:1;min-width:220px;font-size:.7rem;padding:3px 5px">';
        h += '<button onclick="copyLoginLink(\\''+id+'\\')" style="font-size:.72rem;padding:4px 8px">📋 Copy link</button>';
        h += '<a href="'+urlv+'" target="_blank" rel="noopener" style="font-size:.72rem;padding:4px 8px">Otvori</a></div>';
        h += '<div style="font-size:.66rem;color:var(--text-secondary);margin-top:.3rem">Otvori link na bilo kojem računalu i odobri. Ako CLI traži kod, zalijepi ga ispod.</div>';
      } else { h += '<div style="font-size:.7rem;color:var(--text-secondary)">Čekam link…</div>'; }
      h += '<div style="display:flex;gap:6px;margin-top:.4rem"><input id="login-paste-'+id+'" placeholder="Zalijepi kod (ako login traži)" style="flex:1;font-size:.72rem;padding:3px 5px"><button onclick="doPaste(\\''+id+'\\')" style="font-size:.72rem;padding:4px 8px">Pošalji</button></div>';
      h += '<div id="login-status-'+id+'" style="font-size:.66rem;color:var(--text-secondary);margin-top:.3rem"></div>';
      body.innerHTML = h;
    }
    function copyLoginLink(id){ var el=document.getElementById('login-url-'+id); if(el){ el.select(); if(navigator.clipboard) navigator.clipboard.writeText(el.value); var s=document.getElementById('login-status-'+id); if(s)s.textContent='Link kopiran.'; } }
    async function doPaste(id){ var v=document.getElementById('login-paste-'+id); if(!v)return; try{ await fetch('/api/providers/login/paste',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,code:v.value})}); var s=document.getElementById('login-status-'+id); if(s)s.textContent='Kod poslan, čekam potvrdu…'; }catch(e){} }
    var loginPollTimers = {};
    function pollLogin(id){
      clearInterval(loginPollTimers[id]); var tries=0;
      loginPollTimers[id]=setInterval(async function(){
        tries++;
        try {
          var d = await (await fetch('/api/providers/login/poll?id='+encodeURIComponent(id))).json();
          var s=document.getElementById('login-status-'+id);
          var u=document.getElementById('login-url-'+id);
          if (d.url && u && !u.value) u.value=d.url;
          if (d.loggedIn){ clearInterval(loginPollTimers[id]); if(s)s.textContent='✅ Prijava uspješna.'; setTimeout(fetchInfoData, 800); return; }
          if (d.done && !d.loggedIn){ clearInterval(loginPollTimers[id]); if(s)s.textContent='Prijava prekinuta/neuspješna.'; return; }
        } catch(e){}
        if (tries>150){ clearInterval(loginPollTimers[id]); }
      }, 2000);
    }
    async function doApikey(id){ var k=document.getElementById('login-key-'+id); if(!k||!k.value.trim())return; try{ var d=await (await fetch('/api/providers/login/apikey',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,key:k.value.trim()})})).json(); if(d.error)throw new Error(d.error); fetchInfoData(); }catch(e){ alert('Greška: '+e.message); } }
    async function doLogout(id){ if(!confirm('Odjaviti '+id+'?'))return; try{ await fetch('/api/providers/login/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})}); fetchInfoData(); }catch(e){} }

    function renderModelSetup(md) {
      var el = document.getElementById('info-modelsetup-content');
      if (!el) return;
      if (!md || !md.providers) { el.innerHTML = '<div class="empty">Nema podataka o providerima</div>'; return; }
      var h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.5rem">' +
        'Pretplatnički provideri (Claude) nemaju dodatne postavke. Lokalni (Ollama) traži samo <strong>server IP:port</strong> — kao RAG; token je opcijski (samo iza reverse-proxyja).</div>';
      md.providers.forEach(function(p) {
        var dot = p.enabled ? (p.reachable ? 'online' : 'offline') : 'offline';
        var statusTxt = !p.enabled ? 'isključen' : (p.kind === 'subscription' ? 'pretplata' : (p.reachable ? (p.models.length + ' modela') : 'nedostupan'));
        var statusBadge = (p.enabled && (p.reachable || p.kind === 'subscription')) ? 'enabled' : 'disabled';
        h += '<div style="border:1px solid var(--border-color);border-radius:6px;padding:0.6rem;margin-bottom:0.6rem">';
        h += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;flex-wrap:wrap">' +
          '<span class="info-dot ' + dot + '"></span>' +
          '<strong>' + p.name + '</strong>' +
          '<span class="info-badge ' + statusBadge + '">' + statusTxt + '</span>' +
          '<label style="margin-left:auto;font-size:0.72rem;cursor:pointer"><input type="checkbox" ' + (p.enabled ? 'checked' : '') + ' onchange="setProviderEnabled(\\'' + p.id + '\\', this.checked)"> omogućen</label>' +
          '</div>';
        if (p.needsSetup) {
          var inpStyle = 'font-size:0.72rem;padding:3px 5px;background:var(--bg-primary,#111);color:var(--text-primary,#ddd);border:1px solid var(--border-color,#333);border-radius:4px';
          var isCloud = p.kind === 'cloud-key';
          var keyLabel = isCloud ? 'API ključ' : 'Token (opcijski)';
          var keyPh = p.hasAuth ? '••• spremljeno' : (isCloud ? 'sk-or-...' : 'nije potrebno');
          h += '<div style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end;font-size:0.72rem">';
          // Server IP:port samo za lokalne (Ollama)
          if (p.kind === 'local') {
            h += '<div><div style="color:var(--text-secondary)">Server (IP:port)</div><input id="prov-' + p.id + '-url" value="' + (p.baseUrl || '') + '" placeholder="http://127.0.0.1:11434" style="width:230px;' + inpStyle + '"></div>';
          }
          // Ključ + 👁 prikaži (maskiran dok se ne stisne)
          h += '<div><div style="color:var(--text-secondary)">' + keyLabel + '</div>' +
            '<div style="display:flex;align-items:center;gap:4px">' +
            '<input id="prov-' + p.id + '-key" type="password" autocomplete="off" placeholder="' + keyPh + '" style="width:' + (isCloud ? '250' : '170') + 'px;' + inpStyle + '">' +
            '<button type="button" title="Prikaži/sakrij" onclick="toggleKeyVis(\\'' + p.id + '\\', this)" style="font-size:0.8rem;padding:2px 6px;border-radius:4px;cursor:pointer;background:var(--bg-primary,#111);border:1px solid var(--border-color,#333)">&#128065;</button>' +
            '</div></div>';
          h += '<button onclick="saveProvider(\\'' + p.id + '\\')" style="font-size:0.72rem;padding:5px 10px;border-radius:4px;cursor:pointer">Spremi' + (p.kind === 'local' ? ' + test' : '') + '</button>';
          h += '</div>';
          h += '<div style="font-size:0.66rem;color:var(--text-secondary);margin-top:0.3rem">' + (p.authNote || '') + (p.error ? (' <span style="color:var(--accent-red)">— ' + p.error + '</span>') : '') + '</div>';
        } else {
          h += '<div style="font-size:0.66rem;color:var(--text-secondary)">' + (p.authNote || '') + '</div>';
        }
        if (p.models && p.models.length) {
          h += '<div style="font-size:0.66rem;color:var(--text-secondary);margin-top:0.35rem;line-height:1.6">Modeli: ' +
            p.models.map(function(m) { return '<span style="font-family:monospace">' + m.model + '</span> <span class="info-badge ' + m.tier + '">' + m.tier + '</span>' + (m.spawnable ? '' : ' <span style="color:#f59e0b">lokalno</span>'); }).join(' · ') + '</div>';
        }
        h += '</div>';
      });
      el.innerHTML = h;
    }

    async function setProviderEnabled(id, enabled) {
      try {
        var r = await fetch('/api/models/providers/' + encodeURIComponent(id), { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: enabled }) });
        var d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'save failed');
        fetchInfoData();
      } catch(e) { alert('Greska: ' + e.message); }
    }

    function toggleKeyVis(id, btn) {
      var el = document.getElementById('prov-' + id + '-key');
      if (!el) return;
      if (el.type === 'password') { el.type = 'text'; if (btn) btn.style.opacity = '1'; }
      else { el.type = 'password'; if (btn) btn.style.opacity = '0.55'; }
    }

    async function saveProvider(id) {
      var urlEl = document.getElementById('prov-' + id + '-url');
      var keyEl = document.getElementById('prov-' + id + '-key');
      var body = {};
      if (urlEl) body.baseUrl = urlEl.value;
      if (keyEl && keyEl.value !== '') body.apiKey = keyEl.value;
      try {
        var r = await fetch('/api/models/providers/' + encodeURIComponent(id), { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        var d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'save failed');
        fetchInfoData();
      } catch(e) { alert('Greska pri spremanju providera: ' + e.message); }
    }

    function renderInfoAgents(d, modelsData) {
      const agents = d.agents || [];
      // Merge: /api/models/available (živi Ollama + anthropic/openrouter) + d.availableModels
      // (getEffectiveModels — dodaje geminicli/kimicli kad su prijavljeni). Bez merge-a
      // CLI-login modeli (Google/Kimi) se nikad ne pojave u dropdownu.
      var _base = (modelsData && modelsData.models) || [];
      var _extra = (d.availableModels || []).filter(function(m){ return !_base.some(function(b){ return b.spec === m.spec; }); });
      const models = _base.concat(_extra);
      let h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.4rem">' +
        'Model po agentu — “zadano” koristi tier iz registra. Override se sprema u <code>model-config.json → agentOverrides</code> i vrijedi odmah (bez restarta). ' +
        '<strong>lokalno</strong> = Ollama model preko API spawna — radi, ali tekstualno (bez alata: Bash/datoteke/MCP). Claude, Gemini, Kimi i OpenRouter modeli imaju PUNE alate. ' +
        '&#128274; <strong>interface — fiksno</strong> (Klaudio/Stribor/REGOČ) = trajni servisi/glavna petlja; njima se model ne mijenja ovdje.</div>';
      h += '<table class="info-table"><thead><tr>' +
        '<th>Agent</th><th>Uloga</th><th>Min Tier</th><th>Model (odabir)</th>' +
        '<th>Context</th><th>Tools</th><th>Notes</th></tr></thead><tbody>';
      agents.forEach(function(a) {
        const tierBadge = '<span class="info-badge ' + a.minTier + '">' + a.minTier + '</span>';
        h += '<tr><td><strong>' + a.name + '</strong></td>' +
          '<td>' + a.role + '</td>' +
          '<td>' + tierBadge + '</td>' +
          '<td>' + modelSelectHTML(a, models) + '</td>' +
          '<td>' + (a.minContext ? (a.minContext/1000) + 'K' : '-') + '</td>' +
          '<td title="' + (a.toolsNote||'') + '">' + (a.requiresTools ? '✅' : '➖') + '</td>' +
          '<td style="font-size:0.7rem;color:var(--text-secondary)">' + (a.notes||'') + '</td></tr>';
      });
      h += '</tbody></table>';
      document.getElementById('info-agents-content').innerHTML = h;
    }

    function renderInfoModules(d) {
      const modules = d.modules || [];
      let h = '<table class="info-table"><thead><tr>' +
        '<th>Module</th><th>Status</th><th>Type</th><th>Provides</th><th>Degradation</th></tr></thead><tbody>';
      modules.forEach(function(m) {
        const badge = m.required ? 'required' : (m.enabled ? 'enabled' : 'disabled');
        const label = m.required ? 'required' : (m.enabled ? 'enabled' : 'disabled');
        h += '<tr><td><strong>' + m.name + '</strong></td>' +
          '<td><span class="info-badge ' + badge + '">' + label + '</span></td>' +
          '<td>' + (m.required ? 'Core' : 'Optional') + '</td>' +
          '<td style="font-size:0.7rem">' + (m.provides||[]).join(', ') + '</td>' +
          '<td style="font-size:0.7rem;color:var(--text-secondary)">' + (m.degradation||'-') + '</td></tr>';
      });
      h += '</tbody></table>';
      document.getElementById('info-modules-content').innerHTML = h;
    }

    function renderInfoInfra(d) {
      const infra = d.infrastructure || [];
      let h = '';
      infra.forEach(function(s) {
        h += '<div class="info-kv"><span class="info-kv-label">' + s.name + '</span><span class="info-kv-value">' + s.endpoint + '</span></div>';
      });
      document.getElementById('info-infra-content').innerHTML = h || '<div class="empty">No infrastructure</div>';
    }

    function renderInfoDatabases(d) {
      const dbs = d.databases || [];
      let h = '';
      dbs.forEach(function(db) {
        h += '<div class="info-kv"><span class="info-kv-label">' + db.name + '</span><span class="info-kv-value">' + db.purpose + '</span></div>';
      });
      document.getElementById('info-databases-content').innerHTML = h || '<div class="empty">No databases</div>';
    }

    function renderInfoComponents(d) {
      const comps = d.coreComponents || [];
      if (!comps.length) { document.getElementById('info-components-content').innerHTML = '<div class="empty">No components</div>'; return; }
      let h = '<table class="info-table"><thead><tr><th>Component</th><th>Status</th><th>Description</th></tr></thead><tbody>';
      comps.forEach(function(c) {
        var badge = c.status === 'active' ? 'enabled' : 'disabled';
        h += '<tr><td><strong>' + c.name + '</strong></td>' +
          '<td><span class="info-badge ' + badge + '">' + c.status + '</span></td>' +
          '<td style="font-size:0.75rem;color:var(--text-secondary)">' + c.description + '</td></tr>';
      });
      h += '</tbody></table>';
      document.getElementById('info-components-content').innerHTML = h;
    }

    function renderInfoSkillsAndWorkflows(d) {
      var skills = d.skills || [];
      if (!skills.length) { document.getElementById('info-skills-content').innerHTML = '<div class="empty">No skills</div>'; return; }
      var totalWf = skills.reduce(function(s,sk){ return s + (sk.workflowCount||0); }, 0);
      var h = '<div style="margin-bottom:0.75rem;font-size:0.8rem;color:var(--text-secondary)">' + skills.length + ' skills, ' + totalWf + ' workflows</div>';
      skills.forEach(function(s, si) {
        var hasWf = s.workflows && s.workflows.length > 0;
        var chevron = hasWf ? '<span id="skill-chev-'+si+'" style="cursor:pointer;margin-right:0.4rem;font-size:0.7rem;color:var(--text-secondary)">&#9654;</span>' : '<span style="margin-right:0.4rem;font-size:0.7rem;color:var(--border-color)">&#9679;</span>';
        var onclick = hasWf ? ' onclick="toggleSkillWorkflows('+si+')" style="cursor:pointer"' : '';
        h += '<div class="info-kv"' + onclick + '>' + chevron + '<span class="info-kv-label" style="flex:0 0 180px">' + s.name + '</span>';
        h += '<span style="font-size:0.7rem;color:var(--text-secondary);flex:1">' + (s.description || '').substring(0,80) + '</span>';
        if (hasWf) h += '<span style="font-size:0.7rem;color:var(--accent-blue)">' + s.workflowCount + ' wf</span>';
        h += '</div>';
        if (hasWf) {
          h += '<div id="skill-wfs-'+si+'" style="display:none;padding-left:1.5rem;margin-bottom:0.5rem;border-left:2px solid var(--border-color)">';
          s.workflows.forEach(function(w) {
            h += '<div class="wf-item" onclick="event.stopPropagation();toggleWfEditor(\\''+s.name+'\\',\\''+w+'\\',this)">' +
              '<span>' + w + '</span></div>';
          });
          h += '</div>';
        }
      });
      document.getElementById('info-skills-content').innerHTML = h;
    }

    function toggleSkillWorkflows(idx) {
      var el = document.getElementById('skill-wfs-'+idx);
      var chev = document.getElementById('skill-chev-'+idx);
      if (!el) return;
      if (el.style.display === 'none') {
        el.style.display = 'block';
        if (chev) chev.innerHTML = '&#9660;';
      } else {
        el.style.display = 'none';
        if (chev) chev.innerHTML = '&#9654;';
      }
    }

    function toggleWfEditor(skill, name, clickedEl) {
      var existingEditor = clickedEl.nextElementSibling;
      if (existingEditor && existingEditor.classList.contains('wf-editor-inline')) {
        existingEditor.remove();
        return;
      }
      document.querySelectorAll('.wf-editor-inline').forEach(function(e){ e.remove(); });
      var editorDiv = document.createElement('div');
      editorDiv.className = 'wf-editor-inline';
      editorDiv.style.cssText = 'padding:0.75rem;margin:0.25rem 0;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px';
      editorDiv.innerHTML = '<div class="empty">Loading...</div>';
      clickedEl.after(editorDiv);
      fetch('/api/workflow/' + encodeURIComponent(skill) + '/' + encodeURIComponent(name))
        .then(function(r){ return r.json(); })
        .then(function(data){
          if (data.error) { editorDiv.innerHTML = '<div class="empty">Error: '+data.error+'</div>'; return; }
          renderInlineEditor(editorDiv, data, skill, name);
        })
        .catch(function(e){ editorDiv.innerHTML = '<div class="empty">Error: '+e.message+'</div>'; });
    }

    function renderInlineEditor(container, data, skill, name) {
      var steps = data.steps || [];
      var fullContent = data.content || '';
      var editorId = 'wfe-' + skill + '-' + name;
      var h = '';
      if (steps.length > 0) {
        steps.forEach(function(step, i) {
          h += '<div class="wf-step" id="'+editorId+'-step-'+i+'">' +
            '<div class="wf-step-header"><span class="wf-step-title">'+step.title+'</span>' +
            '<div class="wf-step-actions">' +
            '<button onclick="wfMoveUp(\\''+editorId+'\\','+i+')">&#9650;</button>' +
            '<button onclick="wfMoveDown(\\''+editorId+'\\','+i+')">&#9660;</button>' +
            '<button class="btn-del" onclick="wfDelStep(\\''+editorId+'\\','+i+')">&#10005;</button>' +
            '</div></div>' +
            '<textarea id="'+editorId+'-text-'+i+'">'+step.content.replace(/</g,'&lt;')+'</textarea></div>';
        });
      } else {
        h += '<div class="wf-step"><div class="wf-step-header"><span class="wf-step-title">Full Content</span></div>' +
          '<textarea id="'+editorId+'-full" style="min-height:150px">'+fullContent.replace(/</g,'&lt;')+'</textarea></div>';
      }
      h += '<div class="wf-toolbar">' +
        '<button class="btn-save" onclick="wfSave(\\''+skill+'\\',\\''+name+'\\',\\''+editorId+'\\')">Save</button>' +
        '<button class="btn-add" onclick="wfAddStep(\\''+editorId+'\\')">+ Add Step</button>' +
        '<button class="btn-close" onclick="this.closest(\\'.wf-editor-inline\\').remove()">Close</button>' +
        '<span id="'+editorId+'-status" style="font-size:0.75rem;color:var(--text-secondary);margin-left:auto;align-self:center"></span></div>';
      container.innerHTML = h;
      container._wfData = data;
      container._stepCount = steps.length;
    }

    function wfMoveUp(eid, idx) {
      var el = document.getElementById(eid+'-step-'+idx);
      if (el && el.previousElementSibling && el.previousElementSibling.classList.contains('wf-step'))
        el.parentNode.insertBefore(el, el.previousElementSibling);
    }
    function wfMoveDown(eid, idx) {
      var el = document.getElementById(eid+'-step-'+idx);
      if (el && el.nextElementSibling && el.nextElementSibling.classList.contains('wf-step'))
        el.parentNode.insertBefore(el.nextElementSibling, el);
    }
    function wfDelStep(eid, idx) {
      if (confirm('Delete step?')) { var el = document.getElementById(eid+'-step-'+idx); if(el) el.remove(); }
    }
    function wfAddStep(eid) {
      var toolbar = document.querySelector('#'+eid+'-status').closest('.wf-toolbar');
      if (!toolbar) return;
      var n = toolbar.parentNode.querySelectorAll('.wf-step').length;
      var div = document.createElement('div');
      div.className = 'wf-step';
      div.innerHTML = '<div class="wf-step-header"><span class="wf-step-title">New Step</span>' +
        '<div class="wf-step-actions"><button class="btn-del" onclick="this.closest(\\'.wf-step\\').remove()">&#10005;</button></div></div>' +
        '<textarea placeholder="### Step: Title..."></textarea>';
      toolbar.parentNode.insertBefore(div, toolbar);
    }
    function wfSave(skill, name, eid) {
      var statusEl = document.getElementById(eid+'-status');
      statusEl.textContent = 'Saving...'; statusEl.style.color = 'var(--accent-yellow)';
      var container = statusEl.closest('.wf-editor-inline');
      var textareas = container.querySelectorAll('.wf-step textarea');
      var data = container._wfData || {};
      var orig = data.content || '';
      var headerEnd = orig.indexOf('### Step ');
      var header = headerEnd > 0 ? orig.substring(0, headerEnd) : orig.split('\\n').slice(0,10).join('\\n')+'\\n\\n';
      var parts = [header];
      textareas.forEach(function(ta){ parts.push(ta.value); });
      var body = textareas.length > 0 ? parts.join('\\n\\n') : (container.querySelector('#'+eid+'-full') || {value:orig}).value;
      fetch('/api/workflow/'+encodeURIComponent(skill)+'/'+encodeURIComponent(name),{
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content:body})
      }).then(function(r){return r.json()}).then(function(d){
        statusEl.textContent = d.status==='saved' ? 'Saved!' : 'Error: '+(d.error||'?');
        statusEl.style.color = d.status==='saved' ? 'var(--accent-green)' : 'var(--accent-red)';
      }).catch(function(e){ statusEl.textContent='Error: '+e.message; statusEl.style.color='var(--accent-red)'; });
    }

    function renderInfoRules(d) {
      const rules = d.rules || [];
      let h = '<table class="info-table"><thead><tr><th>#</th><th>Rule</th><th>Summary</th></tr></thead><tbody>';
      rules.forEach(function(r, i) {
        h += '<tr><td style="font-weight:700;color:var(--accent-blue)">' + r.number + '</td>' +
          '<td><strong>' + r.name + '</strong></td>' +
          '<td style="font-size:0.75rem;color:var(--text-secondary)">' + r.summary + '</td></tr>';
      });
      h += '</tbody></table>';
      document.getElementById('info-rules-content').innerHTML = h;
    }

    function renderInfoMetrics(m) {
      var el = document.getElementById('info-metrics-content');
      if (!m) { el.innerHTML = '<div class="empty">No metrics data</div>'; return; }
      var h = '';
      var t = m.tasks || {};
      h += '<div class="info-kv"><span class="info-kv-label">Tasks Total</span><span class="info-kv-value">' + (t.total||0) + '</span></div>';
      h += '<div class="info-kv"><span class="info-kv-label">Completed</span><span class="info-kv-value">' + (t.completed||0) + '</span></div>';
      h += '<div class="info-kv"><span class="info-kv-label">In Progress</span><span class="info-kv-value">' + (t.inProgress||0) + '</span></div>';
      h += '<div class="info-kv"><span class="info-kv-label">Pending</span><span class="info-kv-value">' + (t.pending||0) + '</span></div>';
      var c = m.costs || {};
      h += '<div class="info-kv" style="margin-top:0.5rem;border-top:1px solid var(--border-color);padding-top:0.3rem"><span class="info-kv-label">Cost Total</span><span class="info-kv-value">$' + Number(c.total||0).toFixed(2) + '</span></div>';
      var o = m.observability || {};
      h += '<div class="info-kv"><span class="info-kv-label">Events Total</span><span class="info-kv-value">' + (o.totalEvents||0) + '</span></div>';
      h += '<div class="info-kv"><span class="info-kv-label">Events (24h)</span><span class="info-kv-value">' + (o.last24h||0) + '</span></div>';
      el.innerHTML = h;
    }

    // ============================================
    // INITIALIZATION
    // ============================================

    initTabNavigation();

    // TASK-3053: PLOCA SE PUNI NEOVISNO O WEBSOCKETU.
    //
    // Kvar (Goran, 29.07.2026: „ne vidim ni jedan task"): jedina dva puta do podataka bila su
    // ws.onopen -> fetchTasks() i setInterval ispod. Kako je connect() stajao IZNAD tog
    // setInterval-a, svaka iznimka iz new WebSocket(...) — a preglednik je baca kad je
    // veza blokirana (mijesani sadrzaj na HTTPS-u, posrednik, stroga polica) — prekidala je
    // izvodjenje prije nego se osvjezavanje uopce registrira. Rezultat: zaglavlje i stupci se
    // iscrtaju, zadataka nema NIKAD, a u konzoli stoji jedna jedina greska.
    //
    // Zato: prvo dohvat, pa tek onda veza, i to u try — WebSocket je ubrzanje (zivo
    // osvjezavanje), nikad preduvjet za prikaz.
    fetchProjectsForFilter();
    fetchTasks();
    setInterval(fetchTasks, 30000); // Refresh every 30s — radi i bez WebSocketa

    try {
      connect();
    } catch (e) {
      console.error('[WS] Zivo osvjezavanje nedostupno, ploca radi na osvjezavanju od 30 s:', e);
      const st = document.getElementById('status-text');
      if (st) st.textContent = 'Bez zive veze — osvjezavam svakih 30 s';
      document.getElementById('connection-status')?.classList.add('disconnected');
    }
  </script>
</body>
</html>`

// ============================================
// ============================================
// INFO PAYLOAD BUILDER
// ============================================

// ── Model catalog (SSoT za dropdown na Info tabu) ──────────────────────────
// spawnable=true → agent se MOŽE pokrenuti danas preko `claude --print --model`.
// spawnable=false → kandidat (Ollama itd.), treba API spawn path (F2 / TASK-2588).
// Ako Goran odabere override, sprema se u model-config.json → agentOverrides[id].
// Interface/glavna-petlja agenti — trajni procesi koji NE idu kroz resolveSpawnModel,
// pa im model-override nema efekta. Dropdown se zaključava, PUT ih odbija.
// Prazno: glavni agenti (REGOČ/Klaudio/Stribor) su ODKLJUČANI — model im se može mijenjati.
// REGOČ i Stribor override djeluje preko resolveSpawnModel (self/on-demand spawn);
// Klaudio override zahtijeva da telegram_agent poštuje agentOverrides[klaudio] (workstream B).
const FIXED_INTERFACE_AGENTS = new Set<string>([]);

const AVAILABLE_MODELS: Array<{ spec: string; provider: string; model: string; tier: string; label: string; spawnable: boolean }> = [
  { spec: 'anthropic:opus',   provider: 'anthropic', model: 'opus',   tier: 'frontier', label: 'Claude Opus',   spawnable: true },
  { spec: 'anthropic:sonnet', provider: 'anthropic', model: 'sonnet', tier: 'strong',   label: 'Claude Sonnet', spawnable: true },
  { spec: 'anthropic:haiku',  provider: 'anthropic', model: 'haiku',  tier: 'basic',    label: 'Claude Haiku',  spawnable: true },
  { spec: 'ollama:qwen3:8b',                  provider: 'ollama', model: 'qwen3:8b',                  tier: 'basic',  label: 'Ollama qwen3:8b',              spawnable: false },
  { spec: 'ollama:qwen2.5-coder:7b-instruct', provider: 'ollama', model: 'qwen2.5-coder:7b-instruct', tier: 'good',   label: 'Ollama qwen2.5-coder:7b',      spawnable: false },
  { spec: 'ollama:qwen3-coder:30b',           provider: 'ollama', model: 'qwen3-coder:30b',           tier: 'strong', label: 'Ollama qwen3-coder:30b',       spawnable: false },
  { spec: 'ollama:mistral:instruct',          provider: 'ollama', model: 'mistral:instruct',          tier: 'good',   label: 'Ollama mistral:instruct',      spawnable: false },
  { spec: 'ollama:devstral:latest',           provider: 'ollama', model: 'devstral:latest',           tier: 'strong', label: 'Ollama devstral:latest',       spawnable: false },
]

// Katalog + modeli CLI-login providera (geminicli/kimicli) koji se pojave TEK kad je prijava odrađena.
function getEffectiveModels(): typeof AVAILABLE_MODELS {
  const extra: typeof AVAILABLE_MODELS = []
  try {
    const H = process.env.HOME || ''
    const _cf = join(TM_ROOT, 'credentials.env')
    const _geminiKey = existsSync(_cf) && /^GEMINI_API_KEY=.+/m.test(readFileSync(_cf, 'utf-8'))
    if (existsSync(join(H, '.gemini/oauth_creds.json')) || _geminiKey) {
      extra.push(
        { spec: 'geminicli:gemini-2.5-pro',   provider: 'geminicli', model: 'gemini-2.5-pro',   tier: 'frontier', label: 'Gemini 2.5 Pro (Google API key)',   spawnable: true },
        { spec: 'geminicli:gemini-2.5-flash', provider: 'geminicli', model: 'gemini-2.5-flash', tier: 'good',     label: 'Gemini 2.5 Flash (Google API key)', spawnable: true },
      )
    }
    const kd = join(H, '.kimi-code/oauth')
    if (existsSync(kd)) { try { if (readdirSync(kd).length > 0) extra.push({ spec: 'kimicli:kimi-k2', provider: 'kimicli', model: 'kimi-k2', tier: 'strong', label: 'Kimi K2 (login)', spawnable: true }) } catch {} }
  } catch {}
  return [...AVAILABLE_MODELS, ...extra]
}

// Učitaj trenutne per-agent override-e iz model-config.json (model-agnostic SSoT).
function loadAgentOverrides(HOME: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const p = join(TM_ROOT, 'models/model-config.json')
    if (existsSync(p)) {
      const mc = JSON.parse(readFileSync(p, 'utf-8'))
      const ov = mc.agentOverrides || {}
      for (const [k, v] of Object.entries(ov)) {
        if (!k.startsWith('_') && typeof v === 'string') out[k] = v as string
      }
    }
  } catch {}
  return out
}

// Heuristika: mapiraj Ollama ime modela na quality tier (samo za prikaz).
function ollamaTierGuess(name: string): string {
  const n = name.toLowerCase()
  if (/embed/.test(n)) return 'classifier'
  if (/(30b|70b|large|coder:30)/.test(n)) return 'strong'
  if (/(1b|3b|mini|tiny|ministral-3|llama3\.2:3b)/.test(n)) return 'classifier'
  if (/coder|devstral|mistral/.test(n)) return 'good'
  return 'basic'
}

// Živi dohvat lokalnih Ollama modela s konfiguriranog servera (kao RAG).
async function fetchOllamaModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, '') + '/api/tags'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 4000)
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey
    const r = await fetch(url, { signal: ctrl.signal, headers })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json() as { models?: Array<{ name?: string }> }
    return (d.models || []).map(m => m.name || '').filter(Boolean)
  } finally {
    clearTimeout(t)
  }
}

// Providers + živi popis modela — hrani i dropdown po agentu i setup panel.
async function buildModelsAvailable(): Promise<{ providers: any[]; models: any[] }> {
  const HOME = process.env.HOME || os.homedir()
  let provCfg: Record<string, any> = {}
  try {
    const mc = JSON.parse(readFileSync(join(TM_ROOT, 'models/model-config.json'), 'utf-8'))
    provCfg = mc.providers || {}
  } catch {}

  const providers: any[] = []
  const models: any[] = []

  // Anthropic — pretplata, bez dodatnog setupa
  const anthEnabled = provCfg.anthropic?.enabled !== false
  const anthModels = AVAILABLE_MODELS.filter(m => m.provider === 'anthropic')
  providers.push({
    id: 'anthropic', name: 'Anthropic (Claude)', kind: 'subscription',
    needsSetup: false, enabled: anthEnabled, reachable: anthEnabled,
    baseUrl: null, hasAuth: true,
    authNote: 'Pretplata / ANTHROPIC_API_KEY — bez dodatnih postavki.',
    models: anthModels,
  })
  if (anthEnabled) models.push(...anthModels)

  // Ollama — lokalno, treba IP:port (token opcijski, samo iza proxyja)
  const oCfg = provCfg.ollama || {}
  const oEnabled = oCfg.enabled !== false
  const baseUrl = oCfg.baseUrl || process.env.TM_OLLAMA_URL || 'http://127.0.0.1:11434'
  const apiKey = typeof oCfg.apiKey === 'string' && oCfg.apiKey && !oCfg.apiKey.startsWith('env:') ? oCfg.apiKey : undefined
  const hasAuth = !!(oCfg.apiKey && oCfg.apiKey !== '')
  let oModels: any[] = []
  let reachable = false
  let error: string | null = null
  if (oEnabled) {
    try {
      const names = await fetchOllamaModels(baseUrl, apiKey)
      reachable = true
      oModels = names.map(n => ({
        spec: 'ollama:' + n, provider: 'ollama', model: n,
        tier: ollamaTierGuess(n), label: 'Ollama ' + n, spawnable: false,
      }))
    } catch (e: any) {
      error = String(e && e.message ? e.message : e)
    }
  }
  providers.push({
    id: 'ollama', name: 'Ollama (lokalno)', kind: 'local',
    needsSetup: true, enabled: oEnabled, reachable, baseUrl, hasAuth, error,
    authNote: 'Standardni Ollama nema lozinku — dovoljan je IP:port (kao RAG). Token samo ako je iza reverse-proxyja.',
    models: oModels,
  })
  models.push(...oModels)

  // OpenRouter — cloud, treba API ključ. Agentski tool-loop → spawnable (puni alati).
  const orCfg = provCfg.openrouter || {}
  const orEnabled = orCfg.enabled === true  // opt-in (default off)
  const orHasAuth = !!(orCfg.apiKey && orCfg.apiKey !== '')
  const OR_CURATED = [
    { spec: 'openrouter:z-ai/glm-5.2', provider: 'openrouter', model: 'z-ai/glm-5.2', tier: 'strong', label: 'GLM-5.2 (OpenRouter)', spawnable: true },
    { spec: 'openrouter:z-ai/glm-5',   provider: 'openrouter', model: 'z-ai/glm-5',   tier: 'strong', label: 'GLM-5 (OpenRouter)',   spawnable: true },
    { spec: 'openrouter:google/gemini-2.5-flash', provider: 'openrouter', model: 'google/gemini-2.5-flash', tier: 'good', label: 'Gemini 2.5 Flash — alati (OpenRouter)', spawnable: true },
    { spec: 'openrouter:google/gemini-2.5-pro', provider: 'openrouter', model: 'google/gemini-2.5-pro', tier: 'frontier', label: 'Gemini 2.5 Pro — alati (OpenRouter)', spawnable: true },
  ]
  providers.push({
    id: 'openrouter', name: 'OpenRouter (cloud)', kind: 'cloud-key',
    needsSetup: true, enabled: orEnabled, reachable: orEnabled && orHasAuth, baseUrl: 'https://openrouter.ai/api/v1', hasAuth: orHasAuth,
    authNote: 'Treba API ključ (sk-or-...). Agenti dobivaju PUNE alate (bash/read/write) preko agentic tool-loopa. Trošak se naplaćuje po pozivu.',
    models: orEnabled ? OR_CURATED : [],
  })
  if (orEnabled) models.push(...OR_CURATED)

  return { providers, models }
}

// PUT /api/models/providers/:id — postavke providera (enabled, baseUrl, token).
async function handleSetProvider(providerId: string, req: Request): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  if (!['anthropic', 'ollama', 'openai', 'google', 'openrouter'].includes(providerId)) {
    return json({ error: 'Unknown provider' }, 400)
  }
  try {
    const body = (await req.json()) as { enabled?: boolean; baseUrl?: string; apiKey?: string }
    const HOME = process.env.HOME || os.homedir()
    const mcPath = join(TM_ROOT, 'models/model-config.json')
    if (!existsSync(mcPath)) return json({ error: 'model-config.json not found' }, 500)
    const mc = JSON.parse(readFileSync(mcPath, 'utf-8'))
    if (!mc.providers) mc.providers = {}
    if (!mc.providers[providerId]) mc.providers[providerId] = {}
    const p = mc.providers[providerId]

    if (typeof body.enabled === 'boolean') p.enabled = body.enabled
    if (typeof body.baseUrl === 'string') {
      const u = body.baseUrl.trim()
      if (u && !/^https?:\/\/[^\s]+$/.test(u)) return json({ error: 'Invalid baseUrl (očekivano http://host:port)' }, 400)
      if (u) p.baseUrl = u
    }
    if (typeof body.apiKey === 'string') {
      if (body.apiKey === '') delete p.apiKey
      else p.apiKey = body.apiKey
    }

    const { writeFileSync: _wfs } = require('fs')
    _wfs(mcPath, JSON.stringify(mc, null, 2) + '\n')
    return json({ status: 'saved', providerId, enabled: p.enabled !== false, baseUrl: p.baseUrl || null, hasAuth: !!p.apiKey })
  } catch (err) {
    return json({ error: String(err) }, 400)
  }
}

function buildInfoPayload(): Record<string, unknown> {
  const HOME = process.env.HOME || os.homedir()
  const agentOverrides = loadAgentOverrides(HOME)

  // Load agent registry
  let agents: Record<string, unknown>[] = []
  let agentCount = 0
  try {
    const regPath = join(TM_ROOT, 'REGOC_AGENTS.json')
    if (existsSync(regPath)) {
      const reg = JSON.parse(readFileSync(regPath, 'utf-8'))
      const agentMap = reg.agents || {}
      agentCount = Object.keys(agentMap).length

      const tierMap: Record<string, string> = { opus: 'frontier', sonnet: 'strong', haiku: 'basic' }
      const reqMap: Record<string, { minContext: number; tools: boolean; notes: string }> = {
        regoc: { minContext: 128000, tools: true, notes: 'Orchestrator — frontier required' },
        kosjenka: { minContext: 128000, tools: true, notes: 'Architect — strategic planning' },
        jelena: { minContext: 128000, tools: true, notes: 'Engineer — code generation' },
        malik: { minContext: 128000, tools: true, notes: 'Security — OWASP, CVE awareness' },
        manda: { minContext: 128000, tools: false, notes: 'Researcher — deep analysis' },
        dora: { minContext: 128000, tools: false, notes: 'Analyst — multi-perspective' },
        potjeh: { minContext: 64000, tools: true, notes: 'QA — testing, verification' },
        gita: { minContext: 64000, tools: false, notes: 'Artist — HTML/SVG/Canvas' },
        grga: { minContext: 64000, tools: true, notes: 'Designer — UI/UX, vision preferred' },
        klaudio: { minContext: 32000, tools: false, notes: 'Telegram 24/7 — low cost, fast' },
        stribor: { minContext: 64000, tools: true, notes: 'Analiza glasa i govora — transkripcija, prozodija, dijarizacija' },
        emard: { minContext: 128000, tools: true, notes: 'FPGA Expert — Verilog, CDC, timing' },
      }

      agents = Object.entries(agentMap).map(([id, a]: [string, any]) => {
        const req = reqMap[id] || { minContext: 64000, tools: false, notes: '' }
        // Alati NE ovise o statičkoj reqMap zastavici nego o STVARNOM modelu:
        // svi Claude-spawnani agenti (claude --print / claude -p) imaju PUNE alate;
        // agent na lokalnom Ollama modelu (API spawn, text-only) NEMA alate.
        const ovSpec = agentOverrides[id]
        const effProvider = ovSpec ? String(ovSpec).split(':')[0] : 'anthropic'
        // Agentski CLI-jevi/tool-loop imaju PUNE alate: Claude (claude --print), Gemini (gemini --yolo),
        // Kimi (kimi CLI), OpenRouter (openrouter-agent tool-loop). Samo Ollama je tekstualno (bez alata).
        const hasTools = ['anthropic', 'geminicli', 'kimicli', 'openrouter'].includes(effProvider)
        return {
          id,
          name: a.name || id,
          role: a.role || '',
          minTier: tierMap[a.model] || 'strong',
          currentModel: a.model || 'unknown',
          override: agentOverrides[id] || null,
          fixed: FIXED_INTERFACE_AGENTS.has(id),
          minContext: req.minContext,
          requiresTools: hasTools,
          toolsNote: hasTools ? 'Puni alati (Bash, datoteke, RAG, web…)' : 'lokalno (Ollama) — tekstualno, bez alata',
          notes: req.notes,
        }
      })
    }
  } catch {}

  // Load model config
  let providers: Record<string, unknown>[] = []
  let providerCount = 0
  try {
    const mcPath = join(TM_ROOT, 'models/model-config.json')
    if (existsSync(mcPath)) {
      const mc = JSON.parse(readFileSync(mcPath, 'utf-8'))
      const provs = mc.providers || {}
      const defaults = mc.defaults || {}

      const providerModels: Record<string, Array<{ id: string; tier: string }>> = {
        anthropic: [
          { id: 'claude-opus-4-7', tier: 'frontier' },
          { id: 'claude-sonnet-4-6', tier: 'strong' },
          { id: 'claude-haiku-4-5', tier: 'basic' },
        ],
        openai: [
          { id: 'gpt-4o', tier: 'strong' },
          { id: 'gpt-4o-mini', tier: 'good' },
          { id: 'o4-mini', tier: 'strong' },
        ],
        google: [
          { id: 'gemini-2.5-pro', tier: 'frontier' },
          { id: 'gemini-2.5-flash', tier: 'good' },
        ],
        ollama: [
          { id: 'qwen3:8b', tier: 'basic' },
          { id: 'llama3.2:3b', tier: 'classifier' },
          { id: 'qwen3-embedding:8b', tier: 'classifier' },
        ],
      }

      providers = Object.entries(provs)
        .filter(([k]) => k !== 'custom')
        .map(([id, p]: [string, any]) => ({
          id,
          name: id.charAt(0).toUpperCase() + id.slice(1),
          enabled: p.enabled || false,
          online: p.enabled || false,
          models: providerModels[id] || [],
        }))

      providerCount = providers.filter((p: any) => p.enabled).length
    }
  } catch {}

  // Load module config
  let modules: Record<string, unknown>[] = []
  let modulesEnabled = 0
  try {
    const modPath = join(TM_ROOT, 'modules/module-config.json')
    if (existsSync(modPath)) {
      const mc = JSON.parse(readFileSync(modPath, 'utf-8'))
      const mods = mc.modules || {}

      const degradationMap: Record<string, string> = {
        'mod-rag': 'Keyword search (ripgrep)',
        'mod-telegram': 'Console notifications',
        'mod-teamspeak': 'No voice chat',
        'mod-voice': 'Text-only notifications',
        'mod-dashboard': 'CLI-only task management',
        'mod-email': 'No email',
        'mod-gitlab': 'No GitLab',
        'mod-github': 'No GitHub',
        'mod-nextcloud': 'No file sharing',
        'mod-security': 'No tool inspection',
        'mod-knowledge': 'No knowledge graph',
      }

      const providesMap: Record<string, string[]> = {
        'core-daemon': ['messaging', 'orchestration', 'agent-spawn'],
        'core-models': ['model-routing', 'multi-provider'],
        'core-taskmanager': ['task-crud', 'task-api'],
        'mod-rag': ['semantic-search', 'embeddings'],
        'mod-telegram': ['telegram-messaging', 'notifications'],
        'mod-teamspeak': ['voice-chat'],
        'mod-voice': ['tts', 'voice-notifications'],
        'mod-dashboard': ['web-dashboard', 'task-api'],
        'mod-email': ['email-send', 'email-receive'],
        'mod-gitlab': ['git-hosting', 'ci-cd'],
        'mod-github': ['git-hosting-public'],
        'mod-nextcloud': ['file-sharing', 'deck-tasks'],
        'mod-security': ['tool-inspection', 'prompt-guard', 'audit-log'],
        'mod-knowledge': ['knowledge-graph', 'wikilinks'],
      }

      modules = Object.entries(mods).map(([id, m]: [string, any]) => {
        const req = id.startsWith('core-')
        const en = m.enabled !== false
        if (en) modulesEnabled++
        return {
          id,
          name: id.replace('core-', 'Core: ').replace('mod-', ''),
          enabled: en,
          required: req,
          provides: providesMap[id] || [],
          degradation: degradationMap[id] || '-',
        }
      })
    }
  } catch {}

  const rules = [
    { number: 1, name: 'WRITE PERMISSIONS', summary: 'Only ./  and ~/app/regoc_system/ — rest is read-only' },
    { number: 2, name: 'RAG-FIRST', summary: 'Search RAG before saying "I don\'t know"' },
    { number: 3, name: 'SAMO REGOČ AGENTI', summary: '12 named agents only — never PAI generic (Serena, Marcus...)' },
    { number: 4, name: 'AGENTFACTORY OBAVEZAN', summary: 'Pre-load context, backstory, personality at spawn' },
    { number: 5, name: 'ERROR TRACKING', summary: 'Investigate → fix root cause → document in LESSONS/ → RAG' },
    { number: 6, name: 'ZOD VALIDATION', summary: 'Runtime type safety for all agents' },
    { number: 7, name: 'SERENA MCP', summary: 'Use for files >1000 lines (70-90% token savings)' },
    { number: 8, name: 'SECURITY ISOLATION', summary: 'Gita & Grga: no IPs, ports, paths, credentials' },
    { number: 9, name: 'INFRASTRUCTURE', summary: 'TaskWebUI:17781 | Voice:8888 | ChromaDB:18765 | Ollama:11434' },
    { number: 10, name: 'CONTEXT 75%', summary: 'Auto-save to RAG when context exceeds 75%' },
    { number: 11, name: 'CHECKPOINT FIRST', summary: 'CHECKPOINT block BEFORE task, not after' },
    { number: 12, name: 'PROGRESS NOTES', summary: 'Agents update TaskManager every 5 min' },
    { number: 13, name: '/tmp PROHIBITION', summary: 'Use ~/.tmp/ not /tmp/ (tmpfs too small)' },
    { number: 14, name: 'DOCKER PERSISTENCE', summary: 'Everything in volume mounts' },
    { number: 15, name: 'AUTO RAG SAVE', summary: 'Save to RAG immediately after every research' },
    { number: 16, name: 'MULTI-AGENT', summary: 'Kosjenka→design, Jelena→impl, Potjeh→test, Malik→security' },
    { number: 17, name: 'MONITORMODELOOP', summary: 'Continuous monitoring — check queue, spawn agents' },
    { number: 18, name: 'run_in_background=BROKEN', summary: 'Never use! Output is lost. BUG in Task tool.' },
    { number: 19, name: 'DELEGATE ALL TASKS', summary: 'Don\'t work alone — spawn agents for everything' },
    { number: 20, name: 'NEVER GENERIC FOR NAMED', summary: 'Always full identity via AgentFactory' },
    { number: 21, name: 'KLAUDIO MEMORY', summary: '5 sessions, 30 min = new session, SQLite' },
    { number: 22, name: 'MESSAGE QUEUE', summary: 'SELECT/INSERT/UPDATE messages in messages.db' },
    { number: 23, name: 'ALWAYS TEST BEFORE DONE', summary: 'Never assume it works — VERIFY!' },
  ]

  return {
    system: {
      version: '5.0.0',
      fullName: 'REsursni Gestor za Orkestraciju Članova',
      principle: 'Orchestrate, don\'t execute',
      orchestratorModel: 'opus (frontier tier)',
      agentCount,
      moduleCount: modules.length,
      modulesEnabled,
      providerCount,
      platform: process.platform + ' ' + process.arch,
    },
    providers,
    agents,
    modules,
    infrastructure: [
      { name: 'TaskWebUI', endpoint: 'localhost:17781' },
      { name: 'VoiceServer', endpoint: 'localhost:8888' },
      { name: 'RegocPulse', endpoint: 'localhost:17780 (planned)' },
      { name: 'ChromaDB', endpoint: (process.env.TM_CHROMA_HOST || '127.0.0.1') + ':' + (process.env.TM_CHROMA_PORT || '8000') },
      { name: 'Ollama', endpoint: (process.env.TM_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/^https?:\/\//, '') },
      { name: 'STT Server', endpoint: 'localhost:8787 (disabled)' },
    ],
    databases: [
      { name: 'messages.db', purpose: 'Inter-agent communication (MessageQueue)' },
      { name: 'tasks.db', purpose: 'Zadatci, projekti, red izvrsavanja i graf znanja' },
      { name: 'audit.db', purpose: 'Security audit log' },
    ],
    rules,
    availableModels: getEffectiveModels(),
    coreComponents: [
      { name: 'RegocDaemon', status: 'active', description: 'Main orchestration daemon — polls MessageQueue, spawns agents, watchdog' },
      { name: 'UnifiedSpawnPipeline', status: 'active', description: 'Complete agent prompt builder — 7 sections (checkpoint, identity, awareness, knowledge, RAG, verification, task)' },
      { name: 'SystemAwarenessBlock', status: 'active', description: 'Compact 450-token system context injected into every agent prompt' },
      { name: 'ModelRouter', status: 'active', description: 'AI model-agnostic routing — 4 providera (Anthropic, OpenAI, Google, Ollama)' },
      { name: 'ModuleRegistry', status: 'active', description: 'Plug & play module system s enable/disable i graceful degradation' },
      { name: 'ModeClassifier', status: 'active', description: 'Effort tier routing (E1-E5) — rule-based, bez AI poziva' },
      { name: 'MonitorLoop v4.0', status: 'active', description: '7-fazni execution loop: OBSERVE→THINK→PLAN→BUILD→EXECUTE→VERIFY→LEARN' },
      { name: 'HelpPipeline', status: 'active', description: 'Agent-to-agent help requests — routing po tipu (decision/review/expertise/unblock)' },
      { name: 'AgentSignals (BTW)', status: 'active', description: 'File-based signaling za slanje poruka running agentu (BTW/REDIRECT/STOP/CONTEXT)' },
      { name: 'AgentCommunicationBridge', status: 'active', description: 'Bridges HelpPipeline responses → AgentSignals za live delivery' },
      { name: 'AgentPool', status: 'active', description: 'Warm agent pool — persistent context za opus agente (max 3, 15min)' },
      { name: 'AgentCheckpoint', status: 'active', description: 'CHECKPOINT block generator — peer message provjera od SVIH agenata' },
      { name: 'AgentLogger', status: 'active', description: 'Unified JSONL logging — jedan log po agent spawnu, capture stdout' },
      { name: 'SecurityPipeline', status: 'active', description: '3 inspektora (Pattern, Egress, Rules) na svaki tool poziv, localSafe mode' },
      { name: 'PromptGuard', status: 'active', description: 'Prompt injection detekcija — 13 pattern rules, HR+EN, score 0-100' },
      { name: 'AuditLogger', status: 'active', description: 'Centralizirani security audit log (SQLite, 90-day retention)' },
      { name: 'ISAGenerator', status: 'active', description: 'Ideal State Artifact — strukturirani task format s effort tier prilagodbom' },
      { name: 'KnowledgeGraph', status: 'active', description: 'SQLite relacijski graf znanja — 8 tipova relacija, BFS traversal' },
      { name: 'WikilinkParser', status: 'active', description: '[[link]] resolution u memory fajlovima' },
      { name: 'KnowledgeHarvester', status: 'active', description: 'Automatska ekstrakcija znanja iz sesija (lesson/decision/pattern/error)' },
      { name: 'ObservabilityLogger', status: 'active', description: 'JSONL structured logging — tool calls, agent spawns, task updates' },
      { name: 'CostTracker', status: 'active', description: 'API token usage i cost tracking per agent/task/model' },
      { name: 'HealthSnapshot', status: 'active', description: 'Automatski health check svih servisa (5min interval)' },
      { name: 'RegocPulse', status: 'planned', description: 'Unified service manager — health check, auto-restart, circuit breaker (port 17780)' },
      { name: 'Installer Wizard', status: 'active', description: '10-step interactive CLI setup wizard za modularnu instalaciju' },
    ],
    skills: (() => {
      const skillsDir = join(HOME, '.claude/skills')
      try {
        const dirs = readdirSync(skillsDir).filter(d => {
          try { return statSync(join(skillsDir, d)).isDirectory() && !d.startsWith('_') && !d.startsWith('.') } catch { return false }
        }).sort()
        return dirs.map(name => {
          const skillFile = join(skillsDir, name, 'SKILL.md')
          let description = ''
          if (existsSync(skillFile)) {
            const content = readFileSync(skillFile, 'utf-8')
            const descMatch = content.match(/description:\s*(.+)/i)
            if (descMatch) description = descMatch[1].trim().substring(0, 120)
          }
          const wfDir = join(skillsDir, name, 'Workflows')
          let workflows: string[] = []
          try { if (existsSync(wfDir)) workflows = readdirSync(wfDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md','')) } catch {}
          return { name, description, workflowCount: workflows.length, workflows }
        })
      } catch { return [] }
    })(),
  }
}

// API HANDLERS
// ============================================

// PUT /api/agents/:id/model — postavi ili obriši per-agent model override.
// Body: { model: string }  — "" ili "default" briše override (agent koristi zadani tier model).
// Whitelist: samo spec-ovi iz AVAILABLE_MODELS. Sprema u model-config.json → agentOverrides[id].
async function handleSetAgentModel(agentId: string, req: Request): Promise<Response> {
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })

  if (!/^[a-z0-9_-]+$/.test(agentId)) {
    return json({ error: 'Invalid agent id' }, 400)
  }
  try {
    const body = (await req.json()) as { model?: string | null }
    const raw = (body.model ?? '').toString().trim()
    const clearing = raw === '' || raw === 'default' || raw === 'zadano'

    // Interface/glavna-petlja agenti ne troše override — odbij postavljanje (clear je OK, no-op).
    if (FIXED_INTERFACE_AGENTS.has(agentId) && !clearing) {
      return json({ error: `Agent '${agentId}' je interface/glavna petlja — model override se ne primjenjuje.` }, 400)
    }

    if (!clearing) {
      // Validiraj protiv statičkih (Anthropic) + ŽIVIH modela (Ollama /api/tags),
      // jer dropdown nudi žive modele — inače bi ih PUT odbio.
      let known = getEffectiveModels().some(m => m.spec === raw)
      if (!known) {
        try {
          const av = await buildModelsAvailable()
          known = av.models.some((m: any) => m.spec === raw)
        } catch {}
      }
      if (!known) return json({ error: `Unknown model spec '${raw}'` }, 400)
    }

    const HOME = process.env.HOME || os.homedir()
    const mcPath = join(TM_ROOT, 'models/model-config.json')
    if (!existsSync(mcPath)) return json({ error: 'model-config.json not found' }, 500)

    const mc = JSON.parse(readFileSync(mcPath, 'utf-8'))
    if (!mc.agentOverrides || typeof mc.agentOverrides !== 'object') mc.agentOverrides = {}

    if (clearing) {
      delete mc.agentOverrides[agentId]
    } else {
      mc.agentOverrides[agentId] = raw
    }

    const { writeFileSync: _wfs } = require('fs')
    _wfs(mcPath, JSON.stringify(mc, null, 2) + '\n')

    const spawnable = clearing ? null : (getEffectiveModels().find(m => m.spec === raw)?.spawnable ?? false)
    return json({ status: 'saved', agentId, model: clearing ? null : raw, spawnable })
  } catch (err) {
    return json({ error: String(err) }, 400)
  }
}

function handleGetTasks(url: URL): Response {
  // Build filter object from query params
  const rawFilter: Record<string, unknown> = {}

  const status = url.searchParams.get('status')
  const assignee = url.searchParams.get('assignee')
  const priority = url.searchParams.get('priority')
  const tag = url.searchParams.get('tag')
  const search = url.searchParams.get('search')
  const projectId = url.searchParams.get('projectId')

  if (status) rawFilter.status = status
  if (assignee) rawFilter.assignee = assignee
  if (priority) rawFilter.priority = parseInt(priority)
  if (tag) rawFilter.tag = tag
  if (search) rawFilter.search = search
  if (projectId) rawFilter.projectId = projectId

  // Validate with Zod
  const parseResult = TaskFilterSchema.safeParse(rawFilter)
  if (!parseResult.success) {
    return new Response(JSON.stringify({
      error: 'Validation failed',
      details: parseResult.error.issues
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const validatedFilter = parseResult.data

  // SQL-Only: Build filter for TaskManagerSQL (no MD merge needed)
  const filter: any = {}
  if (validatedFilter.status) filter.status = validatedFilter.status
  if (validatedFilter.assignee) filter.assignee = validatedFilter.assignee
  if (validatedFilter.priority) filter.priority = validatedFilter.priority
  if (validatedFilter.projectId) filter.projectId = validatedFilter.projectId
  if (validatedFilter.search) filter.search = validatedFilter.search

  const tasks = taskManager.getTasks(filter)

  return new Response(JSON.stringify(tasks), {
    headers: { 'Content-Type': 'application/json' }
  })
}

function handleGetTask(taskId: string): Response {
  const task = taskManager.getTask(taskId)

  if (!task) {
    return new Response(JSON.stringify({ error: 'Task not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify(task), {
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * WARN o progutanim poljima na POST /api/tasks — ODGOĐEN do ishoda zahtjeva (Z4/TASK-3010).
 *
 * KVAR: 28.07. je REGOČ poslao `project` umjesto `projectId` na 7 zadataka. API je vratio
 * 201, polje je nestalo, zadatci su ostali bez projekta. Upozorenje je POSTOJALO, ali je
 * ispisano PRIJE nego zadatak dobije ID, pa se nije imalo s čime povezati — sedam sirotih
 * redaka "nepoznata polja ignorirana: project" i nijedna žrtva.
 *
 * ZAŠTO ODGODA, A NE DVA POVEZANA RETKA: ID je jedino što retku daje vrijednost; redak bez
 * njega je točno ono što se pokazalo neupotrebljivim. Dva retka traže korelacijski ključ,
 * udvostručuju obujam i od čitatelja traže spajanje — a i dalje je jedan od njih šum.
 * Zato: TOČNO JEDAN WARN po zahtjevu koji nešto proguta, ispisan kad se ishod zna.
 *
 * CIJENA ODGODE koju ovo mora platiti: ako zahtjev nikad ne stigne do stvaranja (Zod 400,
 * anti-echo 422, iznimka), odgođeni ispis bi se izgubio — gore nego danas. Zato se poziva
 * na SVIM izlazima iz handlera, a umjesto ID-a nosi razlog odbijanja.
 */
function warnCreateSwallowedFields(
  fields: { unknown: string[]; conflicts: string[] } | null,
  outcome: string,
): void {
  if (!fields) return
  if (fields.unknown.length === 0 && fields.conflicts.length === 0) return
  const parts: string[] = []
  if (fields.unknown.length > 0) parts.push(`nepoznata polja ignorirana: ${fields.unknown.join(', ')}`)
  // conflicts = poslana OBA naziva istog polja; camelCase pobjeđuje, alias se guta.
  // Isti razred tihog gubitka, pa ide u isti redak (odgovor se NE mijenja — v. dolje).
  if (fields.conflicts.length > 0) parts.push(`dvostruki naziv, alias ignoriran: ${fields.conflicts.join(', ')}`)
  console.warn(`[API] ${outcome} POST /api/tasks — ${parts.join('; ')}`)
}

async function handleCreateTask(req: Request): Promise<Response> {
  // Izvan try-a: catch mora znati što je progutano da se trag ne izgubi na iznimci.
  let createFields: { normalized: Record<string, unknown>; unknown: string[]; conflicts: string[] } | null = null
  try {
    const body = await req.json()

    // Nazivi polja (D6 / TASK-2976) — isti prijevod kao na PUT-u, ali BEZ tvrdog 400:
    // stvaranje zadatka je životna funkcija ploče (daemon, UI, agenti, skripte, cron) i
    // odbijanje zbog bezopasnog viška polja srušilo bi dotok posla. Kompromis: zadatak se
    // stvori, ali odgovor NOSI popis progutanih polja i log ih zapiše upozorenjem —
    // ključno je da gutanje više nije nevidljivo. Ispis je odgođen do ID-a zadatka
    // (v. warnCreateSwallowedFields); ovdje se samo prikupi.
    createFields = normalizeTaskFields(body, CREATE_TASK_FIELDS)

    // Validate with Zod
    const parseResult = CreateTaskInputSchema.safeParse(createFields.normalized)
    if (!parseResult.success) {
      warnCreateSwallowedFields(createFields, 'ODBIJEN(400 validation)')
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const validatedData = parseResult.data

    // Anti-echo guard: reject tasks whose "spec" is itself a recycled REGOČ agent
    // report (📋 SUMMARY / 🔍 ANALYSIS / ⚡ ACTIONS ... ≥3 markers) rather than an
    // actionable specification. This is the structural source of the stand-down
    // loop (TASK-2422→2423→2424): a stand-down report becomes a new task, which
    // produces another stand-down report. See DispatchGuard.ts + memory
    // [[regoc-claude-print-delegation-loop]]. Single ingress chokepoint — every
    // creator (HTTP UI, RegocDaemon, agents) POSTs through here.
    if (isRecycledAgentReport(`${validatedData.title ?? ''}\n${validatedData.description ?? ''}`)) {
      console.warn(`[TaskWebUI] BLOCKED recycled-report task creation (anti-echo guard): "${(validatedData.title ?? '').slice(0, 80)}"`)
      warnCreateSwallowedFields(createFields, 'ODBIJEN(422 recycled_report)')
      return new Response(JSON.stringify({
        error: 'Recycled agent report rejected',
        code: 'recycled_report',
        reason: 'Sadržaj zadatka je recikliran REGOČ izvještaj (≥3 format-markera: 📋 SUMMARY / 🔍 ANALYSIS / ⚡ ACTIONS ...), ne specifikacija. Pošalji pravu spec: ŠTO / ZAŠTO / KOJI fajlovi / KRITERIJ za done.',
      }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Map validated data to TaskManagerSQL input format
    const input = {
      title: validatedData.title,
      description: validatedData.description,
      priority: validatedData.priority,
      assignee: validatedData.assignee,
      blockedBy: validatedData.blockedBy,
      tags: validatedData.tags,
      projectId: validatedData.projectId,
      // Stvaratelj se dosad tvrdo upisivao kao 'user' i tko god ga je poslao — nestao je.
      // Sad se poštuje ako je poslan (createdBy ili created_by), uz isti default.
      createdBy: typeof createFields.normalized.createdBy === 'string' && createFields.normalized.createdBy
        ? String(createFields.normalized.createdBy).slice(0, 64)
        : 'user',
    }

    const task = taskManager.createTask(input)

    // TU je ID konačno poznat — jedini trenutak u kojem se gutanje može povezati sa žrtvom.
    warnCreateSwallowedFields(createFields, task.id)

    // Broadcast to WebSocket clients
    const message = JSON.stringify({ type: 'task_created', task })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return new Response(JSON.stringify(
      createFields.unknown.length > 0
        ? { ...task, warnings: { ignoredFields: createFields.unknown } }
        : task
    ), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    // Iznimka nakon normalizacije (npr. pad INSERT-a): zadatka nema, ali trag ostaje.
    warnCreateSwallowedFields(createFields, `ODBIJEN(500/iznimka: ${String(error).slice(0, 80)})`)
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// Globalni JSON-response helper (lokalni `const json` u drugim funkcijama ga zasjenjuju).
function json(o: unknown, s = 200): Response {
  return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
}

// ============================================================================
// LOGIN PROVIDERS — prijava preko linka (copy-link + paste) iz TaskManagera.
// CLI-jevi (kimi/gemini/claude) traže PTY → koristimo `script -qfec` (bez node-pty).
// Uspjeh = pojava creds-datoteke → providers.<id>.enabled=true (ulazi u listu modela).
// ============================================================================
interface LoginProviderDef { id: string; name: string; kind: 'oauth-cli' | 'apikey'; cmd?: string; bin?: string; creds: string; envKey?: string; install?: string }
const LOGIN_PROVIDERS: LoginProviderDef[] = [
  { id: 'kimicli',    name: 'Kimi',                kind: 'oauth-cli', cmd: 'kimi login',        bin: 'kimi',   creds: '~/.kimi-code/oauth' },
  { id: 'geminicli',  name: 'Gemini (Google)',     kind: 'oauth-cli', cmd: 'gemini',            bin: 'gemini', creds: '~/.gemini/oauth_creds.json', envKey: 'GEMINI_API_KEY' },
  { id: 'claude',     name: 'Claude (Anthropic)',  kind: 'oauth-cli', cmd: 'claude setup-token', bin: 'claude', creds: '~/.claude/.credentials.json', install: 'curl -fsSL https://claude.ai/install.sh | bash' },
  { id: 'openrouter', name: 'OpenRouter (cloud)',  kind: 'apikey',    creds: '', envKey: 'OPENROUTER_API_KEY' },
]
interface LoginSess { proc: any; url: string; buf: string; ok: boolean; done: boolean; err: string; started: number }
const loginSessions = new Map<string, LoginSess>()

function loginHomeExpand(p: string): string { const H = process.env.HOME || ''; return p.startsWith('~/') ? join(H, p.slice(2)) : p }
function loginBinPath(bin?: string): string | null {
  if (!bin) return null
  const H = process.env.HOME || ''
  for (const d of [join(H, '.local/node/bin'), join(H, '.local/bin'), '/usr/local/bin', '/usr/bin']) {
    const f = join(d, bin); if (existsSync(f)) return f
  }
  return null
}
function loginCredsPresent(def: LoginProviderDef): boolean {
  try {
    if (def.kind === 'apikey') {
      const f = loginHomeExpand(process.env.TM_CREDENTIALS_FILE || '~/.taskmanager/credentials.env')
      return existsSync(f) && new RegExp('^' + def.envKey + '=.+', 'm').test(readFileSync(f, 'utf-8'))
    }
    // oauth-cli s envKey (npr. Gemini): smatra se konfiguriranim i ako je API ključ u credentials.env
    if (def.envKey) {
      const f = loginHomeExpand(process.env.TM_CREDENTIALS_FILE || '~/.taskmanager/credentials.env')
      if (existsSync(f) && new RegExp('^' + def.envKey + '=.+', 'm').test(readFileSync(f, 'utf-8'))) return true
    }
    const p = loginHomeExpand(def.creds)
    if (!existsSync(p)) return false
    const st = statSync(p)
    return st.isDirectory() ? readdirSync(p).length > 0 : st.size > 0
  } catch { return false }
}
function loginSetProviderEnabled(id: string, enabled: boolean): void {
  try {
    const mcPath = loginHomeExpand(process.env.TM_MODEL_CONFIG || '~/.taskmanager/models/model-config.json')
    const mc = existsSync(mcPath) ? JSON.parse(readFileSync(mcPath, 'utf-8')) : {}
    mc.providers = mc.providers || {}
    mc.providers[id] = { ...(mc.providers[id] || {}), enabled }
    writeFileSync(mcPath, JSON.stringify(mc, null, 2))
  } catch {}
}
function loginSpawnEnv(): Record<string, string> {
  const H = process.env.HOME || ''
  return {
    PATH: `${join(H, '.local/node/bin')}:${join(H, '.local/bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    HOME: H, USER: process.env.USER || 'regoc', TERM: 'xterm-256color',
    GOOGLE_GENAI_USE_GCA: 'true',  // Gemini → OAuth Login-with-Google put
  }
}
// Potrošnja trenutne Claude sesije za statusnu traku (TASK-2694).
// Logika je u src/SessionUsage.ts (jedinično testirana): prvo keš u memoriji,
// pa keš koji pišu session_usage.py hookovi, i tek ako je oboje starije od praga
// → svjež probe. Bez toga bi prikaz "svake minute" znao satima visjeti na istoj
// brojci kad hookovi ne pišu (mirna sesija, drugi agenti troše kvotu).
const sessionUsageState: UsageState = {}
const sessionUsageDeps = createDefaultDeps(sessionUsageState)

async function handleSessionUsage(req?: Request): Promise<Response> {
  // ?force=1 → I/O u konzoli; skraćuje prag svježine, ali probe i dalje ima donju branu.
  const force = req ? new URL(req.url).searchParams.get('force') === '1' : false
  const u = await resolveSessionUsage({ force }, sessionUsageDeps)
  // A7/TASK-3006: zona se MORA navesti izrijekom. Kontejner nema `TZ` (radi u UTC-u), a
  // `TIME_ZONE=Europe/Zagreb` runtime ne gleda — pa je traka za reset u 02:40 UTC pisala
  // „02:40" iako je stvarno 04:40 po Zagrebu. Formatiranje je na jednom mjestu
  // (`QuotaWakeup.formatLocalTime`) da prikaz i okidač ne mogu razići brojke.
  let resetLocal: string | null = null
  try {
    if (u.sessionResetAt) resetLocal = formatLocalTime(u.sessionResetAt)
  } catch {}
  return json({
    session_percent: u.sessionPercent,
    weekly_percent: u.weeklyPercent,
    session_reset_at: u.sessionResetAt,
    session_reset_local: resetLocal,
    weekly_reset_at: u.weeklyResetAt,
    status: u.status,
    age_s: Math.round(u.ageMs / 1000),
    source: u.source,
    stale: u.stale,
    error: u.error,
  })
}

function handleLoginStatus(): Response {
  const list = LOGIN_PROVIDERS.map(def => {
    const s = loginSessions.get(def.id)
    return {
      id: def.id, name: def.name, kind: def.kind,
      installed: def.kind === 'apikey' ? true : !!loginBinPath(def.bin),
      loggedIn: loginCredsPresent(def),
      apikey: !!def.envKey,
      active: !!s && !s.done,
      url: s?.url || '',
      installCmd: def.install || '',
    }
  })
  return json({ providers: list })
}
async function handleLoginStart(req: Request): Promise<Response> {
  try {
    const { id } = await req.json() as { id: string }
    const def = LOGIN_PROVIDERS.find(d => d.id === id)
    if (!def || def.kind !== 'oauth-cli') return json({ error: 'Nepoznat OAuth provider' }, 400)
    if (!loginBinPath(def.bin)) return json({ error: 'not-installed', installCmd: def.install || '' }, 409)
    const prev = loginSessions.get(id); if (prev && !prev.done) { try { prev.proc.kill() } catch {} }
    // Gemini: seed OAuth (Login-with-Google) auth-tip da preskoči interaktivni izbornik i ispiše
    // Google URL (redirect na codeassist.google.com/authcode → korisnik dobije KOD za paste).
    if (id === 'geminicli') {
      try {
        const gdir = loginHomeExpand('~/.gemini'); if (!existsSync(gdir)) mkdirSync(gdir, { recursive: true })
        const gset = join(gdir, 'settings.json')
        let cfg: any = {}; try { if (existsSync(gset)) cfg = JSON.parse(readFileSync(gset, 'utf-8')) } catch {}
        cfg.selectedAuthType = 'oauth-personal'
        cfg.security = { ...(cfg.security || {}), auth: { ...((cfg.security || {}).auth || {}), selectedType: 'oauth-personal' } }
        writeFileSync(gset, JSON.stringify(cfg, null, 2))
      } catch {}
    }
    // `script -qfec "<cmd>" /dev/null` alocira PTY; -f flush odmah.
    const proc = Bun.spawn(['script', '-qfec', def.cmd!, '/dev/null'], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: loginSpawnEnv(), cwd: process.env.HOME,
    })
    const sess: LoginSess = { proc, url: '', buf: '', ok: false, done: false, err: '', started: Date.now() }
    loginSessions.set(id, sess)
    ;(async () => {
      try {
        const reader = proc.stdout.getReader(); const dec = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          sess.buf += dec.decode(value, { stream: true })
          if (!sess.url) { const m = sess.buf.replace(/\r/g, '').match(/https?:\/\/[^\s"'<>]+/); if (m) sess.url = m[0] }
          if (loginCredsPresent(def)) break
        }
      } catch {}
      sess.ok = loginCredsPresent(def); sess.done = true
      if (sess.ok) loginSetProviderEnabled(id, true)
      try { proc.kill() } catch {}
    })()
    // Kratko pričekaj da URL stigne (device/oauth flow ispisuje ga u 1-2s)
    for (let i = 0; i < 30 && !sess.url && !sess.done; i++) await new Promise(r => setTimeout(r, 200))
    return json({ ok: true, url: sess.url, active: !sess.done })
  } catch (e: any) { return json({ error: String(e?.message || e) }, 500) }
}
function handleLoginPoll(url: URL): Response {
  const id = url.searchParams.get('id') || ''
  const def = LOGIN_PROVIDERS.find(d => d.id === id)
  if (!def) return json({ error: 'unknown' }, 404)
  const s = loginSessions.get(id)
  const loggedIn = loginCredsPresent(def)
  if (loggedIn && s && !s.done) { s.done = true; s.ok = true; loginSetProviderEnabled(id, true) }
  return json({ id, url: s?.url || '', loggedIn, done: s?.done ?? !s, active: !!s && !s.done, tail: (s?.buf || '').replace(/\r/g, '').slice(-400) })
}
async function handleLoginPaste(req: Request): Promise<Response> {
  try {
    const { id, code } = await req.json() as { id: string; code: string }
    const s = loginSessions.get(id)
    if (!s || s.done) return json({ error: 'Nema aktivne sesije' }, 409)
    s.proc.stdin.write((code || '') + '\n'); s.proc.stdin.flush?.()
    return json({ ok: true })
  } catch (e: any) { return json({ error: String(e?.message || e) }, 500) }
}
async function handleLoginApikey(req: Request): Promise<Response> {
  try {
    const { id, key } = await req.json() as { id: string; key: string }
    const def = LOGIN_PROVIDERS.find(d => d.id === id)
    if (!def || !def.envKey) return json({ error: 'Provider ne podržava API ključ' }, 400)
    if (!key || !key.trim()) return json({ error: 'Prazan ključ' }, 400)
    const f = loginHomeExpand(process.env.TM_CREDENTIALS_FILE || '~/.taskmanager/credentials.env')
    let txt = existsSync(f) ? readFileSync(f, 'utf-8') : ''
    const line = `${def.envKey}=${key.trim()}`
    txt = new RegExp('^' + def.envKey + '=.*$', 'm').test(txt) ? txt.replace(new RegExp('^' + def.envKey + '=.*$', 'm'), line) : (txt.replace(/\s*$/, '') + '\n' + line + '\n')
    writeFileSync(f, txt, { mode: 0o600 })
    // Gemini: prebaci auth na API-key (OAuth Code Assist je Google ukinuo) + trust workspace.
    if (id === 'geminicli') {
      try {
        const gdir = loginHomeExpand('~/.gemini'); if (!existsSync(gdir)) mkdirSync(gdir, { recursive: true })
        const gset = join(gdir, 'settings.json')
        let cfg: any = {}; try { if (existsSync(gset)) cfg = JSON.parse(readFileSync(gset, 'utf-8')) } catch {}
        cfg.selectedAuthType = 'gemini-api-key'
        cfg.security = { ...(cfg.security || {}), auth: { ...((cfg.security || {}).auth || {}), selectedType: 'gemini-api-key' } }
        writeFileSync(gset, JSON.stringify(cfg, null, 2))
      } catch {}
    }
    loginSetProviderEnabled(id, true)
    return json({ ok: true })
  } catch (e: any) { return json({ error: String(e?.message || e) }, 500) }
}
async function handleLoginLogout(req: Request): Promise<Response> {
  try {
    const { id } = await req.json() as { id: string }
    const def = LOGIN_PROVIDERS.find(d => d.id === id)
    if (!def) return json({ error: 'unknown' }, 404)
    const s = loginSessions.get(id); if (s && !s.done) { try { s.proc.kill() } catch {} ; s.done = true }
    if (def.kind === 'oauth-cli' && def.creds) { try { rmSync(loginHomeExpand(def.creds), { recursive: true, force: true }) } catch {} }
    loginSetProviderEnabled(id, false)
    return json({ ok: true })
  } catch (e: any) { return json({ error: String(e?.message || e) }, 500) }
}

// Sigurno preuzimanje datoteke na koju task linka (resultSummary). Dozvoljeno SAMO unutar
// HOME-a; blokira path-traversal (resolve + prefix provjera), služi samo obične datoteke.
function handleFileDownload(url: URL): Response {
  try {
    const raw = (url.searchParams.get('path') || '').trim()
    if (!raw) return new Response('Missing path', { status: 400 })
    const HOME = process.env.HOME || ''
    const expanded = raw.startsWith('~/') ? join(HOME, raw.slice(2)) : raw
    const abs = resolve(expanded)
    const homeAbs = resolve(HOME)
    if (abs !== homeAbs && !abs.startsWith(homeAbs + '/')) {
      return new Response('Forbidden path (izvan HOME-a)', { status: 403 })
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) return new Response('Not found', { status: 404 })
    const name = (abs.split('/').pop() || 'file').replace(/["\r\n]/g, '')
    return new Response(Bun.file(abs), {
      headers: { 'Content-Disposition': `attachment; filename="${name}"` }
    })
  } catch (e: any) {
    return new Response('Error: ' + (e?.message || e), { status: 500 })
  }
}

async function handleUpdateTask(taskId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json()
    console.log(`[API] Updating task ${taskId} with:`, JSON.stringify(body))

    // ─── Nazivi polja (D6 / TASK-2976) ─────────────────────────────────────
    // Prompt-predložak koji daemon šalje SVAKOM agentu piše snake_case, shema je
    // camelCase, a Zod `.strip()` je razliku bacao bez ijedne greške: agent pošalje
    // sažetak, dobije 200, sažetak nestane (449/509 završenih bez rezultata).
    // Zato se nazivi prvo prevedu, a ono što ostane nepoznato ODBIJA se glasno —
    // tiho 200 je gore od 400 jer ploča izgleda uredno dok dokaza o radu nema.
    const fields = normalizeTaskFields(body, UPDATE_TASK_FIELDS)
    if (fields.unknown.length > 0) {
      console.error(`[API] ${taskId} PUT s nepoznatim poljem: ${fields.unknown.join(', ')}`)
      return new Response(JSON.stringify(unknownFieldResponseBody(fields.unknown, UPDATE_TASK_FIELDS)), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    if (fields.aliased.length > 0) {
      console.log(`[API] ${taskId} snake_case alias preslikan: ${fields.aliased.join(', ')}`)
    }
    if (fields.conflicts.length > 0) {
      console.warn(`[API] ${taskId} poslana OBA naziva, camelCase je mjerodavan; ignorirano: ${fields.conflicts.join(', ')}`)
    }

    // Validate with Zod
    const parseResult = UpdateTaskInputSchema.safeParse(fields.normalized)
    if (!parseResult.success) {
      console.error(`[API] Validation failed for task ${taskId}:`, parseResult.error.issues)
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const validatedData = parseResult.data

    // Map validated data to TaskManagerSQL update format
    const updates: Record<string, unknown> = {}
    if (validatedData.title !== undefined) updates.title = validatedData.title
    if (validatedData.description !== undefined) updates.description = validatedData.description
    if (validatedData.status !== undefined) updates.status = validatedData.status
    if (validatedData.priority !== undefined) updates.priority = validatedData.priority
    if (validatedData.assignee !== undefined) updates.assignee = validatedData.assignee
    if (validatedData.blockedBy !== undefined) updates.blockedBy = validatedData.blockedBy
    if (validatedData.tags !== undefined) updates.tags = validatedData.tags
    if (validatedData.projectId !== undefined) updates.projectId = validatedData.projectId

    // Handle progressNotes via SQL update (TaskManagerSQL handles them internally)
    if (validatedData.progressNotes !== undefined && validatedData.progressNotes.length > 0) {
      updates.progressNotes = validatedData.progressNotes
    }

    // resultSummary (agentov odgovor apendan prije zatvaranja) i blockedReason (strojni razlog
    // blokade, TASK-2953). snake_case je već preveden gore u normalizeTaskFields — ovdje se
    // čita SAMO kanonski naziv, da alias-logika ne postoji na dva mjesta.
    const rs = validatedData.resultSummary
    if (rs !== undefined) updates.resultSummary = rs

    const br = validatedData.blockedReason
    if (br !== undefined) updates.blockedReason = br

    // ─── CompletionGuard (TASK-2954 / nalaz D2) ────────────────────────────
    // Zatvaranje u `completed` traži DOKAZ izvršenja. Ovo je jedini HTTP ulaz za
    // status zadatka, pa je i jedino mjesto gdje se pravilo može provesti za SVE
    // pozivatelje (agent curl, RegocDaemon auto-exec, UI, skripte).
    // Dokazani obrazac koji ovo zaustavlja: agent doslovno napiše "ne mogu / nemam
    // pristup alatima / zadatak je gotov." i svejedno postavi completed ⇒ ploča laže.
    // ROLLOUT (dorada TASK-2959): prvih 24 h SHADOW — sud se logira, status se piše
    // po starom. Iznimka su NE-heuristički sudovi (prazan rezultat, agentova vlastita
    // REGOC-STATUS deklaracija) koji se provode odmah jer ne mogu dati lažni pozitiv.
    // Konfiguracija: config/completion-gate.json { enabled, live, deterministicLive }.
    const gateCfg = loadGateConfig()
    if (updates.status === 'completed' && gateCfg.enabled) {
      const existingTask = taskManager.getTask(taskId)
      // Mjerodavan je tekst koji će ZAVRŠITI na zadatku: novi ako je poslan, inače postojeći.
      const effectiveSummary = rs !== undefined ? String(rs) : (existingTask?.resultSummary || '')
      const verdict = evaluateCompletion(effectiveSummary)
      const forced = (validatedData as any).force === true
      const enforce = shouldEnforce(verdict, gateCfg) && !forced

      if (!verdict.accept) {
        console.warn(
          `[API] ${taskId} ${formatVerdictLog(verdict)} — ${enforce ? 'BLOKIRAM' : 'SHADOW'}` +
          `${forced ? ' (FORCED — čovjek je pregazio sud)' : ''}`,
        )
        // Shadow zapis u točno onom obliku koji rollout-provjera grepa.
        if (!enforce && !forced) console.warn(`[API] ${formatShadowLog(taskId, verdict)}`)
        if (enforce) {
          return new Response(JSON.stringify({
            error: 'Completion rejected',
            code: verdict.code,
            label: verdict.label,
            details: verdict.reason,
            suggestedStatus: verdict.suggestedStatus,
            suggestedBody: {
              status: 'blocked',
              blocked_reason: verdict.blockedReason.slice(0, 500),
              result_summary: effectiveSummary.slice(0, 20000),
            },
            hint: 'Zadatak koji NIJE izvršen zatvori kao blocked s razlogom (NEEDS_CONTEXT: fali opis / BLOCKED: fali alat). ' +
                  'Ako je posao stvarno napravljen, dopiši u result_summary ŠTO je pokrenuto i ŠTO je vraćeno (naredba, datoteka, mjerenje, status). ' +
                  'Ručno pregaziti sud: dodaj "force": true.',
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          })
        }
      }
    }

    const task = taskManager.updateTask(taskId, updates as any)

    if (!task) {
      // updateTask returns null for two distinct reasons: the task genuinely
      // does not exist, OR a forbidden status transition was requested on an
      // existing task (e.g. completed -> in_progress). Collapsing both into a
      // 404 "Task not found" is misleading and has repeatedly tripped agents
      // that blindly follow the in_progress->completed protocol. Disambiguate
      // by re-fetching: if the task exists, it was a forbidden transition (409).
      const existing = taskManager.getTask(taskId)
      if (existing) {
        const allowed = taskManager.getAllowedTransitions(existing.status)
        const requested = (updates as any).status
        console.error(`[API] Forbidden status transition for ${taskId}: ${existing.status} -> ${requested}`)
        return new Response(JSON.stringify({
          error: 'Forbidden status transition',
          details: `Task ${taskId} is '${existing.status}' and cannot transition to '${requested}'.`,
          currentStatus: existing.status,
          requestedStatus: requested,
          allowedTransitions: allowed
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      console.error(`[API] Task ${taskId} not found`)
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    console.log(`[API] Task ${taskId} updated successfully. New priority: ${task.priority}`)

    // Broadcast to WebSocket clients
    const message = JSON.stringify({ type: 'task_updated', task })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return new Response(JSON.stringify(task), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error(`[API] Error updating task ${taskId}:`, error)
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * POST /api/tasks/:id/reclaim — R2 stale-watchdog (TASK-2560).
 *
 * Odvojena ruta jer `in_progress -> pending` NAMJERNO nije u ValidStatusTransitions
 * (agent ne smije vraćati vlastiti task unatrag kroz obični PUT). Watchdog je jedina
 * legitimna iznimka, pa ide kroz vlastiti, auditirani ulaz.
 *
 * Body: { reason: string }  → 200 task | 400 bez razloga | 404 nema taska | 409 nije in_progress
 */
async function handleReclaimTask(taskId: string, req: Request): Promise<Response> {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  try {
    const body = await req.json().catch(() => ({} as any))
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    const by = typeof body?.by === 'string' && body.by.trim() ? body.by.trim() : 'stale-watchdog'

    if (!reason) {
      return json({ error: 'Missing reason', details: 'Reclaim zahtijeva tekstualni "reason" (ide u audit trail).' }, 400)
    }

    const existing = taskManager.getTask(taskId)
    if (!existing) {
      console.error(`[API] Reclaim: task ${taskId} not found`)
      return json({ error: 'Task not found' }, 404)
    }
    if (existing.status !== 'in_progress') {
      return json({
        error: 'Not reclaimable',
        details: `Task ${taskId} je '${existing.status}' — reclaim je dopušten samo iz 'in_progress'.`,
        currentStatus: existing.status,
      }, 409)
    }

    const task = taskManager.reclaimStaleTask(taskId, reason, by)
    if (!task) return json({ error: 'Reclaim failed' }, 500)

    console.log(`[API] Task ${taskId} reclaimed by ${by}: ${reason}`)

    const message = JSON.stringify({ type: 'task_updated', task })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return json(task, 200)
  } catch (error) {
    console.error(`[API] Error reclaiming task ${taskId}:`, error)
    return json({ error: 'Invalid JSON body' }, 400)
  }
}

async function handleUpdateTaskProgress(taskId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json()
    console.log(`[API] Updating task ${taskId} progress with:`, JSON.stringify(body))

    // Validate progressPercent
    if (typeof body.progressPercent !== 'number' || body.progressPercent < 0 || body.progressPercent > 100) {
      console.error(`[API] Invalid progressPercent for task ${taskId}:`, body.progressPercent)
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: [{ message: 'progressPercent must be a number between 0 and 100' }]
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Update task with new progressPercent
    const updates: Record<string, unknown> = {
      progressPercent: body.progressPercent
    }

    // Add progress note if provided
    if (body.note) {
      const agent = 'regoc'
      taskManager.addProgressNote(taskId, agent, body.note)
    }

    const task = taskManager.updateTask(taskId, updates as any)

    if (!task) {
      console.error(`[API] Task ${taskId} not found`)
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    console.log(`[API] Task ${taskId} progress updated to ${task.progressPercent}%`)

    // Broadcast to WebSocket clients
    const message = JSON.stringify({ type: 'task_updated', task })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return new Response(JSON.stringify(task), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error(`[API] Error updating task progress ${taskId}:`, error)
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============================================
// RUČNA KOČNICA (TASK-3047)
// ============================================

/**
 * POST /api/tasks/:id/pause  · POST /api/tasks/:id/resume
 *
 * Pauza NE mijenja status zadatka. Namjerno: `cancelled` i `completed` su terminalni, a
 * `in_progress→pending` je zabranjen prijelaz — pauza kroz status bi zadatak ili zaključala
 * ili bi tražila rupu u automatu. Zastavica `paused` čuva status netaknutim, pa „Nastavi"
 * doslovno vraća zadatak tamo gdje je stao.
 */
function handleTaskPause(taskId: string, paused: boolean, req: Request): Promise<Response> {
  return (async () => {
    let by = 'user'
    let reason = ''
    try {
      const body = await req.json() as any
      if (typeof body?.by === 'string' && body.by) by = body.by
      if (typeof body?.reason === 'string') reason = body.reason
    } catch { /* tijelo nije obavezno */ }

    const task = taskManager.setTaskPaused(taskId, paused, by, reason)
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    console.log(`[API] Task ${taskId} ${paused ? 'PAUZIRAN' : 'NASTAVLJEN'} (${by})${reason ? ` — ${reason}` : ''}`)

    const message = JSON.stringify({ type: 'task_updated', task })
    wsClients.forEach(client => { try { client.send(message) } catch { wsClients.delete(client) } })

    return new Response(JSON.stringify(task), { headers: { 'Content-Type': 'application/json' } })
  })()
}

/**
 * GET /api/pause — stanje globalne kočnice.
 * POST /api/pause `{paused: bool, by?, reason?}` — pritisni/otpusti.
 *
 * Globalna pauza zaustavlja auto-exec I prekida tekuće spawnove (RegocDaemon.enforcePauses).
 * Stanje je u datoteci jer ga čitaju tri procesa i mora preživjeti restart bilo kojeg.
 */
function handleGetPause(): Response {
  const state = readPauseState()
  return new Response(JSON.stringify({ ...state, description: describePause(state) }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleSetPause(req: Request): Promise<Response> {
  try {
    const body = await req.json() as any
    if (typeof body?.paused !== 'boolean') {
      return new Response(JSON.stringify({ error: 'Polje `paused` (boolean) je obavezno' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    const state = writePauseState({
      paused: body.paused,
      by: typeof body.by === 'string' && body.by ? body.by : 'user',
      reason: typeof body.reason === 'string' ? body.reason : '',
    })
    console.log(`[API] Globalna kočnica: ${describePause(state)}`)

    const message = JSON.stringify({ type: 'pause_changed', pause: state })
    wsClients.forEach(client => { try { client.send(message) } catch { wsClients.delete(client) } })

    return new Response(JSON.stringify({ ...state, description: describePause(state) }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: `Neispravno tijelo zahtjeva: ${error}` }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }
}

function handleDeleteTask(taskId: string): Response {
  const success = taskManager.deleteTask(taskId)

  if (!success) {
    return new Response(JSON.stringify({ error: 'Task not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Broadcast to WebSocket clients
  const message = JSON.stringify({ type: 'task_deleted', taskId })
  wsClients.forEach(client => {
    try { client.send(message) } catch { wsClients.delete(client) }
  })

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

function handleHealthCheck(): Response {
  return new Response(JSON.stringify({
    status: 'healthy',
    watcher: watcherReady,
    clients: wsClients.size,
    timestamp: new Date().toISOString()
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

// ============================================
// PROJECT API HANDLERS
// ============================================

function handleGetProjects(url: URL): Response {
  const rawFilter: Record<string, unknown> = {}

  const status = url.searchParams.get('status')
  const priority = url.searchParams.get('priority')
  const lead_agent = url.searchParams.get('lead_agent')
  const agent = url.searchParams.get('agent')
  const tag = url.searchParams.get('tag')
  const search = url.searchParams.get('search')

  if (status) rawFilter.status = status
  if (priority) rawFilter.priority = parseInt(priority)
  if (lead_agent) rawFilter.lead_agent = lead_agent
  if (agent) rawFilter.agent = agent
  if (tag) rawFilter.tag = tag
  if (search) rawFilter.search = search

  const parseResult = ProjectFilterSchema.safeParse(rawFilter)
  if (!parseResult.success) {
    return new Response(JSON.stringify({
      error: 'Validation failed',
      details: parseResult.error.issues
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const projects = projectManager.getProjects(parseResult.data)

  return new Response(JSON.stringify(projects), {
    headers: { 'Content-Type': 'application/json' }
  })
}

function handleGetProject(projectId: string): Response {
  const project = projectManager.getProject(projectId)

  if (!project) {
    return new Response(JSON.stringify({ error: 'Project not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Include agents and RAG links
  const agents = projectManager.getProjectAgents(projectId)
  const ragLinks = projectManager.getProjectRAGLinks(projectId)
  const tasks = projectManager.getProjectTasks(projectId)

  return new Response(JSON.stringify({
    ...project,
    agents,
    ragLinks,
    tasks
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

async function handleCreateProject(req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const parseResult = CreateProjectInputSchema.safeParse(body)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const project = projectManager.createProject(parseResult.data)

    // Broadcast to WebSocket clients
    const message = JSON.stringify({ type: 'project_created', project })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return new Response(JSON.stringify(project), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleUpdateProject(projectId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const parseResult = UpdateProjectInputSchema.safeParse(body)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const project = projectManager.updateProject(projectId, parseResult.data)

    if (!project) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Broadcast to WebSocket clients
    const message = JSON.stringify({ type: 'project_updated', project })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return new Response(JSON.stringify(project), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============================================
// SPEC DISPATCH-UPGRADE + TEMPLATES
// ============================================

const TEMPLATES_DIR = join(TM_ROOT, 'templates')

// Hardcoded fallback ako spec-upgrade.md fizički nestane (dispatch mora preživjeti).
const FALLBACK_SPEC_TEMPLATE = '[[AGENT:$agent]]\nNadogradi projekt $projekt po specifikaciji:\n\n$spec'

/**
 * Skup poznatih agent id-eva iz REGOC_AGENTS.json (autoritet — uključuje emard,
 * za razliku od MessageQueue.VALID_AGENTS). Učitava se svjež na svaki dispatch
 * (registry je malen, izbjegava stale cache nakon dodavanja agenta).
 */
function loadKnownAgentIds(): Set<string> {
  try {
    const regPath = join(TM_ROOT, 'REGOC_AGENTS.json')
    const reg = JSON.parse(readFileSync(regPath, 'utf-8'))
    return new Set(Object.keys(reg.agents || {}))
  } catch {
    return new Set()
  }
}

/** Renderira template zamjenom $agent/$projekt/$spec (split+join — bez regex escape briga). */
function renderSpecTemplate(tpl: string, agent: string, projekt: string, spec: string): string {
  return tpl
    .split('$agent').join(agent)
    .split('$projekt').join(projekt)
    .split('$spec').join(spec)
}

/**
 * POST /api/projects/:id/dispatch-upgrade
 * Body: { agent: string, template?: string }
 * Redoslijed (ADR-2): task → history → message. Task je source-of-truth statusa;
 * poruka je trigger. sendMessage fail → NE rollback (vrati warning, task ostaje vidljiv).
 */
async function handleDispatchUpgrade(projectId: string, req: Request): Promise<Response> {
  const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  try {
    const body = await req.json().catch(() => ({})) as { agent?: string; template?: string }

    // 1) projekt + spec
    const project = projectManager.getProject(projectId)
    if (!project) return json({ error: 'Project not found' }, 404)
    const spec = ((project as any).specification || '').trim()

    // 2) guard: prazna spec (R1) — prazni loop nema smisla
    if (!spec) return json({ error: 'Specifikacija je prazna', code: 'empty_spec' }, 422)

    // 3) validacija agenta protiv REGOC_AGENTS.json (autoritet, ne VALID_AGENTS — R9)
    const agent = (body.agent || '').toLowerCase().trim()
    if (!agent) return json({ error: 'Nedostaje agent', code: 'missing_agent' }, 400)
    if (!loadKnownAgentIds().has(agent)) {
      return json({ error: `Nepoznat agent: ${agent}`, code: 'unknown_agent' }, 400)
    }

    // 4) kreiraj task IZRAVNO (zaobiđi HTTP anti-echo guard) → odmah in_progress (pravilo #12).
    //    Spec NE ide u description (drži task lagan + izbjegava guard) — samo naslov+referenca.
    const task = taskManager.createTask({
      title: `Nadogradnja po specifikacijama: ${project.name}`,
      description: `Dispatch-upgrade za projekt ${project.id} (${project.name}). Specifikacija je u poruci agentu ${agent}.`,
      priority: 2,
      assignee: agent,
      tags: ['spec-upgrade'],
      projectId: project.id,
      createdBy: 'webui',
    } as any)
    const taskId = task.id
    // pending → in_progress (dva koraka; API ne dozvoljava pending→completed izravno)
    taskManager.updateTask(taskId, { status: 'in_progress' } as any)

    // 5) snapshot spec u history
    projectManager.addSpecHistory(project.id, spec, agent, taskId)

    // 6) render template (param template > spec-upgrade.md > hardcoded fallback)
    let tpl = FALLBACK_SPEC_TEMPLATE
    if (body.template && body.template.trim()) {
      tpl = body.template
    } else {
      const tplPath = join(TEMPLATES_DIR, 'spec-upgrade.md')
      if (existsSync(tplPath)) tpl = readFileSync(tplPath, 'utf-8')
    }
    const rendered = renderSpecTemplate(tpl, agent, project.name, spec)
    // SECURITY (Malik M1): template i spec su user-controlled. Ukloni BILO KAKAV vodeći
    // [[AGENT:..]] (iz templatea ili spec teksta) pa nametni VALIDIRANI agent kao prvi redak —
    // inače user može preusmjeriti dispatch na drugog agenta preko prvog retka.
    const stripped = rendered.replace(/^\s*\[\[AGENT:[^\]]*\]\]\s*\n?/i, '')
    const content = `[[AGENT:${agent}]]\n${stripped}`

    // 7) pošalji poruku u REGOČ queue
    const messageId = messageQueue.sendMessage('user', 'regoc', content, {
      messageType: 'text',
      priority: 2,
      metadata: { source: 'spec-upgrade', forceAgent: agent, taskId, projectId: project.id }
    })

    if (!messageId) {
      // sendMessage fail → NE rollback; task ostaje in_progress i vidljiv (ADR-2)
      return json({ taskId, messageId: null, warning: 'Task kreiran, ali dispatch poruka nije poslana — pokušaj ponovno.' }, 200)
    }

    return json({ taskId, messageId, agent, projectId: project.id })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
}

/**
 * GET/PUT /api/templates/:name — editabilni .md template (uzor: workflow editor).
 * Path-traversal guard identičan workflow ruti: `^[A-Za-z0-9_-]+$` (zabranjuje '.', pa i '..').
 */
async function handleTemplate(name: string, req: Request): Promise<Response> {
  const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return json({ error: 'Invalid template name' }, 400)
  }
  const tplPath = join(TEMPLATES_DIR, name + '.md')

  if (req.method === 'GET') {
    if (!existsSync(tplPath)) return json({ error: 'Template not found' }, 404)
    return json({ name, path: tplPath, content: readFileSync(tplPath, 'utf-8') })
  }

  // PUT
  try {
    const body = await req.json() as { content?: string }
    if (typeof body.content !== 'string' || !body.content) throw new Error('Missing content')
    mkdirSync(TEMPLATES_DIR, { recursive: true })  // seedan migracijom, ali siguran za svaki slučaj
    writeFileSync(tplPath, body.content)
    return json({ status: 'saved', path: tplPath })
  } catch (err) {
    return json({ error: String(err) }, 400)
  }
}

function handleDeleteProject(projectId: string): Response {
  const success = projectManager.deleteProject(projectId)

  if (!success) {
    return new Response(JSON.stringify({ error: 'Project not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Broadcast to WebSocket clients
  const message = JSON.stringify({ type: 'project_deleted', projectId })
  wsClients.forEach(client => {
    try { client.send(message) } catch { wsClients.delete(client) }
  })

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

async function handleAddProjectAgent(projectId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const parseResult = AddAgentInputSchema.safeParse(body)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const agent = projectManager.addAgent(projectId, parseResult.data)

    if (!agent) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify(agent), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

function handleRemoveProjectAgent(projectId: string, agentId: string): Response {
  const success = projectManager.removeAgent(projectId, agentId)

  if (!success) {
    return new Response(JSON.stringify({ error: 'Agent not found on project' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

async function handleLinkProjectRAG(projectId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const parseResult = LinkRAGInputSchema.safeParse(body)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const link = projectManager.linkRAG(projectId, parseResult.data)

    if (!link) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify(link), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

function handleUnlinkProjectRAG(projectId: string, collection: string, docId: string): Response {
  const success = projectManager.unlinkRAG(projectId, collection, docId)

  if (!success) {
    return new Response(JSON.stringify({ error: 'RAG link not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

// ============================================
// RAG API HANDLERS
// ============================================

async function handleGetRAGCollections(): Promise<Response> {
  try {
    const collections = await ragService.listCollections()
    return new Response(JSON.stringify(collections), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to fetch collections',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleGetRAGEntries(url: URL): Promise<Response> {
  try {
    const rawFilter: Record<string, unknown> = {}

    const collection = url.searchParams.get('collection')
    const type = url.searchParams.get('type')
    const agent = url.searchParams.get('agent')
    const dateFrom = url.searchParams.get('dateFrom')
    const dateTo = url.searchParams.get('dateTo')
    const search = url.searchParams.get('search')
    const limit = url.searchParams.get('limit')
    const offset = url.searchParams.get('offset')

    if (collection) rawFilter.collection = collection
    if (type) rawFilter.type = type
    if (agent) rawFilter.agent = agent
    if (dateFrom) rawFilter.dateFrom = dateFrom
    if (dateTo) rawFilter.dateTo = dateTo
    if (search) rawFilter.search = search
    if (limit) rawFilter.limit = parseInt(limit)
    if (offset) rawFilter.offset = parseInt(offset)

    const parseResult = RAGFilterSchema.safeParse(rawFilter)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const result = await ragService.getEntries(parseResult.data)
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to fetch entries',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleGetRAGEntry(collection: string, id: string): Promise<Response> {
  try {
    const entry = await ragService.getEntry(collection, id)

    if (!entry) {
      return new Response(JSON.stringify({ error: 'Entry not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify(entry), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to fetch entry',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleDeleteRAGEntries(req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const parseResult = RAGDeleteRequestSchema.safeParse(body)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const result = await ragService.deleteEntries(parseResult.data)
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to delete entries',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleRAGHealth(): Promise<Response> {
  try {
    const health = await ragService.healthCheck()
    return new Response(JSON.stringify(health), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Health check failed',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============================================
// KONZOLA HANDLERS
// ============================================

async function handleKonzolaStatus(): Promise<Response> {
  // Ne čitamo status datoteku doslovno: mrtav daemon ostavlja zamrznut zapis koji je
  // traka satima prikazivala kao trenutno stanje (TASK-2991).
  const daemonData = await buildDaemonBlock()

  let services: any = {}
  try {
    const health = await getCachedHealthCheck()
    services = health?.services || {}
  } catch {}

  return new Response(JSON.stringify({
    daemon: daemonData,
    services,
    mode: konzolaMode,
    wsClients: wsClients.size,
    timestamp: new Date().toISOString()
  }), { headers: { 'Content-Type': 'application/json' } })
}

async function handleKonzolaExec(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const rawCommand = body.command?.trim()

    if (!rawCommand) {
      return new Response(JSON.stringify({ error: 'No command provided' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }

    // Check blocked patterns
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(rawCommand)) {
        return new Response(JSON.stringify({ error: `Command blocked by security policy` }), {
          status: 403, headers: { 'Content-Type': 'application/json' }
        })
      }
    }

    // Check command aliases
    const alias = COMMAND_ALIASES[rawCommand]
    if (alias) {
      return executeKonzolaCommand(alias)
    }

    // Parse command
    const parts = rawCommand.split(/\s+/)
    const executable = parts[0]
    const args = parts.slice(1)

    // Validate allowlist
    if (!ALLOWED_COMMANDS.has(executable) && !rawCommand.startsWith('regoc-services')) {
      return new Response(JSON.stringify({ error: `Command not allowed: "${executable}". Type 'help' for allowed commands.` }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      })
    }

    // Plan mode: block mutating commands
    if (konzolaMode === 'plan' && WORK_MODE_COMMANDS.has(executable)) {
      return new Response(JSON.stringify({ error: `Command "${executable}" requires WORK mode. Switch with: mode work` }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      })
    }

    // Git: only read-only in plan mode
    if (executable === 'git' && konzolaMode === 'plan') {
      const gitSubCmd = args[0]
      const readOnlyGitCmds = ['status', 'log', 'diff', 'show', 'branch', 'remote', 'tag']
      if (gitSubCmd && !readOnlyGitCmds.includes(gitSubCmd)) {
        return new Response(JSON.stringify({ error: `Git "${gitSubCmd}" requires WORK mode.` }), {
          status: 403, headers: { 'Content-Type': 'application/json' }
        })
      }
    }

    return executeKonzolaCommand([executable, ...args])
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function executeKonzolaCommand(cmdArgs: string[]): Promise<Response> {
  try {
    const proc = Bun.spawn(cmdArgs, {
      cwd: process.env.TM_SERVICES_DIR || process.cwd(),
      stdout: 'pipe', stderr: 'pipe',
      env: { HOME: process.env.HOME || os.homedir(), PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', USER: process.env.USER || 'taskmanager', LANG: 'en_US.UTF-8' }
    })

    const timeout = setTimeout(() => { try { proc.kill() } catch {} }, 30000)
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    clearTimeout(timeout)

    return new Response(JSON.stringify({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: `Execution failed: ${error instanceof Error ? error.message : String(error)}` }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleKonzolaMode(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const newMode = body.mode
    if (newMode !== 'plan' && newMode !== 'work') {
      return new Response(JSON.stringify({ error: 'Invalid mode. Use "plan" or "work".' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }
    konzolaMode = newMode
    const message = JSON.stringify({ type: 'console_mode_changed', mode: konzolaMode })
    wsClients.forEach(client => { try { client.send(message) } catch { wsClients.delete(client) } })
    return new Response(JSON.stringify({ mode: konzolaMode }), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleKonzolaLogs(url: URL): Promise<Response> {
  const source = url.searchParams.get('source') || 'daemon'
  const lines = parseInt(url.searchParams.get('lines') || '50')
  let logFile: string
  switch (source) {
    case 'voiceserver': logFile = join(process.env.HOME || os.homedir(), '.tmp/regoc_logs/voiceserver.log'); break
    case 'taskwebui': logFile = join(process.env.HOME || os.homedir(), '.tmp/regoc_logs/taskwebui.log'); break
    case 'klaudio': logFile = join(process.env.HOME || os.homedir(), '.tmp/regoc_logs/klaudio.log'); break
    default: logFile = DAEMON_LOG_FILE
  }
  try {
    const proc = Bun.spawn(['tail', '-n', String(Math.min(lines, 200)), logFile], { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(proc.stdout).text()
    return new Response(JSON.stringify({ source, lines: output.trim().split('\n'), timestamp: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to read log' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============================================
// KONZOLA MESSAGE HANDLER (Natural Language → REGOČ Queue)
// ============================================

async function handleKonzolaMessage(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const text = body.message?.trim()

    if (!text) {
      return new Response(JSON.stringify({ error: 'No message provided' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }

    // Send message to REGOČ via message queue
    const msgId = messageQueue.sendMessage('user', 'regoc', text, {
      messageType: 'text',
      priority: 3,
      metadata: { source: 'konzola', timestamp: new Date().toISOString() }
    })

    if (!msgId) {
      return new Response(JSON.stringify({ error: 'Failed to queue message' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      })
    }

    // Broadcast to WS clients
    const wsMsg = JSON.stringify({
      type: 'console_output',
      text: `📨 Poruka poslana REGOČ-u (${msgId.substring(0, 8)}): "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`,
      level: 'log-info',
      source: 'konzola'
    })
    wsClients.forEach(client => { try { client.send(wsMsg) } catch { wsClients.delete(client) } })

    return new Response(JSON.stringify({
      success: true,
      messageId: msgId,
      to: 'regoc',
      queued: true
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============================================
// KONZOLA LOG STREAMER (VERBOSE)
// ============================================

// Track file positions per source
const logSources: Record<string, { file: string, position: number }> = {
  daemon: { file: DAEMON_LOG_FILE, position: 0 },
  klaudio: { file: join(process.env.HOME || os.homedir(), '.tmp/regoc_logs/klaudio.log'), position: 0 },
  // TASK-3095: rad GLAVNE REGOC sesije (Claude Code) — dosad se u konzoli nije vidjelo
  // NISTA od onoga sto REGOC radi izmedju dvije poruke, jer on ne prolazi kroz daemon.
  // Puni ga hooks/RegocConsoleLog.hook.ts (PostToolUse).
  regoc: { file: join(process.env.HOME || os.homedir(), '.tmp/regoc_logs/regoc.log'), position: 0 },
  voiceserver: { file: join(process.env.HOME || os.homedir(), '.tmp/regoc_logs/voiceserver.log'), position: 0 },
}

// Dedup: track last N messages to suppress scheduler spam
let lastLogLines: string[] = []
const DEDUP_WINDOW = 10

// Message queue tracking — last seen message timestamp
let lastSeenMsgTimestamp = new Date().toISOString()
let lastSeenEventId = 0

function isDuplicateLogLine(line: string): boolean {
  const content = line.replace(/^\[[\dT:.Z-]+\]\s*/, '')
  if (lastLogLines.includes(content)) return true
  lastLogLines.push(content)
  if (lastLogLines.length > DEDUP_WINDOW) lastLogLines.shift()
  return false
}

function detectLogLevel(line: string): string {
  if (line.includes('ERROR') || line.includes('FAILED') || line.includes('❌')) return 'log-error'
  if (line.includes('WARN') || line.includes('⚠️')) return 'log-warn'
  if (line.includes('✅') || line.includes('[OK]') || line.includes('success')) return 'log-success'
  if (line.includes('📨') || line.includes('Processing') || line.includes('AI inference')) return 'log-info'
  if (line.includes('[WATCHDOG]') || line.includes('[Context')) return 'log-info'
  if (line.includes('CLAUDE CODE') || line.includes('Received') || line.includes('Response sent')) return 'log-info'
  if (line.includes('HEARTBEAT')) return 'log-system'
  if (line.includes('Queued') || line.includes('completed task')) return 'log-system'
  return ''
}

function broadcastKonzola(text: string, level: string, source: string) {
  const msg = JSON.stringify({ type: 'console_output', text, level, source })
  wsClients.forEach(client => { try { client.send(msg) } catch { wsClients.delete(client) } })
}

// --- Stream 1: Log file tailing ---
function streamLogFiles() {
  const { existsSync, statSync, openSync, readSync, closeSync } = require('fs')

  for (const [name, src] of Object.entries(logSources)) {
    try {
      if (!existsSync(src.file)) continue
      const stat = statSync(src.file)
      if (stat.size <= src.position) {
        if (stat.size < src.position) src.position = 0
        continue
      }
      const readSize = Math.min(stat.size - src.position, 65536)
      const fd = openSync(src.file, 'r')
      const buf = Buffer.alloc(readSize)
      readSync(fd, buf, 0, readSize, src.position)
      closeSync(fd)
      src.position = src.position + readSize
      const newContent = buf.toString('utf-8')
      if (!newContent.trim()) continue

      const lines = newContent.trim().split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        if (isDuplicateLogLine(line)) continue
        const level = detectLogLevel(line)
        const prefix = name !== 'daemon' ? `[${name}] ` : ''
        broadcastKonzola(prefix + line, level, name)
      }
    } catch {}
  }
}

// --- Stream 2: Message Queue activity ---
function streamMessageQueue() {
  try {
    const db = konzolaDb
    if (!db) return

    // Get new messages since last check
    const newMsgs = db.prepare(`
      SELECT id, from_agent, to_agent, substr(content, 1, 120) as content,
             message_type, priority, status, created_at, processed_at,
             substr(response, 1, 120) as response
      FROM messages
      WHERE created_at > ? OR (processed_at IS NOT NULL AND processed_at > ?)
      ORDER BY created_at ASC
      LIMIT 20
    `).all(lastSeenMsgTimestamp, lastSeenMsgTimestamp) as any[]

    for (const m of newMsgs) {
      if (m.status === 'pending' || m.status === 'processing') {
        broadcastKonzola(
          `📨 [MQ] ${m.from_agent} → ${m.to_agent}: "${m.content}"${m.priority <= 2 ? ' ⚡P' + m.priority : ''}`,
          'log-info', 'mq'
        )
      }
      if (m.status === 'completed' && m.response) {
        broadcastKonzola(
          `✅ [MQ] ${m.to_agent} → ${m.from_agent}: "${m.response}"`,
          'log-success', 'mq'
        )
      }
      if (m.status === 'failed') {
        broadcastKonzola(
          `❌ [MQ] FAILED ${m.from_agent} → ${m.to_agent}: "${m.content}"`,
          'log-error', 'mq'
        )
      }
    }

    lastSeenMsgTimestamp = new Date().toISOString()
  } catch {}
}

// --- Stream 3: Event Log (audit trail) ---
function streamEventLog() {
  try {
    const db = konzolaDb
    if (!db) return

    // Check if event_log table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_log'").get()
    if (!tableExists) return

    const events = db.prepare(`
      SELECT id, event_type, agent_id, substr(details, 1, 150) as details, created_at
      FROM event_log
      WHERE id > ?
      ORDER BY id ASC
      LIMIT 20
    `).all(lastSeenEventId) as any[]

    for (const ev of events) {
      lastSeenEventId = ev.id
      const icon = ev.event_type.includes('completed') ? '✅' :
                   ev.event_type.includes('failed') ? '❌' :
                   ev.event_type.includes('processing') ? '⚙️' :
                   ev.event_type.includes('claimed') ? '🔄' :
                   ev.event_type.includes('progress') ? '📊' :
                   ev.event_type.includes('project') ? '📁' : '📋'
      const level = ev.event_type.includes('failed') ? 'log-error' :
                    ev.event_type.includes('completed') ? 'log-success' : 'log-info'
      broadcastKonzola(
        `${icon} [EVENT] ${ev.event_type} | ${ev.agent_id || '--'} | ${ev.details || ''}`,
        level, 'event'
      )
    }
  } catch {}
}

// --- Stream 4: Observability proxy (agent tool use from port 4000) ---
let obsWs: any = null
let obsReconnectTimer: any = null

function connectObservabilityStream() {
  try {
    obsWs = new WebSocket('ws://localhost:4000/stream')

    obsWs.onmessage = (event: any) => {
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
        if (data.type === 'event') {
          formatObsEvent(data.data)
        } else if (data.type === 'initial' && Array.isArray(data.data)) {
          // Skip initial batch to avoid flooding — only show last 3
          data.data.slice(-3).forEach((ev: any) => formatObsEvent(ev))
        }
      } catch {}
    }

    obsWs.onclose = () => {
      obsWs = null
      // Reconnect after 10 seconds
      if (!obsReconnectTimer) {
        obsReconnectTimer = setTimeout(() => { obsReconnectTimer = null; connectObservabilityStream() }, 10000)
      }
    }

    obsWs.onerror = () => { try { obsWs?.close() } catch {} }
  } catch {
    // Observability server not available — silent fail
  }
}

function formatObsEvent(ev: any) {
  if (!ev || !ev.hook_event_type) return
  const agent = ev.agent_name || ev.source_app || '??'
  const type = ev.hook_event_type

  if (type === 'PreToolUse' && ev.payload?.tool_name) {
    const tool = ev.payload.tool_name
    const input = ev.payload.tool_input
    let detail = ''
    if (tool === 'Read' && input?.file_path) detail = ` → ${input.file_path}`
    else if (tool === 'Edit' && input?.file_path) detail = ` → ${input.file_path}`
    else if (tool === 'Write' && input?.file_path) detail = ` → ${input.file_path}`
    else if (tool === 'Bash' && input?.command) detail = ` → ${String(input.command).substring(0, 60)}`
    else if (tool === 'Grep' && input?.pattern) detail = ` → "${input.pattern}"`
    else if (tool === 'Glob' && input?.pattern) detail = ` → ${input.pattern}`
    else if (tool === 'Task') detail = ` → ${input?.description || ''}`
    broadcastKonzola(`🔧 [${agent}] ${tool}${detail}`, 'log-info', 'obs')
  }
  else if (type === 'UserPromptSubmit') {
    const prompt = ev.payload?.prompt || ev.summary || ''
    if (prompt) broadcastKonzola(`💬 [${agent}] Prompt: "${String(prompt).substring(0, 80)}"`, 'log-cmd', 'obs')
  }
  else if (type === 'Stop') {
    const summary = ev.summary || ''
    if (summary) broadcastKonzola(`🏁 [${agent}] Done: ${String(summary).substring(0, 80)}`, 'log-success', 'obs')
  }
}

// --- Stream 5: Session JSONL watcher (agent reasoning/thinking) ---
const CLAUDE_PROJECTS_DIR = join(process.env.HOME || os.homedir(), '.claude/projects')
const sessionFilePositions: Record<string, number> = {}
let activeSessionFiles: string[] = []
let lastSessionScan = 0
const SESSION_SCAN_INTERVAL = 5000 // 5s — catch short-lived subagents quickly

function scanActiveSessions() {
  const now = Date.now()
  if (now - lastSessionScan < SESSION_SCAN_INTERVAL && activeSessionFiles.length > 0) return
  lastSessionScan = now

  const { readdirSync, statSync, existsSync } = require('fs')
  const results: { path: string; mtime: number }[] = []

  try {
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR)
    for (const dir of projectDirs) {
      const projectPath = join(CLAUDE_PROJECTS_DIR, dir)
      try {
        if (!statSync(projectPath).isDirectory()) continue
        const files = readdirSync(projectPath)

        // Main session files — only from non-regoc-system projects (skip our own huge session)
        const isRegocProject = dir.includes('regoc-system')
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          const filePath = join(projectPath, file)
          try {
            const fstat = statSync(filePath)
            // Skip our own main session (>500KB) in regoc-system project
            if (isRegocProject && fstat.size > 512000) continue
            if (now - fstat.mtimeMs < 300000) {
              results.push({ path: filePath, mtime: fstat.mtimeMs })
            }
          } catch {}
        }

        // Subagent directories — ALWAYS watch these (they are spawned agents)
        for (const file of files) {
          if (file.endsWith('.jsonl')) continue // Skip files, only process directories
          if (!file.includes('-')) continue // Session dirs have UUIDs with dashes
          const subagentsDir = join(projectPath, file, 'subagents')
          try {
            if (!existsSync(subagentsDir) || !statSync(subagentsDir).isDirectory()) continue
            const subFiles = readdirSync(subagentsDir)
            for (const sf of subFiles) {
              if (!sf.endsWith('.jsonl')) continue
              const sfPath = join(subagentsDir, sf)
              try {
                const sfStat = statSync(sfPath)
                if (now - sfStat.mtimeMs < 300000) {
                  results.push({ path: sfPath, mtime: sfStat.mtimeMs })
                }
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  results.sort((a, b) => b.mtime - a.mtime)
  activeSessionFiles = results.slice(0, 15).map(r => r.path)

  // Initialize positions for new files
  // Small files (<100KB, likely subagent sessions): read from beginning to catch all reasoning
  // Large files: start from end (only show new live content)
  for (const f of activeSessionFiles) {
    if (!(f in sessionFilePositions)) {
      try {
        const fsize = require('fs').statSync(f).size
        sessionFilePositions[f] = fsize < 102400 ? 0 : fsize
      } catch { sessionFilePositions[f] = 0 }
    }
  }

  // Cleanup stale entries
  for (const key of Object.keys(sessionFilePositions)) {
    if (!activeSessionFiles.includes(key)) delete sessionFilePositions[key]
  }
}

function streamSessionJSONL() {
  scanActiveSessions()
  if (activeSessionFiles.length === 0) return

  const { existsSync, statSync, openSync, readSync, closeSync } = require('fs')

  for (const filePath of activeSessionFiles) {
    try {
      if (!existsSync(filePath)) continue
      const stat = statSync(filePath)
      const pos = sessionFilePositions[filePath] || 0

      if (stat.size <= pos) {
        if (stat.size < pos) sessionFilePositions[filePath] = 0
        continue
      }

      const readSize = Math.min(stat.size - pos, 131072) // Max 128KB per tick
      const fd = openSync(filePath, 'r')
      const buf = Buffer.alloc(readSize)
      readSync(fd, buf, 0, readSize, pos)
      closeSync(fd)
      sessionFilePositions[filePath] = pos + readSize

      const content = buf.toString('utf-8')
      const lines = content.split('\n')

      for (const line of lines) {
        if (!line.trim() || line.length < 20) continue
        try {
          const entry = JSON.parse(line)
          formatSessionEntry(entry, filePath)
        } catch {} // Partial writes — skip
      }
    } catch {}
  }
}

function formatSessionEntry(entry: any, filePath: string) {
  if (!entry?.type) return

  // Determine source label from file path
  const source = filePath.includes('subagents/') ? 'agent' :
                 filePath.includes('-app-klaudio') ? 'klaudio' :
                 filePath.includes('-home-klaudio/') ? 'daemon' : 'session'

  if (entry.type === 'assistant' && entry.message?.content && Array.isArray(entry.message.content)) {
    const model = entry.message.model || ''
    const ms = model.includes('opus') ? 'opus' :
               model.includes('sonnet') ? 'sonnet' :
               model.includes('haiku') ? 'haiku' : model.split('-').pop()?.substring(0, 8) || '??'

    for (const block of entry.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        const thought = String(block.thinking).replace(/\s+/g, ' ').trim().substring(0, 250)
        broadcastKonzola(
          `🧠 [${ms}] ${thought}${block.thinking.length > 250 ? '...' : ''}`,
          'log-thinking', source
        )
      }
      else if (block.type === 'tool_use' && block.name) {
        const tool = block.name
        const input = block.input || {}
        let detail = ''
        if (tool === 'Read' && input.file_path) detail = ` → ${input.file_path}`
        else if (tool === 'Edit' && input.file_path) detail = ` → ${input.file_path}`
        else if (tool === 'Write' && input.file_path) detail = ` → ${input.file_path}`
        else if (tool === 'Bash' && input.command) detail = ` → ${String(input.command).substring(0, 80)}`
        else if (tool === 'Grep' && input.pattern) detail = ` → "${input.pattern}"`
        else if (tool === 'Glob' && input.pattern) detail = ` → ${input.pattern}`
        else if (tool === 'Task') detail = ` → ${input.description || ''} [${input.subagent_type || ''}]`
        else if (tool === 'TodoWrite') detail = ' → update tasks'
        else if (tool === 'WebSearch' && input.query) detail = ` → "${input.query}"`
        else if (tool === 'WebFetch' && input.url) detail = ` → ${input.url}`
        broadcastKonzola(`🔧 [${ms}] ${tool}${detail}`, 'log-info', source)
      }
      else if (block.type === 'text' && block.text) {
        const text = String(block.text).replace(/\s+/g, ' ').trim().substring(0, 250)
        if (text.length > 5) { // Skip trivial empty responses
          broadcastKonzola(
            `💭 [${ms}] ${text}${block.text.length > 250 ? '...' : ''}`,
            'log-text', source
          )
        }
      }
    }

    // Show token usage if available (indicates processing completed)
    const usage = entry.message?.usage
    if (usage && (usage.input_tokens || usage.output_tokens)) {
      const inp = usage.input_tokens || 0
      const out = usage.output_tokens || 0
      const cache = usage.cache_read_input_tokens || 0
      broadcastKonzola(
        `📊 [${ms}] tokens: in=${inp} out=${out}${cache ? ' cache=' + cache : ''}`,
        'log-system', source
      )
    }
  }
  else if (entry.type === 'progress' && entry.data) {
    const hookName = entry.data.hookName || entry.data.type || ''
    // Skip noisy SessionStart hooks
    if (hookName && !hookName.includes('SessionStart') && !hookName.includes('compact')) {
      broadcastKonzola(`⚙️ [hook] ${hookName}`, 'log-system', source)
    }
  }
  // 'user' and 'queue-operation' types are skipped (too noisy)
}

// --- Main streamer: all 5 streams ---
function startKonzolaLogStreamer() {
  const { existsSync, statSync } = require('fs')

  // Initialize log file positions from end
  for (const [, src] of Object.entries(logSources)) {
    try { if (existsSync(src.file)) src.position = statSync(src.file).size } catch {}
  }

  // Initialize event log cursor
  try {
    const db = konzolaDb
    if (db) {
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_log'").get()
      if (tableExists) {
        const last = db.prepare('SELECT MAX(id) as maxid FROM event_log').get() as any
        lastSeenEventId = last?.maxid || 0
      }
    }
  } catch {}

  // Stream 1+2+3: Log files + MQ + Events (every 2 seconds)
  logStreamInterval = setInterval(() => {
    if (wsClients.size === 0) return
    streamLogFiles()
    streamMessageQueue()
    streamEventLog()
    streamSessionJSONL()
  }, 2000)

  // Stream 4: Observability WebSocket (real-time agent tool use)
  connectObservabilityStream()
}

// ============================================
// STATUS DASHBOARD HANDLER
// ============================================

async function handleStatusDashboard(): Promise<Response> {
  // 1. Daemon status — izvedeno stanje (živ PID + starost zapisa), ne goli sadržaj datoteke
  const daemonData = await buildDaemonBlock()

  // 2. Service health (cached)
  let services: any = {}
  try {
    const health = await getCachedHealthCheck()
    services = health?.services || {}
  } catch {}

  // 3. Token usage — K7/TASK-2986.
  // Izvor je `cost_log` koji od sada puni svaki spawn (SpawnTelemetry). Prije je ovdje
  // stajao `~/.claude/stats-cache.json`, zamrznut 23.02. — ploča je pet mjeseci pokazivala
  // mrtve brojke. Stari keš ostaje SAMO kao fallback dok se cost_log ne napuni, i tada je
  // izričito označen kao zastario.
  let tokens: any = { byModel: {}, daily: [], totalSessions: 0, totalMessages: 0, source: 'none', windowDays: TOKEN_WINDOW_DAYS }
  try {
    const ct = getCostTracker()
    const byModel = ct.getUsageByModel(TOKEN_WINDOW_DAYS)
    if (Object.keys(byModel).length > 0) {
      const counts = ct.getSpawnCounts(TOKEN_WINDOW_DAYS)
      tokens = {
        byModel,
        daily: ct.getDailyTokens(TOKEN_WINDOW_DAYS),
        totalSessions: counts.sessions,
        totalMessages: counts.spawns,
        totalTasks: counts.tasks,
        lastAt: counts.lastAt,
        source: 'cost_log',
        windowDays: TOKEN_WINDOW_DAYS,
      }
    } else {
      const statsCache = JSON.parse(await Bun.file(STATS_CACHE_FILE).text())
      tokens = {
        byModel: statsCache.modelUsage || {},
        daily: statsCache.dailyModelTokens || [],
        totalSessions: statsCache.totalSessions || 0,
        totalMessages: statsCache.totalMessages || 0,
        source: 'stats-cache (zastarjelo)',
        lastAt: statsCache.lastComputedDate || null,
        windowDays: null,
      }
    }
  } catch {}

  // 4. Task stats
  let taskStats: any = {}
  try { taskStats = taskManager.getStats() } catch {}

  // 5. Project stats + active projects
  let projectStats: any = {}
  let activeProjects: any[] = []
  try {
    projectStats = projectManager.getStats()
    activeProjects = projectManager.getProjects({ status: 'active' as any })
  } catch {}

  // 6. Scheduler state
  let scheduler: any = {}
  try {
    scheduler = JSON.parse(await Bun.file(SCHEDULER_STATE_FILE).text())
  } catch {}

  // TASK-623: Read system mode
  let modeData: any = { mode: 'WORK', since: null, setBy: 'default' }
  try {
    if (existsSync(SYSTEM_MODE_FILE)) {
      modeData = JSON.parse(readFileSync(SYSTEM_MODE_FILE, 'utf-8'))
    }
  } catch {}

  return new Response(JSON.stringify({
    daemon: daemonData,
    services,
    tokens,
    tasks: taskStats,
    projects: { stats: projectStats, active: activeProjects },
    scheduler,
    mode: modeData,
    wsClients: wsClients.size,
    timestamp: new Date().toISOString()
  }), { headers: { 'Content-Type': 'application/json' } })
}

// ============================================
// AGENT STATUS API HANDLER
// ============================================

function handleGetAgents(): Response {
  const HOME = process.env.HOME || os.homedir()
  try {
    const regPath = join(TM_ROOT, 'REGOC_AGENTS.json')
    const tierMap: Record<string, string> = { opus: 'frontier', sonnet: 'strong', haiku: 'basic' }
    if (!existsSync(regPath)) {
      return new Response(JSON.stringify({ agents: [], totalAgents: 0, activeCount: 0 }), { headers: { 'Content-Type': 'application/json' } })
    }
    const reg = JSON.parse(readFileSync(regPath, 'utf-8'))
    const agentMap = reg.agents || {}

    // TASK-624: Load persistent config for per-agent status
    let persistConfig: any = { persistentMode: 'off', enabledAgents: [] }
    try {
      if (existsSync(PERSISTENT_CONFIG_FILE)) {
        persistConfig = JSON.parse(readFileSync(PERSISTENT_CONFIG_FILE, 'utf-8'))
      }
    } catch {}

    function getAgentMode(id: string): string {
      if (id === 'klaudio' || id === 'stribor') return 'standalone'
      if (id === 'emard') return 'disabled'
      if (persistConfig.persistentMode === 'off') return 'on-demand'
      if (persistConfig.persistentMode === 'full') return 'persistent'
      if (persistConfig.persistentMode === 'selective') {
        return persistConfig.enabledAgents?.includes(id) ? 'persistent' : 'on-demand'
      }
      return 'on-demand'
    }

    function isAgentAlive(id: string): boolean {
      try {
        const hbFile = join(HOME, `.tmp/agent_heartbeat_${id}.json`)
        if (!existsSync(hbFile)) return false
        const hb = JSON.parse(readFileSync(hbFile, 'utf-8'))
        const age = Date.now() - new Date(hb.ts).getTime()
        return age < 120000 // alive if heartbeat < 2 minutes
      } catch {
        return false
      }
    }

    const agents = Object.entries(agentMap).map(([id, a]: [string, any]) => ({
      id,
      name: a.name || id,
      role: a.role || '',
      model: a.model || 'unknown',
      tier: tierMap[a.model] || 'strong',
      status: isAgentAlive(id) ? 'alive' : 'idle',
      tools: a.tools?.core_skills || [],
      skills: a.skills || [],
      // TASK-624: persistent status
      persistent: getAgentMode(id) === 'persistent',
      alive: isAgentAlive(id),
      mode: getAgentMode(id),
    }))

    return new Response(JSON.stringify({
      agents,
      totalAgents: agents.length,
      activeCount: agents.filter(a => a.alive).length,
      persistentMode: persistConfig.persistentMode,
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), agents: [], totalAgents: 0, activeCount: 0 }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

// ============================================
// MODULE STATUS API HANDLER
// ============================================

function handleGetModules(): Response {
  const HOME = process.env.HOME || os.homedir()
  try {
    const modPath = join(TM_ROOT, 'modules/module-config.json')
    if (!existsSync(modPath)) {
      return new Response(JSON.stringify({ modules: [] }), { headers: { 'Content-Type': 'application/json' } })
    }
    const mc = JSON.parse(readFileSync(modPath, 'utf-8'))
    const mods = mc.modules || {}

    const degradationMap: Record<string, string> = {
      'mod-rag': 'Keyword search (ripgrep)',
      'mod-telegram': 'Console notifications',
      'mod-teamspeak': 'No voice chat',
      'mod-voice': 'Text-only notifications',
      'mod-dashboard': 'CLI-only task management',
      'mod-email': 'No email',
      'mod-gitlab': 'No GitLab',
      'mod-github': 'No GitHub',
      'mod-nextcloud': 'No file sharing',
      'mod-security': 'No tool inspection',
      'mod-knowledge': 'No knowledge graph',
    }

    const providesMap: Record<string, string[]> = {
      'core-daemon': ['messaging', 'orchestration'],
      'core-models': ['model-routing', 'multi-provider'],
      'core-taskmanager': ['task-crud', 'task-api'],
      'mod-rag': ['semantic-search', 'embeddings'],
      'mod-telegram': ['telegram-messaging', 'notifications'],
      'mod-teamspeak': ['voice-chat'],
      'mod-voice': ['tts', 'voice-notifications'],
      'mod-dashboard': ['web-dashboard', 'task-api'],
      'mod-email': ['email-send', 'email-receive'],
      'mod-gitlab': ['git-hosting', 'ci-cd'],
      'mod-github': ['git-hosting-public'],
      'mod-nextcloud': ['file-sharing', 'deck-tasks'],
      'mod-security': ['tool-inspection', 'prompt-guard', 'audit-log'],
      'mod-knowledge': ['knowledge-graph', 'wikilinks'],
    }

    const modules = Object.entries(mods).map(([id, m]: [string, any]) => {
      const req = id.startsWith('core-')
      const en = m.enabled !== false
      return {
        id,
        name: id.replace('core-', 'Core: ').replace('mod-', ''),
        enabled: en,
        required: req,
        provides: providesMap[id] || [],
        degradation: degradationMap[id] || '-',
      }
    })
    return new Response(JSON.stringify({ modules }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), modules: [] }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

// ============================================
// METRICS API HANDLER
// ============================================

async function handleGetMetrics(): Promise<Response> {
  // Cost data
  let costs: any = { total: 0, byAgent: {}, byDay: [] }
  try {
    const { getCostTracker } = await import('./core/CostTracker')
    const ct = getCostTracker()
    const stats = ct.getStats()
    costs = {
      total: stats.totalCostUsd || 0,
      byAgent: stats.byAgent || {},
      byDay: ct.getCostByDay(7),
    }
  } catch {}

  // Observability data
  let observability: any = { totalEvents: 0, byEvent: {}, last24h: 0 }
  try {
    const { getObservabilityLogger } = await import(process.env.TM_OBSERVABILITY_MODULE || './core/__nema__')
    const logger = getObservabilityLogger()
    observability = logger.getStats()
  } catch {}

  // Task stats
  let tasks: any = { total: 0, completed: 0, pending: 0, inProgress: 0 }
  try {
    const stats = taskManager.getStats()
    tasks = {
      total: stats.total || 0,
      completed: stats.byStatus?.completed || 0,
      pending: stats.byStatus?.pending || 0,
      inProgress: stats.byStatus?.in_progress || 0,
    }
  } catch {}

  return new Response(JSON.stringify({
    costs,
    observability,
    tasks,
    timestamp: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } })
}

// ============================================
// SECURITY DASHBOARD API HANDLER
// ============================================

async function handleGetSecurity(): Promise<Response> {
  // Audit log data
  let auditLog: any = { total: 0, bySeverity: {}, last24h: 0, recent: [] }
  try {
    const { getAuditLogger } = await import(process.env.TM_AUDIT_MODULE || './core/__nema__')
    const audit = getAuditLogger()
    const stats = audit.getStats()
    auditLog = {
      total: stats.total || 0,
      bySeverity: stats.bySeverity || {},
      last24h: stats.last24h || 0,
      recent: audit.query({ limit: 10 }),
    }
  } catch {}

  // PromptGuard availability
  let promptGuard = { available: false }
  try {
    const pgPath = join(TM_ROOT, 'security/PromptGuard.ts')
    promptGuard = { available: existsSync(pgPath) }
  } catch {}

  // SecurityPipeline availability
  let securityPipeline: any = { available: false, mode: 'unknown' }
  try {
    const spPath = join(TM_ROOT, 'security/SecurityPipeline.ts')
    securityPipeline = { available: existsSync(spPath), mode: 'localSafe' }
  } catch {}

  return new Response(JSON.stringify({
    auditLog,
    promptGuard,
    securityPipeline,
    timestamp: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } })
}

// ============================================
// TASK-623/624: SYSTEM MODE & PERSISTENT AGENTS API HANDLERS
// ============================================

const SYSTEM_MODE_FILE = join(process.env.HOME || os.homedir(), '.tmp/regoc_mode.json')
const PERSISTENT_CONFIG_FILE = join(process.env.HOME || os.homedir(), '.tmp/regoc_persistent_config.json')
const AGENTS_REGISTRY_FILE = join(TM_ROOT, 'REGOC_AGENTS.json')

function handleGetSystemMode(): Response {
  try {
    if (existsSync(SYSTEM_MODE_FILE)) {
      const data = JSON.parse(readFileSync(SYSTEM_MODE_FILE, 'utf-8'))
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ mode: 'WORK', since: null, setBy: 'default' }), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ mode: 'WORK', since: null, setBy: 'default' }), { headers: { 'Content-Type': 'application/json' } })
  }
}

async function handleSetSystemMode(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { mode?: string, reason?: string }
    const { mode, reason } = body

    if (mode !== 'PLAN' && mode !== 'WORK') {
      return new Response(JSON.stringify({ error: 'mode must be PLAN or WORK' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }

    const data = {
      mode,
      since: new Date().toISOString(),
      setBy: 'api',
      reason: reason || null
    }
    const { writeFileSync: wfs } = require('fs')
    wfs(SYSTEM_MODE_FILE, JSON.stringify(data, null, 2))

    // Broadcast mode change to message queue
    try {
      const mq = getMessageQueue()
      mq.sendMessage('regoc', 'klaudio', `[SYSTEM] Mode changed to ${mode}${reason ? `: ${reason}` : ''}`, {
        messageType: 'broadcast',
        priority: 1
      })
    } catch {}

    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })
  }
}

function handleGetPersistentConfig(): Response {
  try {
    if (existsSync(PERSISTENT_CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(PERSISTENT_CONFIG_FILE, 'utf-8'))
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ persistentMode: 'off', enabledAgents: [], since: null }), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ persistentMode: 'off', enabledAgents: [], since: null }), { headers: { 'Content-Type': 'application/json' } })
  }
}

async function handleSetPersistentConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { persistentMode?: string, enabledAgents?: string[], reason?: string }
    const { persistentMode, enabledAgents, reason } = body

    if (!['off', 'selective', 'full'].includes(persistentMode || '')) {
      return new Response(JSON.stringify({ error: 'persistentMode must be off/selective/full' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }

    const config = {
      persistentMode,
      enabledAgents: enabledAgents || [],
      since: new Date().toISOString(),
      setBy: 'api'
    }
    const { writeFileSync: wfs } = require('fs')
    wfs(PERSISTENT_CONFIG_FILE, JSON.stringify(config, null, 2))

    return new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleToggleAgentPersistent(agentId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json() as { enabled?: boolean }
    const { enabled } = body

    let config: any
    try {
      config = existsSync(PERSISTENT_CONFIG_FILE)
        ? JSON.parse(readFileSync(PERSISTENT_CONFIG_FILE, 'utf-8'))
        : { persistentMode: 'off', enabledAgents: [] }
    } catch {
      config = { persistentMode: 'off', enabledAgents: [] }
    }

    // Auto-switch to selective on per-agent toggle
    if (config.persistentMode !== 'selective') {
      config.persistentMode = 'selective'
    }

    if (enabled && !config.enabledAgents.includes(agentId)) {
      config.enabledAgents.push(agentId)
    } else if (!enabled) {
      config.enabledAgents = config.enabledAgents.filter((a: string) => a !== agentId)
    }

    config.since = new Date().toISOString()
    config.setBy = 'api'

    const { writeFileSync: wfs } = require('fs')
    wfs(PERSISTENT_CONFIG_FILE, JSON.stringify(config, null, 2))

    return new Response(JSON.stringify({ id: agentId, persistent: enabled, config }), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })
  }
}

function handleStopAgent(agentId: string): Response {
  const signalFile = join(process.env.HOME || os.homedir(), `.tmp/agent_stop_${agentId}`)
  try {
    const { writeFileSync: wfs } = require('fs')
    wfs(signalFile, '')
    return new Response(JSON.stringify({ status: 'stop_signal_sent', agent: agentId }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

// ============================================
// SERVER
// ============================================

// Start file watcher
startFileWatcher()

// Start konzola log streamer
startKonzolaLogStreamer()

const server = Bun.serve({
  port: PORT,
  hostname: HOST,  // Bind to 0.0.0.0 for external access

  async fetch(req: Request) {
    const url = new URL(req.url)

    // Host validation for security
    if (!isHostAllowed(req)) {
      console.warn(`[Security] Blocked request from unauthorized host: ${req.headers.get('host')}`)
      return new Response('Forbidden - Host not allowed', { status: 403 })
    }

    // CORS headers - allow specific origins
    const origin = req.headers.get('origin') || '*'
    const headers = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true'
    }

    // Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers })
    }

    // WebSocket upgrade
    if (url.pathname === '/stream') {
      const success = server.upgrade(req)
      if (success) return undefined
    }

    // TASK-3096: proxy za aplikacije koje slusaju samo lokalno na nodu.
    // node-B je iza VirtualBox NAT-a i prosljedjuju se SAMO 2222 i 17781, pa aplikacija na
    // 17789 (MelodyFinder) nije dostupna izvana. Umjesto diranja VirtualBox konfiguracije
    // (koja je na Windows hostu i nije nam dostupna), promet ide kroz vec proslijedjeni
    // 17781: /app/<port>/<putanja> -> http://127.0.0.1:<port>/<putanja>.
    // Dopusten je uzak raspon portova, da ovo ne postane otvoreni proxy prema cijelom stroju.
    const APP_PROXY_PORTS = new Set([17783, 17784, 17785, 17786, 17787, 17788, 17789])
    if (url.pathname.startsWith('/app/')) {
      const seg = url.pathname.slice('/app/'.length)
      const slash = seg.indexOf('/')
      const portStr = slash < 0 ? seg : seg.slice(0, slash)
      const rest = slash < 0 ? '/' : seg.slice(slash)
      const port = Number(portStr)
      if (!APP_PROXY_PORTS.has(port)) {
        return new Response(`Proxy nije dopusten za port ${portStr}. Dopusteni: ${[...APP_PROXY_PORTS].join(', ')}`, { status: 403 })
      }
      const target = `http://127.0.0.1:${port}${rest}${url.search}`
      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers: req.headers,
          body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : await req.arrayBuffer(),
        })
        return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
      } catch (e: any) {
        return new Response(`Aplikacija na portu ${port} ne odgovara (${e?.message || e}). Je li pokrenuta na 127.0.0.1:${port}?`, { status: 502 })
      }
    }

    // Health check
    if (url.pathname === '/health') {
      return handleHealthCheck()
    }

    // Gita Image Service Proxy
    if (url.pathname === '/api/gita/generate' && req.method === 'POST') {
      try {
        const gitaResponse = await fetch('http://localhost:8889/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: await req.text()
        })
        return new Response(await gitaResponse.arrayBuffer(), {
          status: gitaResponse.status,
          headers: {
            'Content-Type': gitaResponse.headers.get('Content-Type') || 'application/json',
            ...headers
          }
        })
      } catch (error) {
        return new Response(JSON.stringify({
          error: 'Gita Image Service unavailable',
          details: error instanceof Error ? error.message : String(error)
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...headers }
        })
      }
    }

    if (url.pathname === '/api/gita/health' && req.method === 'GET') {
      try {
        const gitaResponse = await fetch('http://localhost:8889/health')
        return new Response(await gitaResponse.text(), {
          status: gitaResponse.status,
          headers: { 'Content-Type': 'application/json', ...headers }
        })
      } catch (error) {
        return new Response(JSON.stringify({
          error: 'Gita Image Service unavailable'
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...headers }
        })
      }
    }

    // Preuzimanje dokumenta na koji task (resultSummary) linka — sigurno, samo unutar HOME-a.
    if (url.pathname === '/api/files/download' && req.method === 'GET') {
      return handleFileDownload(url)
    }

    // Login providers (prijava preko linka)
    if (url.pathname === '/api/session-usage' && req.method === 'GET') return handleSessionUsage(req)
    if (url.pathname === '/api/providers/login/status' && req.method === 'GET') return handleLoginStatus()
    if (url.pathname === '/api/providers/login/start' && req.method === 'POST') return handleLoginStart(req)
    if (url.pathname === '/api/providers/login/poll' && req.method === 'GET') return handleLoginPoll(url)
    if (url.pathname === '/api/providers/login/paste' && req.method === 'POST') return handleLoginPaste(req)
    if (url.pathname === '/api/providers/login/apikey' && req.method === 'POST') return handleLoginApikey(req)
    if (url.pathname === '/api/providers/login/logout' && req.method === 'POST') return handleLoginLogout(req)

    // API Routes
    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      return handleGetTasks(url)
    }

    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      return handleCreateTask(req)
    }

    if (url.pathname.match(/^\/api\/tasks\/[^\/]+$/) && req.method === 'GET') {
      const taskId = url.pathname.split('/')[3]
      return handleGetTask(taskId)
    }

    // PUT /api/tasks/:id/progress - Update task progress
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/progress$/) && req.method === 'PUT') {
      const taskId = url.pathname.split('/')[3]
      return handleUpdateTaskProgress(taskId, req)
    }

    if (url.pathname.match(/^\/api\/tasks\/[^\/]+$/) && req.method === 'PUT') {
      const taskId = url.pathname.split('/')[3]
      return handleUpdateTask(taskId, req)
    }

    // TASK-3047: ručna kočnica — globalna i po zadatku.
    if (url.pathname === '/api/pause' && req.method === 'GET') return handleGetPause()
    if (url.pathname === '/api/pause' && req.method === 'POST') return handleSetPause(req)
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/pause$/) && req.method === 'POST') {
      return handleTaskPause(url.pathname.split('/')[3], true, req)
    }
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/resume$/) && req.method === 'POST') {
      return handleTaskPause(url.pathname.split('/')[3], false, req)
    }

    // POST /api/tasks/:id/reclaim - R2 stale-watchdog: in_progress -> pending
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/reclaim$/) && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3]
      return handleReclaimTask(taskId, req)
    }

    if (url.pathname.match(/^\/api\/tasks\/[^\/]+$/) && req.method === 'DELETE') {
      const taskId = url.pathname.split('/')[3]
      return handleDeleteTask(taskId)
    }

    // ============================================
    // PROJECT API ROUTES
    // ============================================

    // GET /api/projects - List projects
    if (url.pathname === '/api/projects' && req.method === 'GET') {
      return handleGetProjects(url)
    }

    // POST /api/projects - Create project
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      return handleCreateProject(req)
    }

    // GET /api/projects/:id - Get project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+$/) && req.method === 'GET') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleGetProject(projectId)
    }

    // PUT /api/projects/:id - Update project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+$/) && req.method === 'PUT') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleUpdateProject(projectId, req)
    }

    // DELETE /api/projects/:id - Delete project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+$/) && req.method === 'DELETE') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleDeleteProject(projectId)
    }

    // POST /api/projects/:id/dispatch-upgrade - Dispatch "Nadogradi po specifikacijama"
    if (url.pathname.match(/^\/api\/projects\/[^\/]+\/dispatch-upgrade$/) && req.method === 'POST') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleDispatchUpgrade(projectId, req)
    }

    // GET|PUT /api/templates/:name - Editabilni .md template (spec-upgrade itd.)
    const tplMatch = url.pathname.match(/^\/api\/templates\/([^/]+)$/)
    if (tplMatch && (req.method === 'GET' || req.method === 'PUT')) {
      return handleTemplate(decodeURIComponent(tplMatch[1]), req)
    }

    // POST /api/projects/:id/agents - Add agent to project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+\/agents$/) && req.method === 'POST') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleAddProjectAgent(projectId, req)
    }

    // DELETE /api/projects/:id/agents/:agentId - Remove agent from project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+\/agents\/[^\/]+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/')
      const projectId = decodeURIComponent(parts[3])
      const agentId = decodeURIComponent(parts[5])
      return handleRemoveProjectAgent(projectId, agentId)
    }

    // POST /api/projects/:id/rag - Link RAG to project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+\/rag$/) && req.method === 'POST') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleLinkProjectRAG(projectId, req)
    }

    // DELETE /api/projects/:id/rag/:collection/:docId - Unlink RAG from project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+\/rag\/[^\/]+\/[^\/]+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/')
      const projectId = decodeURIComponent(parts[3])
      const collection = decodeURIComponent(parts[5])
      const docId = decodeURIComponent(parts[6])
      return handleUnlinkProjectRAG(projectId, collection, docId)
    }

    // ============================================
    // RAG API ROUTES
    // ============================================

    // GET /api/rag/collections - List collections
    if (url.pathname === '/api/rag/collections' && req.method === 'GET') {
      return handleGetRAGCollections()
    }

    // GET /api/rag/entries - List entries with filters
    if (url.pathname === '/api/rag/entries' && req.method === 'GET') {
      return handleGetRAGEntries(url)
    }

    // GET /api/rag/entries/:collection/:id - Get single entry
    if (url.pathname.match(/^\/api\/rag\/entries\/[^\/]+\/[^\/]+$/) && req.method === 'GET') {
      const parts = url.pathname.split('/')
      const collection = decodeURIComponent(parts[4])
      const id = decodeURIComponent(parts[5])
      return handleGetRAGEntry(collection, id)
    }

    // DELETE /api/rag/entries - Bulk delete entries
    if (url.pathname === '/api/rag/entries' && req.method === 'DELETE') {
      return handleDeleteRAGEntries(req)
    }

    // GET /api/rag/health - RAG health check
    if (url.pathname === '/api/rag/health' && req.method === 'GET') {
      return handleRAGHealth()
    }

    // ============================================
    // KONZOLA API ROUTES
    // ============================================

    // GET /api/konzola/status - Aggregated status
    if (url.pathname === '/api/konzola/status' && req.method === 'GET') {
      return handleKonzolaStatus()
    }

    // POST /api/konzola/exec - Execute command
    if (url.pathname === '/api/konzola/exec' && req.method === 'POST') {
      return handleKonzolaExec(req)
    }

    // POST /api/konzola/mode - Switch plan/work mode
    if (url.pathname === '/api/konzola/mode' && req.method === 'POST') {
      return handleKonzolaMode(req)
    }

    // GET /api/konzola/logs - Tail log file
    if (url.pathname === '/api/konzola/logs' && req.method === 'GET') {
      return handleKonzolaLogs(url)
    }

    // POST /api/konzola/message - Send natural language message to REGOČ queue
    if (url.pathname === '/api/konzola/message' && req.method === 'POST') {
      return handleKonzolaMessage(req)
    }

    // ============================================
    // SYSTEM MODE API ROUTES (TASK-623)
    // ============================================

    // GET /api/system/mode — current system mode
    if (url.pathname === '/api/system/mode' && req.method === 'GET') {
      return handleGetSystemMode()
    }

    // PUT /api/system/mode — change system mode
    if (url.pathname === '/api/system/mode' && req.method === 'PUT') {
      return handleSetSystemMode(req)
    }

    // GET /api/system/persistent — persistent agents config
    if (url.pathname === '/api/system/persistent' && req.method === 'GET') {
      return handleGetPersistentConfig()
    }

    // PUT /api/system/persistent — update persistent config
    if (url.pathname === '/api/system/persistent' && req.method === 'PUT') {
      return handleSetPersistentConfig(req)
    }

    // PUT /api/agents/:id/persistent — toggle one agent persistent mode
    if (url.pathname.match(/^\/api\/agents\/[^\/]+\/persistent$/) && req.method === 'PUT') {
      const agentId = decodeURIComponent(url.pathname.split('/')[3])
      return handleToggleAgentPersistent(agentId, req)
    }

    // POST /api/agents/:id/stop — stop a persistent agent
    if (url.pathname.match(/^\/api\/agents\/[^\/]+\/stop$/) && req.method === 'POST') {
      const agentId = decodeURIComponent(url.pathname.split('/')[3])
      return handleStopAgent(agentId)
    }

    // PUT /api/agents/:id/model — set/clear per-agent model override (model-config.json)
    if (url.pathname.match(/^\/api\/agents\/[^\/]+\/model$/) && req.method === 'PUT') {
      const agentId = decodeURIComponent(url.pathname.split('/')[3])
      return handleSetAgentModel(agentId, req)
    }

    // GET /api/models/available — providers + live models (Ollama /api/tags)
    if (url.pathname === '/api/models/available' && req.method === 'GET') {
      try {
        return new Response(JSON.stringify(await buildModelsAvailable()), { headers: { 'Content-Type': 'application/json' } })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }
    }

    // PUT /api/models/providers/:id — provider setup (enabled, baseUrl, token)
    if (url.pathname.match(/^\/api\/models\/providers\/[^\/]+$/) && req.method === 'PUT') {
      const providerId = decodeURIComponent(url.pathname.split('/')[4])
      return handleSetProvider(providerId, req)
    }

    // ============================================
    // INFO API ROUTE
    // ============================================

    // GET /api/info - REGOČ System Info (model requirements, agents, modules, rules)
    if (url.pathname === '/api/info' && req.method === 'GET') {
      try {
        const info = buildInfoPayload()
        return new Response(JSON.stringify(info), { headers: { 'Content-Type': 'application/json' } })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }
    }

    // WORKFLOW API ROUTES
    // ============================================

    // GET /api/workflow/:skill/:name — Read workflow markdown
    const wfGetMatch = url.pathname.match(/^\/api\/workflow\/([^/]+)\/([^/]+)$/)
    // Path-traversal guard: skill/name are interpolated into a filesystem path
    // (read on GET, WRITE on PUT). `[^/]+` permits `..`, so reject anything that
    // isn't a strict identifier. Disallowing '.' makes '..' impossible — airtight,
    // no canonicalization needed. Applies to every method on this route.
    if (wfGetMatch) {
      const [, _wfSkill, _wfName] = wfGetMatch
      if (!/^[A-Za-z0-9_-]+$/.test(_wfSkill) || !/^[A-Za-z0-9_-]+$/.test(_wfName)) {
        return new Response(JSON.stringify({ error: 'Invalid skill or workflow name' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
    }
    if (wfGetMatch && req.method === 'GET') {
      const [, skill, name] = wfGetMatch
      const _home = process.env.HOME || os.homedir()
      const wfPath = join(_home, '.claude/skills', skill, 'Workflows', name + '.md')
      if (!existsSync(wfPath)) {
        return new Response(JSON.stringify({ error: 'Workflow not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      }
      const content = readFileSync(wfPath, 'utf-8')
      const steps = content.split(/\n(?=### Step )/i).filter(s => s.match(/^### Step /i))
      return new Response(JSON.stringify({
        skill, name, path: wfPath,
        content,
        steps: steps.map((s, i) => {
          const titleMatch = s.match(/^### (.+)/m)
          return { index: i, title: titleMatch ? titleMatch[1].trim() : `Step ${i+1}`, content: s.trim() }
        }),
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    // PUT /api/workflow/:skill/:name — Save workflow markdown
    if (wfGetMatch && req.method === 'PUT') {
      const [, skill, name] = wfGetMatch
      const _home2 = process.env.HOME || os.homedir()
      const wfPath = join(_home2, '.claude/skills', skill, 'Workflows', name + '.md')
      const wfDir = join(_home2, '.claude/skills', skill, 'Workflows')
      if (!existsSync(wfDir)) {
        return new Response(JSON.stringify({ error: 'Skill workflows dir not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      }
      try {
        const body = await req.json() as { content: string }
        if (!body.content) throw new Error('Missing content')
        const { writeFileSync: _wfs } = require('fs')
        _wfs(wfPath, body.content)
        return new Response(JSON.stringify({ status: 'saved', path: wfPath }), { headers: { 'Content-Type': 'application/json' } })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
    }

    // STATUS API ROUTES
    // ============================================

    // GET /api/status/dashboard - Aggregated dashboard data
    if (url.pathname === '/api/status/dashboard' && req.method === 'GET') {
      return handleStatusDashboard()
    }

    // GET /api/agents - Agent Status Panel
    if (url.pathname === '/api/agents' && req.method === 'GET') {
      return handleGetAgents()
    }

    // GET /api/modules - Module Status
    if (url.pathname === '/api/modules' && req.method === 'GET') {
      return handleGetModules()
    }

    // GET /api/metrics - Performance Metrics
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      return handleGetMetrics()
    }

    // GET /api/security - Security Dashboard Data
    if (url.pathname === '/api/security' && req.method === 'GET') {
      return handleGetSecurity()
    }

    // Serve HTML UI
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML_TEMPLATE, {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
      })
    }

    // 404
    return new Response('Not Found', { status: 404 })
  },

  websocket: {
    open(ws) {
      console.log('[WebSocket] Client connected')
      wsClients.add(ws)

      // Send initial data
      const tasks = taskManager.getTasks()
      ws.send(JSON.stringify({ type: 'initial', tasks }))
    },

    message(ws, message) {
      console.log('[WebSocket] Message:', message)
    },

    close(ws) {
      console.log('[WebSocket] Client disconnected')
      wsClients.delete(ws)
    },

    error(ws, error) {
      console.error('[WebSocket] Error:', error)
      wsClients.delete(ws)
    }
  }
})

console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                     Regoc TaskManagerMD - Web UI Server                   ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  Internal:  ${HOST}:${PORT} (inside Docker)                                  ║
║  External:  :${EXTERNAL_PORT} (mapped by Docker)                               ║
╠───────────────────────────────────────────────────────────────────────────╣
║  Local:     http://localhost:${EXTERNAL_PORT}                                   ║
║  LAN:       http://${process.env.TM_EXTERNAL_HOST || 'localhost'}:${EXTERNAL_PORT}                              ║
║  Tailscale: http://dell-home.tailc98738.ts.net:${EXTERNAL_PORT}                 ║
╠───────────────────────────────────────────────────────────────────────────╣
║  Tasks API:    /api/tasks                                                 ║
║  Projects API: /api/projects                                              ║
║  RAG API:      /api/rag/collections, /api/rag/entries                     ║
║  Health:       /health, /api/rag/health                                   ║
║  WebSocket:    /stream                                                    ║
║  Gita:         /api/gita/generate, /api/gita/health                       ║
║  Konzola:      /api/konzola/status, /exec, /mode, /logs                  ║
║  Status:       /api/status/dashboard                                     ║
║  Agents:       /api/agents                                               ║
║  Modules:      /api/modules                                              ║
║  Metrics:      /api/metrics                                              ║
║  Security:     /api/security                                             ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  Tasks Dir: ${TASKS_DIR}
║  Watching:  ${watcherReady ? 'Active' : 'Inactive'}
╚═══════════════════════════════════════════════════════════════════════════╝
`)
