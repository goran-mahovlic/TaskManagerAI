#!/usr/bin/env bun
/**
 * REGOC ProjectManager
 *
 * CRUD operations for Projects in the REGOC system.
 * Handles project lifecycle, agent assignments, and RAG linking.
 *
 * Author: Jelena Kovacevic (Engineer Agent)
 * Version: 1.0.0
 */

import Database from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import {
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  ProjectFilterSchema,
  AddAgentInputSchema,
  LinkRAGInputSchema,
  type Project,
  type ProjectStatus,
  type ProjectPriority,
  type ProjectRole,
  type ProjectAgent,
  type ProjectRAGLink,
  type CreateProjectInput,
  type UpdateProjectInput,
  type ProjectFilter,
  type AddAgentInput,
  type LinkRAGInput
} from '../zod/schemas/project'
import type { AgentId } from '../zod/schemas/task'
// TASK-3516/TASK-3513: poredak projekata po zadnjem radu — jedna izvedba za oba zadatka.
import { projectLastActivityExpr, projectsOrderBy, TASKS_ORDER_BY } from './ChronoOrder'
import { TM_DB, TM_DATA } from './paths'

/**
 * Brojke zadataka po statusu za jedan projekt (TASK-3513: kućica projekta
 * pokazuje u radu / na čekanju / blokirano / gotovo). `v_projects_summary` nosi
 * samo ukupno i gotovo, pa ostala tri statusa dodajemo pri čitanju umjesto da
 * mijenjamo pogled — pogled dijele i drugi potrošači (scheduler, izvještaji).
 */
function projectStatusCountsSelect(srcAlias: string): string {
  const count = (status: string) =>
    `(SELECT COUNT(*) FROM tasks t WHERE t.project_id = ${srcAlias}.id AND t.status = '${status}')`
  return `${count('in_progress')} AS in_progress_task_count,
      ${count('pending')} AS pending_task_count,
      ${count('blocked')} AS blocked_task_count`
}

// ============================================
// CONFIGURATION
// ============================================

// U6/TASK-4266: projekti moraju živjeti u istoj bazi kao zadatci — i ondje gdje
// `~/.claude/regoc` ne postoji. Prekidač je `TM_DB`/`TM_HOME`; bez njih je putanja
// nepromijenjena, pa živa REGOČ instalacija nastavlja čitati svoju bazu.
const LEGACY_DATA_DIR = join(homedir(), '.claude/regoc/data')
const DATA_DIR = (process.env.TM_DB || process.env.TM_HOME) ? TM_DATA : LEGACY_DATA_DIR
const DB_PATH = (process.env.TM_DB || process.env.TM_HOME) ? TM_DB : join(LEGACY_DATA_DIR, 'regoc.db')
const PROJECTS_SCHEMA_PATH = join(DATA_DIR, 'projects-schema.sql')
const MIGRATE_TASKS_PATH = join(DATA_DIR, 'migrate-tasks-project.sql')

// ============================================
// PROJECT MANAGER CLASS
// ============================================

export class ProjectManager {
  private db: Database

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.ensureSchema()
  }

  /**
   * Ensure database schema exists
   */
  private ensureSchema(): void {
    // Check if projects table exists
    const tableCheck = this.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'"
    ).get()

    if (!tableCheck) {
      // Run schema migrations
      if (existsSync(PROJECTS_SCHEMA_PATH)) {
        const schema = readFileSync(PROJECTS_SCHEMA_PATH, 'utf-8')
        this.db.exec(schema)
        console.log('[ProjectManager] Projects schema applied')
      }
    }

    // Check if tasks.project_id exists
    const columnCheck = this.db.query(
      "SELECT * FROM pragma_table_info('tasks') WHERE name='project_id'"
    ).get()

    if (!columnCheck) {
      // Run tasks migration
      if (existsSync(MIGRATE_TASKS_PATH)) {
        try {
          const migration = readFileSync(MIGRATE_TASKS_PATH, 'utf-8')
          this.db.exec(migration)
          console.log('[ProjectManager] Tasks migration applied')
        } catch (error) {
          // Column might already exist in some form
          console.log('[ProjectManager] Tasks migration skipped (column may exist)')
        }
      }
    }
  }

  /**
   * Generate next project ID
   */
  private generateProjectId(): string {
    const result = this.db.query('SELECT next_id FROM project_sequence WHERE id = 1').get() as { next_id: number } | null

    if (!result) {
      this.db.exec('INSERT INTO project_sequence (id, next_id) VALUES (1, 1)')
      return 'PRJ-001'
    }

    const nextId = result.next_id
    this.db.exec(`UPDATE project_sequence SET next_id = ${nextId + 1} WHERE id = 1`)

    return `PRJ-${String(nextId).padStart(3, '0')}`
  }

  // ============================================
  // CRUD OPERATIONS
  // ============================================

  /**
   * Create a new project
   */
  createProject(input: CreateProjectInput): Project {
    const validated = CreateProjectInputSchema.parse(input)

    const id = this.generateProjectId()
    const now = new Date().toISOString()

    const stmt = this.db.prepare(`
      INSERT INTO projects (id, name, description, status, priority, lead_agent, created_at, updated_at, target_date, tags, metadata, nextcloud_folder_id, nextcloud_share_url)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      id,
      validated.name,
      validated.description || null,
      validated.priority,
      validated.lead_agent || null,
      now,
      now,
      validated.target_date || null,
      JSON.stringify(validated.tags || []),
      JSON.stringify(validated.metadata || {}),
      validated.nextcloud_folder_id || null,
      validated.nextcloud_share_url || null
    )

    // Add lead agent to project_agents if specified
    if (validated.lead_agent) {
      this.addAgent(id, { agent_id: validated.lead_agent as AgentId, role: 'lead' })
    }

    return this.getProject(id)!
  }

  /**
   * Get a project by ID
   */
  getProject(id: string): Project | null {
    const row = this.db.query(`
      SELECT v_projects_summary.*, ${projectLastActivityExpr('v_projects_summary')} AS last_activity_at,
      ${projectStatusCountsSelect('v_projects_summary')}
      FROM v_projects_summary WHERE id = ?
    `).get(id) as any

    if (!row) return null

    return this.rowToProject(row)
  }

  /**
   * Get all projects with optional filters
   */
  getProjects(filter?: ProjectFilter): Project[] {
    const validated = filter ? ProjectFilterSchema.parse(filter) : {}

    // `last_activity_at` = vrijeme zadnjeg rada na projektu (najnovija promjena
    // njegovih zadataka). Izlazi i u odgovoru, da ga ploča može prikazati bez
    // drugog upita (TASK-3513).
    let query = `SELECT v_projects_summary.*, ${projectLastActivityExpr('v_projects_summary')} AS last_activity_at,
      ${projectStatusCountsSelect('v_projects_summary')}
      FROM v_projects_summary WHERE 1=1`
    const params: any[] = []

    if (validated.status) {
      query += ' AND status = ?'
      params.push(validated.status)
    }

    if (validated.priority) {
      query += ' AND priority = ?'
      params.push(validated.priority)
    }

    if (validated.lead_agent) {
      query += ' AND lead_agent = ?'
      params.push(validated.lead_agent)
    }

    if (validated.agent) {
      query += ' AND id IN (SELECT project_id FROM project_agents WHERE agent_id = ?)'
      params.push(validated.agent)
    }

    if (validated.tag) {
      query += ' AND tags LIKE ?'
      params.push(`%"${validated.tag}"%`)
    }

    if (validated.search) {
      query += ' AND (name LIKE ? OR description LIKE ?)'
      const searchPattern = `%${validated.search}%`
      params.push(searchPattern, searchPattern)
    }

    query += projectsOrderBy('v_projects_summary')

    const rows = this.db.query(query).all(...params) as any[]
    return rows.map(row => this.rowToProject(row))
  }

  /**
   * Update a project
   */
  updateProject(id: string, input: UpdateProjectInput): Project | null {
    const validated = UpdateProjectInputSchema.parse(input)

    const existing = this.getProject(id)
    if (!existing) return null

    const updates: string[] = []
    const params: any[] = []

    if (validated.name !== undefined) {
      updates.push('name = ?')
      params.push(validated.name)
    }

    if (validated.description !== undefined) {
      updates.push('description = ?')
      params.push(validated.description)
    }

    // Spec se nosi vlastitom kolonom (ne metadata-JSON) → bez read-modify-write race-a.
    // spec_updated_at se postavlja uz svaki Save spec-a.
    if (validated.specification !== undefined) {
      updates.push('specification = ?')
      params.push(validated.specification)
      updates.push('spec_updated_at = ?')
      params.push(new Date().toISOString())
    }

    if (validated.status !== undefined) {
      updates.push('status = ?')
      params.push(validated.status)
    }

    if (validated.priority !== undefined) {
      updates.push('priority = ?')
      params.push(validated.priority)
    }

    if (validated.lead_agent !== undefined) {
      updates.push('lead_agent = ?')
      params.push(validated.lead_agent)
    }

    if (validated.target_date !== undefined) {
      updates.push('target_date = ?')
      params.push(validated.target_date)
    }

    if (validated.tags !== undefined) {
      updates.push('tags = ?')
      params.push(JSON.stringify(validated.tags))
    }

    if (validated.metadata !== undefined) {
      updates.push('metadata = ?')
      params.push(JSON.stringify(validated.metadata))
    }

    if (validated.nextcloud_folder_id !== undefined) {
      updates.push('nextcloud_folder_id = ?')
      params.push(validated.nextcloud_folder_id)
    }

    if (validated.nextcloud_share_url !== undefined) {
      updates.push('nextcloud_share_url = ?')
      params.push(validated.nextcloud_share_url)
    }

    if (updates.length === 0) {
      return existing
    }

    params.push(id)
    const stmt = this.db.prepare(`
      UPDATE projects SET ${updates.join(', ')} WHERE id = ?
    `)
    stmt.run(...params)

    return this.getProject(id)
  }

  /**
   * Delete a project
   */
  deleteProject(id: string): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ============================================
  // AGENT MANAGEMENT
  // ============================================

  /**
   * Add an agent to a project
   */
  addAgent(projectId: string, input: AddAgentInput): ProjectAgent | null {
    const validated = AddAgentInputSchema.parse(input)

    const project = this.getProject(projectId)
    if (!project) return null

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO project_agents (project_id, agent_id, role, assigned_at)
      VALUES (?, ?, ?, ?)
    `)

    const now = new Date().toISOString()
    stmt.run(projectId, validated.agent_id, validated.role, now)

    return {
      project_id: projectId,
      agent_id: validated.agent_id,
      role: validated.role,
      assigned_at: now
    }
  }

  /**
   * Remove an agent from a project
   */
  removeAgent(projectId: string, agentId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?'
    ).run(projectId, agentId)

    return result.changes > 0
  }

  /**
   * Get all agents assigned to a project
   */
  getProjectAgents(projectId: string): ProjectAgent[] {
    const rows = this.db.query(`
      SELECT * FROM project_agents WHERE project_id = ? ORDER BY role, agent_id
    `).all(projectId) as any[]

    return rows.map(row => ({
      project_id: row.project_id,
      agent_id: row.agent_id,
      role: row.role,
      assigned_at: row.assigned_at
    }))
  }

  // ============================================
  // RAG LINKING
  // ============================================

  /**
   * Link a RAG entry to a project
   */
  linkRAG(projectId: string, input: LinkRAGInput, linkedBy?: string): ProjectRAGLink | null {
    const validated = LinkRAGInputSchema.parse(input)

    const project = this.getProject(projectId)
    if (!project) return null

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO project_rag_entries (project_id, rag_collection, rag_document_id, linked_at, linked_by)
      VALUES (?, ?, ?, ?, ?)
    `)

    const now = new Date().toISOString()
    stmt.run(projectId, validated.rag_collection, validated.rag_document_id, now, linkedBy || null)

    return {
      project_id: projectId,
      rag_collection: validated.rag_collection,
      rag_document_id: validated.rag_document_id,
      linked_at: now,
      linked_by: linkedBy
    }
  }

  /**
   * Unlink a RAG entry from a project
   */
  unlinkRAG(projectId: string, collection: string, documentId: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM project_rag_entries
      WHERE project_id = ? AND rag_collection = ? AND rag_document_id = ?
    `).run(projectId, collection, documentId)

    return result.changes > 0
  }

  /**
   * Get all RAG links for a project
   */
  getProjectRAGLinks(projectId: string): ProjectRAGLink[] {
    const rows = this.db.query(`
      SELECT * FROM project_rag_entries WHERE project_id = ? ORDER BY linked_at DESC
    `).all(projectId) as any[]

    return rows.map(row => ({
      project_id: row.project_id,
      rag_collection: row.rag_collection,
      rag_document_id: row.rag_document_id,
      linked_at: row.linked_at,
      linked_by: row.linked_by
    }))
  }

  // ============================================
  // PROJECT TASKS
  // ============================================

  /**
   * Get all tasks for a project
   */
  getProjectTasks(projectId: string): any[] {
    const rows = this.db.query(`
      SELECT * FROM tasks WHERE project_id = ?
      ${TASKS_ORDER_BY}
    `).all(projectId) as any[]

    return rows.map(row => ({
      ...row,
      blockedBy: JSON.parse(row.blocked_by || '[]')
    }))
  }

  /**
   * Assign a task to a project
   */
  assignTaskToProject(taskId: string, projectId: string | null): boolean {
    // Verify project exists if not null
    if (projectId !== null) {
      const project = this.getProject(projectId)
      if (!project) return false
    }

    const result = this.db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(projectId, taskId)
    return result.changes > 0
  }

  // ============================================
  // SPEC HISTORY (snapshot pri dispatchu — ADR-1)
  // ============================================

  /**
   * Snapshot specifikacije u trenutku dispatcha (append-only).
   * taskId može biti null ako task kreiranje padne — snapshot ipak ostaje forenzika.
   * Svi parametri parametrizirani (nikad string-concat spec teksta u SQL).
   */
  addSpecHistory(projectId: string, spec: string, dispatchedTo: string, taskId: string | null): { id: string } {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO project_spec_history (id, project_id, specification, dispatched_to, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, projectId, spec, dispatchedTo, taskId, new Date().toISOString())
    return { id }
  }

  /**
   * Dohvat povijesti dispatcheva za projekt (najnoviji prvi).
   */
  getSpecHistory(projectId: string): any[] {
    return this.db.query(`
      SELECT * FROM project_spec_history WHERE project_id = ? ORDER BY created_at DESC
    `).all(projectId) as any[]
  }

  // ============================================
  // STATISTICS
  // ============================================

  /**
   * Get project statistics
   */
  getStats(): {
    total: number
    byStatus: Record<ProjectStatus, number>
    byPriority: Record<number, number>
  } {
    const rows = this.db.query(`
      SELECT status, priority, COUNT(*) as count FROM projects GROUP BY status, priority
    `).all() as { status: ProjectStatus, priority: number, count: number }[]

    const byStatus: Record<ProjectStatus, number> = {
      active: 0,
      on_hold: 0,
      completed: 0,
      archived: 0
    }

    const byPriority: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    let total = 0

    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] || 0) + row.count
      byPriority[row.priority] = (byPriority[row.priority] || 0) + row.count
      total += row.count
    }

    return { total, byStatus, byPriority }
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * Convert database row to Project object
   */
  private rowToProject(row: any): Project {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status as ProjectStatus,
      priority: row.priority as ProjectPriority,
      lead_agent: row.lead_agent,
      created_at: row.created_at,
      updated_at: row.updated_at,
      target_date: row.target_date,
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags || []),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
      nextcloud_folder_id: row.nextcloud_folder_id,
      nextcloud_share_url: row.nextcloud_share_url,
      // Spec polja (kolone na projects, izložene kroz v_projects_summary)
      specification: row.specification ?? '',
      spec_updated_at: row.spec_updated_at ?? null,
      agent_count: row.agent_count,
      task_count: row.task_count,
      completed_task_count: row.completed_task_count,
      // TASK-3513: brojke po statusu za kućicu projekta na ploči
      in_progress_task_count: row.in_progress_task_count,
      pending_task_count: row.pending_task_count,
      blocked_task_count: row.blocked_task_count,
      calculated_progress: row.calculated_progress,
      rag_entry_count: row.rag_entry_count,
      // TASK-3516/3513: vrijeme zadnjeg rada na projektu — sada ga računaju
      // i getProjects() i getProject(), pa je updated_at samo zaštitna mreža.
      last_activity_at: row.last_activity_at ?? row.updated_at
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close()
  }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

let projectManagerInstance: ProjectManager | null = null

export function getProjectManager(): ProjectManager {
  if (!projectManagerInstance) {
    projectManagerInstance = new ProjectManager()
  }
  return projectManagerInstance
}

// ============================================
// CLI USAGE
// ============================================

if (import.meta.main) {
  const pm = getProjectManager()

  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'list':
      const projects = pm.getProjects()
      console.log(JSON.stringify(projects, null, 2))
      break

    case 'create':
      const name = args[1]
      if (!name) {
        console.error('Usage: ProjectManager.ts create <name> [description]')
        process.exit(1)
      }
      const newProject = pm.createProject({
        name,
        description: args[2]
      })
      console.log('Created:', JSON.stringify(newProject, null, 2))
      break

    case 'get':
      const id = args[1]
      if (!id) {
        console.error('Usage: ProjectManager.ts get <id>')
        process.exit(1)
      }
      const project = pm.getProject(id)
      console.log(project ? JSON.stringify(project, null, 2) : 'Not found')
      break

    case 'stats':
      console.log(JSON.stringify(pm.getStats(), null, 2))
      break

    default:
      console.log(`
REGOC ProjectManager CLI

Usage:
  bun ProjectManager.ts list                    - List all projects
  bun ProjectManager.ts create <name> [desc]   - Create project
  bun ProjectManager.ts get <id>               - Get project by ID
  bun ProjectManager.ts stats                  - Show statistics
      `)
  }

  pm.close()
}
