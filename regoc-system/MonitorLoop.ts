/**
 * REGOČ MONITORMODELOOP v4.0 — 7-Phase Algorithm Execution Loop
 *
 * Upgraded from v3.5 basic poll-execute to structured 7-phase loop:
 * OBSERVE → THINK → PLAN → BUILD → EXECUTE → VERIFY → LEARN
 *
 * Uses: ModeClassifier (F3.2), Structured Status (F2.2), Verification Gate (F2.1),
 *       Help Pipeline (F6.1), AuditLogger (F1.5)
 *
 * Trigger: keyword "MONITORMODELOOP" in session
 * Exit: "STOP" or "EXIT" keyword
 */

import { getModeClassifier, type ClassificationResult } from './ModeClassifier'
import { parseTaskSignal, type TaskSignal } from './MessageQueue'
import { getHelpPipeline } from './HelpPipeline'

export interface MonitorCycleMetrics {
  cycle: number
  timestamp: string
  phase: MonitorPhase
  pendingTasks: number
  activeAgents: number
  completedThisCycle: number
  blockedCount: number
  verificationPassRate: number
}

export type MonitorPhase = 'OBSERVE' | 'THINK' | 'PLAN' | 'BUILD' | 'EXECUTE' | 'VERIFY' | 'LEARN' | 'IDLE'

export interface MonitorState {
  active: boolean
  cycle: number
  currentPhase: MonitorPhase
  startedAt: string | null
  lastCycleAt: string | null
  totalTasksProcessed: number
  totalCycles: number
  metrics: MonitorCycleMetrics[]
}

export class MonitorLoop {
  private state: MonitorState = {
    active: false,
    cycle: 0,
    currentPhase: 'IDLE',
    startedAt: null,
    lastCycleAt: null,
    totalTasksProcessed: 0,
    totalCycles: 0,
    metrics: [],
  }

  private classifier = getModeClassifier()
  private helpPipeline = getHelpPipeline()
  private maxConcurrentSpawns = 3
  private cyclePauseMs = 5000

  /**
   * Phase 1: OBSERVE — Check task queue, pending messages, agent status, health
   */
  observe(): { pendingTasks: TaskSummary[]; pendingMessages: number; activeAgents: string[] } {
    this.state.currentPhase = 'OBSERVE'
    // In real implementation, this queries regoc.db and messages.db
    // For now, returns structure for integration
    return {
      pendingTasks: [],
      pendingMessages: 0,
      activeAgents: [],
    }
  }

  /**
   * Phase 2: THINK — Classify tasks by effort tier, prioritize, identify blocks
   */
  think(tasks: TaskSummary[]): ThinkResult {
    this.state.currentPhase = 'THINK'

    const classified = tasks.map(task => {
      const classification = this.classifier.classify({
        title: task.title,
        description: task.description,
        tags: task.tags,
      })
      return { task, classification }
    })

    // Sort by priority then effort
    classified.sort((a, b) => {
      if (a.task.priority !== b.task.priority) return a.task.priority - b.task.priority
      const effortOrder = { E1: 1, E2: 2, E3: 3, E4: 4, E5: 5 }
      return effortOrder[a.classification.effort] - effortOrder[b.classification.effort]
    })

    return {
      classified,
      totalE1: classified.filter(c => c.classification.effort === 'E1').length,
      totalE2: classified.filter(c => c.classification.effort === 'E2').length,
      totalE3Plus: classified.filter(c => ['E3', 'E4', 'E5'].includes(c.classification.effort)).length,
    }
  }

  /**
   * Phase 3: PLAN — Determine which agents needed, in what order, with what context
   */
  plan(thinkResult: ThinkResult, activeAgents: string[]): PlanResult {
    this.state.currentPhase = 'PLAN'

    const availableSlots = this.maxConcurrentSpawns - activeAgents.length
    const toSpawn: SpawnPlan[] = []

    for (const { task, classification } of thinkResult.classified) {
      if (toSpawn.length >= availableSlots) break
      if (classification.effort === 'E1') continue // REGOČ handles E1 directly

      for (const agentId of classification.suggestedAgents) {
        if (activeAgents.includes(agentId)) continue
        if (toSpawn.some(s => s.agentId === agentId)) continue

        toSpawn.push({
          agentId,
          taskId: task.id,
          taskTitle: task.title,
          effort: classification.effort,
          reasoning: classification.reasoning,
        })
        break // one agent per task in this cycle
      }
    }

    return { toSpawn, skipped: thinkResult.classified.length - toSpawn.length }
  }

  /**
   * Phase 4: BUILD — Prepare agent prompts with CHECKPOINT block, SO protocol
   */
  buildPrompts(plans: SpawnPlan[]): BuiltPrompt[] {
    this.state.currentPhase = 'BUILD'

    return plans.map(plan => ({
      agentId: plan.agentId,
      taskId: plan.taskId,
      prompt: this.buildAgentPrompt(plan),
      model: this.getModelForAgent(plan.agentId),
    }))
  }

  private buildAgentPrompt(plan: SpawnPlan): string {
    return `## CHECKPOINT — ${plan.agentId}
- Task: ${plan.taskTitle} (${plan.taskId})
- Effort: ${plan.effort}
- Status: in_progress

## VERIFICATION GATE (OBAVEZNO prije DONE)
1. IDENTIFY — Pronađi relevantne testove
2. RUN — Pokreni ih. Ako si dirao kod dugotrajnog procesa (daemon/server/worker),
   RUN uključuje DEPLOY: restartaj proces i provjeri
   (bun ~/.claude/regoc/StaleCodeCheck.ts --entry <fajl> --pid <pid>; exit 3 = stari kod).
   Popravak na disku nije popravak u pogonu — bun/node ne učitavaju kod ponovno.
3. READ — Pročitaj SVAKI redak outputa
4. VERIFY — Potvrdi da output DOKAZUJE uspjeh
5. CLAIM — Tek SADA pošalji [TASK_DONE:${plan.taskId}] s citatom

## STRUCTURED STATUS
Koristi jedan od:
- [TASK_DONE:${plan.taskId}] + verification evidence
- [TASK_DONE_WITH_CONCERNS:${plan.taskId}] + concerns
- [TASK_BLOCKED:${plan.taskId}] + razlog
- [TASK_NEEDS_CONTEXT:${plan.taskId}] + što nedostaje

## Ako zapneš: šalji help_request
Pošalji poruku u MessageQueue: help_request s opisom problema.

## ZADATAK
${plan.taskTitle}
${plan.reasoning}`
  }

  private getModelForAgent(agentId: string): string {
    const opusAgents = ['regoc', 'kosjenka', 'jelena', 'malik', 'manda', 'dora', 'grga', 'emard']
    return opusAgents.includes(agentId) ? 'opus' : 'sonnet'
  }

  /**
   * Phase 5: EXECUTE — Spawn agents (FOREGROUND! run_in_background = BROKEN!)
   */
  execute(prompts: BuiltPrompt[]): ExecuteResult {
    this.state.currentPhase = 'EXECUTE'
    // In real implementation, this calls spawnAgentOnDemand() from RegocDaemon
    // Returns spawn results for tracking
    return {
      spawned: prompts.map(p => ({ agentId: p.agentId, taskId: p.taskId, model: p.model })),
      failed: [],
    }
  }

  /**
   * Phase 6: VERIFY — Check completion, verification gate, structured status
   */
  verify(messages: Array<{ content: string; from: string }>): VerifyResult {
    this.state.currentPhase = 'VERIFY'

    const results: VerifyResult = { done: [], blocked: [], needsContext: [], concerns: [], invalid: [] }

    for (const msg of messages) {
      const signal = parseTaskSignal(msg.content)
      if (!signal) {
        results.invalid.push({ from: msg.from, reason: 'No structured status signal found' })
        continue
      }

      switch (signal.type) {
        case 'DONE':
          if (!signal.verification || signal.verification === '(legacy signal — no verification)') {
            results.invalid.push({ from: msg.from, reason: 'DONE without verification evidence' })
          } else {
            results.done.push({ from: msg.from, taskId: signal.taskId, verification: signal.verification })
          }
          break
        case 'DONE_WITH_CONCERNS':
          results.concerns.push({ from: msg.from, taskId: signal.taskId, concerns: signal.concerns || [] })
          break
        case 'BLOCKED':
          results.blocked.push({ from: msg.from, taskId: signal.taskId, reason: signal.reason || '', helpNeeded: signal.helpNeeded || 'unblock' })
          break
        case 'NEEDS_CONTEXT':
          results.needsContext.push({ from: msg.from, taskId: signal.taskId, contextNeeded: signal.contextNeeded || '' })
          break
      }
    }

    return results
  }

  /**
   * Phase 7: LEARN — Save lessons to RAG, update metrics
   */
  learn(verifyResult: VerifyResult): LearnResult {
    this.state.currentPhase = 'LEARN'

    this.state.cycle++
    this.state.totalCycles++
    this.state.lastCycleAt = new Date().toISOString()
    this.state.totalTasksProcessed += verifyResult.done.length

    const passRate = verifyResult.done.length + verifyResult.concerns.length > 0
      ? verifyResult.done.length / (verifyResult.done.length + verifyResult.concerns.length + verifyResult.invalid.length)
      : 0

    const metrics: MonitorCycleMetrics = {
      cycle: this.state.cycle,
      timestamp: this.state.lastCycleAt,
      phase: 'LEARN',
      pendingTasks: 0,
      activeAgents: 0,
      completedThisCycle: verifyResult.done.length,
      blockedCount: verifyResult.blocked.length,
      verificationPassRate: Math.round(passRate * 100) / 100,
    }

    this.state.metrics.push(metrics)
    if (this.state.metrics.length > 100) this.state.metrics.shift()

    return {
      metrics,
      lessonsToSave: verifyResult.blocked.map(b => `Agent ${b.from} blocked on ${b.taskId}: ${b.reason}`),
    }
  }

  getState(): MonitorState {
    return { ...this.state }
  }

  start(): void {
    this.state.active = true
    this.state.startedAt = new Date().toISOString()
    this.state.currentPhase = 'OBSERVE'
  }

  stop(): void {
    this.state.active = false
    this.state.currentPhase = 'IDLE'
  }

  isActive(): boolean {
    return this.state.active
  }
}

// Supporting types
interface TaskSummary {
  id: string
  title: string
  description: string
  priority: number
  tags: string[]
  assignee?: string
}

interface ThinkResult {
  classified: Array<{ task: TaskSummary; classification: ClassificationResult }>
  totalE1: number
  totalE2: number
  totalE3Plus: number
}

interface SpawnPlan {
  agentId: string
  taskId: string
  taskTitle: string
  effort: string
  reasoning: string
}

interface BuiltPrompt {
  agentId: string
  taskId: string
  prompt: string
  model: string
}

interface ExecuteResult {
  spawned: Array<{ agentId: string; taskId: string; model: string }>
  failed: Array<{ agentId: string; error: string }>
}

interface VerifyResult {
  done: Array<{ from: string; taskId: string; verification: string }>
  blocked: Array<{ from: string; taskId: string; reason: string; helpNeeded: string }>
  needsContext: Array<{ from: string; taskId: string; contextNeeded: string }>
  concerns: Array<{ from: string; taskId: string; concerns: string[] }>
  invalid: Array<{ from: string; reason: string }>
}

interface LearnResult {
  metrics: MonitorCycleMetrics
  lessonsToSave: string[]
}

let _instance: MonitorLoop | null = null

export function getMonitorLoop(): MonitorLoop {
  if (!_instance) _instance = new MonitorLoop()
  return _instance
}
