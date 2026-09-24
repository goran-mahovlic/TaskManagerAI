#!/usr/bin/env bun
/**
 * Dual Backend Adapter
 *
 * Piše u OBA backenda (ChromaDB + pgvector), čita iz pgvectora.
 * Koristi se za prijelazno razdoblje dok se ne verificira pgvector.
 */

import type {
  RagBackend,
  MemoryResult,
  DeleteMemoryResult,
  HealthCheckResult
} from './rag-backend.interface'

export class DualAdapter implements RagBackend {
  readonly name = 'pgvector' as const  // Dual mode čita iz pgvectora
  private primary: RagBackend  // pgvector - za čitanje
  private secondary: RagBackend  // chromadb - backup za pisanje

  constructor(pgvector: RagBackend, chromadb: RagBackend) {
    this.primary = pgvector
    this.secondary = chromadb
  }

  async storeMemory(
    collection: string,
    id: string,
    content: string,
    embedding: number[],
    metadata: Record<string, any>
  ): Promise<string> {
    // Piši u OBA backenda paralelno
    const results = await Promise.allSettled([
      this.primary.storeMemory(collection, id, content, embedding, metadata),
      this.secondary.storeMemory(collection, id, content, embedding, metadata)
    ])

    // Provjeri greške
    const primaryResult = results[0]
    const secondaryResult = results[1]

    if (primaryResult.status === 'rejected') {
      console.error('[DualAdapter] pgvector write failed:', primaryResult.reason)
    }
    if (secondaryResult.status === 'rejected') {
      console.error('[DualAdapter] chromadb write failed:', secondaryResult.reason)
    }

    // Vrati ID ako je barem jedan uspio
    if (primaryResult.status === 'fulfilled') {
      return primaryResult.value
    }
    if (secondaryResult.status === 'fulfilled') {
      return secondaryResult.value
    }

    throw new Error('Both backends failed to store memory')
  }

  async queryMemory(
    collection: string,
    queryEmbedding: number[],
    n: number,
    where?: Record<string, any>
  ): Promise<MemoryResult[]> {
    // Čitaj SAMO iz primarnog (pgvector)
    try {
      return await this.primary.queryMemory(collection, queryEmbedding, n, where)
    } catch (error) {
      console.error('[DualAdapter] pgvector query failed, falling back to chromadb:', error)
      return await this.secondary.queryMemory(collection, queryEmbedding, n, where)
    }
  }

  async deleteMemory(
    collection: string,
    ids: string[]
  ): Promise<DeleteMemoryResult> {
    // Briši iz OBA backenda
    const results = await Promise.allSettled([
      this.primary.deleteMemory(collection, ids),
      this.secondary.deleteMemory(collection, ids)
    ])

    // Vrati rezultat iz primarnog
    if (results[0].status === 'fulfilled') {
      return results[0].value
    }
    if (results[1].status === 'fulfilled') {
      return results[1].value
    }

    throw new Error('Both backends failed to delete memory')
  }

  async getMemory(
    collection: string,
    id: string
  ): Promise<MemoryResult | null> {
    // Čitaj iz primarnog
    try {
      const result = await this.primary.getMemory(collection, id)
      if (result) return result
    } catch (error) {
      console.error('[DualAdapter] pgvector getMemory failed:', error)
    }

    // Fallback na sekundarni
    return await this.secondary.getMemory(collection, id)
  }

  async getAllMemories(
    collection: string,
    where?: Record<string, any>
  ): Promise<MemoryResult[]> {
    try {
      return await this.primary.getAllMemories(collection, where)
    } catch (error) {
      console.error('[DualAdapter] pgvector getAllMemories failed:', error)
      return await this.secondary.getAllMemories(collection, where)
    }
  }

  async listCollections(): Promise<string[]> {
    // Kombiniraj iz oba backenda (unique)
    const [primaryColls, secondaryColls] = await Promise.all([
      this.primary.listCollections().catch(() => [] as string[]),
      this.secondary.listCollections().catch(() => [] as string[])
    ])

    const allColls = new Set([...primaryColls, ...secondaryColls])
    return Array.from(allColls).sort()
  }

  async countDocuments(collection: string): Promise<number> {
    // Vrati broj iz primarnog
    try {
      return await this.primary.countDocuments(collection)
    } catch {
      return await this.secondary.countDocuments(collection)
    }
  }

  async collectionExists(collection: string): Promise<boolean> {
    // Postoji ako je u bilo kojem backendu
    const [primaryExists, secondaryExists] = await Promise.all([
      this.primary.collectionExists(collection).catch(() => false),
      this.secondary.collectionExists(collection).catch(() => false)
    ])

    return primaryExists || secondaryExists
  }

  async ensureCollection(collection: string): Promise<void> {
    await Promise.all([
      this.primary.ensureCollection(collection),
      this.secondary.ensureCollection(collection)
    ])
  }

  async deleteCollection(collection: string): Promise<void> {
    await Promise.all([
      this.primary.deleteCollection(collection),
      this.secondary.deleteCollection(collection)
    ])
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const [primaryHealth, secondaryHealth] = await Promise.all([
      this.primary.healthCheck(),
      this.secondary.healthCheck()
    ])

    return {
      connected: primaryHealth.connected && secondaryHealth.connected,
      version: `pgvector: ${primaryHealth.version || 'N/A'}, chromadb: ${secondaryHealth.connected ? 'OK' : 'FAIL'}`,
      error: primaryHealth.error || secondaryHealth.error
    }
  }

  async close(): Promise<void> {
    await Promise.all([
      this.primary.close(),
      this.secondary.close()
    ])
  }

  /**
   * Status sinkronizacije između backenda.
   */
  async getSyncStatus(): Promise<{
    pgvector: { collections: number; documents: number }
    chromadb: { collections: number; documents: number }
    inSync: boolean
  }> {
    const [pgColls, chromaColls] = await Promise.all([
      this.primary.listCollections().catch(() => []),
      this.secondary.listCollections().catch(() => [])
    ])

    let pgDocs = 0
    let chromaDocs = 0

    for (const coll of pgColls) {
      pgDocs += await this.primary.countDocuments(coll).catch(() => 0)
    }
    for (const coll of chromaColls) {
      chromaDocs += await this.secondary.countDocuments(coll).catch(() => 0)
    }

    return {
      pgvector: { collections: pgColls.length, documents: pgDocs },
      chromadb: { collections: chromaColls.length, documents: chromaDocs },
      inSync: pgColls.length === chromaColls.length && pgDocs === chromaDocs
    }
  }
}
