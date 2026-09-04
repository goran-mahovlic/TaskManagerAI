#!/usr/bin/env bun
/**
 * RAG po projektu (R4, TASK-4311)
 *
 * Presjek znanja i troška: ploča zna koliko je koji projekt POTROŠIO, Chroma zna
 * koliko o njemu ZNA. Dok se to nije spajalo, PRJ-041 (1613 USD) je izgledao jednako
 * kao projekt s 200 dokumenata. Ovaj modul daje broj dokumenata po `project_id` i
 * `where` klauzulu za filtriranje kartice RAG.
 *
 * Čiste funkcije su odvojene od mrežnog dijela da se logika (posebno NULA za projekt
 * bez dokumenata) može testirati bez Chrome.
 *
 * Autor: Jelena Kovačević (Engineer)
 */

import {
  getChromaClient,
  listCollections,
  listDefaultSearchCollections,
  sanitizeCollectionName,
  type RAGConfig,
} from './rag/rag-memory'

// ============================================
// ČISTE FUNKCIJE
// ============================================

/** Ključ metapodatka pod kojim RAG nosi projekt (SSOT: lib/rag-metadata.ts). */
export const PROJECT_META_KEY = 'project_id'

/**
 * Chroma `where` za jedan projekt. Prazan/nedostajući projekt = bez filtra
 * (dohvat svega), a NE `{project_id: ""}` — to bi vratilo nulu dokumenata.
 */
export function buildProjectWhere(
  projectId?: string | null
): Record<string, unknown> | undefined {
  const id = (projectId ?? '').trim()
  if (!id) return undefined
  return { [PROJECT_META_KEY]: id }
}

/** Zbroji dokumente po `project_id`; dokumenti bez projekta se ne broje. */
export function tallyProjectIds(
  metadatas: Array<Record<string, unknown> | null | undefined>
): Record<string, number> {
  const tally: Record<string, number> = {}
  for (const m of metadatas || []) {
    const raw = m ? m[PROJECT_META_KEY] : undefined
    const pid = raw == null ? '' : String(raw).trim()
    if (!pid) continue
    tally[pid] = (tally[pid] || 0) + 1
  }
  return tally
}

/** Spoji zbrojeve dviju kolekcija u novi objekt (ulazi ostaju netaknuti). */
export function mergeTallies(
  a: Record<string, number>,
  b: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = { ...a }
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = (out[k] || 0) + v
  }
  return out
}

/**
 * Nadopuni zbroj NULAMA za projekte s ploče kojih u RAG-u nema.
 * To je cijela poanta zadatka: rupa u znanju mora biti VIDLJIVA, a ključ koji
 * nedostaje u odgovoru ploča ne može ispisati.
 */
export function projectCountsFor(
  projectIds: string[],
  tally: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id of projectIds || []) {
    if (!id) continue
    out[id] = tally?.[id] || 0
  }
  for (const [k, v] of Object.entries(tally || {})) {
    out[k] = v
  }
  return out
}

// ============================================
// MREŽNI DIO (Chroma)
// ============================================

export interface ProjectDocCounts {
  /** project_id → broj dokumenata (uključuje nule za projekte s ploče). */
  counts: Record<string, number>
  /** Ukupno dokumenata u pregledanim kolekcijama. */
  total: number
  /** Koliko ih uopće nosi `project_id` (ostatak je nepripisano znanje). */
  withProject: number
  /** Kolekcije koje su pregledane. */
  collections: string[]
  fetchedAt: string
  cached: boolean
}

/**
 * Jedan prolaz po kolekcijama uz `include: ['metadatas']` — bez dokumenata i
 * bez embeddinga, pa je jeftin (mjereno 04.09.2026.: 8910 dokumenata / 29 kolekcija
 * u ~1,3 s). Po projektu se NE pita zasebno: 66 projekata × 29 kolekcija bi bilo
 * 1914 upita umjesto 29.
 */
export async function countDocumentsByProject(options: {
  config: RAGConfig
  projectIds?: string[]
  /** true = i kolekcije izuzete iz zadane pretrage (pai_agent_*). */
  allCollections?: boolean
}): Promise<ProjectDocCounts> {
  const { config, projectIds = [], allCollections = true } = options

  const collections = allCollections
    ? await listCollections(config)
    : await listDefaultSearchCollections(config)

  const client = getChromaClient(config)
  let tally: Record<string, number> = {}
  let total = 0
  const seen: string[] = []

  for (const name of collections) {
    try {
      const collection = await client.getCollection({ name: sanitizeCollectionName(name) })
      const res: any = await collection.get({ include: ['metadatas'] })
      const metadatas = (res?.metadatas || []) as Array<Record<string, unknown> | null>
      total += Array.isArray(res?.ids) ? res.ids.length : metadatas.length
      tally = mergeTallies(tally, tallyProjectIds(metadatas))
      seen.push(name)
    } catch (error) {
      console.error(`[RAGProjectStats] kolekcija ${name}:`, error)
    }
  }

  const withProject = Object.values(tally).reduce((s, n) => s + n, 0)

  return {
    counts: projectCountsFor(projectIds, tally),
    total,
    withProject,
    collections: seen,
    fetchedAt: new Date().toISOString(),
    cached: false,
  }
}
