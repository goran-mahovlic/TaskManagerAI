#!/usr/bin/env bun
/**
 * REGOČ Task Scheduler Integration
 *
 * Rješava BUG-001: Scheduler Auto-Continue Failure
 *
 * Funkcionalnosti:
 * 1. Task completion watcher - detektira kad task završi
 * 2. Auto-continue - automatski pokreće sljedeći unblocked task
 * 3. Task chain logika - prati dependencies i odblokirava taskove
 *
 * Usage:
 *   import { TaskSchedulerIntegration } from './TaskSchedulerIntegration'
 *   const scheduler = new TaskSchedulerIntegration()
 *   scheduler.start()
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { getMessageQueue } from './MessageQueue'
import { homedir } from 'os'

// ============================================
// Configuration
// ============================================

const HOME = process.env.HOME || homedir()
const TASKS_DIR = join(HOME, '.claude/tasks')
const AGENTS_DIR = join(TASKS_DIR, 'agents')
const REGOC_DIR = join(HOME, '.claude/regoc')
const FAZA8_DIR = join(REGOC_DIR, 'TaskManagerMD')
const IMPLEMENTATION_MASTER = join(FAZA8_DIR, 'IMPLEMENTATION-MASTER.md')

/**
 * TASK-4752 (A) — IZVOR PONAVLJANJA. Stanje je do 08.09.2026. živjelo u
 * '/tmp/regoc_scheduler_state.json'. U kontejneru je /tmp prolazan: svakim gubitkom
 * /tmp scheduler zaboravi koje je zadatke već objavio, ponovno pročita
 * IMPLEMENTATION-MASTER.md i objavi SVIH 10 F8 zadataka kao svježe dovršene →
 * 10 × 2 primatelja = 20 poruka po naletu. Mjereno u messages.db: 303 poruke,
 * 15 naleta po točno 20, ista F8-001..010 serija (AUTO-START TASK-F8-004 66×).
 * ~/.claude je bind-mount s hosta → stanje preživi i restart kontejnera.
 */
const SCHEDULER_STATE_DIR = join(REGOC_DIR, 'data')
export const SCHEDULER_STATE_FILE = join(SCHEDULER_STATE_DIR, 'scheduler_state.json')

/** Prolazne putanje iz kojih se stanje jednokratno preuzima (seoba bez naleta). */
export const LEGACY_SCHEDULER_STATE_FILES = [
  '/tmp/regoc_scheduler_state.json',
  join(HOME, '.tmp/regoc_scheduler_state.json'),
]
const CHECK_INTERVAL_MS = 30000 // Check every 30 seconds

// ============================================
// Types
// ============================================

interface TaskInfo {
  id: string
  title: string
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED'
  assignee: string
  blockedBy: string[]
  priority: number
}

interface SchedulerState {
  lastCheck: string
  completedTasks: string[]
  activeTasks: string[]
  queuedTasks: string[]
  lastTaskCompleted: string | null
  lastTaskStarted: string | null
}

// ============================================
// Task Parser
// ============================================

function parseTasksFromMaster(): TaskInfo[] {
  if (!existsSync(IMPLEMENTATION_MASTER)) {
    console.log('[TaskScheduler] IMPLEMENTATION-MASTER.md not found')
    return []
  }

  const content = readFileSync(IMPLEMENTATION_MASTER, 'utf-8')
  const tasks: TaskInfo[] = []

  // Parse task sections - look for ### TASK-F8-XXX patterns
  const taskSectionRegex = /### (TASK-F8-\d+):[^\n]+\n([\s\S]*?)(?=### TASK-F8-|\n## \d+\.|$)/g
  let match

  while ((match = taskSectionRegex.exec(content)) !== null) {
    const taskId = match[1]
    const section = match[2]

    // Extract status
    const statusMatch = section.match(/\*\*Status:\*\*\s*(\w+)/i)
    const status = statusMatch ? statusMatch[1].toUpperCase() : 'PENDING'

    // Extract assignee
    const assigneeMatch = section.match(/\*\*Assignee:\*\*\s*(\w+)/i)
    const assignee = assigneeMatch ? assigneeMatch[1].toLowerCase() : 'unassigned'

    // Extract blocked by
    const blockedByMatch = section.match(/\*\*Blocked By:\*\*\s*([^\n]+)/i)
    let blockedBy: string[] = []
    if (blockedByMatch && blockedByMatch[1].trim() !== '-') {
      blockedBy = blockedByMatch[1]
        .split(/[,\s]+/)
        .map(s => s.trim())
        .filter(s => s.match(/^(TASK-)?F8-\d+$/i))
        .map(s => s.startsWith('TASK-') ? s : `TASK-${s}`)
    }

    // Extract priority
    const priorityMatch = section.match(/\*\*Priority:\*\*\s*(\d+)/i)
    const priority = priorityMatch ? parseInt(priorityMatch[1]) : 5

    // Extract title from first line
    const titleMatch = match[0].match(/### TASK-F8-\d+:\s*([^\n]+)/)
    const title = titleMatch ? titleMatch[1].trim() : taskId

    tasks.push({
      id: taskId,
      title,
      status: status as TaskInfo['status'],
      assignee,
      blockedBy,
      priority
    })
  }

  return tasks
}

// ============================================
// Task Chain Logic
// ============================================

function findUnblockedTasks(tasks: TaskInfo[]): TaskInfo[] {
  const completedIds = new Set(
    tasks.filter(t => t.status === 'COMPLETED').map(t => t.id)
  )

  return tasks.filter(task => {
    // Must be PENDING or BLOCKED
    if (task.status !== 'PENDING' && task.status !== 'BLOCKED') {
      return false
    }

    // All dependencies must be completed
    const allDepsCompleted = task.blockedBy.every(depId => completedIds.has(depId))
    return allDepsCompleted
  }).sort((a, b) => a.priority - b.priority)
}

function findNextTask(tasks: TaskInfo[]): TaskInfo | null {
  const unblockedTasks = findUnblockedTasks(tasks)

  // Find first task that is PENDING (not IN_PROGRESS)
  const pendingUnblocked = unblockedTasks.filter(t => t.status === 'PENDING')

  if (pendingUnblocked.length > 0) {
    return pendingUnblocked[0]
  }

  return null
}

// ============================================
// Notification Helpers
// ============================================

async function notifyTaskCompletion(taskId: string, taskTitle: string, nextTask: TaskInfo | null): Promise<void> {
  const mq = getMessageQueue()

  let message = `Task ${taskId} COMPLETED: ${taskTitle}`
  if (nextTask) {
    message += `\nNext unblocked: ${nextTask.id} - ${nextTask.title} (assignee: ${nextTask.assignee})`
  } else {
    message += '\nNo more unblocked tasks in queue.'
  }

  // TASK-4752 (B): dojava se VIŠE NE šalje u regoc red. REGOČ je dispečer — sve što
  // mu stigne pokušava klasificirati kao posao, a "Task … COMPLETED" nije posao nego
  // obavijest da je posao gotov (07.09.2026. 19:18 je jedan nalet tako otvorio
  // TASK-4742…4751). Za čovjeka je grana prema Klaudiju/Telegramu dovoljna.
  // Vrata na dispečeru (DispatchGuard.isSchedulerNotification) ostaju kao druga
  // crta obrane za dojave iz drugih izvora.

  // Send to Klaudio (Telegram)
  mq.sendMessage('scheduler', 'klaudio', message, {
    messageType: 'text',
    priority: 3,
    metadata: {
      type: 'task_notification'
    }
  })

  console.log(`[TaskScheduler] Notified: ${message}`)
}

async function notifyTaskAutoStart(task: TaskInfo): Promise<void> {
  const mq = getMessageQueue()

  const message = `AUTO-START: ${task.id} - ${task.title}\nAssignee: ${task.assignee}\nPriority: ${task.priority}`

  // Send to assignee
  if (task.assignee !== 'unassigned') {
    mq.sendMessage('scheduler', task.assignee as any, message, {
      messageType: 'command',
      priority: 2,
      metadata: {
        type: 'task_assignment',
        taskId: task.id
      }
    })
  }

  // TASK-4752 (B): AUTO-START se više ne duplicira u regoc red. Ta je grana slala
  // poruku BEZ metapodatka (33 takve u messages.db) pa ju frazni ingress-guard nije
  // ni mogao prepoznati; assignee je ionako jedini kome je auto-start upućen.

  console.log(`[TaskScheduler] Auto-started task: ${task.id}`)
}

// ============================================
// State Management
// ============================================

function emptyState(): SchedulerState {
  return {
    lastCheck: new Date().toISOString(),
    completedTasks: [],
    activeTasks: [],
    queuedTasks: [],
    lastTaskCompleted: null,
    lastTaskStarted: null
  }
}

/**
 * Prvo čitljivo stanje s popisa (TASK-4752). Redoslijed je trajno → prolazno, pa
 * prvi pokretanje nakon seobe preuzme staro stanje umjesto da objavi 10 F8
 * dojava kao svježe. Oštećena datoteka ne obara scheduler — pada na sljedeći izvor.
 */
export function loadStateFrom(paths: string[]): SchedulerState {
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (parsed && typeof parsed === 'object') {
        return { ...emptyState(), ...parsed }
      }
    } catch {}
  }
  return emptyState()
}

function loadState(): SchedulerState {
  return loadStateFrom([SCHEDULER_STATE_FILE, ...LEGACY_SCHEDULER_STATE_FILES])
}

function saveState(state: SchedulerState): void {
  try {
    mkdirSync(SCHEDULER_STATE_DIR, { recursive: true })
    writeFileSync(SCHEDULER_STATE_FILE, JSON.stringify(state, null, 2))
  } catch (error) {
    console.error('[TaskScheduler] Error saving state:', error)
  }
}

// ============================================
// Main Scheduler Class
// ============================================

export class TaskSchedulerIntegration {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private state: SchedulerState

  constructor() {
    this.state = loadState()
  }

  /**
   * Start the scheduler
   */
  start(): void {
    console.log('[TaskScheduler] Starting task completion watcher...')
    console.log(`[TaskScheduler] Check interval: ${CHECK_INTERVAL_MS}ms`)

    // Initial check
    this.tick()

    // Set up interval
    this.intervalId = setInterval(() => this.tick(), CHECK_INTERVAL_MS)

    console.log('[TaskScheduler] Scheduler started.')
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    saveState(this.state)
    console.log('[TaskScheduler] Scheduler stopped.')
  }

  /**
   * Main tick - check for completed tasks and auto-continue
   */
  async tick(): Promise<void> {
    try {
      const tasks = parseTasksFromMaster()

      if (tasks.length === 0) {
        return
      }

      // Get current state
      const currentCompleted = tasks
        .filter(t => t.status === 'COMPLETED')
        .map(t => t.id)

      const currentActive = tasks
        .filter(t => t.status === 'IN_PROGRESS')
        .map(t => t.id)

      // Detect newly completed tasks
      const newlyCompleted = currentCompleted.filter(
        id => !this.state.completedTasks.includes(id)
      )

      // Process newly completed tasks
      for (const completedId of newlyCompleted) {
        const completedTask = tasks.find(t => t.id === completedId)
        if (completedTask) {
          console.log(`[TaskScheduler] Detected completion: ${completedId}`)

          // Find next unblocked task
          const nextTask = findNextTask(tasks)

          // Notify about completion and next task
          await notifyTaskCompletion(completedId, completedTask.title, nextTask)

          // Auto-start next task if available
          if (nextTask) {
            await notifyTaskAutoStart(nextTask)
          }

          this.state.lastTaskCompleted = completedId
        }
      }

      // Update state
      this.state.completedTasks = currentCompleted
      this.state.activeTasks = currentActive
      this.state.queuedTasks = findUnblockedTasks(tasks).map(t => t.id)
      this.state.lastCheck = new Date().toISOString()

      saveState(this.state)

    } catch (error) {
      console.error('[TaskScheduler] Error in tick:', error)
    }
  }

  /**
   * Manually trigger check for a specific task completion
   */
  async onTaskCompleted(taskId: string): Promise<void> {
    console.log(`[TaskScheduler] Manual completion trigger for: ${taskId}`)
    await this.tick()
  }

  /**
   * Get current scheduler status
   */
  getStatus(): SchedulerState {
    return { ...this.state }
  }
}

// ============================================
// CLI Interface
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const command = args[0]

  const scheduler = new TaskSchedulerIntegration()

  switch (command) {
    case 'start':
      scheduler.start()
      // Keep process running
      process.on('SIGINT', () => {
        scheduler.stop()
        process.exit(0)
      })
      break

    case 'check':
      scheduler.tick().then(() => {
        console.log('Check completed.')
        console.log('Status:', JSON.stringify(scheduler.getStatus(), null, 2))
      })
      break

    case 'status':
      console.log(JSON.stringify(scheduler.getStatus(), null, 2))
      break

    case 'tasks':
      const tasks = parseTasksFromMaster()
      console.log('\nAll Tasks:')
      tasks.forEach(t => {
        console.log(`  ${t.id}: ${t.status} (${t.assignee}) - blocked by: ${t.blockedBy.join(', ') || 'none'}`)
      })
      console.log('\nUnblocked Tasks:')
      findUnblockedTasks(tasks).forEach(t => {
        console.log(`  ${t.id}: ${t.title}`)
      })
      break

    case 'help':
    default:
      console.log(`REGOČ Task Scheduler Integration

Usage:
  bun TaskSchedulerIntegration.ts <command>

Commands:
  start   - Start the scheduler (runs continuously)
  check   - Run one check cycle
  status  - Show current scheduler state
  tasks   - List all tasks and their status
  help    - Show this help

The scheduler watches for task completions and automatically:
1. Notifies REGOČ and Klaudio when a task completes
2. Finds the next unblocked task
3. Sends auto-start notification to the assignee
`)
  }
}
