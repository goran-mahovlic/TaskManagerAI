#!/usr/bin/env bun
/**
 * RAG Backend Factory
 *
 * Stvara RAG backend adapter prema konfiguraciji (`rag-backend-config.ts`).
 * Podržava: chromadb, pgvector, dual (piše u oba, čita iz pgvectora).
 *
 * Adapteri se učitavaju DINAMIČKI: uvoz ove datoteke ne povlači ni `chromadb` ni `pg`,
 * pa je tvornica upotrebljiva (i `bun build` prolazi) i kad opcijske ovisnosti nisu
 * instalirane. Zato su funkcije koje vraćaju adapter asinkrone.
 */

import type { RagBackend, BackendType, RagBackendConfig } from './adapters/rag-backend.interface'
import type { ChromaAdapter } from './adapters/chroma-adapter'
import type { PgVectorAdapter } from './adapters/pgvector-adapter'
import type { DualAdapter } from './adapters/dual-adapter'
import { ENV_LOZINKE, pgLozinka, pgLozinkaPostavljena, ucitajRagBackendKonfig } from './rag-backend-config'

// ============================================================================
// Singleton instance
// ============================================================================

let chromaInstance: ChromaAdapter | null = null
let pgvectorInstance: PgVectorAdapter | null = null
let dualInstance: DualAdapter | null = null
let currentBackendType: BackendType | null = null

// ============================================================================
// Konfiguracija
// ============================================================================

/**
 * Konfiguracija backenda za stvaranje adaptera. `pgvector.password` je UVIJEK prazan —
 * lozinka se dodaje tek u `getPgVectorAdapter()`, pa ovaj objekt smije u dnevnik.
 * Baca ako traženi backend nije podešen (bolje jasna greška nego poziv na prazan domaćin).
 */
export function loadBackendConfig(): RagBackendConfig {
  const p = ucitajRagBackendKonfig()
  return {
    backend: p.backend,
    chroma: { host: p.chroma.host, port: p.chroma.port },
    pgvector: {
      host: p.pgvector.host,
      port: p.pgvector.port ?? 0,
      database: p.pgvector.database,
      user: p.pgvector.user,
      password: '',
      ...(p.pgvector.maxConnections ? { maxConnections: p.pgvector.maxConnections } : {}),
      ...(p.pgvector.dimensions ? { dimensions: p.pgvector.dimensions } : {}),
    },
  }
}

function trebaChroma(): void {
  if (!ucitajRagBackendKonfig().chroma.configured) {
    throw new Error('ChromaDB nije podešen — postavi TM_CHROMA_HOST (i TM_CHROMA_PORT)')
  }
}

function trebaPgvector(): string {
  if (!ucitajRagBackendKonfig().pgvector.configured) {
    throw new Error('pgvector nije podešen — host, port, database i user u rag-backend.json (ili TM_PGVECTOR_*)')
  }
  const lozinka = pgLozinka()
  if (!lozinka) throw new Error(`${ENV_LOZINKE} nije postavljen (okolina ili credentials.env)`)
  return lozinka
}

// ============================================================================
// Factory
// ============================================================================

/** ChromaDB adapter (singleton). */
export async function getChromaAdapter(config?: RagBackendConfig): Promise<ChromaAdapter> {
  if (!chromaInstance) {
    if (!config) trebaChroma()
    const cfg = config || loadBackendConfig()
    const { ChromaAdapter } = await import('./adapters/chroma-adapter')
    chromaInstance = new ChromaAdapter(cfg.chroma)
  }
  return chromaInstance
}

/** pgvector adapter (singleton). Lozinka iz `TM_PGVECTOR_PASSWORD` / credentials.env. */
export async function getPgVectorAdapter(config?: RagBackendConfig): Promise<PgVectorAdapter> {
  if (!pgvectorInstance) {
    const lozinka = trebaPgvector()
    const cfg = config || loadBackendConfig()
    const { PgVectorAdapter } = await import('./adapters/pgvector-adapter')
    pgvectorInstance = new PgVectorAdapter({ ...cfg.pgvector, password: lozinka })
  }
  return pgvectorInstance
}

/** Dual adapter (singleton). */
export async function getDualAdapter(config?: RagBackendConfig): Promise<DualAdapter> {
  if (!dualInstance) {
    const pgvector = await getPgVectorAdapter(config)
    const chromadb = await getChromaAdapter(config)
    const { DualAdapter } = await import('./adapters/dual-adapter')
    dualInstance = new DualAdapter(pgvector, chromadb)
  }
  return dualInstance
}

/**
 * Backend prema konfiguraciji — glavni ulaz za korištenje RAG backenda.
 */
export async function getRagBackend(forceReload: boolean = false): Promise<RagBackend> {
  const cfg = loadBackendConfig()

  // Ako se backend promijenio, resetiraj instance
  if (forceReload || currentBackendType !== cfg.backend) {
    await resetBackends()
    currentBackendType = cfg.backend
  }

  switch (cfg.backend) {
    case 'chromadb':
      return getChromaAdapter()
    case 'pgvector':
      return getPgVectorAdapter()
    case 'dual':
      return getDualAdapter()
    default:
      console.warn(`Nepoznat tip backenda: ${cfg.backend}, koristim chromadb`)
      return getChromaAdapter()
  }
}

/** Resetiraj sve singleton instance (npr. nakon promjene konfiguracije). */
export async function resetBackends(): Promise<void> {
  const closePromises: Promise<void>[] = []

  if (dualInstance) {
    // Dual zatvara oba svoja adaptera — ne zatvaraj ih dvaput.
    closePromises.push(dualInstance.close())
    dualInstance = null
    pgvectorInstance = null
    chromaInstance = null
  }
  if (pgvectorInstance) {
    closePromises.push(pgvectorInstance.close())
    pgvectorInstance = null
  }
  if (chromaInstance) {
    closePromises.push(chromaInstance.close())
    chromaInstance = null
  }

  currentBackendType = null
  await Promise.allSettled(closePromises)
}

/** Trenutni tip backenda iz konfiguracije. */
export function getCurrentBackendType(): BackendType {
  return loadBackendConfig().backend
}

/** Je li pgvector dostupan (podešen + lozinka + `pg` + konekcija). */
export async function isPgVectorAvailable(): Promise<boolean> {
  try {
    if (!ucitajRagBackendKonfig().pgvector.configured || !pgLozinkaPostavljena()) return false
    const adapter = await getPgVectorAdapter()
    const health = await adapter.healthCheck()
    return health.connected
  } catch {
    return false
  }
}

// ============================================================================
// CLI: provjera backenda
// ============================================================================

if (import.meta.main) {
  const command = process.argv[2]

  if (command === 'status') {
    const p = ucitajRagBackendKonfig()
    console.log('Backend konfiguracija (bez lozinke):')
    console.log(JSON.stringify({ ...p, lozinkaPostavljena: pgLozinkaPostavljena() }, null, 2))

    console.log('\nProvjera konekcija...')
    try {
      const chroma = await getChromaAdapter()
      const h = await chroma.healthCheck()
      console.log(`ChromaDB: ${h.connected ? 'OK' : 'NE'} ${h.error || ''}`)
    } catch (e) {
      console.log(`ChromaDB: NE ${e instanceof Error ? e.message : e}`)
    }
    try {
      const pgvector = await getPgVectorAdapter()
      const h = await pgvector.healthCheck()
      console.log(`pgvector: ${h.connected ? 'OK' : 'NE'} ${h.version || h.error || ''}`)
    } catch (e) {
      console.log(`pgvector: NE ${e instanceof Error ? e.message : e}`)
    }
    await resetBackends()
  } else {
    console.log('Uporaba:')
    console.log('  bun src/rag/rag-backend-factory.ts status  - provjeri konekcije')
  }
}
