#!/usr/bin/env bun
/**
 * pgvector Adapter
 *
 * Implementacija RagBackend sučelja za PostgreSQL + pgvector.
 * Koristi 'pg' npm paket s connection poolingom.
 *
 * TASK-4967: ChromaDB-pgvector dual backend
 *
 * Shema tablice:
 *   CREATE TABLE rag_documents (
 *     id TEXT PRIMARY KEY,
 *     collection TEXT NOT NULL,
 *     content TEXT,
 *     embedding vector(4096),
 *     metadata JSONB,
 *     stored_at TIMESTAMPTZ DEFAULT NOW(),
 *     migrated_from TEXT
 *   );
 *   CREATE INDEX idx_collection ON rag_documents(collection);
 *   CREATE INDEX idx_embedding ON rag_documents
 *     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
 */

import { Pool, PoolClient } from 'pg'
import type {
  RagBackend,
  MemoryResult,
  DeleteMemoryResult,
  HealthCheckResult,
  PgVectorConfig
} from './rag-backend.interface'

// ============================================================================
// Konstante
// ============================================================================

const TABLE_NAME = 'rag_documents'
const EMBEDDING_DIMENSIONS = 4096  // qwen3-embedding:8b

// ============================================================================
// PgVectorAdapter
// ============================================================================

export class PgVectorAdapter implements RagBackend {
  readonly name = 'pgvector' as const
  private pool: Pool
  private config: PgVectorConfig
  private initialized: boolean = false

  constructor(config: PgVectorConfig) {
    this.config = config
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.maxConnections || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    })
  }

  /**
   * Osiguraj da tablica i indeksi postoje.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    const client = await this.pool.connect()
    try {
      // Kreiraj pgvector ekstenziju
      await client.query('CREATE EXTENSION IF NOT EXISTS vector')

      // Kreiraj tablicu
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          id TEXT PRIMARY KEY,
          collection TEXT NOT NULL,
          content TEXT,
          embedding vector(${EMBEDDING_DIMENSIONS}),
          metadata JSONB,
          stored_at TIMESTAMPTZ DEFAULT NOW(),
          migrated_from TEXT
        )
      `)

      // Kreiraj indekse
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_rag_collection
        ON ${TABLE_NAME}(collection)
      `)

      // NAPOMENA: pgvector ograničava IVFFlat i HNSW indekse na max 2000 dimenzija.
      // qwen3-embedding:8b koristi 4096D → vektorski indeks nije moguć.
      // Koristimo sekvencionalni scan (exact search) koji radi za sve dimenzije.
      // Za pilot migraciju ovo je prihvatljivo (brzina pretrage je OK za ~1000 dok.).
      // Ukloni stare indekse ako postoje (mogli su nastati greškom)
      await client.query(`DROP INDEX IF EXISTS idx_rag_embedding_ivfflat`)
      await client.query(`DROP INDEX IF EXISTS idx_rag_embedding_hnsw`)

      this.initialized = true
    } finally {
      client.release()
    }
  }

  async storeMemory(
    collection: string,
    id: string,
    content: string,
    embedding: number[],
    metadata: Record<string, any>
  ): Promise<string> {
    await this.initialize()

    const storedAt = new Date().toISOString()
    const fullMetadata = { ...metadata, stored_at: storedAt }

    // Formatiraj vektor za pgvector
    const vectorStr = `[${embedding.join(',')}]`

    await this.pool.query(`
      INSERT INTO ${TABLE_NAME} (id, collection, content, embedding, metadata, stored_at)
      VALUES ($1, $2, $3, $4::vector, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        collection = EXCLUDED.collection,
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        metadata = EXCLUDED.metadata,
        stored_at = EXCLUDED.stored_at
    `, [id, collection, content, vectorStr, JSON.stringify(fullMetadata), storedAt])

    return id
  }

  async queryMemory(
    collection: string,
    queryEmbedding: number[],
    n: number,
    where?: Record<string, any>
  ): Promise<MemoryResult[]> {
    await this.initialize()

    const vectorStr = `[${queryEmbedding.join(',')}]`

    // Gradi WHERE klauzulu
    let whereClause = 'collection = $1'
    const params: any[] = [collection, vectorStr, n]
    let paramIndex = 4

    if (where && Object.keys(where).length > 0) {
      for (const [key, value] of Object.entries(where)) {
        whereClause += ` AND metadata->>'${key}' = $${paramIndex}`
        params.push(String(value))
        paramIndex++
      }
    }

    // Cosine distance upit (<=> operator)
    const result = await this.pool.query(`
      SELECT
        id,
        content,
        metadata,
        embedding <=> $2::vector AS distance
      FROM ${TABLE_NAME}
      WHERE ${whereClause}
      ORDER BY embedding <=> $2::vector
      LIMIT $3
    `, params)

    return result.rows.map(row => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata || {},
      distance: row.distance,
      relevanceScore: this.calculateRelevanceScore(row.distance)
    }))
  }

  async deleteMemory(
    collection: string,
    ids: string[]
  ): Promise<DeleteMemoryResult> {
    await this.initialize()

    const result: DeleteMemoryResult = {
      deleted: [],
      notFound: [],
      errors: []
    }

    if (ids.length === 0) return result

    // Provjeri koji dokumenti postoje
    const existingResult = await this.pool.query(`
      SELECT id FROM ${TABLE_NAME}
      WHERE collection = $1 AND id = ANY($2)
    `, [collection, ids])

    const existingIds = new Set(existingResult.rows.map(r => r.id))

    for (const id of ids) {
      if (!existingIds.has(id)) {
        result.notFound.push(id)
      }
    }

    // Obriši postojeće
    const idsToDelete = ids.filter(id => existingIds.has(id))
    if (idsToDelete.length > 0) {
      try {
        await this.pool.query(`
          DELETE FROM ${TABLE_NAME}
          WHERE collection = $1 AND id = ANY($2)
        `, [collection, idsToDelete])
        result.deleted = idsToDelete
      } catch (error) {
        for (const id of idsToDelete) {
          result.errors.push({
            id,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }

    return result
  }

  async getMemory(
    collection: string,
    id: string
  ): Promise<MemoryResult | null> {
    await this.initialize()

    const result = await this.pool.query(`
      SELECT id, content, metadata
      FROM ${TABLE_NAME}
      WHERE collection = $1 AND id = $2
    `, [collection, id])

    if (result.rows.length === 0) return null

    const row = result.rows[0]
    return {
      id: row.id,
      content: row.content,
      metadata: row.metadata || {}
    }
  }

  async getAllMemories(
    collection: string,
    where?: Record<string, any>
  ): Promise<MemoryResult[]> {
    await this.initialize()

    let whereClause = 'collection = $1'
    const params: any[] = [collection]
    let paramIndex = 2

    if (where && Object.keys(where).length > 0) {
      for (const [key, value] of Object.entries(where)) {
        whereClause += ` AND metadata->>'${key}' = $${paramIndex}`
        params.push(String(value))
        paramIndex++
      }
    }

    const result = await this.pool.query(`
      SELECT id, content, metadata
      FROM ${TABLE_NAME}
      WHERE ${whereClause}
      ORDER BY stored_at DESC
    `, params)

    return result.rows.map(row => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata || {}
    }))
  }

  async listCollections(): Promise<string[]> {
    await this.initialize()

    const result = await this.pool.query(`
      SELECT DISTINCT collection
      FROM ${TABLE_NAME}
      ORDER BY collection
    `)

    return result.rows.map(r => r.collection)
  }

  async countDocuments(collection: string): Promise<number> {
    await this.initialize()

    const result = await this.pool.query(`
      SELECT COUNT(*) as count
      FROM ${TABLE_NAME}
      WHERE collection = $1
    `, [collection])

    return parseInt(result.rows[0].count, 10)
  }

  async collectionExists(collection: string): Promise<boolean> {
    await this.initialize()

    const result = await this.pool.query(`
      SELECT 1 FROM ${TABLE_NAME}
      WHERE collection = $1
      LIMIT 1
    `, [collection])

    return result.rows.length > 0
  }

  async ensureCollection(collection: string): Promise<void> {
    // U pgvector kolekcije su implicitne (samo column u tablici)
    await this.initialize()
  }

  async deleteCollection(collection: string): Promise<void> {
    await this.initialize()

    await this.pool.query(`
      DELETE FROM ${TABLE_NAME}
      WHERE collection = $1
    `, [collection])
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await this.pool.query('SELECT version()')
      const version = result.rows[0].version

      // Provjeri pgvector
      const extResult = await this.pool.query(`
        SELECT extversion FROM pg_extension WHERE extname = 'vector'
      `)

      const pgvectorVersion = extResult.rows[0]?.extversion || 'not installed'

      return {
        connected: true,
        version: `PostgreSQL: ${version.split(' ')[1]}, pgvector: ${pgvectorVersion}`
      }
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  // ============================================================================
  // Pomoćne metode
  // ============================================================================

  private calculateRelevanceScore(distance: number | undefined): number {
    if (distance === undefined) return 0.5
    // Cosine distance: 0 = identični, 2 = suprotni
    // Pretvaramo u sličnost: 1 - (distance / 2)
    return Math.max(0, 1 - (distance / 2))
  }

  /**
   * Batch insert za migraciju (efikasniji od pojedinačnih insertova).
   */
  async batchInsert(docs: Array<{
    id: string
    collection: string
    content: string
    embedding: number[]
    metadata: Record<string, any>
    migratedFrom?: string
  }>): Promise<number> {
    await this.initialize()

    if (docs.length === 0) return 0

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      let inserted = 0
      for (const doc of docs) {
        const vectorStr = `[${doc.embedding.join(',')}]`
        const storedAt = new Date().toISOString()

        await client.query(`
          INSERT INTO ${TABLE_NAME}
            (id, collection, content, embedding, metadata, stored_at, migrated_from)
          VALUES ($1, $2, $3, $4::vector, $5, $6, $7)
          ON CONFLICT (id) DO NOTHING
        `, [
          doc.id,
          doc.collection,
          doc.content,
          vectorStr,
          JSON.stringify({ ...doc.metadata, stored_at: storedAt }),
          storedAt,
          doc.migratedFrom || null
        ])
        inserted++
      }

      await client.query('COMMIT')
      return inserted
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Statistika po kolekcijama.
   */
  async getStats(): Promise<Array<{ collection: string; count: number }>> {
    await this.initialize()

    const result = await this.pool.query(`
      SELECT collection, COUNT(*) as count
      FROM ${TABLE_NAME}
      GROUP BY collection
      ORDER BY count DESC
    `)

    return result.rows.map(r => ({
      collection: r.collection,
      count: parseInt(r.count, 10)
    }))
  }
}
