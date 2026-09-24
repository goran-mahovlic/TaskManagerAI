#!/usr/bin/env bun
/**
 * RAG Backend Interface
 *
 * Apstraktno sučelje za RAG memorijske backende.
 * Implementacije: ChromaAdapter, PgVectorAdapter, DualAdapter
 *
 * Ovo je ČISTO sučelje (samo tipovi) — uvoz ne povlači ni `chromadb` ni `pg`.
 * Konfiguracija se razrješava u `../rag-backend-config.ts` (datoteka + okolina);
 * lozinka NIKAD nije dio JSON-a, dodaje se tek pri stvaranju adaptera.
 */

// ============================================================================
// Tipovi rezultata
// ============================================================================

export interface MemoryResult {
  id: string
  content: string
  metadata: Record<string, any>
  distance?: number
  relevanceScore?: number
}

export interface DeleteMemoryResult {
  deleted: string[]
  notFound: string[]
  errors: Array<{ id: string; error: string }>
}

export interface CollectionStats {
  name: string
  count: number
  exists: boolean
}

export interface HealthCheckResult {
  connected: boolean
  version?: string
  error?: string
}

// ============================================================================
// Backend sučelje
// ============================================================================

export interface RagBackend {
  /** Naziv backenda (za logiranje) */
  readonly name: 'chromadb' | 'pgvector'

  /**
   * Spremi dokument s embeddings u kolekciju.
   * @returns ID dokumenta
   */
  storeMemory(
    collection: string,
    id: string,
    content: string,
    embedding: number[],
    metadata: Record<string, any>
  ): Promise<string>

  /**
   * Pretraži kolekciju po embedding vektoru.
   * @param queryEmbedding - vektor upita (iste dimenzije kao pohranjeni)
   * @param n - broj rezultata
   * @param where - opcionalni filter po metapodacima
   */
  queryMemory(
    collection: string,
    queryEmbedding: number[],
    n: number,
    where?: Record<string, any>
  ): Promise<MemoryResult[]>

  /**
   * Obriši dokumente iz kolekcije po ID-ovima.
   */
  deleteMemory(
    collection: string,
    ids: string[]
  ): Promise<DeleteMemoryResult>

  /**
   * Dohvati dokument po ID-u.
   */
  getMemory(
    collection: string,
    id: string
  ): Promise<MemoryResult | null>

  /**
   * Dohvati sve dokumente iz kolekcije.
   * @param where - opcionalni filter
   */
  getAllMemories(
    collection: string,
    where?: Record<string, any>
  ): Promise<MemoryResult[]>

  /**
   * Lista svih kolekcija.
   */
  listCollections(): Promise<string[]>

  /**
   * Broj dokumenata u kolekciji.
   */
  countDocuments(collection: string): Promise<number>

  /**
   * Provjeri postoji li kolekcija.
   */
  collectionExists(collection: string): Promise<boolean>

  /**
   * Kreiraj kolekciju ako ne postoji.
   */
  ensureCollection(collection: string): Promise<void>

  /**
   * Obriši cijelu kolekciju.
   */
  deleteCollection(collection: string): Promise<void>

  /**
   * Health check za backend.
   */
  healthCheck(): Promise<HealthCheckResult>

  /**
   * Zatvori konekcije (cleanup).
   */
  close(): Promise<void>
}

// ============================================================================
// Backend konfiguracija
// ============================================================================

export interface ChromaConfig {
  host: string
  port: number
}

export interface PgVectorConfig {
  host: string
  port: number
  database: string
  user: string
  /** Samo u memoriji, za konekciju. Nikad se ne zapisuje ni ne vraća kroz API. */
  password: string
  maxConnections?: number
  /** Dimenzija vektora u tablici (mora odgovarati modelu ugrađivanja). */
  dimensions?: number
  /** Rok spajanja u ms (zadano 5000). */
  connectionTimeoutMs?: number
}

export type BackendType = 'chromadb' | 'pgvector' | 'dual'

export interface RagBackendConfig {
  backend: BackendType
  chroma: ChromaConfig
  pgvector: PgVectorConfig
}
