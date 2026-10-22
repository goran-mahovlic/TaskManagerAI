#!/usr/bin/env bun
/**
 * seed-appliance — prvi ingest Tier 0 memorije u Tier 1 (RAG), TASK-2620.
 *
 * Appliance/ISO se isporučuje s PUNIM Tier 0 (markdown) i PRAZNOM ChromaDB-om.
 * Kad korisnik u setupu uključi „Poveži RAG", ovo re-ingesta markdown IZVOR
 * aktualnim embed modelom (zadano `bge-m3`) — nikad se ne kopiraju gotovi vektori.
 *
 * KRITIČNO: vektori različitih modela nisu usporedivi i imaju različitu dimenziju
 * (bge-m3 = 1024, qwen3-embedding:8b = 4096). Promjena modela ⇒ PUNI re-ingest iz
 * izvora; zato seed uvijek očisti kolekciju prije punjenja i zapiše `rag.seededModel`.
 *
 * Izvori (Tier 0):
 *   <tier0.memoryDir>/*.md         (MEMORY.md indeks + memorije)
 *   <tier0.lessonsDir>/**\/*.md    (LESSONS)
 *   <projekt>/CLAUDE.md, GEMINI.md, START.md
 *
 * Uporaba:
 *   bun ~/.claude/regoc/seed-appliance.ts                 # seed u kolekciju iz configa
 *   bun ~/.claude/regoc/seed-appliance.ts --dry-run       # samo popis/chunkovi, bez mreže
 *   bun ~/.claude/regoc/seed-appliance.ts --force         # seedaj i kad je rag.enabled=false
 *   bun ~/.claude/regoc/seed-appliance.ts --limit 5       # smoke test na N chunkova
 *   bun ~/.claude/regoc/seed-appliance.ts --collection X --model bge-m3
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, basename, relative } from 'path'
import { loadMemoryConfig, saveMemoryConfig, type MemoryConfig } from '../skills/CORE/Tools/lib/memory-config'
import { storeMemory, clearCollection, healthCheck, getCollectionCount, type RAGConfig } from '../skills/CORE/Tools/lib/rag-memory'

const MAX_CHUNK = 1500      // znakova — bge-m3 kontekst 8k, ali manji chunk = precizniji dohvat
const MIN_CHUNK = 80        // ispod ovoga nema informacijske vrijednosti (prazne sekcije)

export interface Chunk { content: string; source: string; file: string; section: string; docType: string }

// ─── Prikupljanje izvora ──────────────────────────────────────────────────

function mdFilesIn(dir: string, recursive = false): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) { if (recursive) out.push(...mdFilesIn(p, true)); continue }
    if (name.toLowerCase().endsWith('.md')) out.push(p)
  }
  return out.sort()
}

export function collectSources(cfg: MemoryConfig = loadMemoryConfig()): { path: string; docType: string }[] {
  const src: { path: string; docType: string }[] = []
  for (const p of mdFilesIn(cfg.tier0.memoryDir)) src.push({ path: p, docType: basename(p) === 'MEMORY.md' ? 'memory_index' : 'memory' })
  for (const p of mdFilesIn(cfg.tier0.lessonsDir, true)) src.push({ path: p, docType: 'lesson' })
  // Statične instrukcije uz memoriju (projekt = roditelj LESSONS direktorija)
  const projectRoot = join(cfg.tier0.lessonsDir, '..')
  for (const name of ['CLAUDE.md', 'GEMINI.md', 'START.md']) {
    const p = join(projectRoot, name)
    if (existsSync(p)) src.push({ path: p, docType: 'instructions' })
  }
  return src
}

// ─── Chunkanje po markdown sekcijama ──────────────────────────────────────

/** Razbij dokument na ## / ### sekcije, pa predugačke sekcije na komade ≤ MAX_CHUNK. */
export function chunkMarkdown(text: string, label: string): { content: string; section: string }[] {
  const lines = text.split('\n')
  const parts: { section: string; body: string[] }[] = [{ section: label, body: [] }]
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.+)$/)
    if (h) parts.push({ section: h[2].replace(/[`*]/g, '').trim(), body: [line] })
    else parts[parts.length - 1].body.push(line)
  }
  const out: { content: string; section: string }[] = []
  for (const p of parts) {
    const body = p.body.join('\n').trim()
    if (body.length < MIN_CHUNK) continue
    if (body.length <= MAX_CHUNK) { out.push({ content: body, section: p.section }); continue }
    // Predugačka sekcija → reži po odlomcima. Naslov sekcije ide u SVAKI komad
    // (bez njega nastavci gube kontekst i mjere se kao šum), a prekratki komadi otpadaju.
    const head = `## ${p.section}`
    const pieces: string[] = []
    let buf = ''
    for (const para of body.split(/\n\s*\n/)) {
      if (buf && (buf.length + para.length + 2) > MAX_CHUNK) { pieces.push(buf.trim()); buf = '' }
      buf += (buf ? '\n\n' : '') + para
      while (buf.length > MAX_CHUNK) { pieces.push(buf.slice(0, MAX_CHUNK)); buf = buf.slice(MAX_CHUNK) }
    }
    if (buf.trim()) pieces.push(buf.trim())
    for (const piece of pieces) {
      if (piece.length < MIN_CHUNK) continue
      const content = piece.startsWith(head) ? piece : `${head}\n\n${piece}`
      out.push({ content: content.slice(0, MAX_CHUNK + head.length + 2), section: p.section })
    }
  }
  return out
}

export function buildChunks(cfg: MemoryConfig = loadMemoryConfig()): Chunk[] {
  const chunks: Chunk[] = []
  for (const s of collectSources(cfg)) {
    let text = ''
    try { text = readFileSync(s.path, 'utf-8') } catch { continue }
    const file = basename(s.path)
    for (const c of chunkMarkdown(text, file.replace(/\.md$/, '')))
      chunks.push({ content: c.content, source: s.path, file, section: c.section, docType: s.docType })
  }
  return chunks
}

// ─── Seed ─────────────────────────────────────────────────────────────────

export interface SeedOptions { force?: boolean; dryRun?: boolean; limit?: number; collection?: string; model?: string; onProgress?: (done: number, total: number) => void }
export interface SeedResult { ok: boolean; collection: string; embedModel: string; files: number; chunks: number; stored: number; failed: number; error?: string; count?: number }

export async function seed(opts: SeedOptions = {}): Promise<SeedResult> {
  const cfg = loadMemoryConfig({ reload: true })
  const collection = opts.collection || cfg.rag.collection
  const embedModel = opts.model || cfg.rag.embedModel
  const files = collectSources(cfg).length
  let chunks = buildChunks(cfg)
  if (opts.limit && opts.limit > 0) chunks = chunks.slice(0, opts.limit)
  const base: SeedResult = { ok: false, collection, embedModel, files, chunks: chunks.length, stored: 0, failed: 0 }

  if (opts.dryRun) return { ...base, ok: true }
  if (!cfg.rag.enabled && !opts.force) return { ...base, error: 'Tier 1 (RAG) je isključen — uključi „Poveži RAG" ili pokreni s --force' }

  const ragCfg: RAGConfig = { chromaHost: cfg.rag.chromaHost, chromaPort: cfg.rag.chromaPort, ollamaHost: cfg.rag.ollamaHost, embedModel }

  const health = await healthCheck(ragCfg)
  if (!health.chromadb.connected) return { ...base, error: `ChromaDB nedostupan (${cfg.rag.chromaHost}:${cfg.rag.chromaPort}): ${health.chromadb.error || ''}` }
  if (!health.ollama.connected) return { ...base, error: `Ollama nedostupna (${cfg.rag.ollamaHost}): ${health.ollama.error || ''}` }
  if (!health.embedModel.available) return { ...base, error: `Embed model „${embedModel}" nije dostupan: ${health.embedModel.error || ''} — pokreni: ollama pull ${embedModel}` }

  // Puni re-ingest iz IZVORA (vektori starog modela su nekompatibilni — nikad se ne migriraju)
  if (cfg.rag.seededModel && cfg.rag.seededModel !== embedModel)
    console.log(`[seed] promjena embed modela ${cfg.rag.seededModel} → ${embedModel}: kolekcija se prazni i puni iz izvora`)
  await clearCollection(collection, ragCfg)

  let stored = 0, failed = 0
  for (const [i, c] of chunks.entries()) {
    try {
      await storeMemory({
        collectionName: collection,
        content: c.content,
        metadata: { source: relative(process.env.HOME || '/', c.source), file: c.file, section: c.section, type: c.docType, tier: 'tier0', embed_model: embedModel, seeded_by: 'seed-appliance' },
        documentId: `tier0_${c.file.replace(/[^a-zA-Z0-9]/g, '_')}_${i}`,
        config: ragCfg,
      })
      stored++
    } catch (e) {
      failed++
      console.error(`[seed] ✗ ${c.file} (${c.section}): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (opts.onProgress) opts.onProgress(i + 1, chunks.length)
    else if ((i + 1) % 25 === 0) console.log(`[seed] ${i + 1}/${chunks.length}…`)
  }

  const count = await getCollectionCount(collection, ragCfg).catch(() => undefined)
  // Zamrzni embed model po kolekciji — sljedeći put znamo je li potreban re-ingest
  if (stored > 0 && !opts.limit) saveMemoryConfig({ rag: { seededModel: embedModel, seededAt: new Date().toISOString(), collection } })
  return { ...base, ok: failed === 0 && stored > 0, stored, failed, count }
}

// ─── CLI ──────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const a = process.argv.slice(2)
  const val = (flag: string) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined }
  const opts: SeedOptions = {
    force: a.includes('--force'),
    dryRun: a.includes('--dry-run'),
    limit: val('--limit') ? Number(val('--limit')) : undefined,
    collection: val('--collection'),
    model: val('--model'),
  }
  const cfg = loadMemoryConfig()
  console.log(`[seed] izvor: ${cfg.tier0.memoryDir} + ${cfg.tier0.lessonsDir}`)
  console.log(`[seed] cilj: ${cfg.rag.chromaHost}:${cfg.rag.chromaPort} / ${opts.collection || cfg.rag.collection} · model ${opts.model || cfg.rag.embedModel}${opts.dryRun ? ' (dry-run)' : ''}`)
  const r = await seed(opts)
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.ok ? 0 : 1)
}
