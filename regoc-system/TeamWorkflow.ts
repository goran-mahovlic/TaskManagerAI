#!/usr/bin/env bun
/**
 * REGOČ A7: Team Workflow Engine
 *
 * Multi-agent pipeline orchestration. Defines and executes
 * multi-agent workflows (e.g., Kosjenka -> Jelena -> Potjeh -> Malik).
 *
 * Location: ~/.claude/regoc/TeamWorkflow.ts
 * Storage:  ~/.claude/regoc/data/workflows.json
 *
 * Usage:
 *   import { getTeamWorkflow } from '~/.claude/regoc/TeamWorkflow'
 *   const tw = getTeamWorkflow()
 *   const instance = tw.createFromTemplate('implement-feature', 'TASK-500')
 *   const ready = tw.getReadySteps(instance)
 *
 * Author: Jelena Kovacevic (Engineer Agent)
 * Version: 1.0.0
 * Created: 2026-05-19
 */

import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'

// ============================================
// Configuration
// ============================================

const REGOC_DIR = join(process.env.HOME || '', '.claude/regoc')
const DATA_DIR = join(REGOC_DIR, 'data')
const WORKFLOWS_FILE = join(DATA_DIR, 'workflows.json')

// ============================================
// Types
// ============================================

export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed'
export type StepRole = 'design' | 'implement' | 'test' | 'review' | 'research' | 'analyze' | 'synthesize' | 'audit' | 'verify' | 'recommend' | 'fix'

export interface WorkflowStep {
  agent: string
  role: StepRole | string
  description: string
  dependsOn?: string[]   // step IDs that must complete first
}

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
  steps: WorkflowStep[]
}

export interface WorkflowStepInstance extends WorkflowStep {
  stepId: string
  status: WorkflowStepStatus
  result?: string
  error?: string
  startedAt?: string
  completedAt?: string
}

export interface WorkflowInstance {
  id: string
  workflowId: string
  name: string
  taskId: string
  status: WorkflowStatus
  context?: string
  steps: WorkflowStepInstance[]
  createdAt: string
  completedAt?: string
}

// ============================================
// Built-in Templates
// ============================================

const TEMPLATES: Record<string, WorkflowDefinition> = {
  'implement-feature': {
    id: 'implement-feature',
    name: 'Implement Feature',
    description: 'Full feature implementation pipeline: design -> implement -> test -> security review',
    steps: [
      {
        agent: 'kosjenka',
        role: 'design',
        description: 'Architect designs the feature: ADR, interfaces, data model, integration points',
        dependsOn: [],
      },
      {
        agent: 'jelena',
        role: 'implement',
        description: 'Engineer implements the feature according to design spec',
        dependsOn: ['step-1'],
      },
      {
        agent: 'potjeh',
        role: 'test',
        description: 'QA writes and runs tests, verifies implementation matches design',
        dependsOn: ['step-2'],
      },
      {
        agent: 'malik',
        role: 'review',
        description: 'Security reviews implementation for vulnerabilities, credential leaks, error handling',
        dependsOn: ['step-2'],
      },
    ],
  },
  'research': {
    id: 'research',
    name: 'Research Pipeline',
    description: 'Research -> analysis -> synthesis pipeline for deep investigation',
    steps: [
      {
        agent: 'manda',
        role: 'research',
        description: 'Researcher gathers information from RAG, web, and documentation',
        dependsOn: [],
      },
      {
        agent: 'dora',
        role: 'analyze',
        description: 'Analyst examines findings from multiple perspectives',
        dependsOn: ['step-1'],
      },
      {
        agent: 'kosjenka',
        role: 'synthesize',
        description: 'Architect synthesizes analysis into actionable recommendations and architecture decisions',
        dependsOn: ['step-2'],
      },
    ],
  },
  'security-audit': {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Security audit -> verification -> recommendations pipeline',
    steps: [
      {
        agent: 'malik',
        role: 'audit',
        description: 'Security performs penetration testing, code review, and vulnerability assessment',
        dependsOn: [],
      },
      {
        agent: 'potjeh',
        role: 'verify',
        description: 'QA verifies findings are reproducible and documents test cases',
        dependsOn: ['step-1'],
      },
      {
        agent: 'kosjenka',
        role: 'recommend',
        description: 'Architect creates remediation plan and architectural recommendations',
        dependsOn: ['step-2'],
      },
    ],
  },
  'bug-fix': {
    id: 'bug-fix',
    name: 'Bug Fix',
    description: 'Fix -> test -> security review pipeline for bug resolution',
    steps: [
      {
        agent: 'jelena',
        role: 'fix',
        description: 'Engineer diagnoses root cause and implements fix with regression tests',
        dependsOn: [],
      },
      {
        agent: 'potjeh',
        role: 'test',
        description: 'QA verifies fix resolves the issue, runs regression suite, checks edge cases',
        dependsOn: ['step-1'],
      },
      {
        agent: 'malik',
        role: 'review',
        description: 'Security reviews fix for new vulnerabilities and proper error handling',
        dependsOn: ['step-1'],
      },
    ],
  },
}

// ============================================
// Storage
// ============================================

interface WorkflowStorage {
  instances: WorkflowInstance[]
}

function loadStorage(): WorkflowStorage {
  if (!existsSync(WORKFLOWS_FILE)) {
    return { instances: [] }
  }
  try {
    const raw = readFileSync(WORKFLOWS_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { instances: [] }
  }
}

function saveStorage(storage: WorkflowStorage): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true })
  }
  writeFileSync(WORKFLOWS_FILE, JSON.stringify(storage, null, 2), 'utf-8')
}

// ============================================
// TeamWorkflow Class
// ============================================

export class TeamWorkflow {
  static TEMPLATES = TEMPLATES

  private storagePath: string

  constructor(storagePath?: string) {
    this.storagePath = storagePath || WORKFLOWS_FILE
  }

  // --- Storage helpers ---

  private load(): WorkflowStorage {
    if (!existsSync(this.storagePath)) {
      return { instances: [] }
    }
    try {
      const raw = readFileSync(this.storagePath, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return { instances: [] }
    }
  }

  private save(storage: WorkflowStorage): void {
    const dir = join(this.storagePath, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(this.storagePath, JSON.stringify(storage, null, 2), 'utf-8')
  }

  // --- Public API ---

  /**
   * Create a workflow instance from a built-in template.
   */
  createFromTemplate(templateId: string, taskId: string, context?: string): WorkflowInstance {
    const template = TEMPLATES[templateId]
    if (!template) {
      throw new Error(`Unknown workflow template: ${templateId}. Available: ${Object.keys(TEMPLATES).join(', ')}`)
    }
    return this.create(template, taskId, context)
  }

  /**
   * Create a workflow instance from a custom definition.
   */
  create(definition: WorkflowDefinition, taskId: string, context?: string): WorkflowInstance {
    const instanceId = `WF-${Date.now()}-${randomUUID().slice(0, 8)}`

    // Assign stepIds to steps (step-1, step-2, etc.)
    const steps: WorkflowStepInstance[] = definition.steps.map((step, index) => ({
      ...step,
      stepId: `step-${index + 1}`,
      status: 'pending' as WorkflowStepStatus,
      dependsOn: step.dependsOn || [],
    }))

    const instance: WorkflowInstance = {
      id: instanceId,
      workflowId: definition.id,
      name: definition.name,
      taskId,
      status: 'pending',
      context,
      steps,
      createdAt: new Date().toISOString(),
    }

    const storage = this.load()
    storage.instances.push(instance)
    this.save(storage)

    return instance
  }

  /**
   * Get steps that are ready to execute (all dependencies met).
   * A step is ready if:
   * - Its status is 'pending'
   * - All steps listed in dependsOn have status 'completed'
   */
  getReadySteps(instance: WorkflowInstance): WorkflowStepInstance[] {
    // Reload from storage to get latest state
    const current = this.getStatus(instance.id)
    if (!current) return []

    return current.steps.filter(step => {
      if (step.status !== 'pending') return false

      // No dependencies = ready
      if (!step.dependsOn || step.dependsOn.length === 0) return true

      // All dependencies must be completed
      return step.dependsOn.every(depId => {
        const depStep = current.steps.find(s => s.stepId === depId)
        return depStep?.status === 'completed'
      })
    })
  }

  /**
   * Start a step (mark as running).
   */
  startStep(instanceId: string, stepId: string): boolean {
    const storage = this.load()
    const instance = storage.instances.find(i => i.id === instanceId)
    if (!instance) return false

    const step = instance.steps.find(s => s.stepId === stepId)
    if (!step || step.status !== 'pending') return false

    step.status = 'running'
    step.startedAt = new Date().toISOString()

    // If workflow was pending, set it to running
    if (instance.status === 'pending') {
      instance.status = 'running'
    }

    this.save(storage)
    return true
  }

  /**
   * Mark a step as completed with a result.
   * Auto-completes the workflow if all steps are done.
   */
  completeStep(instanceId: string, stepId: string, result: string): boolean {
    const storage = this.load()
    const instance = storage.instances.find(i => i.id === instanceId)
    if (!instance) return false

    const step = instance.steps.find(s => s.stepId === stepId)
    if (!step) return false
    if (step.status !== 'running' && step.status !== 'pending') return false

    step.status = 'completed'
    step.result = result
    step.completedAt = new Date().toISOString()
    if (!step.startedAt) {
      step.startedAt = step.completedAt
    }

    // If workflow was pending, set it to running
    if (instance.status === 'pending') {
      instance.status = 'running'
    }

    // Check if all steps are now completed or skipped
    const allDone = instance.steps.every(
      s => s.status === 'completed' || s.status === 'skipped'
    )
    if (allDone) {
      instance.status = 'completed'
      instance.completedAt = new Date().toISOString()
    }

    this.save(storage)
    return true
  }

  /**
   * Mark a step as failed with an error message.
   * Skips dependent steps and marks workflow as failed.
   */
  failStep(instanceId: string, stepId: string, error: string): boolean {
    const storage = this.load()
    const instance = storage.instances.find(i => i.id === instanceId)
    if (!instance) return false

    const step = instance.steps.find(s => s.stepId === stepId)
    if (!step) return false

    step.status = 'failed'
    step.error = error
    step.completedAt = new Date().toISOString()
    if (!step.startedAt) {
      step.startedAt = step.completedAt
    }

    // Skip all steps that depend on this failed step (transitively)
    this.skipDependents(instance, stepId)

    // Mark workflow as failed
    instance.status = 'failed'

    this.save(storage)
    return true
  }

  /**
   * Recursively skip all steps that depend on the given stepId.
   */
  private skipDependents(instance: WorkflowInstance, failedStepId: string): void {
    const directDependents = instance.steps.filter(
      s => s.dependsOn?.includes(failedStepId) && s.status === 'pending'
    )

    for (const dep of directDependents) {
      dep.status = 'skipped'
      dep.completedAt = new Date().toISOString()
      // Recursively skip steps that depend on this skipped step
      this.skipDependents(instance, dep.stepId)
    }
  }

  /**
   * Get current workflow status by ID.
   */
  getStatus(instanceId: string): WorkflowInstance | null {
    const storage = this.load()
    return storage.instances.find(i => i.id === instanceId) || null
  }

  /**
   * List all workflow instances.
   */
  list(): WorkflowInstance[] {
    const storage = this.load()
    return storage.instances
  }

  /**
   * List all available template IDs.
   */
  listTemplates(): string[] {
    return Object.keys(TEMPLATES)
  }

  /**
   * Get a template definition by ID.
   */
  getTemplate(templateId: string): WorkflowDefinition | undefined {
    return TEMPLATES[templateId]
  }
}

// ============================================
// Singleton
// ============================================

let _instance: TeamWorkflow | null = null

export function getTeamWorkflow(): TeamWorkflow {
  if (!_instance) {
    _instance = new TeamWorkflow()
  }
  return _instance
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const command = args[0]

  const tw = getTeamWorkflow()

  if (!command || command === '--help') {
    console.log(`
REGOC Team Workflow Engine (A7)

Usage:
  bun TeamWorkflow.ts <command> [options]

Commands:
  templates                          List available workflow templates
  create <template> <taskId> [ctx]   Create workflow from template
  custom <jsonFile> <taskId>         Create workflow from JSON definition
  status <instanceId>                Get workflow status
  ready <instanceId>                 Get steps ready to execute
  start <instanceId> <stepId>        Mark step as running
  complete <instanceId> <stepId> <result>  Mark step as completed
  fail <instanceId> <stepId> <error>      Mark step as failed
  list                               List all workflow instances

Examples:
  bun TeamWorkflow.ts templates
  bun TeamWorkflow.ts create implement-feature TASK-500 "Build auth module"
  bun TeamWorkflow.ts status WF-1716100000-abcd1234
  bun TeamWorkflow.ts ready WF-1716100000-abcd1234
  bun TeamWorkflow.ts complete WF-1716100000-abcd1234 step-1 "Design complete: used Strategy pattern"
`)
    process.exit(0)
  }

  switch (command) {
    case 'templates': {
      const templates = tw.listTemplates()
      console.log('Available workflow templates:')
      for (const id of templates) {
        const t = tw.getTemplate(id)!
        console.log(`  ${id}: ${t.description}`)
        for (const step of t.steps) {
          const deps = step.dependsOn?.length ? ` [depends: ${step.dependsOn.join(', ')}]` : ''
          console.log(`    -> ${step.agent} (${step.role})${deps}`)
        }
      }
      break
    }

    case 'create': {
      const templateId = args[1]
      const taskId = args[2]
      const context = args[3]
      if (!templateId || !taskId) {
        console.error('Usage: create <template> <taskId> [context]')
        process.exit(1)
      }
      const instance = tw.createFromTemplate(templateId, taskId, context)
      console.log(`Workflow created: ${instance.id}`)
      console.log(`  Template: ${instance.name}`)
      console.log(`  Task: ${instance.taskId}`)
      console.log(`  Steps: ${instance.steps.length}`)
      for (const step of instance.steps) {
        console.log(`    ${step.stepId}: ${step.agent} (${step.role}) - ${step.status}`)
      }
      break
    }

    case 'status': {
      const id = args[1]
      if (!id) {
        console.error('Usage: status <instanceId>')
        process.exit(1)
      }
      const instance = tw.getStatus(id)
      if (!instance) {
        console.error(`Workflow not found: ${id}`)
        process.exit(1)
      }
      console.log(JSON.stringify(instance, null, 2))
      break
    }

    case 'ready': {
      const id = args[1]
      if (!id) {
        console.error('Usage: ready <instanceId>')
        process.exit(1)
      }
      const instance = tw.getStatus(id)
      if (!instance) {
        console.error(`Workflow not found: ${id}`)
        process.exit(1)
      }
      const ready = tw.getReadySteps(instance)
      if (ready.length === 0) {
        console.log('No steps ready to execute')
      } else {
        console.log('Ready steps:')
        for (const step of ready) {
          console.log(`  ${step.stepId}: ${step.agent} (${step.role}) - ${step.description}`)
        }
      }
      break
    }

    case 'start': {
      const id = args[1]
      const stepId = args[2]
      if (!id || !stepId) {
        console.error('Usage: start <instanceId> <stepId>')
        process.exit(1)
      }
      const ok = tw.startStep(id, stepId)
      console.log(ok ? `Step ${stepId} started` : `Failed to start step ${stepId}`)
      break
    }

    case 'complete': {
      const id = args[1]
      const stepId = args[2]
      const result = args[3]
      if (!id || !stepId || !result) {
        console.error('Usage: complete <instanceId> <stepId> <result>')
        process.exit(1)
      }
      const ok = tw.completeStep(id, stepId, result)
      console.log(ok ? `Step ${stepId} completed` : `Failed to complete step ${stepId}`)
      break
    }

    case 'fail': {
      const id = args[1]
      const stepId = args[2]
      const error = args[3]
      if (!id || !stepId || !error) {
        console.error('Usage: fail <instanceId> <stepId> <error>')
        process.exit(1)
      }
      const ok = tw.failStep(id, stepId, error)
      console.log(ok ? `Step ${stepId} failed` : `Failed to fail step ${stepId}`)
      break
    }

    case 'list': {
      const instances = tw.list()
      if (instances.length === 0) {
        console.log('No workflow instances')
      } else {
        for (const inst of instances) {
          const done = inst.steps.filter(s => s.status === 'completed').length
          const total = inst.steps.length
          console.log(`  ${inst.id} | ${inst.name} | ${inst.taskId} | ${inst.status} (${done}/${total} steps)`)
        }
      }
      break
    }

    default:
      console.error(`Unknown command: ${command}. Use --help for usage.`)
      process.exit(1)
  }
}
