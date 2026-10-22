// ─── ContextPacker ───────────────────────────────────────────────────
// P4a / TASK-2580 (PRJ-030). Za zadani zadatak vrati MALI kontekst-paket:
// ≤ N memory datoteka (iz MEMORY.md indeksa) + ≤ M RAG hitova.
// Cilj (nit vodilja): agent s malim kontekstom → jeftiniji/slabiji model dostaje,
// manje context-compactiona (dokazani okidač smrti podagenata).
//
// Kategorije = POSTOJEĆE sekcije MEMORY.md (## …) — ne dodajemo kolone.
// RAG je OPCIONALAN: ako ChromaDB nije dostupan, paket i dalje radi (samo memory).
//
// Uporaba (standalone):
//   import { packContext } from './ContextPacker'
//   const pack = await packContext({ title, tags, project }, { maxMemory: 5, maxRag: 3 })

import { existsSync, readFileSync } from 'fs'
import { loadMemoryConfig, memoryIndexPath } from '../skills/CORE/Tools/lib/memory-config'

// Tier 0 (uvijek ON, offline): putanja NIJE hardkodirana na razvojni project-slug —
// dolazi iz SSOT-a ~/.claude/regoc/memory-config.json / env (TASK-2620).
const MEMORY_MD = memoryIndexPath()

export interface TaskLike { title?: string; tags?: string[]; project?: string; description?: string }
export interface MemoryEntry { title: string; file: string; hook: string; category: string; score?: number }
export interface RagHit { collection: string; score: number; snippet: string; section?: string }
export interface ContextPack {
  task: string
  memory: MemoryEntry[]
  rag: RagHit[]
  ragAvailable: boolean
  approxTokens: number
}

// Mapiranje MEMORY.md sekcija → LifeOS-stil taksonomija (informativno)
function taxonomy(section: string): string {
  const s = section.toUpperCase()
  if (s.includes('PROJEKT') || s.includes('DRIBLER') || s.includes('FPGA') || s.includes('EMC')) return 'WORK'
  if (s.includes('FEEDBACK') || s.includes('PRAVILA') || s.includes('LEKC')) return 'LEARNING'
  if (s.includes('INFRA') || s.includes('PORTOVI') || s.includes('BAZE') || s.includes('OBSERV')) return 'STATE'
  if (s.includes('AGENT') || s.includes('INTEGRAC') || s.includes('TOOL') || s.includes('ALATI') || s.includes('JEZIK')) return 'KNOWLEDGE'
  return 'KNOWLEDGE'
}

// Parsiraj MEMORY.md: retci "- [Naslov](fajl.md) — hook", uz tekuću ## sekciju.
export function parseMemoryIndex(path = MEMORY_MD): MemoryEntry[] {
  if (!existsSync(path)) return []
  const out: MemoryEntry[] = []
  let section = 'ROOT'
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const sec = line.match(/^##\s+(.+)/)
    if (sec) { section = sec[1].replace(/[`*]/g, '').trim(); continue }
    const m = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:—|-|–)?\s*(.*)$/)
    if (m) out.push({ title: m[1].trim(), file: m[2].trim(), hook: (m[3] || '').replace(/\*\*/g, '').trim(), category: taxonomy(section) })
  }
  return out
}

function tokenize(s: string): string[] {
  return (s || '').toLowerCase().replace(/[^a-z0-9čćžšđ_\-\/]+/gi, ' ').split(/\s+/).filter(w => w.length > 2)
}

function scoreEntry(e: MemoryEntry, terms: string[]): number {
  const hay = tokenize(`${e.title} ${e.hook} ${e.file}`)
  const hs = new Set(hay)
  let score = 0
  for (const t of terms) {
    if (hs.has(t)) score += 2
    else if (hay.some(w => w.includes(t) || t.includes(w))) score += 1
  }
  return score
}

// Odaberi RAG kolekcije relevantne za zadatak (heuristika po ključnim riječima).
function pickCollections(terms: string[]): string[] {
  const map: Record<string, string[]> = {
    ulx5m_serdes: ['serdes', 'jtag', 'ulx5m', 'gatemate', 'pcie', 'prbs'],
    cubes: ['cubes', 'ch32', 'kockic'],
    emc: ['emc', 'emi', 'tinysa', 'chamber'],
    lifeos_research: ['lifeos', 'robusnost', 'model', 'agent', 'tier', 'routing', 'ollama'],
    integrations: ['telegram', 'nextcloud', 'email', 'gitlab', 'integrac'],
    intergalaktik_sportai: ['dribler', 'sportai', 'eu', 'prijava'],
    presa: ['presa', 'zatik'],
    igor: ['igor', 'senzor', 'pinout', 'bm20c'],
    // TASK-5159 R2: popis sustava (agenti, tijekovi, vještine, alati, prekidači).
    regoc_popis: ['tijek', 'workflow', 'vještin', 'vjestin', 'skill', 'prekidač', 'prekidac', 'katalog', 'identitet', 'regoč', 'regoc'],
  }
  const hit = new Set<string>()
  for (const [coll, kw] of Object.entries(map)) if (kw.some(k => terms.some(t => t.includes(k) || k.includes(t)))) hit.add(coll)
  if (hit.size === 0) hit.add('pai_learning_system')
  return [...hit].slice(0, 2)
}

export async function packContext(task: TaskLike, opts: { maxMemory?: number; maxRag?: number } = {}): Promise<ContextPack> {
  const maxMemory = opts.maxMemory ?? 5
  const maxRag = opts.maxRag ?? 3
  const text = `${task.title || ''} ${(task.tags || []).join(' ')} ${task.project || ''} ${task.description || ''}`
  const terms = [...new Set(tokenize(text))]

  const entries = parseMemoryIndex()
  const memory = entries.map(e => ({ ...e, score: scoreEntry(e, terms) }))
    .filter(e => (e.score || 0) > 0).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, maxMemory)

  let rag: RagHit[] = []
  let ragAvailable = false
  // Tier 1 je OPCIONALAN: kad je toggle „Poveži RAG" isključen, uopće ne diramo Chromu/Ollamu.
  if (!loadMemoryConfig().rag.enabled) {
    const approxTokens0 = Math.round(memory.reduce((s, e) => s + e.title.length + e.hook.length, 0) / 4)
    return { task: task.title || '(bez naslova)', memory, rag, ragAvailable, approxTokens: approxTokens0 }
  }
  try {
    const { queryMemory } = await import('../skills/CORE/Tools/lib/rag-memory')
    const query = task.title || text
    const per = Math.max(1, Math.ceil(maxRag / 1))
    for (const coll of pickCollections(terms)) {
      const res: any[] = await queryMemory({ collectionName: coll, query, nResults: per })
      for (const r of res) rag.push({ collection: coll, score: Math.round((r.score ?? r.distance ?? 0) * 1000) / 1000, snippet: String(r.content || '').slice(0, 200), section: r.metadata?.section })
      ragAvailable = true
    }
    rag = rag.sort((a, b) => b.score - a.score).slice(0, maxRag)
  } catch {
    ragAvailable = false
  }

  const approxTokens = Math.round((memory.reduce((s, e) => s + e.title.length + e.hook.length, 0) + rag.reduce((s, r) => s + r.snippet.length, 0)) / 4)
  return { task: task.title || '(bez naslova)', memory, rag, ragAvailable, approxTokens }
}
