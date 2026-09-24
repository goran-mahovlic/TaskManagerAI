#!/usr/bin/env bun
/**
 * RAG Backend Service
 *
 * Upravljanje RAG backendima (ChromaDB / pgvector / dual) za ploču.
 * Status, prekidač backenda, usporedba kolekcija, migracija ChromaDB → pgvector.
 *
 * API krajnje točke (ožičuje ih `TaskWebUI.ts`):
 *   GET  /api/rag/backend/status     — getStatus()
 *   PUT  /api/rag/backend            — setBackend(backend)
 *   GET  /api/rag/backend/compare    — compareCollections()
 *   GET  /api/rag/backend/migration  — getMigrationStatus()
 *   POST /api/rag/backend/migrate    — startMigration(collection)
 *   GET  /api/rag/backend/config     — getConfig()           (bez lozinke)
 *   PUT  /api/rag/backend/config     — savePgVectorConfig({host, port, database, user})
 *   POST /api/rag/backend/test       — testPgVectorConnection({host, port, database, user, password?})
 *
 * PRAVILA (GAP F13):
 *   - domaćin/port/baza/korisnik samo iz konfiguracije ili okoline (`rag/rag-backend-config.ts`);
 *     prazna konfiguracija → `pgvector.configured: false` i NIJEDAN mrežni poziv;
 *   - lozinka samo iz `TM_PGVECTOR_PASSWORD` (okolina ili credentials.env) — nikad u JSON-u,
 *     nikad u odgovoru, nikad u dnevniku;
 *   - `pg` je opcijski: adapteri se učitavaju dinamički, a `pg` preko imena u varijabli,
 *     pa se ploča gradi i radi bez njega;
 *   - `/test` prolazi kroz iste `ProbeGuard` provjere adrese i prigušenje kao integracije.
 *     Spremljena lozinka se šalje SAMO na spremljeni poslužitelj — proba na drugu adresu
 *     mora donijeti vlastitu lozinku (inače bi `/test` bio način da se tajna pošalje van).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { osigurajMapu, stanjePutanja } from './core/paths'
import { prigusenje, provjeriUrl } from './core/ProbeGuard'
import type { BackendType } from './rag/adapters/rag-backend.interface'
import {
  ENV_LOZINKE,
  ispravanBackend,
  ispravanDomacin,
  ispravanIdentifikator,
  ispravanPort,
  pgLozinka,
  pgLozinkaPostavljena,
  spremiRagBackendKonfig,
  ucitajRagBackendKonfig,
  type RagBackendPostavke,
} from './rag/rag-backend-config'
import { resetBackends } from './rag/rag-backend-factory'

// ============================================================================
// Tipovi
// ============================================================================

export interface BackendStatus {
  currentBackend: BackendType
  chromadb: {
    configured: boolean
    connected: boolean
    host: string
    port: number
    collections: number
    documents: number
    error?: string
  }
  pgvector: {
    /** host, port, database i user su postavljeni. */
    configured: boolean
    /** Podešen + lozinka postavljena + paket `pg` instaliran. */
    available: boolean
    connected: boolean
    host: string
    port: number | null
    database: string
    user: string
    /** Samo da/ne — vrijednost lozinke se nikad ne vraća. */
    passwordSet: boolean
    driverInstalled: boolean
    collections: number
    documents: number
    version?: string
    error?: string
  }
}

export interface CollectionComparison {
  collection: string
  chromaCount: number
  pgvectorCount: number
  match: boolean
  difference: number
}

export interface MigrationStatus {
  inProgress: boolean
  collection?: string
  progress?: number
  startedAt?: string
  finishedAt?: string
  completedCollections: string[]
  totalMigrated: number
  totalFailed: number
  error?: string
}

/** Javni oblik konfiguracije — bez lozinke, samo `passwordSet`. */
export interface RAGBackendConfigView {
  backend: BackendType
  chromadb: { configured: boolean; host: string; port: number }
  pgvector: {
    configured: boolean
    host: string
    port: number | null
    database: string
    user: string
    passwordSet: boolean
    passwordEnv: string
  }
}

// ============================================================================
// Pomoćne funkcije
// ============================================================================

/** Stanje migracije je STANJE (ne konfiguracija) → `$TM_HOME/data/`. */
export function migrationStatusPath(): string {
  return process.env.TM_RAG_MIGRATION_STATUS || stanjePutanja('rag-migration-status.json')
}

const PRAZNA_MIGRACIJA = (): MigrationStatus => ({
  inProgress: false,
  completedCollections: [],
  totalMigrated: 0,
  totalFailed: 0,
})

function loadMigrationStatus(): MigrationStatus {
  const put = migrationStatusPath()
  if (!existsSync(put)) return PRAZNA_MIGRACIJA()
  try {
    return { ...PRAZNA_MIGRACIJA(), ...JSON.parse(readFileSync(put, 'utf-8')) }
  } catch {
    return PRAZNA_MIGRACIJA()
  }
}

function saveMigrationStatus(s: MigrationStatus): void {
  try {
    const put = osigurajMapu(migrationStatusPath())
    const tmp = `${put}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf-8')
    renameSync(tmp, put)
  } catch { /* stanje migracije nije vrijedno rušenja migracije */ }
}

function poruka(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300)
}

/** Ime kolekcije kakvo ChromaDB dopušta (i ništa što bi se moglo protumačiti kao putanja). */
const KOLEKCIJA_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

/** Koliko dokumenata ide u jednu transakciju pri migraciji. */
const MIGRACIJA_SERIJA = 100

async function chromaAdapter(p: RagBackendPostavke) {
  const { ChromaAdapter } = await import('./rag/adapters/chroma-adapter')
  return new ChromaAdapter({ host: p.chroma.host, port: p.chroma.port })
}

async function pgAdapter(p: RagBackendPostavke, lozinka: string) {
  const { PgVectorAdapter } = await import('./rag/adapters/pgvector-adapter')
  return new PgVectorAdapter({
    host: p.pgvector.host,
    port: p.pgvector.port as number,
    database: p.pgvector.database,
    user: p.pgvector.user,
    password: lozinka,
    ...(p.pgvector.maxConnections ? { maxConnections: p.pgvector.maxConnections } : {}),
    ...(p.pgvector.dimensions ? { dimensions: p.pgvector.dimensions } : {}),
  })
}

async function driverInstaliran(): Promise<boolean> {
  const { pgInstaliran } = await import('./rag/adapters/pgvector-adapter')
  return pgInstaliran()
}

// ============================================================================
// RAGBackendService
// ============================================================================

export class RAGBackendService {
  /** Migracija koja se vrti u OVOM procesu (datoteka stanja može ostati od prekinutog). */
  private migracijaTece = false

  /** Status svih backenda. S praznom konfiguracijom ne radi nijedan mrežni poziv. */
  async getStatus(): Promise<BackendStatus> {
    const p = ucitajRagBackendKonfig()
    const passwordSet = pgLozinkaPostavljena()
    const driverInstalled = await driverInstaliran()

    const status: BackendStatus = {
      currentBackend: p.backend,
      chromadb: {
        configured: p.chroma.configured,
        connected: false,
        host: p.chroma.host,
        port: p.chroma.port,
        collections: 0,
        documents: 0,
      },
      pgvector: {
        configured: p.pgvector.configured,
        available: p.pgvector.configured && passwordSet && driverInstalled,
        connected: false,
        host: p.pgvector.host,
        port: p.pgvector.port,
        database: p.pgvector.database,
        user: p.pgvector.user,
        passwordSet,
        driverInstalled,
        collections: 0,
        documents: 0,
      },
    }

    // ChromaDB
    if (!p.chroma.configured) {
      status.chromadb.error = 'ChromaDB nije podešen (TM_CHROMA_HOST)'
    } else {
      try {
        const chroma = await chromaAdapter(p)
        const health = await chroma.healthCheck()
        status.chromadb.connected = health.connected
        if (health.connected) {
          const collections = await chroma.listCollections()
          status.chromadb.collections = collections.length
          let totalDocs = 0
          for (const coll of collections.slice(0, 10)) { // prvih 10 za brzinu
            totalDocs += await chroma.countDocuments(coll)
          }
          if (collections.length > 10) { // procjena za ostale
            totalDocs += Math.round((totalDocs / 10) * (collections.length - 10))
          }
          status.chromadb.documents = totalDocs
        } else {
          status.chromadb.error = health.error
        }
      } catch (error) {
        status.chromadb.error = poruka(error)
      }
    }

    // pgvector
    if (!p.pgvector.configured) {
      status.pgvector.error = 'pgvector nije podešen (host, port, database, user)'
    } else if (!passwordSet) {
      status.pgvector.error = `${ENV_LOZINKE} nije postavljen (okolina ili credentials.env)`
    } else if (!driverInstalled) {
      const { PG_NIJE_INSTALIRAN } = await import('./rag/adapters/pgvector-adapter')
      status.pgvector.error = PG_NIJE_INSTALIRAN
    } else {
      const pgvector = await pgAdapter(p, pgLozinka() as string)
      try {
        const health = await pgvector.healthCheck()
        status.pgvector.connected = health.connected
        status.pgvector.version = health.version
        if (health.connected) {
          const stats = await pgvector.getStats()
          status.pgvector.collections = stats.length
          status.pgvector.documents = stats.reduce((sum, s) => sum + s.count, 0)
        } else {
          status.pgvector.error = health.error
        }
      } catch (error) {
        status.pgvector.error = poruka(error)
      } finally {
        await pgvector.close().catch(() => {})
      }
    }

    return status
  }

  /** Promijeni aktivni backend (pgvector/dual tek nakon uspješne probe konekcije). */
  async setBackend(newBackend: BackendType): Promise<{ success: boolean; error?: string }> {
    if (!ispravanBackend(newBackend)) {
      return { success: false, error: `Nepoznat backend: ${String(newBackend).slice(0, 40)}` }
    }

    if (newBackend !== 'chromadb') {
      const p = ucitajRagBackendKonfig()
      if (!p.pgvector.configured) {
        return { success: false, error: 'pgvector nije podešen — prvo spremi host, port, database i user' }
      }
      const lozinka = pgLozinka()
      if (!lozinka) {
        return { success: false, error: `${ENV_LOZINKE} nije postavljen (okolina ili credentials.env)` }
      }
      const pgvector = await pgAdapter(p, lozinka)
      try {
        const health = await pgvector.healthCheck()
        if (!health.connected) return { success: false, error: `pgvector nije dostupan: ${health.error}` }
      } catch (error) {
        return { success: false, error: `pgvector konekcija nije uspjela: ${poruka(error)}` }
      } finally {
        await pgvector.close().catch(() => {})
      }
    }

    const r = spremiRagBackendKonfig({ backend: newBackend })
    if (!r.ok) return { success: false, error: r.greska }
    await resetBackends()
    return { success: true }
  }

  /** Usporedi kolekcije između backenda (najveća razlika prva). */
  async compareCollections(): Promise<CollectionComparison[]> {
    const p = ucitajRagBackendKonfig()
    if (!p.chroma.configured) throw new Error('ChromaDB nije podešen (TM_CHROMA_HOST)')
    if (!p.pgvector.configured) throw new Error('pgvector nije podešen')
    const lozinka = pgLozinka()
    if (!lozinka) throw new Error(`${ENV_LOZINKE} nije postavljen`)

    const chroma = await chromaAdapter(p)
    const pgvector = await pgAdapter(p, lozinka)
    try {
      const chromaCollections = await chroma.listCollections()
      const pgStats = await pgvector.getStats()
      const pgCounts = new Map(pgStats.map(s => [s.collection, s.count]))
      const allCollections = new Set([...chromaCollections, ...pgCounts.keys()])

      const comparisons: CollectionComparison[] = []
      for (const coll of allCollections) {
        const chromaCount = chromaCollections.includes(coll) ? await chroma.countDocuments(coll) : 0
        const pgvectorCount = pgCounts.get(coll) ?? 0
        comparisons.push({
          collection: coll,
          chromaCount,
          pgvectorCount,
          match: chromaCount === pgvectorCount,
          difference: chromaCount - pgvectorCount,
        })
      }
      return comparisons.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
    } finally {
      await pgvector.close().catch(() => {})
    }
  }

  /** Status migracije. Zapis „u tijeku" bez žive migracije u procesu = prekinuta migracija. */
  getMigrationStatus(): MigrationStatus {
    const s = loadMigrationStatus()
    if (s.inProgress && !this.migracijaTece) {
      return { ...s, inProgress: false, error: s.error || 'migracija je prekinuta (ploča je ponovno pokrenuta) — pokreni je ponovno, već preneseni dokumenti se preskaču' }
    }
    return s
  }

  /**
   * Pokreni migraciju jedne kolekcije ChromaDB → pgvector. Vraća odmah; migracija teče
   * u pozadini ovog procesa, a napredak se čita kroz `getMigrationStatus()`.
   * Ugrađivanja se kopiraju kakva jesu (bez ponovnog računanja); ponovljeno pokretanje
   * preskače već prenesene dokumente (`ON CONFLICT DO NOTHING`).
   */
  async startMigration(collection: string): Promise<{ started: boolean; error?: string }> {
    const ime = String(collection || '').trim()
    if (!KOLEKCIJA_RE.test(ime)) return { started: false, error: 'neispravno ime kolekcije' }
    if (this.migracijaTece) {
      return { started: false, error: `Migracija već teče: ${loadMigrationStatus().collection || ''}` }
    }

    const p = ucitajRagBackendKonfig()
    if (!p.chroma.configured) return { started: false, error: 'ChromaDB nije podešen (TM_CHROMA_HOST)' }
    if (!p.pgvector.configured) return { started: false, error: 'pgvector nije podešen' }
    const lozinka = pgLozinka()
    if (!lozinka) return { started: false, error: `${ENV_LOZINKE} nije postavljen` }
    if (!(await driverInstaliran())) {
      const { PG_NIJE_INSTALIRAN } = await import('./rag/adapters/pgvector-adapter')
      return { started: false, error: PG_NIJE_INSTALIRAN }
    }

    const chroma = await chromaAdapter(p)
    const health = await chroma.healthCheck()
    if (!health.connected) return { started: false, error: `ChromaDB nije dostupan: ${health.error}` }

    const prije = loadMigrationStatus()
    const stanje: MigrationStatus = {
      inProgress: true,
      collection: ime,
      progress: 0,
      startedAt: new Date().toISOString(),
      completedCollections: (prije.completedCollections || []).filter(c => c !== ime),
      totalMigrated: 0,
      totalFailed: 0,
    }
    this.migracijaTece = true
    saveMigrationStatus(stanje)

    void this.migriraj(chroma, p, lozinka, ime, stanje)
    return { started: true }
  }

  private async migriraj(
    chroma: Awaited<ReturnType<typeof chromaAdapter>>,
    p: RagBackendPostavke,
    lozinka: string,
    ime: string,
    stanje: MigrationStatus,
  ): Promise<void> {
    let pgvector: Awaited<ReturnType<typeof pgAdapter>> | null = null
    try {
      pgvector = await pgAdapter(p, lozinka)
      const docs = await chroma.getAllWithEmbeddings(ime)
      for (let i = 0; i < docs.length; i += MIGRACIJA_SERIJA) {
        const serija = docs.slice(i, i + MIGRACIJA_SERIJA).map(d => ({
          id: d.id,
          collection: ime,
          content: d.content,
          embedding: d.embedding,
          metadata: d.metadata || {},
          migratedFrom: 'chromadb',
        }))
        try {
          stanje.totalMigrated += await pgvector.batchInsert(serija)
        } catch (e) {
          stanje.totalFailed += serija.length
          stanje.error = poruka(e)
        }
        stanje.progress = Math.round(((i + serija.length) / docs.length) * 100)
        saveMigrationStatus(stanje)
      }
      stanje.progress = 100
      if (stanje.totalFailed === 0) stanje.completedCollections = [...stanje.completedCollections, ime]
    } catch (e) {
      stanje.error = poruka(e)
    } finally {
      stanje.inProgress = false
      stanje.finishedAt = new Date().toISOString()
      saveMigrationStatus(stanje)
      this.migracijaTece = false
      if (pgvector) await pgvector.close().catch(() => {})
    }
  }

  /** Trenutna konfiguracija za prikaz — BEZ lozinke. */
  getConfig(): RAGBackendConfigView {
    const p = ucitajRagBackendKonfig()
    return {
      backend: p.backend,
      chromadb: { ...p.chroma },
      pgvector: {
        configured: p.pgvector.configured,
        host: p.pgvector.host,
        port: p.pgvector.port,
        database: p.pgvector.database,
        user: p.pgvector.user,
        passwordSet: pgLozinkaPostavljena(),
        passwordEnv: ENV_LOZINKE,
      },
    }
  }

  /** Spremi pgvector konfiguraciju (bez lozinke — ona ide u credentials.env). */
  async savePgVectorConfig(config: {
    host: string
    port: number
    database: string
    user: string
  }): Promise<{ success: boolean; error?: string }> {
    const r = spremiRagBackendKonfig({
      pgvector: {
        host: config?.host,
        port: config?.port === undefined ? undefined : Number(config.port),
        database: config?.database,
        user: config?.user,
      },
    })
    if (!r.ok) return { success: false, error: r.greska }
    await resetBackends()
    return { success: true }
  }

  /**
   * Proba pgvector konekcije s upisanim podatcima.
   * Bez `password`: koristi se spremljena lozinka, ALI samo ako su host/port/baza/korisnik
   * isti kao spremljeni — tajna se nikad ne šalje na adresu koju je netko tek upisao.
   */
  async testPgVectorConnection(config: {
    host: string
    port: number
    database: string
    user: string
    password?: string
  }): Promise<{ connected: boolean; version?: string; error?: string }> {
    const host = String(config?.host || '').trim()
    const port = Number(config?.port)
    const database = String(config?.database || '').trim()
    const user = String(config?.user || '').trim()

    if (!ispravanDomacin(host)) return { connected: false, error: 'neispravan domaćin (bez sheme, putanje i vjerodajnica)' }
    if (!ispravanPort(port)) return { connected: false, error: 'port mora biti cijeli broj 1–65535' }
    if (!ispravanIdentifikator(database)) return { connected: false, error: 'neispravno ime baze' }
    if (!ispravanIdentifikator(user)) return { connected: false, error: 'neispravno korisničko ime' }

    // Iste obrane kao „Probaj konekciju" kod integracija (ProbeGuard).
    // Instalacija izložena internetu postavlja `"dopustiPrivatneMreze": false` u rag-backend.json.
    const privatne = ucitajRagBackendKonfig().dopustiPrivatneMreze
    const adresa = provjeriUrl(`http://${host}:${port}/`, { dopustiHttp: true, dopustiPrivatneMreze: privatne })
    if (!adresa.ok) return { connected: false, error: adresa.greska }
    const prig = prigusenje('rag-pgvector')
    if (!prig.ok) return { connected: false, error: `pričekaj ${Math.ceil(prig.cekajMs / 1000)} s prije sljedeće probe` }

    let lozinka = typeof config?.password === 'string' && config.password ? config.password : ''
    if (!lozinka) {
      const s = ucitajRagBackendKonfig().pgvector
      const isti = s.configured && s.host === host && s.port === port && s.database === database && s.user === user
      if (!isti) {
        return { connected: false, error: 'upiši lozinku — spremljena se koristi samo za spremljeni poslužitelj' }
      }
      lozinka = pgLozinka() || ''
      if (!lozinka) return { connected: false, error: `${ENV_LOZINKE} nije postavljen (okolina ili credentials.env)` }
    }

    try {
      const { PgVectorAdapter, pgInstaliran, PG_NIJE_INSTALIRAN } = await import('./rag/adapters/pgvector-adapter')
      if (!(await pgInstaliran())) return { connected: false, error: PG_NIJE_INSTALIRAN }
      const adapter = new PgVectorAdapter({ host, port, database, user, password: lozinka, maxConnections: 1 })
      try {
        const health = await adapter.healthCheck()
        return health.connected
          ? { connected: true, version: health.version }
          : { connected: false, error: (health.error || 'konekcija nije uspjela').slice(0, 300) }
      } finally {
        await adapter.close().catch(() => {})
      }
    } catch (error) {
      return { connected: false, error: poruka(error) }
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let ragBackendServiceInstance: RAGBackendService | null = null

export function getRAGBackendService(): RAGBackendService {
  if (!ragBackendServiceInstance) {
    ragBackendServiceInstance = new RAGBackendService()
  }
  return ragBackendServiceInstance
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const service = getRAGBackendService()
  const args = process.argv.slice(2)

  switch (args[0]) {
    case 'status':
      console.log(JSON.stringify(await service.getStatus(), null, 2))
      break
    case 'config':
      console.log(JSON.stringify(service.getConfig(), null, 2))
      break
    case 'compare':
      console.log(JSON.stringify(await service.compareCollections(), null, 2))
      break
    case 'set': {
      const backend = args[1] as BackendType
      if (!backend) {
        console.error('Uporaba: bun src/RAGBackendService.ts set <chromadb|pgvector|dual>')
        process.exit(1)
      }
      const result = await service.setBackend(backend)
      console.log(result.success ? `Backend: ${backend}` : `Greška: ${result.error}`)
      break
    }
    default:
      console.log(`
RAG Backend Service

Uporaba:
  bun src/RAGBackendService.ts status           - status backenda
  bun src/RAGBackendService.ts config           - konfiguracija (bez lozinke)
  bun src/RAGBackendService.ts compare          - usporedba kolekcija
  bun src/RAGBackendService.ts set <backend>    - chromadb | pgvector | dual
`)
  }
}
