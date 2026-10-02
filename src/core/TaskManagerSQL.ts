#!/usr/bin/env bun
/**
 * TaskManagerSQL - SQL-Only Task Manager for REGOČ
 *
 * Replaces the dual Markdown+SQLite approach with pure SQL.
 * All task operations go directly to SQLite (regoc.db).
 * Audit trail via task_history table.
 *
 * Author: Jelena Kovačević (Engineer Agent)
 * Version: 2.0.0
 * Date: 2026-05-28
 */

import { ensureInstructionsSchema, addInstruction, listInstructions, claimUndelivered, instructionCounts, instructionSummary, type InstructionRow } from './TaskInstructions';
import Database, { type Statement } from "bun:sqlite";
import { TaskIdAllocator } from "./TaskIdAllocator";
import { seedConcurrency, getConcurrency, setConcurrency, concurrencyHistory, CONCURRENCY_KEY, CONCURRENCY_ENV } from "./ConcurrencySetting";
import { assertNotLiveDbInTest } from "./LiveDbGuard";
import { TM_DB, osigurajMapu } from "./paths";
// TASK-3516: jedno pravilo poretka za cijeli TaskManager — najnovije na vrhu.
import { TASKS_ORDER_BY } from "./ChronoOrder";
import { dopusteniAgenti } from "./AgentIds";

/**
 * TASK-3599 (P5c): oznake koje znace „ovo ceka covjeka". Drzane usklađeno s
 * `AutonomyQueue.DEFAULT_HUMAN_GATED_TAGS` (test to i provjerava). Namjerno se NE
 * importaju odande — TaskManagerSQL je sloj ispod orkestracije i ne smije o njoj ovisiti.
 */
export const HUMAN_GATED_UNBLOCK_TAGS = ['no-autonomy', 'waiting-for-human', 'needs-decision', 'interactive'];

/**
 * Dopuna razloga blokade kad ljudska zadrska drzi zadatak, a ovisnosti su nestale.
 * Dopisuje se IZA izvornog razloga, nikad umjesto njega (TASK-3599).
 */
export const OVISNOSTI_DOVRSENE = 'sve ovisnosti su dovršene, ostaje samo ljudska odluka';

/** Nosi li zadatak oznaku ljudske zadrske? */
export function humanGatedTask(tags?: string[] | null): boolean {
  if (!Array.isArray(tags)) return false;
  return tags.some(t => HUMAN_GATED_UNBLOCK_TAGS.includes(String(t).trim().toLowerCase()));
}

// ============================================
// TYPES & INTERFACES
// ============================================

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type TaskPriority = 1 | 2 | 3 | 4 | 5;

/**
 * Nositelj zadatka je `string`, a NE unija imena (TASK-4809).
 *
 * Do 10.09.2026. su ovdje bila nabrojana imena NAŠIH agenata, pa je paket u tipovima nosio
 * jednu instalaciju. Koja imena postoje zna tek `config/agents.json` odn. `TM_AGENTS`;
 * provjeru radi `jeDopustenAgent()` pri upisu, gdje se popis MOŽE razriješiti — tip ne može.
 */
export type AgentId = string;

/**
 * Dopušteni nositelji u OVOJ instalaciji (prazno = popis nije zatvoren).
 * Funkcija, a ne konstanta: registar smije nastati POSLIJE pokretanja ploče.
 */
export function agentIds(): string[] {
  return dopusteniAgenti().popis;
}

/**
 * TASK-3009: pretinac za zadatke koji nisu dobili projekt.
 *
 * ZASTO: prije ovoga je zadatak bez `projectId` zavrsavao s `project_id = NULL`,
 * pa je propust bio NEVIDLJIV — 28.07. je REGOC poslao `project` umjesto
 * `projectId` na 7 zadataka, API je vratio 200 i polje je tiho nestalo.
 * Pretinac je obican redak u `projects` (naziv: "Pretinac (zadatci bez
 * projekta)"), ne stvaran projekt: cini propuste BROJIVIMA i vidljivima na
 * ploci umjesto da nestanu u NULL.
 *
 * PAZI: ID je stvarni broj koji je API dodijelio (API ne postuje zadani `id`
 * nego uzima svoj sljedeci) — dakle PRJ-033, NE 'PRJ-INBOX'.
 */
export const INBOX_PROJECT_ID = 'PRJ-033';

export const PRIORITY_LABELS: Record<number, string> = {
  1: 'critical',
  2: 'high',
  3: 'normal',
  4: 'low',
  5: 'trivial'
};

export interface ProgressNote {
  timestamp: string;
  agent: string;
  note: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  blockedBy: string[];
  blocks: string[];
  blockedReason?: string;
  tags: string[];
  progressNotes: ProgressNote[];
  progressPercent?: number;
  nextcloudFolder?: string;
  projectId?: string;
  dueDate?: string;
  resultSummary?: string;
  /** TASK-3047: ručna kočnica. Ortogonalna statusu — vidi PauseControl.ts. */
  paused?: boolean;
  pausedAt?: string;
  pausedBy?: string;
  pauseReason?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignee?: string;
  createdBy?: string;
  blockedBy?: string[];
  tags?: string[];
  projectId?: string;
  dueDate?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  blockedBy?: string[];
  blockedReason?: string;
  tags?: string[];
  progressPercent?: number;
  nextcloudFolder?: string;
  projectId?: string;
  dueDate?: string;
  resultSummary?: string;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  assignee?: string;
  priority?: TaskPriority;
  tags?: string[];
  search?: string;
  projectId?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export interface HistoryEntry {
  id: number;
  task_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  changed_at: string;
}

export interface DashboardStats {
  total: number;
  byStatus: Record<TaskStatus, number>;
  byPriority: Record<number, number>;
  byAgent: Record<string, number>;
  byProject: Record<string, number>;
}

// Valid status transitions
const ValidStatusTransitions: Record<string, string[]> = {
  'pending': ['in_progress', 'blocked', 'cancelled'],
  'in_progress': ['completed', 'blocked', 'cancelled'],
  'blocked': ['pending', 'in_progress', 'cancelled'],
  // Ponovno otvaranje (16.09.2026., zahtjev vlasnika): zatvoren zadatak se vraća u red,
  // nikad ravno u rad — agent ga uzima kao i svaki drugi `pending`.
  'completed': ['pending'],
  'cancelled': ['pending']
};

// ============================================
// DB PATH
// ============================================

// SSOT je `core/paths.ts` (ADR-0001 O1.1): `$TM_DB`, inače `$TM_HOME/data/tasks.db`, inače
// `$HOME/.taskmanager/data/tasks.db` — isto mjesto na kojem bazu stvara `bun run init`.
// TASK-5011: do 02.10.2026. je bez `TM_HOME`/`TM_DB` ovdje stajala naslijeđena putanja
// izvornog sustava, pa je svježa instalacija po docs/INSTALL.md padala na SQLITE_CANTOPEN.
// Instalacija koja bazu drži na staroj putanji to kaže izričito: `TM_DB=<putanja>`.
export const DB_PATH = TM_DB;

// ============================================
// ROW → TASK MAPPER
// ============================================

function rowToTask(row: any): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    status: row.status as TaskStatus,
    priority: (row.priority ?? 3) as TaskPriority,
    assignee: row.assignee || undefined,
    createdBy: row.created_by || 'user',
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString(),
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    blockedBy: safeParseJSON(row.blocked_by, []),
    blocks: safeParseJSON(row.blocks, []),
    blockedReason: row.blocked_reason || undefined,
    tags: safeParseJSON(row.tags, []),
    progressNotes: safeParseJSON(row.progress_notes, []),
    progressPercent: row.progress_percent ?? undefined,
    nextcloudFolder: row.nextcloud_folder || undefined,
    projectId: row.project_id || undefined,
    dueDate: row.due_date || undefined,
    resultSummary: row.result_summary || undefined,
    paused: Number(row.paused ?? 0) === 1,
    pausedAt: row.paused_at || undefined,
    pausedBy: row.paused_by || undefined,
    pauseReason: row.pause_reason || undefined,
  };
}

function safeParseJSON(value: any, fallback: any): any {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ============================================
// TASK MANAGER SQL CLASS
// ============================================

export class TaskManagerSQL {
  private db: Database;

  // Prepared statements
  private stmtGetAll!: Statement;
  private stmtGetById!: Statement;
  private stmtCreate!: Statement;
  private stmtUpdate!: Statement;
  private stmtAddHistory!: Statement;
  private stmtGetHistory!: Statement;
  private stmtDelete!: Statement;
  private stmtCountByStatus!: Statement;
  private stmtCountByPriority!: Statement;
  private stmtCountByAgent!: Statement;
  private stmtCountByProject!: Statement;
  private stmtCountTotal!: Statement;

  /** TASK-2702: jedini allocator ID-eva, dijeljen s TaskManager.ts (markdown put) */
  private idAllocator: TaskIdAllocator;

  constructor(dbPath: string = DB_PATH) {
    // TASK-3020: pod test-runnerom je otvaranje ZIVE baze zabranjeno (LiveDbGuard.ts).
    assertNotLiveDbInTest(dbPath, 'TaskManagerSQL');
    osigurajMapu(dbPath);
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");

    this.ensurePauseColumns();
    this.ensureSettings();
    this.ensureInstructions();
    this.prepareStatements();
    this.idAllocator = new TaskIdAllocator(this.db);
    console.log(`[TaskManagerSQL] Initialized. Next ID: ${this.idAllocator.peek()}`);
  }

  // ============================================
  // PREPARED STATEMENTS
  // ============================================

  private prepareStatements(): void {
    this.stmtGetAll = this.db.prepare(`
      SELECT * FROM tasks
      ${TASKS_ORDER_BY}
    `);

    this.stmtGetById = this.db.prepare("SELECT * FROM tasks WHERE id = ?");

    this.stmtCreate = this.db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, priority, assignee,
        created_by, created_at, updated_at, blocked_by, blocks,
        tags, progress_notes, progress_percent, nextcloud_folder,
        project_id, started_at, completed_at, blocked_reason,
        due_date, result_summary
      ) VALUES (
        $id, $title, $description, $status, $priority, $assignee,
        $created_by, $created_at, $updated_at, $blocked_by, $blocks,
        $tags, $progress_notes, $progress_percent, $nextcloud_folder,
        $project_id, $started_at, $completed_at, $blocked_reason,
        $due_date, $result_summary
      )
    `);

    this.stmtUpdate = this.db.prepare(`
      UPDATE tasks SET
        title = $title,
        description = $description,
        status = $status,
        priority = $priority,
        assignee = $assignee,
        updated_at = $updated_at,
        blocked_by = $blocked_by,
        blocks = $blocks,
        tags = $tags,
        progress_notes = $progress_notes,
        progress_percent = $progress_percent,
        nextcloud_folder = $nextcloud_folder,
        project_id = $project_id,
        started_at = $started_at,
        completed_at = $completed_at,
        blocked_reason = $blocked_reason,
        due_date = $due_date,
        result_summary = $result_summary
      WHERE id = $id
    `);

    this.stmtDelete = this.db.prepare("DELETE FROM tasks WHERE id = ?");

    this.stmtAddHistory = this.db.prepare(`
      INSERT INTO task_history (task_id, field, old_value, new_value, changed_by)
      VALUES ($task_id, $field, $old_value, $new_value, $changed_by)
    `);

    this.stmtGetHistory = this.db.prepare(
      "SELECT * FROM task_history WHERE task_id = ? ORDER BY changed_at DESC"
    );

    this.stmtCountByStatus = this.db.prepare(
      "SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status"
    );

    this.stmtCountByPriority = this.db.prepare(
      "SELECT priority, COUNT(*) as cnt FROM tasks GROUP BY priority"
    );

    this.stmtCountByAgent = this.db.prepare(
      "SELECT COALESCE(assignee, 'unassigned') as agent, COUNT(*) as cnt FROM tasks GROUP BY agent ORDER BY cnt DESC"
    );

    this.stmtCountByProject = this.db.prepare(
      "SELECT COALESCE(project_id, 'none') as project, COUNT(*) as cnt FROM tasks WHERE project_id IS NOT NULL AND project_id != '' GROUP BY project ORDER BY cnt DESC"
    );

    this.stmtCountTotal = this.db.prepare("SELECT COUNT(*) as cnt FROM tasks");
  }

  // ============================================
  // ID GENERATION
  // ============================================

  /**
   * TASK-2702: ID dolazi iskljucivo iz TaskIdAllocatora (perzistentni brojac u bazi).
   * Nema vise in-memory nextIdNum -> dva procesa ne mogu dodijeliti isti ID.
   */
  protected generateId(): string {
    return this.idAllocator.allocate();
  }

  /** ID koji bi sljedeci createTask dobio (bez rezervacije). */
  peekNextId(): string {
    return this.idAllocator.peek();
  }

  // ============================================
  // AUDIT TRAIL
  // ============================================

  private logChange(taskId: string, field: string, oldValue: any, newValue: any, changedBy: string = 'system'): void {
    try {
      this.stmtAddHistory.run({
        $task_id: taskId,
        $field: field,
        $old_value: oldValue !== undefined && oldValue !== null ? String(oldValue) : null,
        $new_value: newValue !== undefined && newValue !== null ? String(newValue) : null,
        $changed_by: changedBy,
      });
    } catch (e: any) {
      console.error(`[TaskManagerSQL] Failed to log history for ${taskId}.${field}:`, e.message);
    }
  }

  // ============================================
  // CRUD OPERATIONS
  // ============================================

  /**
   * Get all tasks, optionally filtered
   */
  getTasks(filter?: TaskFilter): Task[] {
    let tasks: Task[];

    if (!filter || Object.keys(filter).length === 0) {
      tasks = (this.stmtGetAll.all() as any[]).map(rowToTask);
    } else {
      // Build dynamic query for filters
      const conditions: string[] = [];
      const params: any[] = [];

      if (filter.status) {
        if (Array.isArray(filter.status)) {
          const placeholders = filter.status.map(() => '?').join(',');
          conditions.push(`status IN (${placeholders})`);
          params.push(...filter.status);
        } else {
          conditions.push("status = ?");
          params.push(filter.status);
        }
      }

      if (filter.assignee) {
        conditions.push("assignee = ?");
        params.push(filter.assignee);
      }

      if (filter.priority) {
        conditions.push("priority = ?");
        params.push(filter.priority);
      }

      if (filter.projectId) {
        conditions.push("project_id = ?");
        params.push(filter.projectId);
      }

      if (filter.search) {
        conditions.push("(title LIKE ? OR description LIKE ?)");
        const searchTerm = `%${filter.search}%`;
        params.push(searchTerm, searchTerm);
      }

      if (filter.createdAfter) {
        conditions.push("created_at >= ?");
        params.push(filter.createdAfter);
      }

      if (filter.createdBefore) {
        conditions.push("created_at <= ?");
        params.push(filter.createdBefore);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT * FROM tasks ${whereClause}
      ${TASKS_ORDER_BY}`;

      const rows = this.db.prepare(sql).all(...params) as any[];
      tasks = rows.map(rowToTask);

      // Post-filter for tags (JSON array in column)
      if (filter.tags && filter.tags.length > 0) {
        tasks = tasks.filter(t =>
          filter.tags!.some(tag => t.tags.includes(tag))
        );
      }
    }

    return tasks;
  }

  /**
   * Get single task by ID
   */
  getTask(id: string): Task | null {
    const row = this.stmtGetById.get(id) as any;
    if (!row) return null;
    return rowToTask(row);
  }

  /**
   * Get the list of statuses a task may transition to from its current status.
   * Returns [] for terminal states (completed, cancelled).
   * Exposes the module-private ValidStatusTransitions table so callers (e.g. the
   * HTTP layer) can distinguish a forbidden transition from a genuine not-found
   * and build a clear error message without duplicating the transition table.
   */
  getAllowedTransitions(status: string): string[] {
    return ValidStatusTransitions[status] ?? [];
  }

  // ============================================
  // PAUZA ZADATKA (TASK-3047)
  // ============================================

  /**
   * Dodaj stupce pauze ako ih nema. Migracija je ovdje, a ne u zasebnoj skripti, jer se
   * baza otvara iz više procesa (WebUI, daemon, alati) i svaki mora zateći isti oblik —
   * `ALTER TABLE` koji padne na „duplicate column" je jedini očekivani ishod na drugom
   * pozivu i namjerno se guta.
   */
  private ensurePauseColumns(): void {
    for (const ddl of [
      "ALTER TABLE tasks ADD COLUMN paused INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN paused_at TEXT",
      "ALTER TABLE tasks ADD COLUMN paused_by TEXT",
      "ALTER TABLE tasks ADD COLUMN pause_reason TEXT",
    ]) {
      try { this.db.exec(ddl); } catch { /* stupac već postoji */ }
    }
  }

  // ============================================
  // POSTAVKE — strop usporednih agenata
  // ============================================

  /**
   * Tablice `settings`/`settings_history` i početna vrijednost stropa (3, ili jednokratno iz
   * `REGOC_MAX_AGENT_CONCURRENT` ako postavka još ne postoji). Idempotentno: bazu otvara
   * više procesa (ploča, orkestrator, alati) i svaki mora zateći isti oblik.
   */
  private ensureSettings(): void {
    try {
      const r = seedConcurrency(this.db, process.env as Record<string, string | undefined>);
      if (r.seeded) console.log(`[TaskManagerSQL] Postavka '${CONCURRENCY_KEY}' upisana: ${r.value}`);
      else if (r.envIgnored) console.warn(`[TaskManagerSQL] ${CONCURRENCY_ENV} je zastarjela — vrijedi postavka '${CONCURRENCY_KEY}'=${r.value} (Config → Usporedni agenti)`);
    } catch (err) {
      console.warn(`[TaskManagerSQL] postavke nisu inicijalizirane: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ============================================
  // DODATNE UPUTE AGENTU DOK RADI (TASK-5013)
  // ============================================

  /** Tablica `task_instructions` — idempotentno, kao `ensureSettings`. */
  private ensureInstructions(): void {
    try { ensureInstructionsSchema(this.db); }
    catch (err) { console.warn(`[TaskManagerSQL] task_instructions nije inicijalizirana: ${err instanceof Error ? err.message : err}`); }
  }

  /** Nova uputa + trag u progressNotes (ploča i povijest vide TKO je poslao uputu). */
  addTaskInstruction(taskId: string, author: string, text: string): InstructionRow {
    const row = addInstruction(this.db, taskId, author, text);
    const kratko = text.length > 120 ? text.slice(0, 117) + '…' : text;
    this.addProgressNote(taskId, author, `📨 Uputa #${row.id} (${author}) čeka dostavu agentu: ${kratko}`);
    return row;
  }

  listTaskInstructions(taskId: string, undeliveredOnly = false): InstructionRow[] {
    return listInstructions(this.db, taskId, { undeliveredOnly });
  }

  /** Atomično preuzimanje za hook; bilješka o dostavi ide samo kad je nešto dostavljeno. */
  claimTaskInstructions(taskId: string, session: string | null): InstructionRow[] {
    const rows = claimUndelivered(this.db, taskId, session);
    if (rows.length) {
      const ids = rows.map(r => `#${r.id}`).join(', ');
      this.addProgressNote(taskId, 'system', `📬 Uputa ${ids} dostavljena agentu u sesiju ${session ? session.slice(0, 8) : '?'}…`);
    }
    return rows;
  }

  taskInstructionCounts(taskId: string) { return instructionCounts(this.db, taskId); }
  taskInstructionSummary() { return instructionSummary(this.db); }

  getConcurrencySetting() { return getConcurrency(this.db); }
  setConcurrencySetting(value: number, by: string, source = 'api') { return setConcurrency(this.db, value, by, source); }
  getConcurrencyHistory(limit = 20) { return concurrencyHistory(this.db, limit); }

  /**
   * Pauziraj/nastavi zadatak. Status se NE dira — pauza je ortogonalna dimenzija
   * (vidi PauseControl.ts). Vraća ažurirani zadatak ili `null` ako ga nema.
   */
  setTaskPaused(id: string, paused: boolean, by: string = 'user', reason: string = ''): Task | null {
    const existing = this.getTask(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    this.db.query(
      `UPDATE tasks SET paused = ?, paused_at = ?, paused_by = ?, pause_reason = ?, updated_at = ? WHERE id = ?`
    ).run(paused ? 1 : 0, paused ? now : null, paused ? by : null, paused ? reason : null, now, id);

    // U povijest ide i pauza i nastavak — bez toga se poslije ne može rekonstruirati
    // zašto je zadatak stajao (isti razlog zbog kojeg postoji task_history za status).
    this.logChange(id, 'paused', existing.paused ? '1' : '0', paused ? '1' : '0', by);
    this.addProgressNote(
      id,
      by,
      paused
        ? `⏸️ PAUZA (ručno, ${by})${reason ? ` — ${reason}` : ''}. Auto-exec preskače zadatak, tekući agent se prekida. Status ostaje '${existing.status}'.`
        : `▶️ NASTAVAK (ručno, ${by}). Zadatak se vraća u normalan tijek.`
    );

    return this.getTask(id);
  }

  isTaskPaused(id: string): boolean {
    const row = this.db.query(`SELECT paused FROM tasks WHERE id = ?`).get(id) as any;
    return !!row && Number(row.paused) === 1;
  }

  /** ID-evi svih pauziranih zadataka — daemon time filtrira red i prekida spawnove. */
  getPausedTaskIds(): string[] {
    const rows = this.db.query(`SELECT id FROM tasks WHERE paused = 1`).all() as any[];
    return rows.map(r => String(r.id));
  }

  /**
   * Create a new task
   */
  createTask(input: CreateTaskInput): Task {
    const now = new Date().toISOString();
    const id = this.generateId();

    const status: TaskStatus = (input.blockedBy && input.blockedBy.length > 0) ? 'blocked' : 'pending';

    // TASK-3009: bez projekta -> pretinac, nikad NULL. Prazan string tretiramo kao
    // "nije zadano" jer ga HTTP sloj salje kad polje nije ispunjeno.
    const requestedProjectId = input.projectId?.trim() || '';
    // Vraceni Task se na kraju cita iz baze (`getTask(id)`), pa FK fallback nize ne
    // mora azurirati ovu varijablu — pozivatelj ionako dobiva ono STO JE UPISANO.
    const projectId: string = requestedProjectId || INBOX_PROJECT_ID;

    const params = {
      $id: id,
      $title: input.title,
      $description: input.description || '',
      $status: status,
      $priority: input.priority ?? 3,
      $assignee: input.assignee || null,
      $created_by: input.createdBy || 'user',
      $created_at: now,
      $updated_at: now,
      $blocked_by: JSON.stringify(input.blockedBy || []),
      $blocks: '[]',
      $tags: JSON.stringify(input.tags || []),
      $progress_notes: '[]',
      $progress_percent: null,
      $nextcloud_folder: null,
      $project_id: projectId,
      $started_at: null,
      $completed_at: null,
      $blocked_reason: '',
      $due_date: input.dueDate || null,
      $result_summary: '',
    };

    // TASK-2702: strogi INSERT (id je PRIMARY KEY) - kolizija mora puknuti, ne prepisati
    try {
      this.stmtCreate.run(params);
    } catch (error: any) {
      const message: string = error?.message ?? '';

      // TASK-3009: FK fallback. `tasks` ima TOCNO JEDAN strani kljuc
      // (project_id -> projects.id, provjereno s PRAGMA foreign_key_list(tasks)),
      // pa je svaka FK greska ovdje greska projekta.
      //
      // TASK-3514 (29.08.2026.): prije se ovdje UVIJEK upisivao NULL — i onda kad je
      // pretinac uredno postojao, a kriv je bio samo projekt IZ ZAHTJEVA (tipfeler,
      // obrisan projekt). To je bila zadnja rupa kroz koju je zadatak i dalje mogao
      // nastati nevidljiv. Sada se NULL upisuje SAMO ako ni pretinac ne postoji, jer
      // tada doista nema kamo — i tek je to stanje vrijedno vike u logu.
      if (/FOREIGN KEY constraint failed/i.test(message)) {
        if (projectId !== INBOX_PROJECT_ID) {
          console.warn(
            `[TaskManagerSQL] WARN TASK-3514: project_id='${projectId}' iz zahtjeva ne postoji u tablici ` +
            `projects. Zadatak ${id} ide u pretinac ${INBOX_PROJECT_ID}, ne u NULL.`
          );
          try {
            this.stmtCreate.run({ ...params, $project_id: INBOX_PROJECT_ID });
          } catch (fallbackError: any) {
            if (!/FOREIGN KEY constraint failed/i.test(fallbackError?.message ?? '')) throw fallbackError;
            console.warn(
              `[TaskManagerSQL] WARN TASK-3009: ni pretinac ${INBOX_PROJECT_ID} ne postoji ` +
              `(obrisan/arhiviran). Zadatak ${id} nastaje s project_id=NULL. Popravi redak projekta pa napravi backfill.`
            );
            this.stmtCreate.run({ ...params, $project_id: null });
          }
        } else {
          console.warn(
            `[TaskManagerSQL] WARN TASK-3009: pretinac ${INBOX_PROJECT_ID} nedostaje/arhiviran. ` +
            `Zadatak ${id} nastaje s project_id=NULL. Popravi redak projekta pa napravi backfill.`
          );
          this.stmtCreate.run({ ...params, $project_id: null });
        }
      } else if (/UNIQUE|constraint/i.test(message)) {
        throw new Error(
          `[TaskManagerSQL] ID collision: ${id} already exists. Refusing to overwrite. ` +
          `(original: ${error.message})`
        );
      } else {
        throw error;
      }
    }

    // Audit: task created
    this.logChange(id, 'created', null, input.title, input.createdBy || 'user');

    // Update blocks arrays on blocking tasks
    if (input.blockedBy && input.blockedBy.length > 0) {
      for (const blockerId of input.blockedBy) {
        const blocker = this.getTask(blockerId);
        if (blocker && !blocker.blocks.includes(id)) {
          const newBlocks = [...blocker.blocks, id];
          this.db.prepare("UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(newBlocks), now, blockerId);
        }
      }
    }

    const task = this.getTask(id);
    if (!task) throw new Error(`Failed to create task ${id}`);
    return task;
  }

  /**
   * Update an existing task
   */
  updateTask(id: string, updates: UpdateTaskInput & { progressNotes?: string[] }): Task | null {
    const existing = this.getTask(id);
    if (!existing) return null;

    // Status transition validation
    if (updates.status && updates.status !== existing.status) {
      if (!ValidStatusTransitions[existing.status]?.includes(updates.status)) {
        console.error(`[TaskManagerSQL] Invalid status transition: ${existing.status} -> ${updates.status}`);
        return null;
      }
    }

    const now = new Date().toISOString();
    const changedBy = updates.assignee || existing.assignee || 'system';

    // Track changes for audit
    const fieldsToCheck: Array<{ key: keyof UpdateTaskInput; dbField: string }> = [
      { key: 'title', dbField: 'title' },
      { key: 'description', dbField: 'description' },
      { key: 'status', dbField: 'status' },
      { key: 'priority', dbField: 'priority' },
      { key: 'assignee', dbField: 'assignee' },
      { key: 'blockedReason', dbField: 'blocked_reason' },
      { key: 'progressPercent', dbField: 'progress_percent' },
      { key: 'projectId', dbField: 'project_id' },
    ];

    for (const { key, dbField } of fieldsToCheck) {
      if (updates[key] !== undefined && updates[key] !== (existing as any)[key]) {
        this.logChange(id, dbField, (existing as any)[key], updates[key], changedBy);
      }
    }

    // Handle progress notes addition
    let progressNotes = existing.progressNotes;
    if (updates.progressNotes && Array.isArray(updates.progressNotes) && updates.progressNotes.length > 0) {
      // TASK-4809: bez nositelja biljesku potpisuje `changedBy` ('system'), ne ime
      // agenta iz NASE instalacije — tuda ploca takvog agenta uopce nema.
      const agent = changedBy;
      for (const noteText of updates.progressNotes) {
        progressNotes.push({
          timestamp: now,
          agent: agent,
          note: noteText,
        });
      }
    }

    // Calculate started_at and completed_at
    let startedAt = existing.startedAt;
    let completedAt = existing.completedAt;

    if (updates.status === 'in_progress' && !startedAt) {
      startedAt = now;
    }
    if (updates.status === 'completed' && !completedAt) {
      completedAt = now;
    }

    // Apply updates
    const updateParams = {
      $id: id,
      $title: updates.title ?? existing.title,
      $description: updates.description ?? existing.description,
      $status: updates.status ?? existing.status,
      $priority: updates.priority ?? existing.priority,
      $assignee: updates.assignee !== undefined ? (updates.assignee || null) : (existing.assignee || null),
      $updated_at: now,
      $blocked_by: updates.blockedBy ? JSON.stringify(updates.blockedBy) : JSON.stringify(existing.blockedBy),
      $blocks: JSON.stringify(existing.blocks),
      $tags: updates.tags ? JSON.stringify(updates.tags) : JSON.stringify(existing.tags),
      $progress_notes: JSON.stringify(progressNotes),
      $progress_percent: updates.progressPercent !== undefined ? updates.progressPercent : (existing.progressPercent ?? null),
      $nextcloud_folder: updates.nextcloudFolder !== undefined ? (updates.nextcloudFolder || null) : (existing.nextcloudFolder || null),
      // TASK-3514: „makni projekt" (prazan string s ploce ili iz skripte) NE znaci NULL
      // nego povratak u pretinac. Zadatak bez projekta ispada iz izvjestaja i troska po
      // projektu, pa je nevidljivost skuplja od pogresno pogodjenog projekta.
      //
      // Grana `else` NAMJERNO ostavlja zatecenu vrijednost (i NULL): svaki PUT dira
      // desetak polja i vecina ih ne salje projekt. Kad bi i taj slucaj vukao pretinac,
      // obican `status` PUT bi u bazi bez retka PRJ-033 pucao na stranom kljucu — to
      // je bio kvar koji je oborio 15 postojecih testova (izolirane fixture baze).
      $project_id: updates.projectId !== undefined
        ? (updates.projectId.trim() || INBOX_PROJECT_ID)
        : (existing.projectId || null),
      $started_at: startedAt || null,
      $completed_at: completedAt || null,
      $blocked_reason: updates.blockedReason !== undefined ? (updates.blockedReason || '') : (existing.blockedReason || ''),
      $due_date: updates.dueDate !== undefined ? (updates.dueDate || null) : (existing.dueDate || null),
      $result_summary: updates.resultSummary !== undefined ? (updates.resultSummary || '') : (existing.resultSummary || ''),
    };

    try {
      this.stmtUpdate.run(updateParams);
    } catch (error: any) {
      // Isti razred kvara kao na INSERT-u: jedini strani kljuc u `tasks` je projekt.
      // Ako je pretinac obrisan/arhiviran, „makni projekt" ne smije srusiti PUT koji je
      // usput mijenjao status i biljeske — vrati se na NULL i vici u log.
      const poruka: string = error?.message ?? '';
      const trazioPretinac = updates.projectId !== undefined && !updates.projectId.trim();
      if (!/FOREIGN KEY constraint failed/i.test(poruka) || !trazioPretinac) throw error;
      console.warn(
        `[TaskManagerSQL] WARN TASK-3514: pretinac ${INBOX_PROJECT_ID} ne postoji, ` +
        `zadatak ${id} ostaje bez projekta (NULL). Popravi redak projekta pa napravi backfill.`
      );
      this.stmtUpdate.run({ ...updateParams, $project_id: null });
    }

    // TASK-3521: RECIPROCITET blockedBy <-> blocks pri izmjeni lanca.
    //
    // `createTask` je od pocetka upisivao dijete u `blocks` roditelja, ali `updateTask`
    // nije — pisao je samo vlastiti stupac (`$blocks: existing.blocks`). Auto-unblock
    // nize iterira `blocks` RODITELJA, pa je lanac slozen naknadno preko
    // `PUT /api/tasks/<ID>` s `blockedBy` ostavljao roditelja s praznim `blocks` i
    // dijete se nikad nije vratilo u `pending` (MUSZG red TASK-3503 -> TASK-3474,
    // 28.08.2026. — reciprocitet je morao biti dopisan rucno u bazu).
    //
    // Radi se TEK NAKON glavnog UPDATE-a i samo kad je `blockedBy` STVARNO poslan:
    // grana `else` u `$blocked_by` namjerno ostavlja zatecenu vrijednost, pa PUT koji
    // dira samo status ne smije ni taknuti tudji `blocks`.
    if (updates.blockedBy !== undefined) {
      const stariRoditelji = existing.blockedBy;
      // Samoblokada je mrtav zadatak — nikad je ne materijaliziraj u `blocks`.
      const noviRoditelji = updates.blockedBy.filter(bid => bid !== id);

      const uklonjeni = stariRoditelji.filter(bid => bid !== id && !noviRoditelji.includes(bid));
      const dodani = noviRoditelji.filter(bid => !stariRoditelji.includes(bid));

      for (const blockerId of uklonjeni) {
        const blocker = this.getTask(blockerId);
        if (!blocker || !blocker.blocks.includes(id)) continue;
        this.db.prepare("UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(blocker.blocks.filter(bid => bid !== id)), now, blockerId);
      }

      for (const blockerId of dodani) {
        const blocker = this.getTask(blockerId);
        // Nepostojeci roditelj (tipfeler u ID-u) se preskace, ne rusi PUT — isto kao u
        // `createTask`. `blocked_by` ostaje zapisan kakav je poslan, da se rupa vidi.
        if (!blocker || blocker.blocks.includes(id)) continue;
        this.db.prepare("UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify([...blocker.blocks, id]), now, blockerId);
      }
    }

    // Handle completion: unblock waiting tasks
    if (updates.status === 'completed') {
      for (const waitingId of existing.blocks) {
        const waitingTask = this.getTask(waitingId);
        if (waitingTask) {
          const newBlockedBy = waitingTask.blockedBy.filter(bid => bid !== id);
          // TASK-3599 (P5c): LJUDSKA ZADRSKA NADJACAVA AUTO-UNBLOCK.
          // Kvar 02.09. u 10:09 i ponovljen u 21:22 na TASK-3630: korak iznad canary-stropa
          // razlaganja stvoren je kao `blocked` s razlogom „canary-strop … ceka ljudsku potvrdu",
          // ali cim su mu ovisnosti zavrsile, ovaj auto-unblock ga je prebacio u `pending` i
          // obrisao razlog. Strop je tako cuvao samo pumpu (readySteps/maxWave), dok je zadatak
          // na plocu izasao kao obican `pending` bez ijednog traga zasto ceka. Oznaka
          // `waiting-for-human` (AutonomyQueue.DEFAULT_HUMAN_GATED_TAGS) je jedina brava koja
          // drzi — pa je ovdje postujemo: ovisnost se skida, ali status i razlog ostaju.
          const humanHeld = humanGatedTask(waitingTask.tags);
          const newStatus = (!humanHeld && newBlockedBy.length === 0 && waitingTask.status === 'blocked') ? 'pending' : waitingTask.status;
          // Razlog blokade mora pratiti stvarnost (vlasnik, 05.09.2026.: „to bi trebalo biti
          // vidljivije oznaceno jer ovako ne vidim"). Kad ljudska zadrska zadrzi status, a
          // ovisnosti su nestale, stari tekst „Ceka TASK-4620" ostajao je zapisan i nakon sto
          // je TASK-4620 dovrsen — sedam zadataka je 6 h pisalo da cekaju zadatak koji je gotov.
          // Izvorni razlog se NE brise (TASK-3599: brisanje je bio prethodni kvar) nego dobiva
          // dopunu — pa se vidi i zasto je zadatak stao i da ga vise nista ne ceka.
          const noviRazlog = (humanHeld && newBlockedBy.length === 0
                              && !String(waitingTask.blockedReason || '').includes(OVISNOSTI_DOVRSENE))
            ? [String(waitingTask.blockedReason || '').trim(), OVISNOSTI_DOVRSENE].filter(Boolean).join(' · ')
            : null;
          this.db.prepare(
            "UPDATE tasks SET blocked_by = ?, status = ?, blocked_reason = CASE WHEN ? = 'pending' THEN '' WHEN ? IS NOT NULL THEN ? ELSE blocked_reason END, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(newBlockedBy), newStatus, newStatus, noviRazlog, noviRazlog, now, waitingId);
          if (newStatus !== waitingTask.status) {
            this.logChange(waitingId, 'status', waitingTask.status, newStatus, 'system');
          } else if (humanHeld && newBlockedBy.length === 0 && waitingTask.status === 'blocked') {
            this.logChange(waitingId, 'auto_unblock_held', id, `zadrzano: ${HUMAN_GATED_UNBLOCK_TAGS.filter(t => (waitingTask.tags || []).includes(t)).join(',')}`, 'system');
          }
        }
      }
    }

    return this.getTask(id);
  }

  /**
   * Add a progress note to a task
   */
  addProgressNote(id: string, agent: string, note: string): void {
    const task = this.getTask(id);
    if (!task) return;

    const now = new Date().toISOString();
    const notes = [...task.progressNotes, { timestamp: now, agent, note }];

    this.db.prepare("UPDATE tasks SET progress_notes = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(notes), now, id);

    this.logChange(id, 'progress_note', null, `[${agent}] ${note}`, agent);
  }

  /**
   * Complete a task with optional result summary
   */
  completeTask(id: string, result: string, agent: string): void {
    const task = this.getTask(id);
    if (!task) return;

    this.updateTask(id, {
      status: 'completed',
      resultSummary: result,
    });

    if (result) {
      this.addProgressNote(id, agent, `COMPLETED: ${result}`);
    }
  }

  /**
   * Reclaim a stale `in_progress` task back to `pending` (R2 stale-watchdog, TASK-2560).
   *
   * `in_progress -> pending` is deliberately ABSENT from ValidStatusTransitions: agents
   * must not be able to regress their own work through the ordinary update path. The
   * watchdog is the one legitimate exception, so it gets its own audited entry point
   * instead of a hole in the transition table.
   *
   * Only `in_progress` may be reclaimed — every other status returns null (the caller
   * distinguishes "not found" by checking getTask first). The assignee is kept on
   * purpose: the audit trail must still show who dropped the task.
   */
  reclaimStaleTask(id: string, reason: string, by: string = 'stale-watchdog'): Task | null {
    const task = this.getTask(id);
    if (!task) return null;
    if (task.status !== 'in_progress') return null;

    const now = new Date().toISOString();
    const notes = [...task.progressNotes, { timestamp: now, agent: by, note: `stale-watchdog: ${reason}` }];

    this.db.prepare(
      "UPDATE tasks SET status = 'pending', progress_notes = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(notes), now, id);

    this.logChange(id, 'status', 'in_progress', 'pending', by);
    this.logChange(id, 'stale_reclaim', null, reason, by);

    return this.getTask(id);
  }

  /**
   * Delete a task
   */
  deleteTask(id: string): boolean {
    const task = this.getTask(id);
    if (!task) return false;

    // Log deletion
    this.logChange(id, 'deleted', task.title, null, 'system');

    // Update blocks arrays of tasks that were blocked by this one
    for (const blockedId of task.blocks) {
      const blockedTask = this.getTask(blockedId);
      if (blockedTask) {
        const newBlockedBy = blockedTask.blockedBy.filter(bid => bid !== id);
        this.db.prepare("UPDATE tasks SET blocked_by = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(newBlockedBy), new Date().toISOString(), blockedId);
      }
    }

    this.stmtDelete.run(id);
    return true;
  }

  // ============================================
  // STATISTICS
  // ============================================

  /**
   * Get dashboard statistics (all SQL, no in-memory)
   */
  getStats(): DashboardStats {
    const total = (this.stmtCountTotal.get() as { cnt: number }).cnt;

    const byStatus: Record<TaskStatus, number> = {
      pending: 0,
      in_progress: 0,
      blocked: 0,
      completed: 0,
      cancelled: 0,
    };

    for (const row of this.stmtCountByStatus.all() as Array<{ status: string; cnt: number }>) {
      if (row.status in byStatus) {
        (byStatus as any)[row.status] = row.cnt;
      }
    }

    const byPriority: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of this.stmtCountByPriority.all() as Array<{ priority: number; cnt: number }>) {
      byPriority[row.priority] = row.cnt;
    }

    const byAgent: Record<string, number> = {};
    for (const row of this.stmtCountByAgent.all() as Array<{ agent: string; cnt: number }>) {
      byAgent[row.agent] = row.cnt;
    }

    const byProject: Record<string, number> = {};
    for (const row of this.stmtCountByProject.all() as Array<{ project: string; cnt: number }>) {
      byProject[row.project] = row.cnt;
    }

    return { total, byStatus, byPriority, byAgent, byProject };
  }

  // ============================================
  // HISTORY / AUDIT
  // ============================================

  /**
   * Get audit history for a task
   */
  getHistory(taskId: string): HistoryEntry[] {
    return this.stmtGetHistory.all(taskId) as HistoryEntry[];
  }

  // ============================================
  // COMPATIBILITY METHODS (for existing WebUI code)
  // ============================================

  /**
   * Legacy compatibility: getTasksFromSQLite
   * Now just calls getTasks() since everything is SQL
   */
  getTasksFromSQLite(): Task[] {
    return this.getTasks();
  }

  /**
   * Start working on a task
   */
  startTask(taskId: string, agent: string): Task | null {
    return this.updateTask(taskId, {
      status: 'in_progress',
      assignee: agent,
    });
  }

  /**
   * Block a task
   */
  blockTask(taskId: string, reason: string, blockedBy?: string[]): Task | null {
    return this.updateTask(taskId, {
      status: 'blocked',
      blockedReason: reason,
      blockedBy: blockedBy,
    });
  }

  /**
   * Unblock a task
   */
  unblockTask(taskId: string): Task | null {
    return this.updateTask(taskId, {
      status: 'pending',
      blockedReason: '',
      blockedBy: [],
    });
  }

  /**
   * Assign task to agent
   */
  assignTask(taskId: string, agent: string): Task | null {
    return this.updateTask(taskId, { assignee: agent });
  }

  /**
   * Close database
   */
  close(): void {
    this.db.close();
  }
}

// ============================================
// SINGLETON EXPORT
// ============================================

let instance: TaskManagerSQL | null = null;

export function getTaskManagerSQL(): TaskManagerSQL {
  if (!instance) {
    instance = new TaskManagerSQL();
  }
  return instance;
}

export default TaskManagerSQL;
