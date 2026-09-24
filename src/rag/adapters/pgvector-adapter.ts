#!/usr/bin/env bun
/**
 * pgvector Adapter
 *
 * Implementacija RagBackend sučelja za PostgreSQL + pgvector.
 *
 * OPCIJSKA OVISNOST: `pg` je u `optionalDependencies`. Modul se NE uvozi statički —
 * ime paketa je u varijabli, pa `bun build` ne pokušava razriješiti `pg`, a ploča se
 * gradi i radi i bez njega. Bez `pg` adapter se da stvoriti, a prvi upit vraća jasnu
 * grešku („paket pg nije instaliran — `bun add pg`").
 *
 * Shema tablice (stvara je `initialize()`):
 *   CREATE TABLE rag_documents (
 *     id TEXT PRIMARY KEY,
 *     collection TEXT NOT NULL,
 *     content TEXT,
 *     embedding vector(<dimensions>),
 *     metadata JSONB,
 *     stored_at TIMESTAMPTZ DEFAULT NOW(),
 *     migrated_from TEXT
 *   );
 *   CREATE INDEX idx_rag_collection ON rag_documents(collection);
 *
 * LOZINKA: drži se samo u privatnom polju za konekciju; `toJSON()` je izostavlja, pa
 * slučajni `JSON.stringify(adapter)` u dnevniku ne može procuriti tajnu.
 */

import type {
  RagBackend,
  MemoryResult,
  DeleteMemoryResult,
  HealthCheckResult,
  PgVectorConfig
} from './rag-backend.interface'

// ============================================================================
// Opcijsko učitavanje `pg`
// ============================================================================

/** Minimalni oblik `pg` API-ja koji adapter koristi (bez ovisnosti o @types/pg). */
interface PgQueryResult { rows: any[] }
interface PgClient {
  query(text: string, params?: any[]): Promise<PgQueryResult>
  release(): void
}
interface PgPool {
  query(text: string, params?: any[]): Promise<PgQueryResult>
  connect(): Promise<PgClient>
  end(): Promise<void>
}

/**
 * Ime modula je u VARIJABLI (ne literal) — namjerno: bundler ne slijedi `import(varijabla)`.
 * `postaviPgModulZaTest()` postoji samo da test dokaže ponašanje kad `pg` nije razrješiv.
 */
let pgModulIme = 'pg'

/** Samo za testove: podmetni ime modula koji ne postoji (ili vrati `'pg'`). */
export function postaviPgModulZaTest(ime: string): void {
  pgModulIme = ime
  pgModulCache = undefined
}

let pgModulCache: any | null | undefined

/** Učitaj `pg` ako je instaliran; inače `null`. Nikad ne baca. */
export async function ucitajPg(): Promise<any | null> {
  if (pgModulCache !== undefined) return pgModulCache
  try {
    const m: any = await import(pgModulIme)
    pgModulCache = m?.Pool ? m : (m?.default ?? null)
  } catch {
    pgModulCache = null
  }
  return pgModulCache
}

/** Je li `pg` dostupan u ovoj instalaciji. */
export async function pgInstaliran(): Promise<boolean> {
  return (await ucitajPg()) !== null
}

export const PG_NIJE_INSTALIRAN = 'paket "pg" nije instaliran — pokreni `bun add pg` (opcijska ovisnost za pgvector)'

// ============================================================================
// Konstante
// ============================================================================

const TABLE_NAME = 'rag_documents'
/** Zadana dimenzija: model ugrađivanja iz `env.example` (qwen3-embedding:8b = 4096). */
export const ZADANA_DIMENZIJA = 4096

/** Ključ metapodatka ide u SQL kao dio izraza `metadata->>'ključ'` — samo sigurni znakovi. */
const SIGURAN_KLJUC = /^[A-Za-z0-9_.-]{1,64}$/

function uvjetiMetapodataka(where: Record<string, any> | undefined, params: any[], od: number): string {
  let sql = ''
  let i = od
  if (where && Object.keys(where).length > 0) {
    for (const [key, value] of Object.entries(where)) {
      if (!SIGURAN_KLJUC.test(key)) throw new Error(`neispravan ključ metapodatka: ${JSON.stringify(key).slice(0, 70)}`)
      sql += ` AND metadata->>'${key}' = $${i}`
      params.push(String(value))
      i++
    }
  }
  return sql
}

// ============================================================================
// PgVectorAdapter
// ============================================================================

export class PgVectorAdapter implements RagBackend {
  readonly name = 'pgvector' as const
  private poolInstance: PgPool | null = null
  #config: PgVectorConfig
  private initialized: boolean = false
  private readonly dimensions: number

  constructor(config: PgVectorConfig) {
    this.#config = { ...config }
    const d = Number(config.dimensions)
    this.dimensions = Number.isInteger(d) && d > 0 && d <= 16000 ? d : ZADANA_DIMENZIJA
  }

  /** Bez lozinke — za dijagnostiku i slučajni `JSON.stringify`. */
  toJSON(): Record<string, unknown> {
    const { password: _lozinka, ...ostalo } = this.#config
    return { name: this.name, ...ostalo, dimensions: this.dimensions }
  }

  /** Pool se stvara lijeno, tek kad `pg` stvarno zatreba. */
  private async pool(): Promise<PgPool> {
    if (this.poolInstance) return this.poolInstance
    const pg = await ucitajPg()
    if (!pg) throw new Error(PG_NIJE_INSTALIRAN)
    const c = this.#config
    this.poolInstance = new pg.Pool({
      host: c.host,
      port: c.port,
      database: c.database,
      user: c.user,
      password: c.password,
      max: c.maxConnections || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: c.connectionTimeoutMs || 5000
    }) as PgPool
    // Greška na NEAKTIVNOJ konekciji (npr. poslužitelj restartan) inače je neuhvaćen
    // 'error' događaj i ruši cijeli proces ploče. Sljedeći upit ionako dobije svoju grešku.
    ;(this.poolInstance as any).on?.('error', () => { /* pool sam odbacuje pokvarenu konekciju */ })
    return this.poolInstance
  }

  /**
   * Osiguraj da tablica i indeksi postoje.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    const client = await (await this.pool()).connect()
    try {
      // Kreiraj pgvector ekstenziju
      await client.query('CREATE EXTENSION IF NOT EXISTS vector')

      // Kreiraj tablicu
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          id TEXT PRIMARY KEY,
          collection TEXT NOT NULL,
          content TEXT,
          embedding vector(${this.dimensions}),
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
      // Model od 4096 dimenzija zato ide bez vektorskog indeksa — sekvencijalni scan
      // (točna pretraga) radi za sve dimenzije i dovoljan je za tisuće dokumenata.
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

    await (await this.pool()).query(`
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
    const params: any[] = [collection, vectorStr, n]
    const whereClause = 'collection = $1' + uvjetiMetapodataka(where, params, 4)

    // Cosine distance upit (<=> operator)
    const result = await (await this.pool()).query(`
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

    return result.rows.map((row: any) => ({
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
    const existingResult = await (await this.pool()).query(`
      SELECT id FROM ${TABLE_NAME}
      WHERE collection = $1 AND id = ANY($2)
    `, [collection, ids])

    const existingIds = new Set(existingResult.rows.map((r: any) => r.id))

    for (const id of ids) {
      if (!existingIds.has(id)) {
        result.notFound.push(id)
      }
    }

    // Obriši postojeće
    const idsToDelete = ids.filter(id => existingIds.has(id))
    if (idsToDelete.length > 0) {
      try {
        await (await this.pool()).query(`
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

    const result = await (await this.pool()).query(`
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

    const params: any[] = [collection]
    const whereClause = 'collection = $1' + uvjetiMetapodataka(where, params, 2)

    const result = await (await this.pool()).query(`
      SELECT id, content, metadata
      FROM ${TABLE_NAME}
      WHERE ${whereClause}
      ORDER BY stored_at DESC
    `, params)

    return result.rows.map((row: any) => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata || {}
    }))
  }

  async listCollections(): Promise<string[]> {
    await this.initialize()

    const result = await (await this.pool()).query(`
      SELECT DISTINCT collection
      FROM ${TABLE_NAME}
      ORDER BY collection
    `)

    return result.rows.map((r: any) => r.collection)
  }

  async countDocuments(collection: string): Promise<number> {
    await this.initialize()

    const result = await (await this.pool()).query(`
      SELECT COUNT(*) as count
      FROM ${TABLE_NAME}
      WHERE collection = $1
    `, [collection])

    return parseInt(result.rows[0].count, 10)
  }

  async collectionExists(collection: string): Promise<boolean> {
    await this.initialize()

    const result = await (await this.pool()).query(`
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

    await (await this.pool()).query(`
      DELETE FROM ${TABLE_NAME}
      WHERE collection = $1
    `, [collection])
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await (await this.pool()).query('SELECT version()')
      const version = result.rows[0].version

      // Provjeri pgvector
      const extResult = await (await this.pool()).query(`
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
    const p = this.poolInstance
    this.poolInstance = null
    this.initialized = false
    if (p) await p.end()
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

    const client = await (await this.pool()).connect()
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

    const result = await (await this.pool()).query(`
      SELECT collection, COUNT(*) as count
      FROM ${TABLE_NAME}
      GROUP BY collection
      ORDER BY count DESC
    `)

    return result.rows.map((r: any) => ({
      collection: r.collection,
      count: parseInt(r.count, 10)
    }))
  }
}
