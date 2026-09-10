/**
 * ResearchRagGate — istraživanje mora završiti u RAG-u (R2 / TASK-4309).
 *
 * KVAR KOJI OVO ZATVARA (Goran, 04.09.2026.): istraživanja žive SAMO u transkriptu.
 * Transkripti se čuvaju ~30 dana (v. `transkript-arhiv-t9`), pa svaki nalaz stariji od
 * mjesec dana nestaje. Mjereno isti dan: PRJ-041 — projekt s najvećim troškom (1613 USD)
 * — nema NIJEDAN dokument u RAG-u. Plaćeno istraživanje ispari, pa se isti posao naruči
 * ponovno.
 *
 * DVA DIJELA, JEDAN IZVOR ISTINE (ovaj modul):
 *   1) KORAK LANCA — korak 2 („Istraživanje", razrada §4 / TASK-4264) dobiva OBVEZAN
 *      izlaz: dokument u RAG-u s `project_id`, `tip=istrazivanje` i popisom izvora.
 *      Tekst je `RESEARCH_STEP_OUTPUT_SPEC`; `buildResearchStepBlock()` ga stavlja na
 *      kraj prompta istraživačkog zadatka (isti obrazac kao `buildAcceptanceChecklist`).
 *   2) VRATAR — zadatak s oznakom `istrazivanje` ne prolazi u `completed` bez ID-a
 *      dokumenta u `result_summary` (`evaluateResearchClosure`, ulaz: TaskWebUI PUT).
 *
 * ZAŠTO OBOJE: sam vratar bi kažnjavao agenta za pravilo koje mu nitko nije rekao (isti
 * kvar zbog kojeg je CompletionGuard morao čekati promptove s `REGOC-STATUS` retkom —
 * v. `config/completion-gate.json`, `_live_checklist` stavka 3). Sam korak lanca bez
 * vratara je preporuka, a preporuke se ne poštuju kad je zadatak pri kraju i skup.
 *
 * ZAŠTO SMIJE ODMAH BITI LIVE (za razliku od CompletionGuarda): sud NIJE heuristika nad
 * prozom. Provjerava se (a) postoji li oznaka `istrazivanje` na zadatku i (b) postoji li
 * u rezultatu doslovan ID dokumenta. Oba su determinističke provjere s uskim dosegom —
 * zadatak bez oznake nikad ne dodiruje. Rollback: `config/research-rag-gate.json`.
 *
 * OVISNOSTI: nikakve (čista logika + lijeno `require('fs')` za konfiguraciju, isti
 * obrazac kao `CompletionGuard.loadGateConfig`) — modul se može jedinično testirati bez
 * daemona, baze i mreže.
 */

import { konfigPutanja } from './paths'

// ─── Rječnik ─────────────────────────────────────────────────────────────────

/**
 * Oznake koje zadatak proglašavaju istraživačkim. `istraživanje` (s dijakritikom) i
 * engleski `research` su tu jer ploča već nosi obje inačice — isti razlog zbog kojeg
 * `TIP_ALIASES` u `lib/rag-metadata.ts` prima `research`/`istraživanje`.
 */
export const RESEARCH_TAGS = ['istrazivanje', 'istraživanje', 'research'] as const

/** Kolekcija u koju upis ide kad zadatak ne kaže drukčije (postoji u ChromaDB-u). */
export const DEFAULT_RESEARCH_COLLECTION = 'pai_learning_system'

/** Alat kojim se upis radi — jedini put koji prolazi vratara sheme R1 (TASK-4308). */
export const RAG_STORE_TOOL = '~/.claude/skills/CORE/Tools/rag-store.ts'

// ─── Prepoznavanje ID-a dokumenta ────────────────────────────────────────────

/**
 * Zadani oblik ID-a iz `lib/rag-memory.ts` (`doc_${Date.now()}_${rand}`). Traži se
 * doslovno jer je to ono što `rag-store.ts` ispiše i što agent zalijepi.
 */
export const RAG_DOC_ID_RE = /\bdoc_\d{10,}_[a-z0-9]{3,}\b/gi

/** Izlazni redak alata: `Stored document: <id>` — najjači dokaz jer ga piše alat, ne agent. */
export const RAG_STORED_LINE_RE = /^[^\S\n]*Stored document:[^\S\n]*([A-Za-z0-9._:\/-]{6,})[^\S\n]*$/gim

/**
 * Ručna deklaracija za upis s vlastitim `--id` (npr. `RAG: pai_learning_system/istr-4309`).
 * Skupina 1 = kolekcija (neobvezna), skupina 2 = ID.
 * Namjerno BEZ prijelaza u novi redak iza dvotočke i uz zahtjev da ID nosi znamenku ili
 * `_`/`-`: inače `…u RAG:\nStored document: doc_…` daje lažni ID „Stored".
 */
export const RAG_DECLARATION_RE =
  /\bRAG(?:[-\s]?(?:DOC|DOKUMENT|ZAPIS))?[^\S\n]*[:=][^\S\n]*(?:([a-z0-9_]{3,})[^\S\n]*\/[^\S\n]*)?((?=[A-Za-z0-9._:-]*[0-9_-])[A-Za-z0-9._:-]{6,})/gi

export interface RagDocRef {
  id: string
  collection?: string
  /** Kojim je obrascem nađen — ide u log da se lažni pozitiv može prepoznati. */
  via: 'stored_line' | 'doc_id' | 'declaration'
}

/** Riječi koje NISU ID nego naslov odsjeka — spriječavaju „RAG: nije upisano" da prođe. */
const NOT_AN_ID = new Set([
  'nije', 'nema', 'prazno', 'todo', 'kasnije', 'naknadno', 'nepoznato',
  'upisano', 'dokument', 'dokumenta', 'memorija', 'collection', 'kolekcija',
])

function pushRef(out: RagDocRef[], seen: Set<string>, ref: RagDocRef): void {
  const id = ref.id.trim().replace(/[.,;)]+$/, '')
  if (!id || id.length < 6) return
  if (NOT_AN_ID.has(id.toLowerCase())) return
  if (seen.has(id)) return
  seen.add(id)
  out.push({ ...ref, id })
}

/** Svi ID-evi RAG dokumenata navedeni u tekstu (bez ponavljanja, redoslijed nalaza). */
export function extractRagDocIds(text?: string | null): RagDocRef[] {
  const t = String(text || '')
  if (!t) return []
  const out: RagDocRef[] = []
  const seen = new Set<string>()

  for (const m of t.matchAll(RAG_STORED_LINE_RE)) pushRef(out, seen, { id: m[1], via: 'stored_line' })
  for (const m of t.matchAll(RAG_DOC_ID_RE)) pushRef(out, seen, { id: m[0], via: 'doc_id' })
  for (const m of t.matchAll(RAG_DECLARATION_RE)) {
    pushRef(out, seen, { id: m[2], collection: m[1] || undefined, via: 'declaration' })
  }
  return out
}

// ─── Je li zadatak istraživački ──────────────────────────────────────────────

/**
 * SAMO oznaka, nikad proza. Zahtjev glasi „zadatak s oznakom `istrazivanje`", a
 * pogađanje iz naslova bi vratara pustilo na svaki zadatak koji spominje istraživanje
 * (uključujući ovaj) — to je točno onaj fail-closed nad slobodnim tekstom zbog kojeg je
 * CompletionGuard morao ići kroz shadow.
 */
export function isResearchTask(tags?: string[] | null): boolean {
  if (!Array.isArray(tags)) return false
  const wanted = new Set<string>(RESEARCH_TAGS as readonly string[])
  return tags.some(t => wanted.has(String(t).trim().toLowerCase()))
}

// ─── Sud ─────────────────────────────────────────────────────────────────────

export type ResearchCode = 'not_research' | 'has_doc_id' | 'missing_doc_id'

export interface ResearchVerdict {
  /** Je li zadatak uopće u dosegu vratara. */
  research: boolean
  /** Smije li se zatvoriti. */
  accept: boolean
  code: ResearchCode
  docs: RagDocRef[]
  reason: string
}

export interface ResearchClosureInput {
  tags?: string[] | null
  resultSummary?: string | null
  /** Za poruku o pogrešci: točna naredba koju agent treba pokrenuti. */
  taskId?: string | null
  projectId?: string | null
}

/** Naredba koju agent mora pokrenuti — s popunjenim zadatkom i projektom kad su poznati. */
export function ragStoreCommand(taskId?: string | null, projectId?: string | null): string {
  return `bun ${RAG_STORE_TOOL} -c ${DEFAULT_RESEARCH_COLLECTION} ` +
    `-t "<sažetak istraživanja: nalaz, brojke, zaključak>" ` +
    `-p ${projectId || '<projectId sa zadatka>'} --type istrazivanje ` +
    `--task ${taskId || '<TASK-####>'} --source <izvor1> --source <izvor2>`
}

export function evaluateResearchClosure(input: ResearchClosureInput): ResearchVerdict {
  if (!isResearchTask(input.tags)) {
    return { research: false, accept: true, code: 'not_research', docs: [], reason: 'zadatak nema oznaku istraživanja' }
  }
  const docs = extractRagDocIds(input.resultSummary)
  if (docs.length > 0) {
    return {
      research: true, accept: true, code: 'has_doc_id', docs,
      reason: `RAG dokument naveden: ${docs.map(d => d.id).join(', ')}`,
    }
  }
  return {
    research: true, accept: false, code: 'missing_doc_id', docs: [],
    reason: 'istraživački zadatak nema ID dokumenta u result_summary — nalaz bi ostao samo u transkriptu (briše se za ~30 dana)',
  }
}

/** Poruka koju agent dobiva uz HTTP 400 — mora reći ŠTO pokrenuti, ne samo što fali. */
export function formatResearchHint(input: ResearchClosureInput): string {
  return 'Istraživanje mora završiti u RAG-u. Upiši nalaz i zalijepi ID dokumenta u result_summary:\n' +
    `  ${ragStoreCommand(input.taskId, input.projectId)}\n` +
    'Alat ispiše redak `Stored document: doc_...` — taj redak (ili `RAG: <kolekcija>/<id>`) ide u result_summary. ' +
    'Ako istraživanja stvarno nije bilo, makni oznaku `istrazivanje` ili zatvori zadatak kao blocked.'
}

/** Jednoredni zapis za log — isti oblik kao `CompletionGuard.formatVerdictLog`. */
export function formatResearchLog(taskId: string, v: ResearchVerdict): string {
  return v.accept
    ? `research-rag-gate: ACCEPT ${taskId} ${v.code}${v.docs.length ? ` docs=${v.docs.map(d => d.id).join(',')}` : ''}`
    : `research-rag-gate: REJECT ${taskId} ${v.code}`
}

// ─── Konfiguracija (hot-reload, isti obrazac kao CompletionGuard) ─────────────

export interface ResearchGateConfig {
  /** Vratar uopće sudi i loga. */
  enabled: boolean
  /** true = odbijanje se PROVODI (HTTP 400); false = SHADOW, samo log. */
  live: boolean
  /** Ide li obvezni korak 2 u prompt istraživačkog zadatka. */
  promptStep: boolean
}

export const DEFAULT_RESEARCH_GATE_CONFIG: ResearchGateConfig = {
  enabled: true,
  live: true,        // sud je deterministički i uzak (samo označeni zadaci) — v. zaglavlje
  promptStep: true,
}

const CONFIG_TTL_MS = 30_000
let _cfg: ResearchGateConfig | null = null
let _loadedAt = 0
let _loadedFrom = ''

function configPath(): string {
  return (
    process.env.REGOC_RESEARCH_GATE_CONFIG ||
    konfigPutanja('research-rag-gate.json')
  )
}

export function loadResearchGateConfig(force = false): ResearchGateConfig {
  const p = configPath()
  const now = Date.now()
  if (!force && _cfg && p === _loadedFrom && now - _loadedAt < CONFIG_TTL_MS) return _cfg
  const cfg = { ...DEFAULT_RESEARCH_GATE_CONFIG }
  try {
    const { readFileSync, existsSync } = require('fs') as typeof import('fs')
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      if (typeof raw?.enabled === 'boolean') cfg.enabled = raw.enabled
      if (typeof raw?.live === 'boolean') cfg.live = raw.live
      if (typeof raw?.promptStep === 'boolean') cfg.promptStep = raw.promptStep
    }
  } catch { /* neispravan JSON → defaulti; vratar nikad ne ruši poziv */ }
  _cfg = cfg
  _loadedAt = now
  _loadedFrom = p
  return cfg
}

/** Provodi li se sud stvarno (HTTP 400), ili ide samo u log. */
export function shouldEnforceResearch(
  v: ResearchVerdict,
  cfg: ResearchGateConfig = loadResearchGateConfig(),
): boolean {
  if (v.accept) return false
  if (!cfg.enabled) return false
  return cfg.live
}

// ─── Korak 2 lanca: obvezan izlaz (predložak iz TASK-4264) ───────────────────

/**
 * SSOT teksta koraka 2. Predložak koraka (TASK-4264) i prompt istraživačkog zadatka
 * čitaju OVO — pravilo koje živi u dvije prepisane kopije prestaje biti isto pravilo
 * (v. `regoc-pravila-sest-preslika` / ADR-0004).
 */
export const RESEARCH_STEP_OUTPUT_SPEC =
  `Korak 2 (Istraživanje) — OBVEZAN IZLAZ: dokument u RAG-u.\n` +
  `Sažetak s izvorima NIJE isporuka dok nije upisan; transkript se briše za ~30 dana.\n` +
  `Upis mora nositi: project_id (projekt zadatka), tip=istrazivanje, task_id i popis izvora ` +
  `(--source po izvoru: URL, putanja do datoteke ili ID zadatka).\n` +
  `Dokaz gotovosti: ID dokumenta u result_summary — bez njega vratar ne pušta zadatak u completed.`

/**
 * Blok koji se lijepi na kraj prompta istraživačkog zadatka. Prazan string za sve
 * ostale zadatke ⇒ prompt je bajt-identičan starome putu (isti ugovor kao
 * `buildAcceptanceChecklist` i `getRecipe`).
 */
export function buildResearchStepBlock(task?: {
  id?: string | null
  tags?: string[] | null
  projectId?: string | null
} | null): string {
  if (!task || !isResearchTask(task.tags)) return ''
  const cfg = loadResearchGateConfig()
  if (!cfg.enabled || !cfg.promptStep) return ''
  return `\n\n## KORAK 2 — ISTRAŽIVANJE ZAVRŠAVA U RAG-u (obvezno)\n` +
    `${RESEARCH_STEP_OUTPUT_SPEC}\n\n` +
    `Naredba:\n  ${ragStoreCommand(task.id, task.projectId)}\n\n` +
    `Zatim u result_summary zalijepi redak koji alat ispiše (\`Stored document: doc_...\`).\n`
}
