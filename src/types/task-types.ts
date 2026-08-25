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
 */

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
 * All valid agent IDs in the REGOC system.
 * 'user' represents human interaction (Goran/Klaudio).
 */
export type AgentId =
  | 'regoc'     // Orchestrator daemon
  | 'klaudio'   // Telegram agent
  | 'stribor'   // Voice & speech analysis expert
  | 'kosjenka'  // Architect agent
  | 'jelena'    // Engineer agent
  | 'malik'     // Security agent
  | 'manda'     // Documentation agent
  | 'potjeh'    // QA/Intern agent
  | 'dora'      // Data agent
  | 'gita'      // Git/Version control agent
  | 'grga'      // UI/UX Designer agent
  | 'user';     // Human user (Goran)

/**
 * List of all agent IDs for iteration purposes.
 */
export const ALL_AGENTS: AgentId[] = [
  'regoc', 'klaudio', 'stribor', 'kosjenka', 'jelena',
  'malik', 'manda', 'potjeh', 'dora', 'gita', 'grga', 'user'
];

/**
 * Agent display names in Croatian.
 */
export const AGENT_NAMES: Record<AgentId, string> = {
  regoc: 'REGOC Orkestrator',
  klaudio: 'Klaudio (Telegram)',
  stribor: 'Stribor (analiza glasa i govora)',
  kosjenka: 'Kosjenka (Architect)',
  jelena: 'Jelena (Engineer)',
  malik: 'Malik (Security)',
  manda: 'Manda (Dokumentacija)',
  potjeh: 'Potjeh (QA)',
  dora: 'Dora (Data)',
  gita: 'Gita (Git)',
  grga: 'Grga (UI/UX)',
  user: 'Korisnik (Goran)'
};

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
 * Default capability matrix for all agents.
 */
export const AGENT_CAPABILITIES: Record<AgentId, AgentCapability> = {
  regoc: {
    agentId: 'regoc',
    capabilities: [
      'create_task', 'update_task', 'delete_task', 'assign_task',
      'complete_task', 'block_task', 'unblock_task', 'view_all_tasks',
      'manage_scheduler', 'send_notifications', 'archive_tasks'
    ],
    autonomous: true,
    maxConcurrentTasks: 999, // Orchestrator has no limit
    specializations: ['orchestration', 'scheduling', 'coordination']
  },
  klaudio: {
    agentId: 'klaudio',
    capabilities: [
      'create_task', 'update_task', 'view_all_tasks', 'send_notifications'
    ],
    autonomous: true,
    maxConcurrentTasks: 5,
    specializations: ['telegram', 'messaging', 'user_interaction']
  },
  stribor: {
    agentId: 'stribor',
    capabilities: [
      'create_task', 'update_task', 'view_all_tasks', 'send_notifications'
    ],
    autonomous: true,
    maxConcurrentTasks: 3,
    specializations: ['voice', 'speech', 'audio', 'stt', 'prosody']
  },
  kosjenka: {
    agentId: 'kosjenka',
    capabilities: [
      'create_task', 'update_task', 'assign_task', 'complete_task',
      'block_task', 'view_all_tasks'
    ],
    autonomous: false,
    maxConcurrentTasks: 5,
    specializations: ['architecture', 'design', 'planning']
  },
  jelena: {
    agentId: 'jelena',
    capabilities: [
      'create_task', 'update_task', 'complete_task', 'block_task',
      'view_all_tasks'
    ],
    autonomous: false,
    maxConcurrentTasks: 5,
    specializations: ['engineering', 'implementation', 'coding']
  },
  malik: {
    agentId: 'malik',
    capabilities: [
      'create_task', 'update_task', 'complete_task', 'block_task',
      'view_all_tasks'
    ],
    autonomous: false,
    maxConcurrentTasks: 3,
    specializations: ['security', 'validation', 'audit']
  },
  manda: {
    agentId: 'manda',
    capabilities: [
      'create_task', 'update_task', 'complete_task', 'view_all_tasks'
    ],
    autonomous: false,
    maxConcurrentTasks: 5,
    specializations: ['documentation', 'writing', 'knowledge_base']
  },
  potjeh: {
    agentId: 'potjeh',
    capabilities: [
      'create_task', 'update_task', 'complete_task', 'view_all_tasks'
    ],
    autonomous: false,
    maxConcurrentTasks: 3,
    specializations: ['testing', 'qa', 'intern_tasks']
  },
  dora: {
    agentId: 'dora',
    capabilities: [
      'create_task', 'update_task', 'complete_task', 'view_all_tasks'
    ],
    autonomous: false,
    maxConcurrentTasks: 5,
    specializations: ['data', 'analysis', 'reports']
  },
  gita: {
    agentId: 'gita',
    capabilities: [
      'create_task', 'update_task', 'complete_task', 'view_all_tasks'
    ],
    autonomous: false,
    maxConcurrentTasks: 5,
    specializations: ['git', 'version_control', 'deployment']
  },
  grga: {
    agentId: 'grga',
    capabilities: [
      'create_task', 'update_task', 'complete_task', 'view_all_tasks'
    ],
    autonomous: false,
    maxConcurrentTasks: 5,
    specializations: ['ui', 'ux', 'design', 'frontend']
  },
  user: {
    agentId: 'user',
    capabilities: [
      'create_task', 'update_task', 'delete_task', 'assign_task',
      'complete_task', 'block_task', 'unblock_task', 'view_all_tasks',
      'archive_tasks'
    ],
    autonomous: false, // User is human
    maxConcurrentTasks: 999,
    specializations: ['everything'] // Human can do anything
  }
};

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
 * Check if a string is a valid AgentId.
 */
export function isAgentId(value: string): value is AgentId {
  return ALL_AGENTS.includes(value as AgentId);
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
  ALL_AGENTS,
  AGENT_NAMES,
  AGENT_CAPABILITIES,
  DEFAULT_SCHEDULER_CONFIG,

  // Type guards
  isTaskStatus,
  isTaskPriority,
  isAgentId,
  isTaskBlocked,
  canStartTask
};
