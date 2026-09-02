import { z } from 'zod'
import { AgentIdSchema } from './task'

// ============================================
// PROJECT STATUS & ENUMS
// ============================================

export const ProjectStatusSchema = z.enum([
  'active', 'on_hold', 'completed', 'archived'
])

export const ProjectPrioritySchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)
])

export const ProjectRoleSchema = z.enum([
  'lead', 'member', 'reviewer', 'observer'
])

// ============================================
// PROJECT AGENT SCHEMA
// ============================================

export const ProjectAgentSchema = z.object({
  project_id: z.string(),
  agent_id: AgentIdSchema,
  role: ProjectRoleSchema,
  assigned_at: z.string().optional()
})

// ============================================
// PROJECT RAG ENTRY LINK SCHEMA
// ============================================

export const ProjectRAGLinkSchema = z.object({
  project_id: z.string(),
  rag_collection: z.string().min(1),
  rag_document_id: z.string().min(1),
  linked_at: z.string().optional(),
  linked_by: z.string().optional()
})

// ============================================
// MAIN PROJECT SCHEMA
// ============================================

export const ProjectSchema = z.object({
  id: z.string().regex(/^PRJ-\d{3,}$/, 'Project ID must be in format PRJ-XXX'),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  status: ProjectStatusSchema,
  priority: ProjectPrioritySchema,
  lead_agent: AgentIdSchema.optional(),
  created_at: z.string(),
  updated_at: z.string(),
  target_date: z.string().optional(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
  // Nextcloud integration fields
  nextcloud_folder_id: z.string().optional(),
  nextcloud_share_url: z.string().optional(),
  // Spec polja (projects.specification / spec_updated_at, izložena kroz v_projects_summary)
  specification: z.string().optional(),
  spec_updated_at: z.string().nullable().optional(),
  // Virtual fields from v_projects_summary
  agent_count: z.number().optional(),
  task_count: z.number().optional(),
  completed_task_count: z.number().optional(),
  // TASK-3513: brojke po statusu (u radu / na čekanju / blokirano)
  in_progress_task_count: z.number().optional(),
  pending_task_count: z.number().optional(),
  blocked_task_count: z.number().optional(),
  calculated_progress: z.number().optional(),
  rag_entry_count: z.number().optional(),
  // TASK-3516: vrijeme zadnjeg rada na projektu (max updated_at njegovih
  // zadataka) — ključ po kojemu se projekti slažu, najnoviji prvi.
  last_activity_at: z.string().nullable().optional()
})

// ============================================
// INPUT SCHEMAS
// ============================================

export const CreateProjectInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: ProjectPrioritySchema.default(3),
  lead_agent: AgentIdSchema.optional(),
  target_date: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  nextcloud_folder_id: z.string().optional(),
  nextcloud_share_url: z.string().optional()
})

export const UpdateProjectInputSchema = CreateProjectInputSchema.partial().extend({
  status: ProjectStatusSchema.optional(),
  // Aktualna editabilna specifikacija projekta (sprema se u projects.specification)
  specification: z.string().optional()
})

// ============================================
// FILTER SCHEMA
// ============================================

export const ProjectFilterSchema = z.object({
  status: ProjectStatusSchema.optional(),
  priority: ProjectPrioritySchema.optional(),
  lead_agent: AgentIdSchema.optional(),
  agent: AgentIdSchema.optional(),  // Filter by any assigned agent
  tag: z.string().optional(),
  search: z.string().optional()
})

// ============================================
// ADD/REMOVE AGENT SCHEMAS
// ============================================

export const AddAgentInputSchema = z.object({
  agent_id: AgentIdSchema,
  role: ProjectRoleSchema.default('member')
})

export const LinkRAGInputSchema = z.object({
  rag_collection: z.string().min(1),
  rag_document_id: z.string().min(1)
})

// ============================================
// TYPE EXPORTS
// ============================================

export type Project = z.infer<typeof ProjectSchema>
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>
export type ProjectPriority = z.infer<typeof ProjectPrioritySchema>
export type ProjectRole = z.infer<typeof ProjectRoleSchema>
export type ProjectAgent = z.infer<typeof ProjectAgentSchema>
export type ProjectRAGLink = z.infer<typeof ProjectRAGLinkSchema>
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>
export type ProjectFilter = z.infer<typeof ProjectFilterSchema>
export type AddAgentInput = z.infer<typeof AddAgentInputSchema>
export type LinkRAGInput = z.infer<typeof LinkRAGInputSchema>
