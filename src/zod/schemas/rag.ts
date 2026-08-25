import { z } from 'zod'

// ============================================
// RAG ENTRY SCHEMA
// ============================================

export const RAGEntrySchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  collection: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  stored_at: z.string().optional(),
  // Optional fields from query results
  distance: z.number().optional(),
  relevanceScore: z.number().optional()
})

// ============================================
// RAG COLLECTION SCHEMA
// ============================================

export const RAGCollectionSchema = z.object({
  name: z.string().min(1),
  count: z.number().int().min(0),
  exists: z.boolean().default(true)
})

// ============================================
// RAG FILTER SCHEMA
// ============================================

export const RAGFilterSchema = z.object({
  collection: z.string().optional(),
  type: z.string().optional(),           // Filter by metadata.type
  agent: z.string().optional(),           // Filter by metadata.agent
  dateFrom: z.string().optional(),        // ISO date string
  dateTo: z.string().optional(),          // ISO date string
  search: z.string().optional(),          // Text search in content
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0)
})

// ============================================
// RAG DELETE REQUEST SCHEMA
// ============================================

export const RAGDeleteRequestSchema = z.object({
  collection: z.string().min(1),
  documentIds: z.array(z.string().min(1)).min(1).max(20)  // Max 20 at once
})

// ============================================
// RAG QUERY SCHEMA
// ============================================

export const RAGQuerySchema = z.object({
  collection: z.string().min(1),
  query: z.string().min(1),
  nResults: z.number().int().min(1).max(50).default(10),
  where: z.record(z.unknown()).optional()
})

// ============================================
// RAG STORE SCHEMA
// ============================================

export const RAGStoreSchema = z.object({
  collection: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  documentId: z.string().optional()
})

// ============================================
// RAG DELETE RESULT SCHEMA
// ============================================

export const RAGDeleteResultSchema = z.object({
  deleted: z.array(z.string()),
  notFound: z.array(z.string()),
  errors: z.array(z.object({
    id: z.string(),
    error: z.string()
  }))
})

// ============================================
// RAG HEALTH CHECK SCHEMA
// ============================================

export const RAGHealthSchema = z.object({
  chromadb: z.object({
    connected: z.boolean(),
    error: z.string().optional()
  }),
  ollama: z.object({
    connected: z.boolean(),
    error: z.string().optional()
  }),
  embedModel: z.object({
    available: z.boolean(),
    error: z.string().optional()
  })
})

// ============================================
// TYPE EXPORTS
// ============================================

export type RAGEntry = z.infer<typeof RAGEntrySchema>
export type RAGCollection = z.infer<typeof RAGCollectionSchema>
export type RAGFilter = z.infer<typeof RAGFilterSchema>
export type RAGDeleteRequest = z.infer<typeof RAGDeleteRequestSchema>
export type RAGQuery = z.infer<typeof RAGQuerySchema>
export type RAGStore = z.infer<typeof RAGStoreSchema>
export type RAGDeleteResult = z.infer<typeof RAGDeleteResultSchema>
export type RAGHealth = z.infer<typeof RAGHealthSchema>
