#!/usr/bin/env bun
/**
 * Memory Config — SSOT za dvorazinsku memoriju (TASK-2620, RegocMobile 60_MEMORY_TIERS).
 *
 * Tier 0 (uvijek ON, offline): markdown memorija (MEMORY.md + memory/*.md + LESSONS/*.md).
 * Tier 1 (opcionalni toggle): ChromaDB + Ollama embeddings (RAG).
 *
 * Jedan izvor istine za oboje = memory-config.json (konfigPutanja, paths.ts).
 * Prioritet: process.env  >  memory-config.json  >  ugrađeni defaulti (127.0.0.1 + bge-m3).
 *
 * Čitaju ga: lib/rag-memory.ts (DEFAULT_CONFIG), ContextPacker.ts, WikilinkParser.ts,
 * seed-appliance.ts i GUI regoc-setup (:17790).
 *
 * Uporaba:
 *   import { loadMemoryConfig, saveMemoryConfig } from './memory-config'
 *   const cfg = loadMemoryConfig()
 *   if (cfg.rag.enabled) { … }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { konfigPutanja, PAKET_DIR, stanjePutanja } from '../core/paths'

// ============================================================================
// Tipovi
// ============================================================================

export interface Tier0Config {
  /** Claude Code project-slug (npr. "-srv-sustav" za /srv/sustav) */
  projectSlug: string
  /** Apsolutna putanja do memory/ direktorija (sadrži MEMORY.md + *.md) */
  memoryDir: string
  /** Apsolutna putanja do LESSONS/ direktorija */
  lessonsDir: string
}

export interface Tier1RagConfig {
  enabled: boolean
  chromaHost: string
  chromaPort: number
  /** Gdje lokalni `chroma run --path` drži podatke (koristi ga regoc-services.sh) */
  chromaDataDir: string
  ollamaHost: string
  embedModel: string
  /** Kolekcija u koju seed-appliance.ts ingesta Tier 0 markdown */
  collection: string
  /** Model kojim je kolekcija ZADNJI PUT seedana — vektori drugog modela NISU usporedivi */
  seededModel: string | null
  seededAt: string | null
}

export interface MemoryConfig {
  version: number
  /** Odakle je učitano (za dijagnostiku/GUI); null ako datoteka ne postoji */
  source: string | null
  tier0: Tier0Config
  rag: Tier1RagConfig
}

// ============================================================================
// Putanje i defaulti
// ============================================================================

const HOME = process.env.HOME || ''
/**
 * Projekt na kojem orkestrator radi — memorija živi u ~/.claude/projects/<slug>/memory.
 * Repozitorij sustava iz `TM_SUSTAV_DIR`, inače sam paket (TASK-5109: bez zadane mape
 * našeg repozitorija i bez slug-a naše razvojne mašine kao rezerve).
 */
const PROJECT_ROOT = (process.env.TM_SUSTAV_DIR || '').trim() || PAKET_DIR

export function configPath(): string {
  return process.env.REGOC_MEMORY_CONFIG || konfigPutanja('memory-config.json')
}

/** Claude Code slug: apsolutna putanja s '/', '_' i '.' zamijenjenim crticom. */
export function deriveProjectSlug(projectPath = PROJECT_ROOT): string {
  return projectPath.replace(/[/_.]/g, '-')
}

function memoryDirForSlug(slug: string): string {
  return join(HOME, '.claude', 'projects', slug, 'memory')
}

/** Slug izveden iz korijena projekta (v. PROJECT_ROOT). */
function defaultProjectSlug(): string {
  return deriveProjectSlug()
}

function bool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'da'].includes(s)) return true
  if (['0', 'false', 'no', 'off', 'ne'].includes(s)) return false
  return fallback
}

/** Ollama host uvijek kao URL (ollama klijent traži shemu). */
function normalizeOllamaHost(h: string): string {
  const s = (h || '').trim()
  if (!s) return 'http://127.0.0.1:11434'
  if (/^https?:\/\//.test(s)) return s
  return 'http://' + (s.includes(':') ? s : s + ':11434')
}

/** Chroma host bez sheme (ChromaClient prima host+port zasebno). */
function normalizeChromaHost(h: string): string {
  return (h || '').trim().replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/\/$/, '') || '127.0.0.1'
}

/** Ugrađeni defaulti — LOKALNI appliance (bez mreže prema .200/.4) + CPU-realan embed model. */
export function defaultMemoryConfig(): MemoryConfig {
  const slug = defaultProjectSlug()
  return {
    version: 1,
    source: null,
    tier0: {
      projectSlug: slug,
      memoryDir: memoryDirForSlug(slug),
      lessonsDir: join(PROJECT_ROOT, 'LESSONS'),
    },
    rag: {
      enabled: false,
      chromaHost: '127.0.0.1',
      chromaPort: 18765,
      chromaDataDir: stanjePutanja('chroma-data'),
      ollamaHost: 'http://127.0.0.1:11434',
      embedModel: 'bge-m3',
      collection: 'regoc_memory',
      seededModel: null,
      seededAt: null,
    },
  }
}

// ============================================================================
// Učitavanje (env > JSON > default), s cacheom
// ============================================================================

let cached: MemoryConfig | null = null

export function loadMemoryConfig(opts: { reload?: boolean } = {}): MemoryConfig {
  if (cached && !opts.reload) return cached

  const cfg = defaultMemoryConfig()
  const path = configPath()

  // 1) JSON (ako postoji)
  if (existsSync(path)) {
    try {
      const j = JSON.parse(readFileSync(path, 'utf-8')) as Partial<MemoryConfig>
      cfg.source = path
      if (j.version) cfg.version = j.version
      if (j.tier0) {
        const t = j.tier0
        if (t.projectSlug) { cfg.tier0.projectSlug = t.projectSlug; cfg.tier0.memoryDir = memoryDirForSlug(t.projectSlug) }
        if (t.memoryDir) cfg.tier0.memoryDir = t.memoryDir
        if (t.lessonsDir) cfg.tier0.lessonsDir = t.lessonsDir
      }
      if (j.rag) {
        const r = j.rag as Partial<Tier1RagConfig>
        if (r.enabled !== undefined) cfg.rag.enabled = !!r.enabled
        if (r.chromaHost) cfg.rag.chromaHost = normalizeChromaHost(r.chromaHost)
        if (r.chromaPort) cfg.rag.chromaPort = Number(r.chromaPort)
        if (r.chromaDataDir) cfg.rag.chromaDataDir = r.chromaDataDir
        if (r.ollamaHost) cfg.rag.ollamaHost = normalizeOllamaHost(r.ollamaHost)
        if (r.embedModel) cfg.rag.embedModel = r.embedModel
        if (r.collection) cfg.rag.collection = r.collection
        if (r.seededModel !== undefined) cfg.rag.seededModel = r.seededModel
        if (r.seededAt !== undefined) cfg.rag.seededAt = r.seededAt
      }
    } catch {
      // neispravan JSON → ostajemo na defaultima (Tier 0 nikad ne smije pasti zbog configa)
      cfg.source = null
    }
  }

  // 2) Env override (najviši prioritet — regoc-services.sh / systemd drop-in)
  const e = process.env
  if (e.REGOC_PROJECT_SLUG) { cfg.tier0.projectSlug = e.REGOC_PROJECT_SLUG; cfg.tier0.memoryDir = memoryDirForSlug(e.REGOC_PROJECT_SLUG) }
  if (e.REGOC_MEMORY_DIR) cfg.tier0.memoryDir = e.REGOC_MEMORY_DIR
  if (e.REGOC_LESSONS_DIR) cfg.tier0.lessonsDir = e.REGOC_LESSONS_DIR
  if (e.REGOC_RAG_ENABLED !== undefined) cfg.rag.enabled = bool(e.REGOC_RAG_ENABLED, cfg.rag.enabled)
  if (e.CHROMA_HOST) cfg.rag.chromaHost = normalizeChromaHost(e.CHROMA_HOST)
  if (e.CHROMA_PORT) cfg.rag.chromaPort = Number(e.CHROMA_PORT)
  if (e.CHROMA_DATA_DIR) cfg.rag.chromaDataDir = e.CHROMA_DATA_DIR
  if (e.OLLAMA_HOST) cfg.rag.ollamaHost = normalizeOllamaHost(e.OLLAMA_HOST)
  if (e.EMBED_MODEL) cfg.rag.embedModel = e.EMBED_MODEL
  if (e.REGOC_RAG_COLLECTION) cfg.rag.collection = e.REGOC_RAG_COLLECTION

  cached = cfg
  return cfg
}

/** MEMORY.md indeks (Tier 0). */
export function memoryIndexPath(cfg: MemoryConfig = loadMemoryConfig()): string {
  return join(cfg.tier0.memoryDir, 'MEMORY.md')
}

/** Je li Tier 1 uključen (env/JSON). Tier 0 je uvijek uključen. */
export function isRagEnabled(cfg: MemoryConfig = loadMemoryConfig()): boolean {
  return cfg.rag.enabled
}

/**
 * Upiši (djelomičan) config na disk i osvježi cache.
 * Piše SAMO trajna polja — env override ostaje stvar okoline, ne datoteke.
 */
export function saveMemoryConfig(patch: { tier0?: Partial<Tier0Config>; rag?: Partial<Tier1RagConfig> }): MemoryConfig {
  const path = configPath()
  let onDisk: any = {}
  if (existsSync(path)) { try { onDisk = JSON.parse(readFileSync(path, 'utf-8')) } catch { onDisk = {} } }
  const base = defaultMemoryConfig()
  const next = {
    version: onDisk.version || base.version,
    tier0: { ...base.tier0, ...(onDisk.tier0 || {}), ...(patch.tier0 || {}) },
    rag: { ...base.rag, ...(onDisk.rag || {}), ...(patch.rag || {}) },
    updated_at: new Date().toISOString(),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n')
  cached = null
  return loadMemoryConfig({ reload: true })
}

// CLI: `bun memory-config.ts` → ispiši razriješenu konfiguraciju (dijagnostika)
if (import.meta.main) {
  const cfg = loadMemoryConfig()
  console.log(JSON.stringify(cfg, null, 2))
}
