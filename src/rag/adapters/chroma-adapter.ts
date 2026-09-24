#!/usr/bin/env bun
/**
 * ChromaDB Adapter
 *
 * Implementacija RagBackend sučelja za ChromaDB.
 * Omotač oko postojećeg chromadb npm paketa.
 *
 * Paket drži `chromadb` 1.x (klijent prima `path`), a noviji 3.x prima `host`/`port`.
 * Konstruktor zato predaje OBOJE — svaka inačica uzme svoje, ostalo ignorira.
 * `listCollections()` u 1.x vraća imena, u 3.x objekte; `imenaKolekcija()` pokriva oba.
 */

import { ChromaClient, type Collection } from 'chromadb'
import type {
  RagBackend,
  MemoryResult,
  DeleteMemoryResult,
  HealthCheckResult,
  ChromaConfig
} from './rag-backend.interface'

// ============================================================================
// Pomoćne funkcije
// ============================================================================

function sanitizeCollectionName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_')

  if (!/^[a-zA-Z0-9]/.test(sanitized)) {
    sanitized = 'c_' + sanitized
  }

  if (!/[a-zA-Z0-9]$/.test(sanitized)) {
    sanitized = sanitized + '_c'
  }

  if (sanitized.length < 3) {
    sanitized = sanitized + '_col'
  }

  if (sanitized.length > 63) {
    sanitized = sanitized.substring(0, 63)
    if (!/[a-zA-Z0-9]$/.test(sanitized)) {
      sanitized = sanitized.substring(0, 62) + 'c'
    }
  }

  return sanitized
}

function sanitizeMetadata(metadata: Record<string, any>): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {}

  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'object') continue

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value
    }
  }

  return sanitized
}

/** Imena kolekcija neovisno o inačici klijenta (1.x: string[], 3.x: objekti s `name`). */
export function imenaKolekcija(popis: any[]): string[] {
  return (popis || []).map(c => (typeof c === 'string' ? c : c?.name)).filter((n): n is string => !!n)
}

function calculateRelevanceScore(distance: number | undefined): number {
  if (distance === undefined) return 0.5
  const cosineSimilarity = Math.max(0, 1 - (distance / 2))
  return cosineSimilarity
}

// ============================================================================
// ChromaAdapter
// ============================================================================

export class ChromaAdapter implements RagBackend {
  readonly name = 'chromadb' as const
  private client: ChromaClient
  private config: ChromaConfig

  constructor(config: ChromaConfig) {
    this.config = config
    const host = String(config.host || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
    const path = `http://${host}:${config.port}`
    this.client = new ChromaClient({ path, host, port: config.port } as any)
  }

  async storeMemory(
    collection: string,
    id: string,
    content: string,
    embedding: number[],
    metadata: Record<string, any>
  ): Promise<string> {
    const coll = await this.getOrCreateCollection(collection)
    const cleanMetadata = sanitizeMetadata({
      ...metadata,
      stored_at: new Date().toISOString()
    })

    await coll.add({
      ids: [id],
      embeddings: [embedding],
      documents: [content],
      metadatas: [cleanMetadata]
    })

    return id
  }

  async queryMemory(
    collection: string,
    queryEmbedding: number[],
    n: number,
    where?: Record<string, any>
  ): Promise<MemoryResult[]> {
    const exists = await this.collectionExists(collection)
    if (!exists) return []

    const coll = await this.dohvatiKolekciju(collection)

    const results: any = await coll.query({
      queryEmbeddings: [queryEmbedding],
      nResults: n,
      where
    } as any)

    const memories: MemoryResult[] = []
    if (results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        memories.push({
          id: results.ids[0][i],
          content: results.documents[0][i] as string,
          metadata: results.metadatas[0][i] as Record<string, any>,
          distance: results.distances?.[0][i],
          relevanceScore: calculateRelevanceScore(results.distances?.[0][i])
        })
      }
    }

    return memories
  }

  async deleteMemory(
    collection: string,
    ids: string[]
  ): Promise<DeleteMemoryResult> {
    const result: DeleteMemoryResult = {
      deleted: [],
      notFound: [],
      errors: []
    }

    const exists = await this.collectionExists(collection)
    if (!exists) {
      result.notFound = [...ids]
      return result
    }

    const coll = await this.dohvatiKolekciju(collection)

    const existingDocs: any = await coll.get({ ids } as any)
    const existingIds = new Set(existingDocs.ids)

    const idsToDelete: string[] = []
    for (const id of ids) {
      if (existingIds.has(id)) {
        idsToDelete.push(id)
      } else {
        result.notFound.push(id)
      }
    }

    if (idsToDelete.length > 0) {
      try {
        await coll.delete({ ids: idsToDelete })
        result.deleted = idsToDelete
      } catch (error) {
        for (const id of idsToDelete) {
          try {
            await coll.delete({ ids: [id] })
            result.deleted.push(id)
          } catch (err) {
            result.errors.push({
              id,
              error: err instanceof Error ? err.message : String(err)
            })
          }
        }
      }
    }

    return result
  }

  async getMemory(
    collection: string,
    id: string
  ): Promise<MemoryResult | null> {
    const exists = await this.collectionExists(collection)
    if (!exists) return null

    const coll = await this.dohvatiKolekciju(collection)

    const results: any = await coll.get({ ids: [id] } as any)

    if (results.ids.length === 0) return null

    return {
      id: results.ids[0],
      content: results.documents[0] as string,
      metadata: results.metadatas[0] as Record<string, any>
    }
  }

  async getAllMemories(
    collection: string,
    where?: Record<string, any>
  ): Promise<MemoryResult[]> {
    const exists = await this.collectionExists(collection)
    if (!exists) return []

    const coll = await this.dohvatiKolekciju(collection)

    const results: any = await coll.get({ where } as any)

    const memories: MemoryResult[] = []
    for (let i = 0; i < results.ids.length; i++) {
      memories.push({
        id: results.ids[i],
        content: results.documents[i] as string,
        metadata: results.metadatas[i] as Record<string, any>
      })
    }

    return memories
  }

  async listCollections(): Promise<string[]> {
    const collections: any[] = await (this.client as any).listCollections()
    return imenaKolekcija(collections)
  }

  async countDocuments(collection: string): Promise<number> {
    const exists = await this.collectionExists(collection)
    if (!exists) return 0

    const coll = await this.dohvatiKolekciju(collection)
    return await coll.count()
  }

  async collectionExists(collection: string): Promise<boolean> {
    const collections = await this.listCollections()
    return collections.includes(sanitizeCollectionName(collection))
  }

  async ensureCollection(collection: string): Promise<void> {
    await this.getOrCreateCollection(collection)
  }

  async deleteCollection(collection: string): Promise<void> {
    const exists = await this.collectionExists(collection)
    if (exists) {
      await this.client.deleteCollection({
        name: sanitizeCollectionName(collection)
      } as any)
    }
  }

  async healthCheck(rokMs = 5000): Promise<HealthCheckResult> {
    try {
      let prekid: ReturnType<typeof setTimeout> | undefined
      const rok = new Promise<never>((_, odbij) => {
        prekid = setTimeout(() => odbij(new Error(`ChromaDB se nije javio u ${Math.round(rokMs / 1000)} s`)), rokMs)
      })
      try {
        await Promise.race([this.client.heartbeat(), rok])
      } finally {
        if (prekid) clearTimeout(prekid)
      }
      return { connected: true }
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async close(): Promise<void> {
    // ChromaDB klijent nema eksplicitni close
  }

  // ============================================================================
  // Pomoćne metode
  // ============================================================================

  private async getOrCreateCollection(name: string): Promise<Collection> {
    const sanitized = sanitizeCollectionName(name)
    return await this.client.getOrCreateCollection({ name: sanitized } as any)
  }

  private async dohvatiKolekciju(name: string): Promise<Collection> {
    return await this.client.getCollection({ name: sanitizeCollectionName(name) } as any)
  }

  /**
   * Dohvati sve dokumente s embeddings (za migraciju).
   * ChromaDB vraća embeddings samo s include parametrom.
   */
  async getAllWithEmbeddings(collection: string): Promise<Array<{
    id: string
    content: string
    embedding: number[]
    metadata: Record<string, any>
  }>> {
    const exists = await this.collectionExists(collection)
    if (!exists) return []

    const coll = await this.dohvatiKolekciju(collection)

    const results: any = await coll.get({
      include: ['documents', 'metadatas', 'embeddings']
    } as any)

    const docs: Array<{
      id: string
      content: string
      embedding: number[]
      metadata: Record<string, any>
    }> = []

    for (let i = 0; i < results.ids.length; i++) {
      docs.push({
        id: results.ids[i],
        content: results.documents[i] as string,
        embedding: results.embeddings?.[i] as number[] || [],
        metadata: results.metadatas[i] as Record<string, any>
      })
    }

    return docs
  }
}
