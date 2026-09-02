import { z } from 'zod'

// Status enum
export const TaskStatusSchema = z.enum([
  'pending', 'in_progress', 'blocked', 'completed', 'cancelled'
])

// Priority (1-5)
export const TaskPrioritySchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)
])

// Agent IDs
export const AgentIdSchema = z.enum([
  'regoc', 'klaudio', 'stribor', 'kosjenka', 'jelena',
  'malik', 'manda', 'potjeh', 'dora', 'gita', 'grga',
  'pai', 'user', 'scheduler'
])

// Progress note
export const ProgressNoteSchema = z.object({
  timestamp: z.string(),
  note: z.string(),
  agent: AgentIdSchema.optional(),
})

// Main Task schema
export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  assignee: AgentIdSchema.optional(),
  createdBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  dueDate: z.string().optional(),
  completedAt: z.string().optional(),
  startedAt: z.string().optional(),
  blockedBy: z.array(z.string()).default([]),
  blockedReason: z.string().optional(),
  blocks: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  progressNotes: z.array(ProgressNoteSchema).default([]),
  progressPercent: z.number().int().min(0).max(100).optional(),
  nextcloudFolder: z.string().optional(),
  projectId: z.string().optional(),
})

// Input schemas
export const CreateTaskInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: TaskPrioritySchema.default(3),
  assignee: AgentIdSchema.optional(),
  dueDate: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  progressPercent: z.number().int().min(0).max(100).optional(),
  nextcloudFolder: z.string().optional(),
  projectId: z.string().optional(),
})

export const UpdateTaskInputSchema = CreateTaskInputSchema.partial().extend({
  // .partial() NE uklanja .default(3) s priority — ZodOptional samo omota ZodDefault,
  // pa je svaki djelomicni PUT (npr. samo {status}) tiho vracao priority na 3 i time
  // demotirao P1/P2 zadatke. Eksplicitno pregazimo polje ciljem BEZ defaulta:
  // izostavljen priority => ostaje nepromijenjen (TaskManagerSQL: updates.priority ?? existing.priority).
  priority: TaskPrioritySchema.optional(),
  status: TaskStatusSchema.optional(),
  progressNotes: z.array(z.string()).optional(),
  // Agentov konačni odgovor koji se apenda u zadatak prije zatvaranja (vidljiv na završenom zadatku,
  // može sadržavati i link na generirani dokument).
  resultSummary: z.string().max(20000).optional(),
  // TASK-2953: strojni razlog blokade (npr. 'session-budget', 'hook-block:PreToolUse').
  // Bez ovoga je Zod tiho odbacivao polje, pa je svaki `status: blocked` stizao bez razloga
  // iako TaskManagerSQL kolonu `blocked_reason` ima i puni je.
  blockedReason: z.string().max(500).optional(),
  // NAZIVI POLJA: shema je kanonska i drži SAMO camelCase. snake_case koji šalju agenti
  // (`result_summary`, `progress_notes`, `blocked_reason`) prevodi se JEDNOM, na HTTP ulazu,
  // u TaskFieldAliases.normalizeTaskFields — aliasi se izvode iz ove sheme, pa ne mogu
  // otrunuti kad se doda novo polje. Dva popisa naziva = D6 opet (TASK-2976).
  // TASK-2954 (D2): svjesno zatvaranje unatoč odbijenom sudu CompletionGuarda.
  // Namijenjeno ČOVJEKU (UI gumb / ručni curl) — spawn promptovi agenata ga ne
  // spominju, pa auto-exec put do njega ne dolazi. Svaka upotreba se loga.
  force: z.boolean().optional(),
})

// Filter schema for GET /api/tasks
export const TaskFilterSchema = z.object({
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  assignee: AgentIdSchema.optional(),
  tag: z.string().optional(),
  search: z.string().optional(),
  projectId: z.string().optional(),
})

// Type exports
export type Task = z.infer<typeof TaskSchema>
export type TaskStatus = z.infer<typeof TaskStatusSchema>
export type TaskPriority = z.infer<typeof TaskPrioritySchema>
export type AgentId = z.infer<typeof AgentIdSchema>
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>
export type TaskFilter = z.infer<typeof TaskFilterSchema>
