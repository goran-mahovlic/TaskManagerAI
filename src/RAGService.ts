#!/usr/bin/env bun
/**
 * REGOC RAGService
 *
 * Wrapper for ChromaDB operations.
 * Provides collection listing, entry retrieval, and deletion for the RAG WebUI.
 *
 * Based on: ~/.claude/skills/CORE/Tools/lib/rag-memory.ts
 * ChromaDB: 192.168.10.200:18765
 *
 * Author: Jelena Kovacevic (Engineer Agent)
 * Version: 1.0.0
 */

import {
  getChromaClient,
  listCollections as listCollectionsCore,
  getCollection,
  collectionExists,
  getCollectionCount,
  deleteMemory,
  getAllMemories,
  retrieveMemory,
  type RAGConfig,
  type MemoryResult,
  type DeleteMemoryResult
} from './rag/rag-memory'

import {
  RAGFilterSchema,
  RAGDeleteRequestSchema,
  type RAGEntry,
  type RAGCollection,
  type RAGFilter,
  type RAGDeleteRequest,
  type RAGDeleteResult
} from './zod/schemas/rag'

// ============================================
// CONFIGURATION
// ============================================

const DEFAULT_RAG_CONFIG: RAGConfig = {
  chromaHost: '192.168.10.200',
  chromaPort: 18765,
  ollamaHost: 'http://192.168.10.4:11434',
  embedModel: 'qwen3-embedding:8b'
}

// ============================================
// RAG SERVICE CLASS
// ============================================

export class RAGService {
  private config: RAGConfig

  constructor(config: RAGConfig = DEFAULT_RAG_CONFIG) {
    this.config = config
  }

  // ============================================
  // COLLECTION OPERATIONS
  // ============================================

  /**
   * List all collections with counts
   */
  async listCollections(): Promise<RAGCollection[]> {
    const names = await listCollectionsCore(this.config)

    const collections: RAGCollection[] = []
    for (const name of names) {
      try {
        const count = await getCollectionCount(name, this.config)
        collections.push({
          name,
          count,
          exists: true
        })
      } catch (error) {
        collections.push({
          name,
          count: 0,
          exists: false
        })
      }
    }

    // Sort by count descending
    return collections.sort((a, b) => b.count - a.count)
  }

  /**
   * Get collection statistics
   */
  async getCollectionStats(collectionName: string): Promise<RAGCollection | null> {
    const exists = await collectionExists(collectionName, this.config)
    if (!exists) return null

    const count = await getCollectionCount(collectionName, this.config)
    return {
      name: collectionName,
      count,
      exists: true
    }
  }

  // ============================================
  // ENTRY OPERATIONS
  // ============================================

  /**
   * Get entries with filtering, pagination, and sorting by date DESC
   */
  async getEntries(filter?: RAGFilter): Promise<{
    entries: RAGEntry[]
    total: number
    hasMore: boolean
  }> {
    const validated = filter ? RAGFilterSchema.parse(filter) : { limit: 50, offset: 0 }

    // If no collection specified, get from all collections
    let collections: string[] = []
    if (validated.collection) {
      collections = [validated.collection]
    } else {
      collections = await listCollectionsCore(this.config)
    }

    // Fetch entries from all relevant collections
    let allEntries: RAGEntry[] = []

    for (const collectionName of collections) {
      try {
        const memories = await getAllMemories({
          collectionName,
          config: this.config
        })

        const entries: RAGEntry[] = memories.map(m => ({
          id: m.id,
          content: m.content,
          collection: collectionName,
          metadata: m.metadata,
          stored_at: m.metadata.stored_at as string | undefined
        }))

        allEntries = allEntries.concat(entries)
      } catch (error) {
        console.error(`[RAGService] Error fetching from ${collectionName}:`, error)
      }
    }

    // Apply filters
    if (validated.type) {
      allEntries = allEntries.filter(e => e.metadata.type === validated.type)
    }

    if (validated.agent) {
      allEntries = allEntries.filter(e => e.metadata.agent === validated.agent)
    }

    if (validated.dateFrom) {
      const fromDate = new Date(validated.dateFrom)
      allEntries = allEntries.filter(e => {
        const storedAt = e.stored_at || e.metadata.stored_at
        if (!storedAt) return true
        return new Date(storedAt as string) >= fromDate
      })
    }

    if (validated.dateTo) {
      const toDate = new Date(validated.dateTo)
      allEntries = allEntries.filter(e => {
        const storedAt = e.stored_at || e.metadata.stored_at
        if (!storedAt) return true
        return new Date(storedAt as string) <= toDate
      })
    }

    if (validated.search) {
      const searchLower = validated.search.toLowerCase()
      allEntries = allEntries.filter(e =>
        e.content.toLowerCase().includes(searchLower) ||
        e.id.toLowerCase().includes(searchLower)
      )
    }

    // Sort by date DESC (newest first)
    allEntries.sort((a, b) => {
      const dateA = a.stored_at || a.metadata.stored_at
      const dateB = b.stored_at || b.metadata.stored_at

      if (!dateA && !dateB) return 0
      if (!dateA) return 1
      if (!dateB) return -1

      return new Date(dateB as string).getTime() - new Date(dateA as string).getTime()
    })

    const total = allEntries.length
    const limit = validated.limit || 50
    const offset = validated.offset || 0

    // Apply pagination
    const paginatedEntries = allEntries.slice(offset, offset + limit)
    const hasMore = offset + limit < total

    return {
      entries: paginatedEntries,
      total,
      hasMore
    }
  }

  /**
   * Get a single entry by collection and ID
   */
  async getEntry(collection: string, documentId: string): Promise<RAGEntry | null> {
    const memory = await retrieveMemory({
      collectionName: collection,
      documentId,
      config: this.config
    })

    if (!memory) return null

    return {
      id: memory.id,
      content: memory.content,
      collection,
      metadata: memory.metadata,
      stored_at: memory.metadata.stored_at as string | undefined
    }
  }

  // ============================================
  // DELETE OPERATIONS
  // ============================================

  /**
   * Delete entries permanently
   * WARNING: This is irreversible!
   */
  async deleteEntries(request: RAGDeleteRequest): Promise<RAGDeleteResult> {
    const validated = RAGDeleteRequestSchema.parse(request)

    // Max 20 at once for safety
    if (validated.documentIds.length > 20) {
      throw new Error('Maximum 20 entries can be deleted at once')
    }

    const result = await deleteMemory({
      collectionName: validated.collection,
      documentIds: validated.documentIds,
      config: this.config
    })

    return {
      deleted: result.deleted,
      notFound: result.notFound,
      errors: result.errors
    }
  }

  /**
   * Delete a single entry
   */
  async deleteEntry(collection: string, documentId: string): Promise<boolean> {
    const result = await this.deleteEntries({
      collection,
      documentIds: [documentId]
    })

    return result.deleted.length > 0
  }

  // ============================================
  // HEALTH CHECK
  // ============================================

  /**
   * Check RAG system health
   */
  async healthCheck(): Promise<{
    chromadb: { connected: boolean; error?: string }
    collections: number
    totalEntries: number
  }> {
    try {
      const client = getChromaClient(this.config)
      await client.heartbeat()

      const collections = await this.listCollections()
      const totalEntries = collections.reduce((sum, c) => sum + c.count, 0)

      return {
        chromadb: { connected: true },
        collections: collections.length,
        totalEntries
      }
    } catch (error) {
      return {
        chromadb: {
          connected: false,
          error: error instanceof Error ? error.message : String(error)
        },
        collections: 0,
        totalEntries: 0
      }
    }
  }

  // ============================================
  // STATISTICS
  // ============================================

  /**
   * Get RAG statistics
   */
  async getStats(): Promise<{
    collections: RAGCollection[]
    totalEntries: number
    topCollections: { name: string; count: number }[]
  }> {
    const collections = await this.listCollections()
    const totalEntries = collections.reduce((sum, c) => sum + c.count, 0)

    // Top 10 collections by count
    const topCollections = collections
      .slice(0, 10)
      .map(c => ({ name: c.name, count: c.count }))

    return {
      collections,
      totalEntries,
      topCollections
    }
  }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

let ragServiceInstance: RAGService | null = null

export function getRAGService(): RAGService {
  if (!ragServiceInstance) {
    ragServiceInstance = new RAGService()
  }
  return ragServiceInstance
}

// ============================================
// CLI USAGE
// ============================================

if (import.meta.main) {
  const service = getRAGService()

  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'collections':
      const collections = await service.listCollections()
      console.log(JSON.stringify(collections, null, 2))
      break

    case 'entries':
      const collection = args[1]
      const result = await service.getEntries({
        collection,
        limit: 10
      })
      console.log(JSON.stringify(result, null, 2))
      break

    case 'get':
      const getCollection = args[1]
      const getId = args[2]
      if (!getCollection || !getId) {
        console.error('Usage: RAGService.ts get <collection> <id>')
        process.exit(1)
      }
      const entry = await service.getEntry(getCollection, getId)
      console.log(entry ? JSON.stringify(entry, null, 2) : 'Not found')
      break

    case 'delete':
      const delCollection = args[1]
      const delId = args[2]
      if (!delCollection || !delId) {
        console.error('Usage: RAGService.ts delete <collection> <id>')
        process.exit(1)
      }
      console.log('WARNING: This will permanently delete the entry!')
      const deleted = await service.deleteEntry(delCollection, delId)
      console.log(deleted ? 'Deleted' : 'Not found or failed')
      break

    case 'health':
      const health = await service.healthCheck()
      console.log(JSON.stringify(health, null, 2))
      break

    case 'stats':
      const stats = await service.getStats()
      console.log(JSON.stringify(stats, null, 2))
      break

    default:
      console.log(`
REGOC RAGService CLI

Usage:
  bun RAGService.ts collections              - List all collections
  bun RAGService.ts entries [collection]     - List entries (10)
  bun RAGService.ts get <collection> <id>    - Get single entry
  bun RAGService.ts delete <collection> <id> - Delete entry (PERMANENT!)
  bun RAGService.ts health                   - Health check
  bun RAGService.ts stats                    - Statistics
      `)
  }
}
