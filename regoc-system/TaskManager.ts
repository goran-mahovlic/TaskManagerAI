// ~/.claude/regoc/TaskManager.ts
// Task Manager - CRUD operacije za REGOC Task sustav
// Autor: Jelena (Engineer Agent), implementirala Kosjenka (Architect Agent)
// Verzija: 1.1
// FAZA 8.3 - F8-003
// FAZA 4 - ZOD Integration (TASK-162, TASK-163, TASK-164)

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import Database from 'bun:sqlite';
import { z } from 'zod';
import { TaskIdAllocator, formatTaskId, parseTaskId } from './TaskIdAllocator';
import { assertNotLiveDbInTest } from './LiveDbGuard';
import { dopusteniAgenti } from './AgentIds';
import {
  CreateTaskInputSchema,
  UpdateTaskInputSchema,
  TaskStatusSchema
} from './zod/schemas/task';

// ============================================
// TYPES & INTERFACES
// ============================================

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type TaskPriority = 1 | 2 | 3 | 4 | 5;  // 1=critical, 5=low

// TASK-5547: popis agenata je PODATAK iz REGOC_AGENTS.json, ne kod (AgentIds.ts).
export type AgentId = string;

export const AGENT_IDS: AgentId[] = [...dopusteniAgenti().agenti, 'user'];

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  1: 'critical',
  2: 'high',
  3: 'normal',
  4: 'low',
  5: 'trivial'
};

export interface ProgressNote {
  timestamp: Date;
  agent: AgentId;
  note: string;
}

export interface Task {
  id: string;                    // TASK-001 format
  title: string;                 // Kratki opis
  description: string;           // Detaljni opis (markdown body)
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: AgentId;            // Koji agent radi
  createdBy: AgentId | 'user';   // Tko je kreirao
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;              // Kada je poceo in_progress
  completedAt?: Date;
  blockedBy: string[];           // Task IDs koje blokira ovaj
  blocks: string[];              // Task IDs koji cekaju ovaj
  blockedReason?: string;        // Zasto je blokiran
  tags: string[];                // #hashtags
  progressNotes: ProgressNote[]; // Log napretka
  progressPercent?: number;      // 0-100, postotak napretka
  nextcloudFolder?: string;      // Nextcloud folder path
  projectId?: string;            // PRJ-XXX project reference
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignee?: AgentId;
  createdBy: AgentId | 'user';
  blockedBy?: string[];
  tags?: string[];
  projectId?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: AgentId;
  blockedBy?: string[];
  blockedReason?: string;
  tags?: string[];
  progressPercent?: number;
  nextcloudFolder?: string;
  projectId?: string;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  assignee?: AgentId;
  priority?: TaskPriority;
  tags?: string[];
  createdAfter?: Date;
  createdBefore?: Date;
  projectId?: string;
}

// ============================================
// MARKDOWN PARSER (inline za nezavisnost)
// ============================================

class MarkdownTaskParser {

  /**
   * Parse markdown section header to extract task ID and title
   */
  parseTaskHeader(line: string): { id: string; title: string } | null {
    // Format: ### [TASK-001] Title here
    const match = line.match(/^###\s*\[(TASK-\d+)\]\s*(.+)$/);
    if (!match) return null;
    return { id: match[1], title: match[2].trim() };
  }

  /**
   * Parse metadata line
   */
  parseMetadataLine(line: string): { key: string; value: string } | null {
    // Format: - **Key:** value
    const match = line.match(/^-\s*\*\*([^:]+):\*\*\s*(.*)$/);
    if (!match) return null;
    return { key: match[1].trim().toLowerCase(), value: match[2].trim() };
  }

  /**
   * Parse status from string
   */
  parseStatus(value: string): TaskStatus {
    const normalized = value.toLowerCase().trim();
    if (normalized === 'in_progress' || normalized === 'in progress') return 'in_progress';
    if (normalized === 'pending') return 'pending';
    if (normalized === 'blocked') return 'blocked';
    if (normalized === 'completed' || normalized === 'done') return 'completed';
    if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
    return 'pending';
  }

  /**
   * Parse priority from string
   */
  parsePriority(value: string): TaskPriority {
    // Format: "1 (critical)" or just "1"
    const match = value.match(/^(\d)/);
    if (match) {
      const num = parseInt(match[1]);
      if (num >= 1 && num <= 5) return num as TaskPriority;
    }
    return 3; // default normal
  }

  /**
   * Parse date from ISO string or readable format
   */
  parseDate(value: string): Date {
    const date = new Date(value);
    return isNaN(date.getTime()) ? new Date() : date;
  }

  /**
   * Parse blocked by list
   */
  parseBlockedBy(value: string): string[] {
    if (value === '-' || value === '' || value.toLowerCase() === 'none') return [];
    return value.split(',').map(s => s.trim()).filter(s => s.startsWith('TASK-'));
  }

  /**
   * Parse tags
   */
  parseTags(value: string): string[] {
    return value.split(/\s+/).filter(t => t.startsWith('#'));
  }

  /**
   * Parse progress notes section
   */
  parseProgressNotes(lines: string[]): ProgressNote[] {
    const notes: ProgressNote[] = [];
    for (const line of lines) {
      // Format: - 2026-01-26 10:30 [agent] Note text
      const match = line.match(/^-\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)\s*\[(\w+)\]\s*(.+)$/);
      if (match) {
        notes.push({
          timestamp: this.parseDate(match[1]),
          agent: match[2] as AgentId,
          note: match[3].trim()
        });
      }
    }
    return notes;
  }

  /**
   * Parse a single task block from markdown
   */
  parseTaskBlock(lines: string[]): Task | null {
    if (lines.length === 0) return null;

    // First line should be header
    const header = this.parseTaskHeader(lines[0]);
    if (!header) return null;

    const task: Task = {
      id: header.id,
      title: header.title,
      description: '',
      status: 'pending',
      priority: 3,
      createdBy: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      blockedBy: [],
      blocks: [],
      tags: [],
      progressNotes: [],
      progressPercent: undefined,
      nextcloudFolder: undefined,
      projectId: undefined
    };

    let inProgressNotes = false;
    const descriptionLines: string[] = [];
    const progressNotesLines: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      // Check for Progress Notes section
      if (line.startsWith('**Progress Notes:**')) {
        inProgressNotes = true;
        continue;
      }

      if (inProgressNotes) {
        progressNotesLines.push(line);
        continue;
      }

      // Try to parse as metadata
      const meta = this.parseMetadataLine(line);
      if (meta) {
        switch (meta.key) {
          case 'status':
            task.status = this.parseStatus(meta.value);
            break;
          case 'priority':
            task.priority = this.parsePriority(meta.value);
            break;
          case 'assigned':
          case 'assignee':
            if (AGENT_IDS.includes(meta.value as AgentId)) {
              task.assignee = meta.value as AgentId;
            }
            break;
          case 'created':
          case 'created at':
            task.createdAt = this.parseDate(meta.value);
            break;
          case 'created by':
            if (AGENT_IDS.includes(meta.value as AgentId)) {
              task.createdBy = meta.value as AgentId;
            }
            break;
          case 'started':
          case 'started at':
            task.startedAt = this.parseDate(meta.value);
            break;
          case 'completed':
          case 'completed at':
            task.completedAt = this.parseDate(meta.value);
            break;
          case 'blocked by':
            task.blockedBy = this.parseBlockedBy(meta.value);
            break;
          case 'blocks':
            task.blocks = this.parseBlockedBy(meta.value);
            break;
          case 'blocked reason':
            task.blockedReason = meta.value;
            break;
          case 'tags':
            task.tags = this.parseTags(meta.value);
            break;
          case 'progress percent':
          case 'progress':
            const percent = parseInt(meta.value);
            if (!isNaN(percent) && percent >= 0 && percent <= 100) {
              task.progressPercent = percent;
            }
            break;
          case 'nextcloud folder':
          case 'nextcloud':
            task.nextcloudFolder = meta.value;
            break;
          case 'project':
          case 'project id':
            task.projectId = meta.value;
            break;
        }
      } else if (line.trim() && !line.startsWith('-')) {
        // Non-metadata, non-empty line is description
        descriptionLines.push(line);
      }
    }

    task.description = descriptionLines.join('\n').trim();
    task.progressNotes = this.parseProgressNotes(progressNotesLines);
    task.updatedAt = task.updatedAt || task.createdAt;

    return task;
  }

  /**
   * Parse entire markdown file into tasks
   */
  parseFile(content: string): Task[] {
    const tasks: Task[] = [];
    const lines = content.split('\n');

    let currentTaskLines: string[] = [];

    for (const line of lines) {
      // Check if this starts a new task
      if (line.startsWith('### [TASK-')) {
        // Save previous task if exists
        if (currentTaskLines.length > 0) {
          const task = this.parseTaskBlock(currentTaskLines);
          if (task) tasks.push(task);
        }
        currentTaskLines = [line];
      } else if (line === '---') {
        // Section separator - save current task
        if (currentTaskLines.length > 0) {
          const task = this.parseTaskBlock(currentTaskLines);
          if (task) tasks.push(task);
        }
        currentTaskLines = [];
      } else if (currentTaskLines.length > 0) {
        // Add to current task
        currentTaskLines.push(line);
      }
    }

    // Don't forget last task
    if (currentTaskLines.length > 0) {
      const task = this.parseTaskBlock(currentTaskLines);
      if (task) tasks.push(task);
    }

    return tasks;
  }

  /**
   * Serialize task to markdown
   */
  serializeTask(task: Task): string {
    const lines: string[] = [];

    // Header
    lines.push(`### [${task.id}] ${task.title}`);

    // Metadata
    lines.push(`- **Status:** ${task.status}`);
    lines.push(`- **Priority:** ${task.priority} (${PRIORITY_LABELS[task.priority]})`);

    if (task.assignee) {
      lines.push(`- **Assigned:** ${task.assignee}`);
    }

    lines.push(`- **Created:** ${task.createdAt.toISOString()}`);
    lines.push(`- **Created By:** ${task.createdBy}`);

    if (task.startedAt) {
      lines.push(`- **Started:** ${task.startedAt.toISOString()}`);
    }

    if (task.completedAt) {
      lines.push(`- **Completed:** ${task.completedAt.toISOString()}`);
    }

    lines.push(`- **Blocked By:** ${task.blockedBy.length > 0 ? task.blockedBy.join(', ') : '-'}`);

    if (task.blocks.length > 0) {
      lines.push(`- **Blocks:** ${task.blocks.join(', ')}`);
    }

    if (task.blockedReason) {
      lines.push(`- **Blocked Reason:** ${task.blockedReason}`);
    }

    if (task.tags.length > 0) {
      lines.push(`- **Tags:** ${task.tags.join(' ')}`);
    }

    if (task.progressPercent !== undefined) {
      lines.push(`- **Progress Percent:** ${task.progressPercent}`);
    }

    if (task.nextcloudFolder) {
      lines.push(`- **Nextcloud Folder:** ${task.nextcloudFolder}`);
    }

    if (task.projectId) {
      lines.push(`- **Project:** ${task.projectId}`);
    }

    // Description
    if (task.description) {
      lines.push('');
      lines.push(task.description);
    }

    // Progress Notes
    if (task.progressNotes.length > 0) {
      lines.push('');
      lines.push('**Progress Notes:**');
      for (const note of task.progressNotes) {
        const timestamp = note.timestamp.toISOString().replace('T', ' ').slice(0, 16);
        lines.push(`- ${timestamp} [${note.agent}] ${note.note}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Serialize tasks grouped by status
   */
  serializeFile(tasks: Task[], agentName: string): string {
    const sections: Record<TaskStatus, Task[]> = {
      in_progress: [],
      pending: [],
      blocked: [],
      completed: [],
      cancelled: []
    };

    for (const task of tasks) {
      sections[task.status].push(task);
    }

    const lines: string[] = [];
    lines.push(`# ${agentName} Tasks`);
    lines.push('');

    // In Progress
    lines.push('## In Progress');
    lines.push('');
    if (sections.in_progress.length > 0) {
      for (const task of sections.in_progress) {
        lines.push(this.serializeTask(task));
        lines.push('');
      }
    }
    lines.push('---');
    lines.push('');

    // Pending
    lines.push('## Pending');
    lines.push('');
    if (sections.pending.length > 0) {
      for (const task of sections.pending) {
        lines.push(this.serializeTask(task));
        lines.push('');
      }
    }
    lines.push('---');
    lines.push('');

    // Blocked
    lines.push('## Blocked');
    lines.push('');
    if (sections.blocked.length > 0) {
      for (const task of sections.blocked) {
        lines.push(this.serializeTask(task));
        lines.push('');
      }
    }
    lines.push('---');
    lines.push('');

    // Completed
    lines.push('## Completed');
    lines.push('');
    if (sections.completed.length > 0) {
      // Sort by completion date, newest first
      const sorted = [...sections.completed].sort((a, b) =>
        (b.completedAt?.getTime() || 0) - (a.completedAt?.getTime() || 0)
      );
      for (const task of sorted) {
        lines.push(this.serializeTask(task));
        lines.push('');
      }
    }
    lines.push('---');
    lines.push('');

    // Cancelled (if any)
    if (sections.cancelled.length > 0) {
      lines.push('## Cancelled');
      lines.push('');
      for (const task of sections.cancelled) {
        lines.push(this.serializeTask(task));
        lines.push('');
      }
      lines.push('---');
    }

    return lines.join('\n');
  }
}

// ============================================
// TASK MANAGER CLASS
// ============================================

// TASK-164: Valid status transitions map
const ValidStatusTransitions: Record<string, string[]> = {
  'pending': ['in_progress', 'blocked', 'cancelled'],
  'in_progress': ['completed', 'blocked', 'cancelled'],
  'blocked': ['pending', 'in_progress', 'cancelled'],
  'completed': [],
  'cancelled': []
};

export class TaskManager {
  private tasksDir: string;
  private parser: MarkdownTaskParser;
  private taskCache: Map<string, Task>;
  private nextIdNum: number;
  private cacheValid: boolean;
  private lastCacheTime: number;
  private cacheTTLMs: number = 5000; // 5 seconds cache
  private db: Database | null = null; // SQLite database connection
  private dbPath: string;
  /** TASK-2702: dijeljeni SSOT allocator (isti kao u TaskManagerSQL) */
  private idAllocator: TaskIdAllocator | null = null;

  constructor(tasksDir?: string, dbPath?: string) {
    const defaultTasksDir = path.join(homedir(), '.claude', 'tasks', 'agents');
    const liveDbPath = path.join(homedir(), '.claude', 'regoc', 'data', 'regoc.db');
    this.tasksDir = tasksDir || defaultTasksDir;
    // TASK-2701: samo PRODUKCIJSKI store (default tasksDir) smije pisati u zivu regoc.db.
    // Svaki alternativni store (testovi, sandbox, demo) bez eksplicitnog dbPath dobiva
    // vlastitu bazu uz svoj direktorij. Bez ovoga je `new TaskManager(TEST_DIR)` slao
    // fixture taskove ('Task 1', 'Full Task', prazan description) ravno u zivu bazu,
    // odakle ih je auto-exec dizao kao prave zadatke i spawnao Opus sesije
    // (incident 2026-07-27 22:42: 70 fixtura po test-runu, 210 kandidata za sanaciju).
    this.dbPath = dbPath
      || (this.tasksDir === defaultTasksDir
        ? liveDbPath
        : path.join(path.dirname(this.tasksDir), `${path.basename(this.tasksDir)}.db`));
    // TASK-3020: pod test-runnerom je otvaranje ZIVE baze zabranjeno (LiveDbGuard.ts).
    // Provjera je ovdje, a ne u initializeDatabase(), jer ta metoda tiho izlazi kad
    // datoteka ne postoji — guard mora opaliti na SVAKI pokusaj ciljanja zive baze.
    assertNotLiveDbInTest(this.dbPath, 'TaskManager');
    this.parser = new MarkdownTaskParser();
    this.taskCache = new Map();
    this.nextIdNum = 1;
    this.cacheValid = false;
    this.lastCacheTime = 0;

    this.ensureDirectoryStructure();
    this.initializeNextId();
    this.initializeDatabase();
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  /**
   * Ensure all required directories and files exist
   */
  private ensureDirectoryStructure(): void {
    const dirs = [
      this.tasksDir,
      path.join(path.dirname(this.tasksDir), '_archive')
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Create agent files if they don't exist
    const agents: AgentId[] = ['regoc', 'klaudio', 'stribor', 'kosjenka', 'jelena',
                              'malik', 'manda', 'potjeh', 'dora', 'gita', 'grga'];

    for (const agent of agents) {
      const filePath = path.join(this.tasksDir, `${agent}.md`);
      if (!fs.existsSync(filePath)) {
        const content = this.parser.serializeFile([], agent);
        fs.writeFileSync(filePath, content, 'utf-8');
      }
    }

    // Create inbox file
    const inboxPath = path.join(path.dirname(this.tasksDir), '_inbox.md');
    if (!fs.existsSync(inboxPath)) {
      fs.writeFileSync(inboxPath, '# Inbox Tasks\n\n## Pending\n\n---\n', 'utf-8');
    }
  }

  /**
   * Seed the MARKDOWN-ONLY fallback counter.
   *
   * TASK-2702: ovo VISE NIJE primarni allocator. Markdown store zaostaje za bazom
   * (max TASK-336 vs TASK-2703), pa bi ID izracunat odavde kolidirao s postojecim
   * taskovima u SQLiteu. Koristi se iskljucivo kad SQLite baza nije dostupna.
   */
  private initializeNextId(): void {
    const allTasks = this.loadAllTasks();
    let maxId = 0;

    for (const [id] of allTasks) {
      const num = parseTaskId(id);
      if (num !== null && num > maxId) maxId = num;
    }

    this.nextIdNum = maxId + 1;
  }

  /**
   * Lazily build the shared SSOT allocator over the SQLite connection.
   */
  private ensureIdAllocator(): TaskIdAllocator | null {
    if (this.idAllocator) return this.idAllocator;
    const db = this.ensureDatabase();
    if (!db) return null;
    try {
      this.idAllocator = new TaskIdAllocator(db);
    } catch (error: any) {
      // Namjerno NE padamo natrag na markdown brojac: baza postoji, samo je
      // trenutno nedostupna. MD brojac bi dodijelio ID koji u bazi vec postoji.
      throw new Error(
        `[TaskManager] Cannot allocate task ID - SQLite allocator unavailable: ${error?.message ?? error}`
      );
    }
    return this.idAllocator;
  }

  /**
   * Generate next task ID.
   *
   * TASK-2702: delegira SSOT allocatoru u SQLiteu. Markdown brojac je samo fallback
   * za instalacije bez baze (i tada ne moze kolidirati - baze nema).
   */
  protected generateId(): string {
    const allocator = this.ensureIdAllocator();
    if (allocator) {
      const id = allocator.allocate();
      const num = parseTaskId(id);
      if (num !== null && num >= this.nextIdNum) this.nextIdNum = num + 1;
      return id;
    }

    console.warn('[TaskManager] SQLite unavailable - falling back to markdown-local ID counter');
    const id = formatTaskId(this.nextIdNum);
    this.nextIdNum++;
    return id;
  }

  // ============================================
  // SQLITE DATABASE INTEGRATION (V1.1)
  // ============================================

  /**
   * TASK-2702: vise procesa (TaskWebUI, daemoni, Telegram) drzi istu bazu otvorenu.
   * Bez busy_timeouta zapis u zauzetu bazu odmah baca "database is locked" -
   * a od uvodenja SSOT allocatora vec i alokacija ID-a je zapis.
   */
  private applyConnectionPragmas(db: Database): void {
    try {
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('PRAGMA foreign_keys=ON');
    } catch (error: any) {
      console.warn('[TaskManager] Failed to apply connection pragmas:', error?.message ?? error);
    }
  }

  /**
   * Initialize SQLite database connection
   */
  private initializeDatabase(): void {
    try {
      // Check if database file exists
      if (!fs.existsSync(this.dbPath)) {
        console.warn(`[TaskManager] SQLite database not found at ${this.dbPath}. Task sync disabled.`);
        return;
      }

      // Open database connection
      this.db = new Database(this.dbPath);
      this.applyConnectionPragmas(this.db);

      // Verify tables exist
      const tables = this.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
        .all();

      if (tables.length === 0) {
        console.warn('[TaskManager] Tasks table not found in database. Task sync disabled.');
        this.db.close();
        this.db = null;
        return;
      }

      console.log('[TaskManager] SQLite database initialized successfully');
    } catch (error: any) {
      console.error('[TaskManager] Failed to initialize database:', error.message);
      this.db = null;
    }
  }

  /**
   * TASK-164: Check if status transition is valid
   * @param current Current task status
   * @param next Desired new status
   * @returns true if transition is allowed
   */
  private isValidStatusTransition(current: string, next: string): boolean {
    return ValidStatusTransitions[current]?.includes(next) ?? false;
  }

  /**
   * Lazy initialize database connection (BUG-004 fix)
   * Called before any database operation to ensure connection exists
   */
  private ensureDatabase(): Database | null {
    if (this.db) return this.db;

    try {
      if (fs.existsSync(this.dbPath)) {
        this.db = new Database(this.dbPath);
        this.applyConnectionPragmas(this.db);
        console.log('[TaskManager] Lazy initialized SQLite connection');
        return this.db;
      }
    } catch (error) {
      console.error('[TaskManager] Failed to lazy init database:', error);
    }
    return null;
  }

  /**
   * Insert a NEWLY created task into SQLite (TASK-2702).
   *
   * Namjerno strogi INSERT bez ON CONFLICT: ako ID vec postoji, to znaci da je
   * dodjela ID-eva pukla i tudi task bi bio tiho prepisan. Radije glasno padni.
   * Ostale (ne-kolizijske) greske ostaju ne-fatalne - markdown je izvor istine.
   */
  private insertTaskIntoDatabase(task: Task): void {
    const db = this.ensureDatabase();
    if (!db) {
      console.log('[TaskManager] SQLite not available, skipping insert');
      return;
    }

    try {
      db.run(
        `INSERT INTO tasks (
          id, title, description, status, priority, assignee,
          created_by, created_at, updated_at, blocked_by,
          progress_percent, nextcloud_folder
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id,
          task.title,
          task.description || '',
          task.status,
          task.priority,
          task.assignee || null,
          task.createdBy,
          task.createdAt.toISOString(),
          task.updatedAt.toISOString(),
          JSON.stringify(task.blockedBy),
          task.progressPercent ?? null,
          task.nextcloudFolder || null
        ]
      );
    } catch (error: any) {
      const message = error?.message ?? String(error);
      if (/UNIQUE|constraint/i.test(message)) {
        throw new Error(
          `[TaskManager] ID collision: task ${task.id} already exists in SQLite. ` +
          `Refusing to overwrite. (original: ${message})`
        );
      }
      console.error(`[TaskManager] Failed to insert task ${task.id} into database:`, message);
    }
  }

  /**
   * Sync task to SQLite database (V1.1)
   * Implements dual-write strategy: Markdown (source of truth) + SQLite (for triggers)
   * BUG-004 fix: Uses lazy initialization via ensureDatabase()
   *
   * TASK-2702: UPSERT je ispravan SAMO za UPDATE putanju. Za kreiranje koristi
   * insertTaskIntoDatabase() - inace kolizija ID-eva tiho prepise tudi task.
   */
  private syncTaskToDatabase(task: Task): void {
    const db = this.ensureDatabase();
    if (!db) {
      console.log('[TaskManager] SQLite not available, skipping sync');
      return;
    }

    try {
      // UPSERT task into SQLite
      //
      // TASK-2956: started_at/completed_at MORAJU biti u ovom upisu. updateTask()
      // ih ispravno postavlja na Task objektu (i markdown ih serijalizira kao
      // "**Completed:**"), ali su prije ispadali iz UPSERT-a — pa je svaki task
      // zatvoren markdown putem zavrsio u SQLite-u sa status='completed' i
      // completed_at=NULL (199/504 zavrsenih, 40%). Izvjestaji "sto je zavrseno
      // danas/ovaj tjedan" su zbog toga morali posezati za updated_at.
      //
      // COALESCE(excluded.X, tasks.X): vec zapisano vrijeme se NIKAD ne gazi
      // NULL-om. Task ucitan iz markdowna bez "**Completed:**" retka (npr. red
      // zapisan prije ovog fixa) inace bi pri sljedecem saveTask()-u obrisao
      // vrijeme koje je TaskManagerSQL uredno upisao. Ista semantika kao u
      // TaskManagerSQL.updateTask(): vrijeme se postavlja jednom i ostaje.
      db.run(
        `INSERT INTO tasks (
          id, title, description, status, priority, assignee,
          created_by, created_at, updated_at, blocked_by,
          progress_percent, nextcloud_folder, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          priority = excluded.priority,
          assignee = excluded.assignee,
          updated_at = excluded.updated_at,
          blocked_by = excluded.blocked_by,
          progress_percent = excluded.progress_percent,
          nextcloud_folder = excluded.nextcloud_folder,
          started_at = COALESCE(excluded.started_at, tasks.started_at),
          completed_at = COALESCE(excluded.completed_at, tasks.completed_at)`,
        [
          task.id,
          task.title,
          task.description || '',
          task.status,
          task.priority,
          task.assignee || null,
          task.createdBy,
          task.createdAt.toISOString(),
          task.updatedAt.toISOString(),
          JSON.stringify(task.blockedBy),
          task.progressPercent ?? null,
          task.nextcloudFolder || null,
          task.startedAt ? task.startedAt.toISOString() : null,
          task.completedAt ? task.completedAt.toISOString() : null
        ]
      );

      // Trigger will automatically handle P1 queue insertion
    } catch (error: any) {
      console.error(`[TaskManager] Failed to sync task ${task.id} to database:`, error.message);
      // Non-fatal: Markdown is still source of truth
    }
  }

  /**
   * Get tasks from SQLite database (BUG-004 fix)
   * Uses lazy initialization via ensureDatabase()
   */
  public getTasksFromSQLite(): Task[] {
    const db = this.ensureDatabase();
    if (!db) {
      return [];
    }

    try {
      const rows = db.query('SELECT * FROM tasks').all() as any[];
      return rows.map(row => ({
        id: row.id,
        title: row.title,
        description: row.description || '',
        status: row.status as TaskStatus,
        priority: row.priority as TaskPriority,
        assignee: row.assignee as AgentId | undefined,
        createdBy: row.created_by as AgentId,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        blockedBy: row.blocked_by ? JSON.parse(row.blocked_by) : [],
        blocks: [],
        tags: [],
        progressNotes: [],
        progressPercent: row.progress_percent ?? undefined,
        nextcloudFolder: row.nextcloud_folder || undefined
      }));
    } catch (error: any) {
      console.error('[TaskManager] Failed to get tasks from SQLite:', error.message);
      return [];
    }
  }

  /**
   * Close database connection
   */
  public closeDatabase(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ============================================
  // FILE I/O
  // ============================================

  /**
   * Get file path for an agent
   */
  private getAgentFilePath(agent: AgentId): string {
    if (agent === 'user') {
      return path.join(path.dirname(this.tasksDir), '_inbox.md');
    }
    return path.join(this.tasksDir, `${agent}.md`);
  }

  /**
   * Read and parse agent file
   */
  private readAgentFile(agent: AgentId): Task[] {
    const filePath = this.getAgentFilePath(agent);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf-8');
    return this.parser.parseFile(content);
  }

  /**
   * Write tasks to agent file
   */
  private writeAgentFile(agent: AgentId, tasks: Task[]): void {
    const filePath = this.getAgentFilePath(agent);
    const agentName = agent === 'user' ? 'Inbox' : agent;
    const content = this.parser.serializeFile(tasks, agentName);
    fs.writeFileSync(filePath, content, 'utf-8');
    this.invalidateCache();
  }

  /**
   * Load all tasks from all files
   */
  private loadAllTasks(): Map<string, Task> {
    const now = Date.now();

    // Return cache if valid
    if (this.cacheValid && (now - this.lastCacheTime) < this.cacheTTLMs) {
      return this.taskCache;
    }

    this.taskCache.clear();

    const agents: AgentId[] = ['regoc', 'klaudio', 'stribor', 'kosjenka', 'jelena',
                              'malik', 'manda', 'potjeh', 'dora', 'gita', 'grga', 'user'];

    for (const agent of agents) {
      const tasks = this.readAgentFile(agent);
      for (const task of tasks) {
        this.taskCache.set(task.id, task);
      }
    }

    this.cacheValid = true;
    this.lastCacheTime = now;

    return this.taskCache;
  }

  /**
   * Invalidate cache
   */
  private invalidateCache(): void {
    this.cacheValid = false;
  }

  /**
   * Find which agent file contains a task
   */
  private findTaskAgent(taskId: string): AgentId | null {
    const agents: AgentId[] = ['regoc', 'klaudio', 'stribor', 'kosjenka', 'jelena',
                              'malik', 'manda', 'potjeh', 'dora', 'gita', 'grga', 'user'];

    for (const agent of agents) {
      const tasks = this.readAgentFile(agent);
      if (tasks.some(t => t.id === taskId)) {
        return agent;
      }
    }

    return null;
  }

  // ============================================
  // CRUD OPERATIONS
  // ============================================

  /**
   * TASK-095: Auto-assign task based on type and agent availability
   * Uses task title and tags to determine best agent
   */
  private autoAssignTask(task: Task): AgentId {
    const titleLower = task.title.toLowerCase();
    const tagsStr = task.tags.join(' ').toLowerCase();
    const combined = `${titleLower} ${tagsStr}`;

    // Check tags first (most explicit)
    if (task.tags.some(t => t === '#bug' || t === '#fix')) return 'jelena';
    if (task.tags.some(t => t === '#security' || t === '#audit')) return 'malik';
    if (task.tags.some(t => t === '#research' || t === '#investigate')) return 'manda';
    if (task.tags.some(t => t === '#design' || t === '#ui' || t === '#ux')) return 'grga';
    if (task.tags.some(t => t === '#test' || t === '#qa')) return 'potjeh';
    if (task.tags.some(t => t === '#architecture' || t === '#design-system')) return 'kosjenka';
    if (task.tags.some(t => t === '#art' || t === '#visual')) return 'gita';
    if (task.tags.some(t => t === '#fpga' || t === '#verilog' || t === '#hdl')) return 'emard';

    // Check title/description keywords
    if (combined.includes('bug') || combined.includes('fix') || combined.includes('implement') ||
        combined.includes('napravi') || combined.includes('kodiraj')) return 'jelena';

    if (combined.includes('research') || combined.includes('investigate') ||
        combined.includes('istraži') || combined.includes('dokumentiraj')) return 'manda';

    if (combined.includes('security') || combined.includes('audit') ||
        combined.includes('sigurnost') || combined.includes('ranjiv')) return 'malik';

    if (combined.includes('design') || combined.includes('ui') || combined.includes('ux') ||
        combined.includes('dizajn') || combined.includes('frontend')) return 'grga';

    if (combined.includes('test') || combined.includes('qa') ||
        combined.includes('verificiraj') || combined.includes('provjeri')) return 'potjeh';

    if (combined.includes('architect') || combined.includes('arhitektur') ||
        combined.includes('struktur') || combined.includes('planiraj')) return 'kosjenka';

    if (combined.includes('art') || combined.includes('visual') || combined.includes('dijagram') ||
        combined.includes('vizual') || combined.includes('excalidraw')) return 'gita';

    if (combined.includes('fpga') || combined.includes('verilog') || combined.includes('ulx3s') ||
        combined.includes('hdl') || combined.includes('timing')) return 'emard';

    // Default: delegate to REGOČ for manual routing
    return 'regoc';
  }

  /**
   * Create a new task
   */
  createTask(input: CreateTaskInput): Task {
    // TASK-162: ZOD validation
    const parseResult = CreateTaskInputSchema.safeParse(input);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      throw new Error(`Invalid task input: ${errors}`);
    }
    const validated = parseResult.data;

    const now = new Date();
    const id = this.generateId();

    const task: Task = {
      id,
      title: validated.title,
      description: validated.description || '',
      status: 'pending',
      priority: validated.priority || 3,
      assignee: validated.assignee,
      createdBy: input.createdBy, // createdBy not in ZOD schema, use original input
      createdAt: now,
      updatedAt: now,
      blockedBy: validated.blockedBy || [],
      blocks: [],
      tags: validated.tags || [],
      progressNotes: [],
      progressPercent: undefined,
      nextcloudFolder: undefined,
      projectId: input.projectId  // PRJ-XXX project reference
    };

    // TASK-095: Auto-assign if no assignee specified
    if (!task.assignee) {
      task.assignee = this.autoAssignTask(task);
      console.log(`[TaskManager] Auto-assigned task ${task.id} to ${task.assignee}`);
    }

    // If blocked by something, set status to blocked
    if (task.blockedBy.length > 0) {
      task.status = 'blocked';
    }

    // Update blocks arrays of blocking tasks
    for (const blockingId of task.blockedBy) {
      const blockingTask = this.getTask(blockingId);
      if (blockingTask && !blockingTask.blocks.includes(task.id)) {
        blockingTask.blocks.push(task.id);
        this.saveTask(blockingTask);
      }
    }

    // TASK-2702: baza prva - strogi INSERT. Ako ID kolidira, pucamo PRIJE nego
    // sto markdown dobije zapis, pa ne ostaje pola-kreiran task.
    this.insertTaskIntoDatabase(task);

    // Determine which file to write to
    const targetAgent = task.assignee || 'user';
    const tasks = this.readAgentFile(targetAgent);
    tasks.push(task);
    this.writeAgentFile(targetAgent, tasks);

    return task;
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): Task | null {
    const allTasks = this.loadAllTasks();
    return allTasks.get(taskId) || null;
  }

  /**
   * Update task
   */
  updateTask(taskId: string, updates: UpdateTaskInput): Task | null {
    // TASK-163: ZOD validation
    const parseResult = UpdateTaskInputSchema.safeParse(updates);
    if (!parseResult.success) {
      console.error('[TaskManager] Update validation failed:', parseResult.error.issues);
      return null;
    }
    const validated = parseResult.data;

    const task = this.getTask(taskId);
    if (!task) return null;

    // TASK-164: Status transition validation
    if (validated.status && validated.status !== task.status) {
      if (!this.isValidStatusTransition(task.status, validated.status)) {
        console.error(`[TaskManager] Invalid status transition: ${task.status} -> ${validated.status}`);
        return null;
      }
    }

    const oldAssignee = task.assignee;
    const oldBlockedBy = [...task.blockedBy];

    // Apply updates (using validated data)
    if (validated.title !== undefined) task.title = validated.title;
    if (validated.description !== undefined) task.description = validated.description;
    if (validated.status !== undefined) task.status = validated.status;
    if (validated.priority !== undefined) task.priority = validated.priority;
    if (validated.assignee !== undefined) task.assignee = validated.assignee;
    if (validated.blockedBy !== undefined) task.blockedBy = validated.blockedBy;
    if (updates.blockedReason !== undefined) task.blockedReason = updates.blockedReason; // Not in ZOD schema
    if (validated.tags !== undefined) task.tags = validated.tags;
    if (updates.progressPercent !== undefined) task.progressPercent = updates.progressPercent; // Not in ZOD schema yet
    if (updates.nextcloudFolder !== undefined) task.nextcloudFolder = updates.nextcloudFolder; // Not in ZOD schema yet
    if (updates.projectId !== undefined) task.projectId = updates.projectId;

    task.updatedAt = new Date();

    // Handle status changes
    if (validated.status === 'in_progress' && !task.startedAt) {
      task.startedAt = new Date();
    }
    if (validated.status === 'completed' && !task.completedAt) {
      task.completedAt = new Date();
    }

    // Handle assignee change - move to different file
    const assigneeChanged = validated.assignee !== undefined && oldAssignee !== validated.assignee;

    if (assigneeChanged) {
      // Remove from old file
      const oldAgent = oldAssignee || 'user';
      const oldTasks = this.readAgentFile(oldAgent).filter(t => t.id !== taskId);
      this.writeAgentFile(oldAgent, oldTasks);

      // Add to new file
      const newAgent = validated.assignee || 'user';
      const newTasks = this.readAgentFile(newAgent);
      newTasks.push(task);
      this.writeAgentFile(newAgent, newTasks);
    } else {
      // CRITICAL: If assignee didn't change, we MUST save the task
      // Otherwise priority, status, and other field changes won't persist to Markdown
      this.saveTask(task);
    }

    // Handle blockedBy changes
    if (validated.blockedBy !== undefined) {
      // Remove this task from old blockers' blocks array
      for (const oldBlockerId of oldBlockedBy) {
        if (!task.blockedBy.includes(oldBlockerId)) {
          const blocker = this.getTask(oldBlockerId);
          if (blocker) {
            blocker.blocks = blocker.blocks.filter(id => id !== taskId);
            this.saveTask(blocker);
          }
        }
      }

      // Add this task to new blockers' blocks array
      for (const newBlockerId of task.blockedBy) {
        if (!oldBlockedBy.includes(newBlockerId)) {
          const blocker = this.getTask(newBlockerId);
          if (blocker && !blocker.blocks.includes(taskId)) {
            blocker.blocks.push(taskId);
            this.saveTask(blocker);
          }
        }
      }
    }

    // V1.1: Sync to SQLite database (dual-write strategy)
    this.syncTaskToDatabase(task);

    return task;
  }

  /**
   * Save task back to its file
   *
   * CRITICAL FIX: Use task.assignee instead of findTaskAgent()
   * to avoid writing to wrong file when duplicate task IDs exist.
   */
  private saveTask(task: Task): void {
    // Use task's assignee field to determine which file to write to
    const agent = task.assignee || 'user';

    const tasks = this.readAgentFile(agent);
    const index = tasks.findIndex(t => t.id === task.id);

    if (index >= 0) {
      tasks[index] = task;
    } else {
      tasks.push(task);
    }

    this.writeAgentFile(agent, tasks);

    // V1.1: Sync to SQLite database (dual-write strategy)
    this.syncTaskToDatabase(task);
  }

  /**
   * Delete task (soft delete - move to archive)
   */
  deleteTask(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    const agent = this.findTaskAgent(taskId);
    if (!agent) return false;

    // Remove from current file
    const tasks = this.readAgentFile(agent).filter(t => t.id !== taskId);
    this.writeAgentFile(agent, tasks);

    // Add to archive
    const archiveDir = path.join(path.dirname(this.tasksDir), '_archive');
    const monthFile = path.join(archiveDir, `${new Date().toISOString().slice(0, 7)}.md`);

    let archiveContent = '';
    if (fs.existsSync(monthFile)) {
      archiveContent = fs.readFileSync(monthFile, 'utf-8');
    } else {
      archiveContent = `# Archive ${new Date().toISOString().slice(0, 7)}\n\n`;
    }

    archiveContent += `\n---\n\n${this.parser.serializeTask(task)}\n`;
    fs.writeFileSync(monthFile, archiveContent, 'utf-8');

    // Update any tasks that were blocked by this one
    for (const blockedId of task.blocks) {
      const blockedTask = this.getTask(blockedId);
      if (blockedTask) {
        blockedTask.blockedBy = blockedTask.blockedBy.filter(id => id !== taskId);
        this.saveTask(blockedTask);
      }
    }

    return true;
  }

  /**
   * Add progress note to task
   */
  addProgressNote(taskId: string, agent: AgentId, note: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    task.progressNotes.push({
      timestamp: new Date(),
      agent,
      note
    });
    task.updatedAt = new Date();

    this.saveTask(task);
    return true;
  }

  // ============================================
  // QUERY OPERATIONS
  // ============================================

  /**
   * Get tasks with filter
   */
  getTasks(filter?: TaskFilter): Task[] {
    const allTasks = Array.from(this.loadAllTasks().values());

    if (!filter) return allTasks;

    return allTasks.filter(task => {
      // Status filter
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!statuses.includes(task.status)) return false;
      }

      // Assignee filter
      if (filter.assignee && task.assignee !== filter.assignee) return false;

      // Priority filter
      if (filter.priority && task.priority !== filter.priority) return false;

      // Tags filter
      if (filter.tags && filter.tags.length > 0) {
        if (!filter.tags.some(tag => task.tags.includes(tag))) return false;
      }

      // Date filters
      if (filter.createdAfter && task.createdAt < filter.createdAfter) return false;
      if (filter.createdBefore && task.createdAt > filter.createdBefore) return false;

      // Project filter
      if (filter.projectId && task.projectId !== filter.projectId) return false;

      return true;
    });
  }

  /**
   * Get tasks for specific agent
   */
  getAgentTasks(agent: AgentId): Task[] {
    return this.readAgentFile(agent);
  }

  /**
   * Get all blocked tasks
   */
  getBlockedTasks(): Task[] {
    return this.getTasks({ status: 'blocked' });
  }

  /**
   * Get tasks waiting on a specific task
   */
  getWaitingTasks(taskId: string): Task[] {
    const task = this.getTask(taskId);
    if (!task) return [];

    return task.blocks
      .map(id => this.getTask(id))
      .filter((t): t is Task => t !== null);
  }

  /**
   * Get unassigned pending tasks
   */
  getUnassignedTasks(): Task[] {
    return this.getTasks({ status: 'pending' }).filter(t => !t.assignee);
  }

  // ============================================
  // STATUS MANAGEMENT
  // ============================================

  /**
   * Start working on a task
   */
  startTask(taskId: string, agent: AgentId): Task | null {
    return this.updateTask(taskId, {
      status: 'in_progress',
      assignee: agent
    });
  }

  /**
   * Complete a task
   */
  completeTask(taskId: string): Task | null {
    const task = this.updateTask(taskId, {
      status: 'completed'
    });

    if (task) {
      // Unblock waiting tasks
      for (const waitingId of task.blocks) {
        const waitingTask = this.getTask(waitingId);
        if (waitingTask) {
          // Remove this task from blockedBy
          waitingTask.blockedBy = waitingTask.blockedBy.filter(id => id !== taskId);

          // If no more blockers, change to pending
          if (waitingTask.blockedBy.length === 0 && waitingTask.status === 'blocked') {
            waitingTask.status = 'pending';
            waitingTask.blockedReason = undefined;
          }

          this.saveTask(waitingTask);
        }
      }
    }

    return task;
  }

  /**
   * Block a task
   */
  blockTask(taskId: string, reason: string, blockedBy?: string[]): Task | null {
    return this.updateTask(taskId, {
      status: 'blocked',
      blockedReason: reason,
      blockedBy: blockedBy
    });
  }

  /**
   * Unblock a task
   */
  unblockTask(taskId: string): Task | null {
    const task = this.getTask(taskId);
    if (!task) return null;

    // Clear blocked reason directly
    task.blockedReason = undefined;
    task.blockedBy = [];
    task.status = 'pending';
    task.updatedAt = new Date();

    this.saveTask(task);
    return task;
  }

  /**
   * Assign task to agent
   */
  assignTask(taskId: string, agent: AgentId): Task | null {
    return this.updateTask(taskId, {
      assignee: agent
    });
  }

  // ============================================
  // STATISTICS
  // ============================================

  /**
   * Get task statistics
   */
  getStats(): {
    total: number;
    byStatus: Record<TaskStatus, number>;
    byPriority: Record<TaskPriority, number>;
    byAgent: Record<string, number>;
  } {
    const allTasks = Array.from(this.loadAllTasks().values());

    const byStatus: Record<TaskStatus, number> = {
      pending: 0,
      in_progress: 0,
      blocked: 0,
      completed: 0,
      cancelled: 0
    };

    const byPriority: Record<TaskPriority, number> = {
      1: 0, 2: 0, 3: 0, 4: 0, 5: 0
    };

    const byAgent: Record<string, number> = {};

    for (const task of allTasks) {
      byStatus[task.status]++;
      byPriority[task.priority]++;

      const agent = task.assignee || 'unassigned';
      byAgent[agent] = (byAgent[agent] || 0) + 1;
    }

    return {
      total: allTasks.length,
      byStatus,
      byPriority,
      byAgent
    };
  }
}

// ============================================
// EXPORT SINGLETON
// ============================================

let taskManagerInstance: TaskManager | null = null;

export function getTaskManager(): TaskManager {
  // TASK-2947: singleton UVIJEK koristi produkcijske putanje (~/.claude/tasks/agents + regoc.db).
  // `bun test` ne radi typecheck, pa je poziv getTaskManager(TEST_DIR) tiho ispuštao argument
  // i test je pisao fixture taskove u živu bazu (auto-exec ih je onda spawnao kao prave agente).
  // Sada takav poziv pukne odmah umjesto da tiho zagadi produkciju.
  if (arguments.length > 0) {
    throw new Error(
      'getTaskManager() ne prima argumente — singleton je vezan na produkcijske putanje. ' +
      'Za izoliranu instancu (testovi) koristi: new TaskManager(tasksDir, dbPath).'
    );
  }
  if (!taskManagerInstance) {
    taskManagerInstance = new TaskManager();
  }
  return taskManagerInstance;
}

// Default export
export default TaskManager;
