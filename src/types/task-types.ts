/**
 * Regoč TaskManagerMD.2 - Core Types for Task Management System
 *
 * @author Jelena (Engineer Agent)
 * @created 2026-01-26
 * @version 1.0.0
 *
 * These type definitions are the foundation for the entire Tasks.md
 * integration system. All components (TaskManager, Scheduler, Notifications)
 * depend on these types.
 *
 * TASK-4809: tko su agenti VIŠE NE PIŠE ovdje. Do 10.09.2026. je ova datoteka nosila
 * `AgentId` kao uniju imena JEDNE instalacije, `ALL_AGENTS`, `AGENT_NAMES` s hrvatskim
 * nazivima tih agenata i `AGENT_CAPABILITIES` s njihovim ulogama — dakle naš tim ugrađen
 * u tipove paketa. Popis i imena sada dolaze iz `config/agents.json` odn. `TM_AGENTS`
 * (v. `src/core/AgentIds.ts`, ADR-0001 O5, `docs/ROADMAP_SAMOSTALNOST.md`).
 */

import { dopusteniAgenti, jeDopustenAgent } from '../core/AgentIds';
import { loadAgents } from '../core/orchestrator/AgentRegistry';

// ============================================================================
// ENUMS & LITERAL TYPES
// ============================================================================

/**
 * Task status enum representing the lifecycle of a task.
 *
 * @example
 * pending -> in_progress -> completed
 * pending -> in_progress -> blocked -> in_progress -> completed
 * pending -> cancelled
 */
export type TaskStatus =
  | 'pending'      // Task created but not started
  | 'in_progress'  // Task is actively being worked on
  | 'blocked'      // Task cannot proceed due to dependency or issue
  | 'completed'    // Task finished successfully
  | 'cancelled';   // Task abandoned/no longer needed

/**
 * Task priority levels.
 * Lower number = higher priority.
 *
 * 1 = CRITICAL - Must be done immediately, blocks other work
 * 2 = HIGH - Important, should be done today
 * 3 = MEDIUM - Normal priority, this week
 * 4 = LOW - Nice to have, when time permits
 * 5 = BACKLOG - Future consideration
 */
export type TaskPriority = 1 | 2 | 3 | 4 | 5;

/**
 * Human-readable priority labels for display purposes.
 */
export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  1: 'CRITICAL',
  2: 'HIGH',
  3: 'MEDIUM',
  4: 'LOW',
  5: 'BACKLOG'
};

/**
 * Identifikator nositelja zadatka.
 *
 * Namjerno `string`, a NE unija imena: koja imena postoje zna tek instalacija, i to u
 * `config/agents.json` (ili `TM_AGENTS`). Zatvorena unija ovdje značila bi da paket u
 * tipovima nosi tuđi tim — tuđem korisniku ne bi prošao ni vlastiti nositelj (nalaz N1,
 * `docs/QA_E2E_SAMOSTALNOST_2026-09-10.md`).
 *
 * Higijenu i pripadnost popisu provjerava `jeDopustenAgent()` u trenutku upisa
 * (`AgentIdSchema`), gdje se popis MOŽE razriješiti — tip to ne može.
 */
export type AgentId = string;

/**
 * Dopušteni nositelji u OVOJ instalaciji, poredani.
 *
 * Prazan niz znači „popis nije zatvoren" (nema ni registra ni `TM_AGENTS`) — tada je
 * dopušten svaki ispravan oblik imena, pa nabrajanje ni nema smisla.
 * Funkcija, a ne konstanta: registar smije nastati POSLIJE pokretanja ploče.
 */
export function allAgents(): AgentId[] {
  return dopusteniAgenti().popis;
}

/**
 * Imena za PRIKAZ, `{ id → ime }`, iz registra (`config/agents.json`, polje `ime`).
 *
 * Agent bez `ime` u registru ne dobiva izmišljeno ime nego se u mapi ne pojavljuje —
 * pozivatelj tada prikazuje sam `id`. Bez registra je mapa prazna.
 */
export function agentNames(): Record<string, string> {
  const mapa: Record<string, string> = {};
  for (const a of loadAgents()) {
    if (a.ime) mapa[a.id.toLowerCase()] = a.ime;
  }
  return mapa;
}

/** Ime za prikaz, uz `id` kao rezervu. */
export function agentName(id: string): string {
  const ime = String(id ?? '').trim();
  return agentNames()[ime.toLowerCase()] || ime;
}

// ============================================================================
// CORE INTERFACES
// ============================================================================

/**
 * Progress note attached to a task.
 * Used to track work being done on a task over time.
 */
export interface ProgressNote {
  /** When the note was added */
  timestamp: Date;
  /** Which agent added the note */
  agent: AgentId;
  /** The note content (markdown supported) */
  note: string;
}

/**
 * Main Task interface - the central data structure.
 *
 * Tasks are stored in Markdown files per agent at:
 * ~/.claude/tasks/agents/{agentId}.md
 */
export interface Task {
  /** Unique identifier in TASK-XXX format */
  id: string;

  /** Short title/subject of the task */
  title: string;

  /** Detailed description (supports markdown) */
  description: string;

  /** Current status in the task lifecycle */
  status: TaskStatus;

  /** Priority level (1=critical, 5=backlog) */
  priority: TaskPriority;

  /** Agent currently assigned to work on this task */
  assignee?: AgentId;

  /** Who created the task */
  createdBy: AgentId | 'user';

  /** When the task was created */
  createdAt: Date;

  /** Last modification timestamp */
  updatedAt: Date;

  /** When work started (status changed to in_progress) */
  startedAt?: Date;

  /** When task was completed */
  completedAt?: Date;

  /** Task IDs that block this task (dependencies) */
  blockedBy: string[];

  /** Task IDs that are waiting for this task to complete */
  blocks: string[];

  /** Human-readable reason why task is blocked */
  blockedReason?: string;

  /** Hashtags for categorization */
  tags: string[];

  /** History of progress updates */
  progressNotes: ProgressNote[];

  /** Optional project/phase grouping */
  project?: string;

  /** Estimated duration in minutes */
  estimatedMinutes?: number;

  /** Actual time spent in minutes */
  actualMinutes?: number;
}

/**
 * Input for creating a new task.
 * Only title and createdBy are required.
 */
export interface CreateTaskInput {
  /** Required: Short task title */
  title: string;

  /** Optional: Detailed description */
  description?: string;

  /** Optional: Priority (defaults to 3 - MEDIUM) */
  priority?: TaskPriority;

  /** Optional: Assign to agent immediately */
  assignee?: AgentId;

  /** Required: Who is creating the task */
  createdBy: AgentId | 'user';

  /** Optional: Dependencies that must complete first */
  blockedBy?: string[];

  /** Optional: Categorization tags */
  tags?: string[];

  /** Optional: Project grouping */
  project?: string;

  /** Optional: Estimated duration */
  estimatedMinutes?: number;
}

/**
 * Input for updating an existing task.
 * All fields are optional - only provided fields are updated.
 */
export interface UpdateTaskInput {
  /** Update title */
  title?: string;

  /** Update description */
  description?: string;

  /** Change status */
  status?: TaskStatus;

  /** Change priority */
  priority?: TaskPriority;

  /** Reassign to different agent */
  assignee?: AgentId;

  /** Update dependencies */
  blockedBy?: string[];

  /** Update blocked reason */
  blockedReason?: string;

  /** Update tags */
  tags?: string[];

  /** Update project */
  project?: string;

  /** Update estimated time */
  estimatedMinutes?: number;

  /** Update actual time spent */
  actualMinutes?: number;
}

/**
 * Filter criteria for querying tasks.
 */
export interface TaskFilter {
  /** Filter by status (single or multiple) */
  status?: TaskStatus | TaskStatus[];

  /** Filter by assignee */
  assignee?: AgentId;

  /** Filter by priority */
  priority?: TaskPriority;

  /** Filter by minimum priority (1 = critical only, 3 = critical+high+medium) */
  minPriority?: TaskPriority;

  /** Filter by tags (any match) */
  tags?: string[];

  /** Filter by project */
  project?: string;

  /** Tasks created after this date */
  createdAfter?: Date;

  /** Tasks created before this date */
  createdBefore?: Date;

  /** Search in title/description */
  searchText?: string;

  /** Include only blocked/unblocked tasks */
  isBlocked?: boolean;
}

// ============================================================================
// EVENT TYPES (for logging and notifications)
// ============================================================================

/**
 * Types of task events for logging and notifications.
 */
export type TaskEventType =
  | 'created'
  | 'updated'
  | 'status_changed'
  | 'assigned'
  | 'unassigned'
  | 'blocked'
  | 'unblocked'
  | 'completed'
  | 'cancelled'
  | 'progress_note'
  | 'priority_changed'
  | 'archived';

/**
 * Task event for logging and audit trail.
 */
export interface TaskEvent {
  /** Unique event ID */
  id: string;

  /** Task this event relates to */
  taskId: string;

  /** Type of event */
  type: TaskEventType;

  /** Agent that triggered the event */
  agent: AgentId;

  /** When the event occurred */
  timestamp: Date;

  /** Event-specific data */
  data?: {
    /** Previous value (for status changes) */
    oldValue?: string;
    /** New value (for status changes) */
    newValue?: string;
    /** Reason (for blocks/cancellations) */
    reason?: string;
    /** Additional context */
    note?: string;
  };
}

// ============================================================================
// AGENT CAPABILITIES
// ============================================================================

/**
 * Task-related capabilities an agent can have.
 */
export type TaskCapability =
  | 'create_task'        // Can create new tasks
  | 'update_task'        // Can update task details
  | 'delete_task'        // Can delete tasks
  | 'assign_task'        // Can assign tasks to agents
  | 'complete_task'      // Can mark tasks as completed
  | 'block_task'         // Can block tasks
  | 'unblock_task'       // Can unblock tasks
  | 'view_all_tasks'     // Can see all agents' tasks
  | 'manage_scheduler'   // Can control the scheduler
  | 'send_notifications' // Can send task notifications
  | 'archive_tasks';     // Can archive old tasks

/**
 * Agent capability definitions.
 * Defines what each agent can do with tasks.
 */
export interface AgentCapability {
  /** Agent ID */
  agentId: AgentId;

  /** List of capabilities this agent has */
  capabilities: TaskCapability[];

  /** Whether agent can work autonomously */
  autonomous: boolean;

  /** Maximum tasks agent can have in_progress at once */
  maxConcurrentTasks: number;

  /** Task types this agent specializes in */
  specializations?: string[];
}

/**
 * Nema ugrađene matrice sposobnosti.
 *
 * Do 10.09.2026. je ovdje stajao `AGENT_CAPABILITIES` — po zapis za svakog od NAŠIH
 * jedanaest agenata, s njihovim ulogama u `specializations` („architecture", „security",
 * „intern_tasks"…). To je politika JEDNE instalacije, a ne činjenica o zadatcima: tko što
 * smije i u čemu je specijaliziran opisuje orkestrator u `config/agents.json` (polje
 * `uloga`, `keywords`). Tip `AgentCapability` ostaje kao OBLIK koji takva politika može
 * popuniti; jezgra sama nikoga ne nabraja (TASK-4809).
 */

// ============================================================================
// NOTIFICATION TYPES
// ============================================================================

/**
 * Notification channel types.
 */
export type NotificationChannel = 'telegram' | 'teamspeak' | 'web' | 'log';

/**
 * Notification urgency levels.
 */
export type NotificationUrgency = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Task notification structure.
 */
export interface TaskNotification {
  /** Unique notification ID */
  id: string;

  /** Related task ID */
  taskId: string;

  /** Event that triggered the notification */
  eventType: TaskEventType;

  /** Target recipient (agent or user) */
  recipient: AgentId;

  /** Which channels to use */
  channels: NotificationChannel[];

  /** Urgency level */
  urgency: NotificationUrgency;

  /** Notification title */
  title: string;

  /** Notification body/message */
  message: string;

  /** When created */
  createdAt: Date;

  /** Whether notification was sent */
  sent: boolean;

  /** When it was sent */
  sentAt?: Date;
}

// ============================================================================
// SCHEDULER TYPES
// ============================================================================

/**
 * Scheduler statistics for monitoring.
 */
export interface SchedulerStats {
  /** Last tick timestamp */
  lastTick: Date;

  /** Number of ticks since start */
  tickCount: number;

  /** Tasks auto-unblocked this session */
  tasksUnblocked: number;

  /** Tasks auto-assigned this session */
  tasksAssigned: number;

  /** Stale warnings sent this session */
  staleWarnings: number;

  /** Critical alerts sent this session */
  criticalAlerts: number;

  /** Tasks archived this session */
  tasksArchived: number;

  /** Current pending tasks count */
  pendingTasks: number;

  /** Current in_progress tasks count */
  inProgressTasks: number;

  /** Current blocked tasks count */
  blockedTasks: number;
}

/**
 * Scheduler configuration options.
 */
export interface SchedulerConfig {
  /** Tick interval in milliseconds (default: 60000 = 1 minute) */
  tickIntervalMs: number;

  /** Hours after which in_progress task is considered stale */
  staleHours: number;

  /** Hours after which critical pending task triggers alert */
  criticalAlertHours: number;

  /** Days after which completed task is archived */
  archiveDays: number;

  /** Whether to auto-assign pending tasks */
  autoAssign: boolean;

  /** Whether to send notifications */
  sendNotifications: boolean;

  /** TASK-065 (Jelena): Auto-execute P1 tasks by spawning agents */
  autoExecuteP1: boolean;

  /** TASK-065 (Jelena): Maximum concurrent agent spawns */
  maxConcurrentSpawns: number;

  /** TASK-066 (Jelena): Enable daily digest for P2 tasks */
  dailyDigestEnabled: boolean;

  /** TASK-066 (Jelena): Hour of day for daily digest (0-23, default: 9 = 09:00) */
  dailyDigestHour: number;
}

/**
 * Default scheduler configuration.
 */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  tickIntervalMs: 60000,    // 1 minute
  staleHours: 24,           // 24 hours
  criticalAlertHours: 1,    // 1 hour
  archiveDays: 7,           // 7 days
  autoAssign: true,
  sendNotifications: true,
  autoExecuteP1: true,      // TASK-065 (Jelena): Auto-spawn agents for P1 tasks
  maxConcurrentSpawns: 2,   // TASK-065 (Jelena): Max 2 concurrent spawns
  dailyDigestEnabled: true, // TASK-066 (Jelena): Send daily P2 digest
  dailyDigestHour: 9        // TASK-066 (Jelena): At 09:00
};

// ============================================================================
// UTILITY TYPES
// ============================================================================

/**
 * Task summary for quick display (e.g., in Telegram messages).
 */
export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: AgentId;
}

/**
 * Result of a task operation.
 */
export interface TaskOperationResult<T = Task> {
  /** Whether operation succeeded */
  success: boolean;

  /** Result data (if successful) */
  data?: T;

  /** Error message (if failed) */
  error?: string;

  /** Error code for programmatic handling */
  errorCode?: string;
}

/**
 * Markdown file metadata from YAML frontmatter.
 */
export interface MarkdownFileMeta {
  agentId: AgentId;
  lastUpdated: Date;
  taskCount: number;
  version: string;
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

/**
 * Check if a string is a valid TaskStatus.
 */
export function isTaskStatus(value: string): value is TaskStatus {
  return ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'].includes(value);
}

/**
 * Check if a number is a valid TaskPriority.
 */
export function isTaskPriority(value: number): value is TaskPriority {
  return [1, 2, 3, 4, 5].includes(value);
}

/**
 * Smije li `value` biti nositelj u OVOJ instalaciji?
 *
 * Delegira na `jeDopustenAgent` (`src/core/AgentIds.ts`) — jedan izvor istine s Zod
 * shemom, pa se provjera u kodu i provjera na ulazu API-ja ne mogu razići.
 */
export function isAgentId(value: string): value is AgentId {
  return jeDopustenAgent(value);
}

/**
 * Check if a task is blocked (has blockedBy or status is blocked).
 */
export function isTaskBlocked(task: Task): boolean {
  return task.status === 'blocked' || task.blockedBy.length > 0;
}

/**
 * Check if a task can be started (pending and not blocked).
 */
export function canStartTask(task: Task): boolean {
  return task.status === 'pending' && task.blockedBy.length === 0;
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  // Types are exported above

  // Constants
  PRIORITY_LABELS,
  DEFAULT_SCHEDULER_CONFIG,

  // Agenti — razrješavaju se iz konfiguracije, pa su funkcije, ne konstante
  allAgents,
  agentNames,
  agentName,

  // Type guards
  isTaskStatus,
  isTaskPriority,
  isAgentId,
  isTaskBlocked,
  canStartTask
};
