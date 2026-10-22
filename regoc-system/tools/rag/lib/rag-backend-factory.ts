#!/usr/bin/env bun
/**
 * RAG Backend Factory
 *
 * Factory za kreiranje RAG backend adaptera na temelju konfiguracije.
 * Podržava: chromadb, pgvector, dual
 *
 * TASK-4967: ChromaDB-pgvector dual backend
 */

import { existsSync } from 'fs'
import { procitajTajnuSpremista, putSpremistaTajni } from '../../../lib/spremiste-tajni'
import type { RagBackend, BackendType, RagBackendConfig } from './adapters/rag-backend.interface'
import { ChromaAdapter } from './adapters/chroma-adapter'
import { PgVectorAdapter } from './adapters/pgvector-adapter'
import { DualAdapter } from './adapters/dual-adapter'
import { loadMemoryConfig } from './memory-config'

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

const CREDENTIALS_PATH = putSpremistaTajni()

/**
 * Učitaj pgvector lozinku iz credentials.env
 */
function loadPgVectorPassword(): string {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Credentials file not found: ${CREDENTIALS_PATH}`)
  }

  // TASK-5705: zajednički čitač (i zapis ploče paketa `IME='…'`, ADR-0007 §5.2)
  const lozinka = procitajTajnuSpremista('PGVECTOR_PASSWORD', CREDENTIALS_PATH)
  if (!lozinka) {
    throw new Error('PGVECTOR_PASSWORD not found in credentials.env')
  }
  return lozinka
}

/**
 * Učitaj konfiguraciju backenda iz memory-config.json
 */
export function loadBackendConfig(): RagBackendConfig {
  const memCfg = loadMemoryConfig({ reload: true })

  // Zadani backend je chromadb
  const backend: BackendType = (memCfg.rag as any).backend || 'chromadb'

  // pgvector config - s defaultima
  const pgHost = (memCfg.rag as any).pgHost || '127.0.0.1'  // TASK-5700: memory-config uvijek daje pgHost
  const pgPort = (memCfg.rag as any).pgPort || 17791
  const pgDatabase = (memCfg.rag as any).pgDatabase || 'regoc_vectors'
  const pgUser = (memCfg.rag as any).pgUser || 'regoc'

  return {
    backend,
    chroma: {
      host: memCfg.rag.chromaHost,
      port: memCfg.rag.chromaPort
    },
    pgvector: {
      host: pgHost,
      port: pgPort,
      database: pgDatabase,
      user: pgUser,
      password: ''  // Učitat će se lazy iz credentials.env
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Dohvati ChromaDB adapter (singleton).
 */
export function getChromaAdapter(config?: RagBackendConfig): ChromaAdapter {
  if (!chromaInstance) {
    const cfg = config || loadBackendConfig()
    chromaInstance = new ChromaAdapter(cfg.chroma)
  }
  return chromaInstance
}

/**
 * Dohvati pgvector adapter (singleton).
 */
export function getPgVectorAdapter(config?: RagBackendConfig): PgVectorAdapter {
  if (!pgvectorInstance) {
    const cfg = config || loadBackendConfig()
    const password = loadPgVectorPassword()
    pgvectorInstance = new PgVectorAdapter({
      ...cfg.pgvector,
      password
    })
  }
  return pgvectorInstance
}

/**
 * Dohvati dual adapter (singleton).
 */
export function getDualAdapter(config?: RagBackendConfig): DualAdapter {
  if (!dualInstance) {
    const pgvector = getPgVectorAdapter(config)
    const chromadb = getChromaAdapter(config)
    dualInstance = new DualAdapter(pgvector, chromadb)
  }
  return dualInstance
}

/**
 * Dohvati backend na temelju konfiguracije.
 * Glavni entry point za korištenje RAG backenda.
 */
export function getRagBackend(forceReload: boolean = false): RagBackend {
  const cfg = loadBackendConfig()

  // Ako se backend promijenio, resetiraj instance
  if (forceReload || currentBackendType !== cfg.backend) {
    resetBackends()
    currentBackendType = cfg.backend
  }

  switch (cfg.backend) {
    case 'chromadb':
      return getChromaAdapter(cfg)
    case 'pgvector':
      return getPgVectorAdapter(cfg)
    case 'dual':
      return getDualAdapter(cfg)
    default:
      console.warn(`Unknown backend type: ${cfg.backend}, falling back to chromadb`)
      return getChromaAdapter(cfg)
  }
}

/**
 * Resetiraj sve singleton instance.
 * Koristi se kad se promijeni konfiguracija.
 */
export async function resetBackends(): Promise<void> {
  const closePromises: Promise<void>[] = []

  if (pgvectorInstance) {
    closePromises.push(pgvectorInstance.close())
    pgvectorInstance = null
  }
  if (chromaInstance) {
    closePromises.push(chromaInstance.close())
    chromaInstance = null
  }
  if (dualInstance) {
    closePromises.push(dualInstance.close())
    dualInstance = null
  }

  currentBackendType = null
  await Promise.all(closePromises)
}

/**
 * Dohvati trenutni tip backenda.
 */
export function getCurrentBackendType(): BackendType {
  const cfg = loadBackendConfig()
  return cfg.backend
}

/**
 * Provjeri je li pgvector dostupan (credentials + connection).
 */
export async function isPgVectorAvailable(): Promise<boolean> {
  try {
    // Provjeri credentials
    if (!procitajTajnuSpremista('PGVECTOR_PASSWORD', CREDENTIALS_PATH)) {
      return false
    }

    // Provjeri konekciju
    const adapter = getPgVectorAdapter()
    const health = await adapter.healthCheck()
    return health.connected
  } catch {
    return false
  }
}

// ============================================================================
// CLI: Test backenda
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'status':
      const cfg = loadBackendConfig()
      console.log('Backend konfiguracija:')
      console.log(JSON.stringify(cfg, (key, value) =>
        key === 'password' ? '***' : value, 2))

      console.log('\nTestiram konekcije...')

      const chroma = getChromaAdapter(cfg)
      const chromaHealth = await chroma.healthCheck()
      console.log(`ChromaDB: ${chromaHealth.connected ? '✅' : '❌'} ${chromaHealth.error || ''}`)

      try {
        const pgvector = getPgVectorAdapter(cfg)
        const pgHealth = await pgvector.healthCheck()
        console.log(`pgvector: ${pgHealth.connected ? '✅' : '❌'} ${pgHealth.version || pgHealth.error || ''}`)
      } catch (e) {
        console.log(`pgvector: ❌ ${e instanceof Error ? e.message : e}`)
      }
      break

    default:
      console.log('Uporaba:')
      console.log('  bun rag-backend-factory.ts status  - provjeri konekcije')
  }

  await resetBackends()
}
