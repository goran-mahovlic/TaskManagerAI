/**
 * Vlastita RAG kolekcija agenta (I6 / TASK-3655).
 *
 * KVAR KOJI OVO ZATVARA: `REGOC_AGENTS.json` nosi mapu `rag_collections` (12 agenata →
 * `agent_regoc`, `agent_jelena` …), a kod ju NIJE čitao nijednom. `ragHints` su tvrdo
 * upisani po pravilu usmjeravanja i gotovo uvijek glase `pai_learning_system`; jedina
 * iznimka je `agent_emard`, doslovno upisan u `RegocDaemon.ts`. Agent tako nikad nije
 * dobio uputu ni da ČITA ni da UPISUJE u vlastitu memoriju, iako `spawn_template`
 * (`required_in_prompt`, stavka 5) traži „RAG memory instructions (before/after)".
 *
 * ZAŠTO PROVJERA POSTOJANJA — I SAMO ZA ČITANJE (R1c/TASK-4602): u ChromaDB-u postoje
 * SAMO 4 od 12 kolekcija (agent_manda, agent_jelena, agent_grga, agent_emard — 03.09.2026.).
 * Uputa da se ČITA iz nepostojeće kolekcije je prazan poziv, pa se ne isporučuje (isti
 * razlog zbog kojeg `IdentityBlock` ispušta nepostojeće putanje). Uputa da se UPISUJE je
 * suprotno: `storeMemory()` kolekciju STVARA (`getOrCreateCollection`), pa je upis jedini
 * način da kolekcija uopće nastane. Vezati upis uz postojanje značilo je kokoš-jaje —
 * 8 od 12 agenata nikad nije dobilo uputu, pa ju nikad nije ni stvorilo. Zato:
 *   `ownRagCollection`      → ČITANJE (gated postojanjem)
 *   `registryRagCollection` → UPIS    (bez uvjeta)
 *
 * ZAŠTO KEŠ, A NE POZIV PO SPAWNU: `buildAgentPrompt` i `buildIdentityBlock` su
 * SINKRONI (isti razlog kao `PromptProjectBlock` — v. Z3/TASK-3013), a Chroma je preko
 * mreže. Popis se zato drži u kešu (`data/chroma_collections.json`); sinkroni čitač
 * vraća zadnji poznati popis, a osvježavanje ide u pozadini (fire-and-forget) kad je
 * keš stariji od TTL-a. Kolekcije ne nestaju same, pa je i star keš točniji od praznog.
 *
 * FAIL-SAFE: nema keša / neispravan keš / Chroma nedostupna → prazan skup → nijedna
 * kolekcija se ne dodaje → prompt je bajt-identičan starome putu.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { ragUkljucen } from '../skills/CORE/Tools/lib/rag-gate' // TASK-5273 (node-A → glavni TASK-5323)
import { chromaUrl as chromaIzPostavki } from './lib/okolina-sustava' // TASK-5700 (K3a)

const HOME = process.env.HOME || process.env.USERPROFILE || ''

/** Naslov odsjeka. Testovi, daemoni i QA provjera ga dijele — ne prepisuj ga rukom. */
export const RAG_MEMORY_HEADING = '## TVOJA RAG MEMORIJA (vlastita kolekcija)'

const DEFAULT_CACHE_FILE = join(HOME, '.claude', 'regoc', 'data', 'chroma_collections.json')
/** Popis kolekcija se mijenja rijetko — 6 h je dovoljno svježe, a mrežu dira minimalno. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 3000

export interface CollectionsCache {
  fetchedAt: string
  url: string
  collections: string[]
}

export interface AgentRegistryLike {
  agents?: Record<string, unknown>
  rag_collections?: Record<string, string>
}

/** URL Chrome. Prazno (test) = osvježavanje se ne pokreće. */
function chromaUrl(): string {
  const v = process.env.REGOC_CHROMA_URL
  return v === undefined ? chromaIzPostavki() : v
}

/** Putanja keša; `REGOC_CHROMA_CACHE` je override SAMO za testove/alat. */
function cacheFile(): string {
  return process.env.REGOC_CHROMA_CACHE || DEFAULT_CACHE_FILE
}

// ─── Dohvat i keš ────────────────────────────────────────────────────────────

/** Iz Chroma v2 odgovora vadi imena kolekcija. Nevaljan oblik → prazno, nikad iznimka. */
export function parseCollectionsPayload(payload: unknown): string[] {
  if (!Array.isArray(payload)) return []
  const imena: string[] = []
  for (const c of payload) {
    const n = (c as { name?: unknown })?.name
    if (typeof n === 'string' && n.length > 0) imena.push(n)
  }
  return imena
}

/** Atomski upis keša (tmp + rename) — sinkroni čitač nikad ne vidi polovičan JSON. */
export function writeCollectionsCache(collections: string[], url: string): void {
  const file = cacheFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const zapis: CollectionsCache = { fetchedAt: new Date().toISOString(), url, collections }
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(zapis, null, 2))
    renameSync(tmp, file)
  } catch { /* keš je pomoćni — neuspjeh upisa ne smije srušiti spawn */ }
}

function readCollectionsCache(): CollectionsCache | null {
  const file = cacheFile()
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    if (!parsed || !Array.isArray(parsed.collections)) return null
    return parsed as CollectionsCache
  } catch {
    return null
  }
}

/**
 * Dohvat popisa iz ChromaDB-a (v2 API; v1 vraća „The v1 API is deprecated").
 * `null` = nedostupno / neispravan odgovor — pozivatelj tada NE dira keš.
 */
export async function fetchChromaCollections(timeoutMs = FETCH_TIMEOUT_MS): Promise<string[] | null> {
  const base = chromaUrl()
  if (!base) return null
  const url = `${base}/api/v2/tenants/default_tenant/databases/default_database/collections`
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) return null
    const imena = parseCollectionsPayload(await resp.json())
    return imena.length > 0 ? imena : null
  } catch {
    return null
  }
}

/** Dohvat + upis keša. Vraća popis ili `null` ako Chroma nije odgovorila. */
export async function refreshCollectionsCache(timeoutMs = FETCH_TIMEOUT_MS): Promise<string[] | null> {
  if (!ragUkljucen()) return null // TASK-5273: čvor bez RAG-a ne dira ChromaDB
  const imena = await fetchChromaCollections(timeoutMs)
  if (!imena) return null
  writeCollectionsCache(imena, chromaUrl())
  return imena
}

let osvjezavanjeUTijeku = false

/** Pozadinsko osvježavanje — najviše jedno u trenutku, iznimke progutane. */
function kickBackgroundRefresh(): void {
  if (osvjezavanjeUTijeku || !chromaUrl()) return
  osvjezavanjeUTijeku = true
  void refreshCollectionsCache()
    .catch(() => null)
    .finally(() => { osvjezavanjeUTijeku = false })
}

/**
 * SINKRONO: zadnji poznati popis kolekcija iz ChromaDB-a.
 * Star keš se i dalje koristi (kolekcije ne nestaju same) uz okidanje osvježavanja.
 * Nema keša / neispravan keš → prazan skup (nijedna uputa se ne dodaje).
 */
export function knownCollections(): Set<string> {
  if (!ragUkljucen()) return new Set() // TASK-5273: bez RAG-a nema uputa za kolekcije
  const kes = readCollectionsCache()
  if (!kes) {
    kickBackgroundRefresh()
    return new Set()
  }
  const dob = Date.parse(kes.fetchedAt || '')
  if (!Number.isFinite(dob) || Date.now() - dob > CACHE_TTL_MS) kickBackgroundRefresh()
  return new Set(kes.collections)
}

// ─── Primjena na agenta ──────────────────────────────────────────────────────

/**
 * Vlastita kolekcija agenta iz `rag_collections`, ali SAMO ako stvarno postoji u Chromi.
 * `null` = agent nije u mapi ili kolekcija nije stvorena (8 od 12 na dan 03.09.2026.).
 */
export function ownRagCollection(
  agentId: string,
  registry: AgentRegistryLike | null | undefined,
  known: Set<string> = knownCollections()
): string | null {
  const naziv = registry?.rag_collections?.[agentId]
  if (!naziv || typeof naziv !== 'string') return null
  return known.has(naziv) ? naziv : null
}

/**
 * Naziv vlastite kolekcije iz registra, BEZ provjere postojanja u Chromi (R1c/TASK-4602).
 *
 * Razlika prema `ownRagCollection`: ta funkcija odgovara na pitanje „ima li se ŠTO ČITATI",
 * a ova na pitanje „kako se agentova kolekcija ZOVE". Za smjer UPISA je mjerodavna ova,
 * jer `storeMemory()` kolekciju stvara (`getOrCreateCollection`) — v. ADR-0005, dopuna R1c.
 */
export function registryRagCollection(
  agentId: string,
  registry: AgentRegistryLike | null | undefined
): string | null {
  const naziv = registry?.rag_collections?.[agentId]
  return typeof naziv === 'string' && naziv.length > 0 ? naziv : null
}

/** Dodaje vlastitu kolekciju na `ragHints`, bez dupliciranja (agent_emard je već upisan). */
export function withOwnCollection(ragHints: string[] | null | undefined, collection: string | null): string[] {
  const osnova = Array.isArray(ragHints) ? ragHints : []
  if (!collection || osnova.includes(collection)) return [...osnova]
  return [...osnova, collection]
}

/**
 * Odsjek prompta s OBA smjera memorije — čitanje PRIJE rada i upis POSLIJE rada.
 * `spawn_template.required_in_prompt[4]` = „RAG memory instructions (before/after)";
 * dosad se isporučivao samo smjer čitanja, i to iz tuđe (zajedničke) kolekcije.
 * Prazan niz ako kolekcije nema → prompt nepromijenjen.
 */
export interface OwnMemoryContext {
  /** Ključ projekta s ploče (REGOC_SYSTEM, PRJ-041) — ulazi u primjer kao `-p`. */
  projectId?: string | null
  /** Zadatak iz kojeg spawn nastaje — ulazi u primjer kao `--task`. */
  taskId?: string | null
  /**
   * Postoji li kolekcija VEĆ u Chromi (R1c/TASK-4602). Mijenja SAMO smjer čitanja:
   * `false` → prvo se uči upis (koji kolekciju stvara), a čitanje se najavljuje kao prazno.
   * Izostavljeno = `true` (zatečeno ponašanje; stari pozivi i testovi nepromijenjeni).
   */
  collectionExists?: boolean
}

/** Placeholderi kad daemon ne zna vrijednost — agent ih mora zamijeniti, ne prepisati. */
const PROJECT_PLACEHOLDER = '<ključ projekta s ploče, npr. REGOC_SYSTEM>'
const TASK_PLACEHOLDER = '<TASK-oznaka ovog zadatka>'

export function ownMemorySection(
  agentId: string,
  collection: string | null,
  ctx: OwnMemoryContext = {}
): string {
  if (!collection) return ''
  // R1b/TASK-4431: primjer je dosad učio STARI oblik (`-m '{"agent","type"}'`), koji od
  // R1 (TASK-4308) PADA na vrataru sheme — svaki agent bi prvi upis potrošio na grešku,
  // a onaj koji ga ne ponovi izgubio bi nalaz. Zato primjer nosi obvezne zastavice, i to
  // s KONKRETNIM vrijednostima kad ih daemon zna (inače placeholder, ne izmišljotina).
  const project = ctx.projectId?.trim() || PROJECT_PLACEHOLDER
  const task = ctx.taskId?.trim() || TASK_PLACEHOLDER
  // R1c/TASK-4602: kolekcija koje još nema NIJE razlog za šutnju — `storeMemory()` ju
  // stvara. Mijenja se samo redoslijed i ton: upis je ovdje jedini smjer koji ima učinka,
  // a čitanje se najavljuje kao prazno da agent ne protumači 0 pogodaka kao kvar.
  const postoji = ctx.collectionExists !== false
  const uvod = postoji
    ? `Ovo je TVOJA kolekcija (\`${collection}\`) — u njoj je ono što si ti prije naučio.

PRIJE rada (provjeri jesi li ovo već rješavao):
  bun ~/.claude/skills/CORE/Tools/rag-query.ts -c ${collection} -q "[tema zadatka]" -n 5`
    : `Ovo je TVOJA kolekcija (\`${collection}\`) — još je PRAZNA (nijedan tvoj nalaz nije u njoj).
Stvara ju TVOJ PRVI UPIS, ništa ne moraš pripremati unaprijed. Dok je prazna, čitanje
(\`rag-query.ts -c ${collection}\`) vraća 0 pogodaka — to je očekivano, nije kvar.`

  return `
${RAG_MEMORY_HEADING}
${uvod}

POSLIJE rada (OBAVEZNO — inače se nalaz gubi do sljedećeg spawna):
  bun ~/.claude/skills/CORE/Tools/rag-store.ts -c ${collection} \\
    -t "[što si naučio: uzrok, popravak, čime je dokazan]" \\
    -p ${project} --type lekcija --task ${task}

Zastavice \`-p\` (projekt), \`--type\` (istrazivanje|odluka|nalaz|spec|lekcija) i \`--task\`
su OBVEZNE — upis bez njih se odbija. Za \`--type istrazivanje\` dodaj i \`--source <url|datoteka>\`.

Upisuj SAMO ono što ti sljedeći put štedi vrijeme (uzrok kvara, zamka, mjerenje) —
ne prepričavaj zadatak i ne upisuj tajne (tokeni, lozinke, ključevi).
`
}

// ─── `regoc_popis` u RAG-FIRST (TASK-5159, dizajn TASK-5158 §7) ─────────────
//
// Kolekcija generiranog popisa sustava (agenti, tijekovi, vještine, alati, prekidači) odgovara
// na 19/19 pitanja o sustavu, `regoc_znanje` na 0/19 (TASK-5153) — ali je nijedan put do agenta
// nije imenovao. R5: sadržaj se NE kopira u `regoc_znanje` (dvije kopije se razilaze).

export const POPIS_KOLEKCIJA = 'regoc_popis'
/** Stanje sinkronizacije popisa u RAG (`tools/katalog/popis_obnova.py`). */
export const POPIS_RAG_STATE = join(HOME, '.claude', 'regoc', 'data', 'popis_rag.state.json')

/**
 * Je li kolekcija dostupna. Fail-safe kao vlastita kolekcija: bez dokaza nema retka.
 * Dva dokaza jer `regoc_popis` živi u aktivnom RAG backendu (pgvector), a keš kolekcija
 * (`knownCollections`) gleda samo ChromaDB — izmjereno 03.10.: 40 kolekcija, `regoc_popis` nije
 * među njima, a `rag-query.ts -c regoc_popis` vraća `popis:tijek:bug-fix` (88 %).
 */
export function popisDostupan(known: Set<string> = knownCollections(), statePath: string = POPIS_RAG_STATE): boolean {
  if (known.has(POPIS_KOLEKCIJA)) return true
  try {
    if (!existsSync(statePath)) return false
    const s = JSON.parse(readFileSync(statePath, 'utf-8'))
    return !!s && typeof s === 'object' && Object.keys(s).some(k => k.startsWith('popis:'))
  } catch { return false }
}

/** Pojmovi sustava (R2): agent, tijek/workflow, vještina/skill, alat, prekidač, katalog, identitet, REGOČ. */
export const SUSTAV_RE = /(^|[^\p{L}])(agent|tijek|workflow|vještin|vjestin|skill|alat|prekidač|prekidac|katalog|identitet|regoč|regoc)/iu

export function oSustavu(tekst: string | null | undefined): boolean {
  return SUSTAV_RE.test(String(tekst || ''))
}

/** R2: `regoc_popis` na prvo mjesto `ragHints` kad zadatak govori o sustavu i kolekcija je dostupna. */
export function withSystemCollection(ragHints: string[] | null | undefined, tekst: string | null | undefined, dostupan: boolean): string[] {
  const osnova = Array.isArray(ragHints) ? [...ragHints] : []
  if (!dostupan || !oSustavu(tekst) || osnova.includes(POPIS_KOLEKCIJA)) return osnova
  return [POPIS_KOLEKCIJA, ...osnova]
}

/** R1/R3: isti redci za blok identiteta agenta i za Telegram sesiju — jedan izvor. */
export function popisRedci(): string[] {
  return [
    '### Znanje o sustavu (RAG-FIRST)',
    `Za pitanja o agentima, tijekovima, vještinama, alatima i prekidačima PRVO: \`bun ~/.claude/skills/CORE/Tools/rag-query.ts -c ${POPIS_KOLEKCIJA} -q "<pitanje>" -n 5\` (prije \`pai_learning_system\`; popis se obnavlja svakih 10 min iz izvora istine).`,
  ]
}
