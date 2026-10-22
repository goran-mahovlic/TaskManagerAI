/**
 * ReviewCheckpoint — kontrolne točke za ručni pregled (A5 / TASK-3004).
 *
 * ŠTO RJEŠAVA: dugotrajan autonoman rad danas ide do kraja ili do pada. Ne postoji
 * unaprijed dogovorena točka na kojoj se stane, Goran pogleda što je nastalo i kaže
 * „nastavi". Vrata autonomije (ADR-0001 §8) mjere POTROŠNJU — stanu na 70 % prozora i
 * nastave same čim se kvota obnovi. Ovdje se mjeri SADRŽAJ: staje se jer je gotov korak
 * koji čovjek mora vidjeti, i ne nastavlja se dok on ne potvrdi. Zato ovaj mehanizam
 * nadopunjuje pragove, a ne zamjenjuje ih: prag kaže „nemam više kvote", točka kaže
 * „ne smijem dalje bez tebe".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GDJE ŽIVI ČEKANJE (izmjereno 29.07.2026 nad data/regoc.db — ne pretpostavljeno)
 *
 * Zadatak koji čeka čovjeka NE SMIJE stajati ni u jednom od tri zatečena statusa:
 *
 *   `in_progress` — love ga TRI čistača (zombie-recovery 10 min, stale-watchdog 4 h,
 *     stale-reaper 24 h → blocked / 7 d → cancelled). Uz to je to broj koji Goran čita
 *     kao „koliko sada stvarno radi"; zadatak koji tjedan dana čeka pregled taj broj laže.
 *     Ovo je doslovno bojazan iz opisa zadatka („in_progress mjesecima kvari mjerenja").
 *
 *   `blocked` — GROBLJE, mjereno: 87 blokiranih, od toga 67 s PRAZNIM `blocked_reason`,
 *     medijan starosti 8,3 dana, njih 50 starije od tjedan dana, najstariji 37 dana.
 *     Zapis koji ondje završi nitko ne žanje. Uz to je opasno: `RegocScheduler.resolveBlocks`
 *     bezuvjetno vraća u `pending` svaki blocked zadatak s praznim `blockedBy`
 *     („No dependencies but still marked blocked - unblock") — takvih je danas 80. Taj
 *     raspoređivač trenutno NE VRTI NIJEDAN PROCES (provjereno `pgrep`), ali dan kad ga
 *     netko upali, kontrolna točka parkirana u `blocked` tiho bi se sama otvorila.
 *
 *   `cancelled` — terminalno, iz njega se posao ne vraća.
 *
 * ODLUKA: čekanje se NE zapisuje u status zadatka. Zadatak ostaje `pending` (jedini status
 * čije je značenje — „nije počelo" — za njega istinito) i jednostavno se ne pokreće, isto
 * kao odgoda u A3 vratima opsega. Samo čekanje je ZASEBAN ZAPIS s vlastitim vijekom u
 * `data/review_checkpoints.json`: tko je stao, zašto, otkad, tko je obaviješten i što je
 * odlučeno. Da je `pending` doista inertan, izmjereno je: TASK-2402 stoji u `pending`
 * od 19.06. (40 dana) i nijedan ga čistač nije dirnuo.
 *
 * ZAŠTO NE `blockedBy` (mehanizam ovisnosti koji već postoji): jer u praksi ne postoji.
 * Lanac A1–A7 (TASK-3000…3006), koji se u promptovima opisuje kao „sljedeći zadatak kreće
 * kad ovaj bude completed jer se blockedBy sam prazni", ima `blocked_by = []` u SVIH SEDAM
 * zadataka. Redoslijed je zapravo radio auto-exec (prioritet → starost). Graditi kontrolnu
 * točku na tom polju značilo bi graditi na kodu koji se ne izvršava.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KAKO SE OBAVJEŠĆUJE (izmjereno)
 *
 * Kroz postojeći put: red `messages` (to_agent='user') → R1 user-flush → Telegram. Taj je
 * put ŽIV i dokazan: `userFlush` i `userFlushLive` su `true`, u redu je 0 neisporučenih
 * poruka, 205 isporučenih, zadnja danas u 16:47.
 *
 * ALI: `userFlushBacklog` je `false`, što znači da poruka starija od 30 minuta NIKAD ne
 * ode. Ako je daemon ugašen u trenutku kad se točka otvori, jedna jedina obavijest bi tiho
 * istrunula i točka bi čekala zauvijek, nevidljiva. Zato se ovdje obavijest NE šalje
 * „jednom pa nadamo se": zapis pamti `notifiedAt`, pa se dok je isporuka izostala poruka
 * postavlja IZNOVA (svaki put svježa, dakle unutar prozora), a otvorena točka se ponavlja
 * podsjetnikom svakih `reminderHours`. Zaboravljena kontrolna točka je isti kvar kao
 * groblje blokiranih zadataka — samo s boljim namjerama.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KAKO SE NASTAVLJA BEZ GUBITKA KONTEKSTA
 *
 * Sesija se NE zamrzava. `claude --print` spawn je jednokratan proces — ne postoji način
 * da ga se uspava na tri dana i probudi s istim kontekstom. Zato je kontrolna točka UVIJEK
 * na granici između zadataka, nikad usred jednog: zadatak koji je stigao do točke se uredno
 * zatvori, a ono što slijedi je NOVI spawn. (Isti razlog kao u ADR-0001 §8.4: „stani na pola"
 * je najskuplji mogući ishod — potrošeno, a nedovršeno.)
 *
 * Kontekst se zato ne prenosi procesom nego ZAPISOM. U trenutku zaustavljanja sprema se
 * kratak brief: koji je zadatak okinuo točku, njegov `result_summary`, zadnje bilješke o
 * napretku, datoteke kojih se dotaknuo i popis onoga što čeka iza. Kad Goran odobri, taj se
 * brief zalijepi na kraj prompta prvog nastavljenog zadatka — isti obrazac kojim se već
 * prenosi projekt (`buildProjectTail`). Nastavak time počinje znajući što se dogodilo prije
 * njega i što je Goran rekao, a da se nijedna sesija nije morala držati živom.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SMJER OTKAZIVANJA: fail-OPEN, ali glasno. Pokvaren ili nečitljiv zapis stanja NE smije
 * zamrznuti sav autonoman rad — kućno je iskustvo da se brana koja zaustavi normalan rad
 * ukloni prvi dan (isto što se dogodilo naivnom E1 gateu u ModeClassifieru, 92 % krivo
 * skrenutog prometa). Umjesto toga: točke se tretiraju kao da ih nema, ali se diže alarm i
 * piše redak u dnevnik. Zapis se piše atomarno (tmp + rename), pa je taj slučaj kvar, ne
 * očekivano stanje.
 *
 * LICENCA: zamisao „stop_after" dolazi iz tuđeg projekta pod PolyForm Noncommercial. Ovdje
 * nije preuzet ni redak njihova koda ni njihove strukture podataka — ovo je vlastita izvedba
 * nad postojećim REGOČ pojmovima (oznake zadatka, `messages` red, zastavice, JSONL dnevnik).
 *
 * Autorica: Jelena (Engineer) · 2026-07-29 · TASK-3004 (A5)
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { parseTaskTime } from './AutonomyQueue'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
const REGOC_DIR = join(HOME, '.claude', 'regoc')
const DATA_DIR = join(REGOC_DIR, 'data')

/** Stanje: sve poznate kontrolne točke i njihove odluke. Čitaju ga daemon, alat i ploča. */
export const CHECKPOINT_STATE_PATH =
  process.env.REGOC_CHECKPOINT_STATE || join(DATA_DIR, 'review_checkpoints.json')

/** Dnevnik: svaki događaj (otvaranje, obavijest, odluka, zadržavanje) — trajan trag. */
export const CHECKPOINT_LOG_PATH =
  process.env.REGOC_CHECKPOINT_LOG || join(DATA_DIR, 'review_checkpoints.jsonl')

/** Podešavanje ponašanja; čita se pri svakoj odluci, pa izmjena djeluje bez restarta. */
export const CHECKPOINT_CONFIG_PATH =
  process.env.REGOC_CHECKPOINT_CONFIG || join(REGOC_DIR, 'config', 'review-checkpoints.json')

// ============================================
// Oznake — jezik kojim se točka izjavljuje i rješava
// ============================================

/** Oznaka na zadatku: „kad ja završim, stani i čekaj čovjeka". Nosi i opseg: `stop-after:tag:xy`. */
export const STOP_AFTER_TAG = 'stop-after'

/**
 * Odobrenje s ploče. Postoje DVA puta do odluke i to je namjerno:
 *   • alat  `bun ~/.claude/regoc/tools/checkpoint.ts approve <ID>` (naveden u samoj obavijesti),
 *   • oznaka na zadatku koji je okinuo točku — za slučaj kad je Goran pred pločom, a ne pred ljuskom.
 * Dolazni Telegram kanal namjerno NIJE korišten: zadnja poruka `from_agent='user'` u bazi je
 * od 13.07., taj put je u praksi mrtav, pa bi „odobri odgovorom" bilo obećanje bez pokrića.
 */
export const APPROVE_TAG = 'nastavi'
/** Odbijanje s ploče: „ne nastavljaj ovaj plan". Točka ostaje na snazi, ali bez podsjetnika. */
export const REJECT_TAG = 'ne-nastavljaj'

// ============================================
// Podešavanje
// ============================================

export interface CheckpointConfig {
  /** 'on' = točke djeluju; 'off' = potpuni no-op i kad je zastavica upaljena (brza kočnica). */
  policy: 'on' | 'off'
  /** Opseg za golu oznaku `stop-after` bez dvotočke. */
  defaultScope: 'project' | 'task'
  /** Zadatak s ovom oznakom prolazi i kroz otvorenu točku (npr. hitni popravak same brane). */
  excludeTags: string[]
  /** Koliko unatrag se traže zadatci koji su okinuli točku (sati). */
  triggerLookbackHours: number
  /** Razmak između podsjetnika na otvorenu točku (sati). */
  reminderHours: number
  /** Nakon koliko sati podsjetnik postaje glasan. Nikad ne odobrava sam. */
  escalateAfterHours: number
  /** Zaštita od poplave: iznad ovog broja otvorenih točaka diže se alarm o kvaru pravila. */
  maxOpenCheckpoints: number
}

export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  policy: 'on',
  defaultScope: 'project',
  excludeTags: ['no-checkpoint'],
  triggerLookbackHours: 24,
  reminderHours: 24,
  escalateAfterHours: 48,
  maxOpenCheckpoints: 10,
}

export function loadCheckpointConfig(path: string = CHECKPOINT_CONFIG_PATH): CheckpointConfig {
  const cfg = { ...DEFAULT_CHECKPOINT_CONFIG }
  try {
    if (!existsSync(path)) return cfg
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (raw?.policy === 'off' || raw?.policy === 'on') cfg.policy = raw.policy
    if (raw?.defaultScope === 'project' || raw?.defaultScope === 'task') cfg.defaultScope = raw.defaultScope
    if (Array.isArray(raw?.excludeTags)) cfg.excludeTags = raw.excludeTags.filter((t: any) => typeof t === 'string')
    for (const k of ['triggerLookbackHours', 'reminderHours', 'escalateAfterHours', 'maxOpenCheckpoints'] as const) {
      const v = Number(raw?.[k])
      if (Number.isFinite(v) && v >= 0) (cfg as any)[k] = v
    }
  } catch { /* pokvaren config → zadane vrijednosti, nikad pad */ }
  return cfg
}

// ============================================
// Izjava točke (čitanje iz zadatka)
// ============================================

export type ScopeKind = 'tag' | 'project' | 'task' | 'all' | 'none'

export interface CheckpointScope {
  kind: ScopeKind
  /** Vrijednost opsega: naziv oznake / id projekta / id zadatka. Za `all` i `none` je null. */
  value: string | null
}

export interface CheckpointDeclaration {
  taskId: string
  scope: CheckpointScope
  /** Doslovno kako je izjavljeno — ide u dnevnik da se odluka može provjeriti unatrag. */
  raw: string
}

export interface CheckpointTaskLike {
  id: string
  title?: string | null
  description?: string | null
  assignee?: string | null
  status?: string | null
  tags?: string[] | string | null
  projectId?: string | null
  project_id?: string | null
  resultSummary?: string | null
  result_summary?: string | null
  progressNotes?: string[] | string | null
  progress_notes?: string[] | string | null
  completedAt?: string | null
  completed_at?: string | null
  updatedAt?: string | null
  updated_at?: string | null
}

/** Oznake dolaze iz SQLite-a kao JSON tekst, a iz API-ja kao polje — oba oblika su legitimna. */
export function toTags(v: CheckpointTaskLike['tags']): string[] {
  if (Array.isArray(v)) return v.filter(t => typeof t === 'string')
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter((t: any) => typeof t === 'string') : [] } catch { return [] }
  }
  return []
}

function toNotes(v: CheckpointTaskLike['progressNotes']): string[] {
  if (Array.isArray(v)) return v.filter(t => typeof t === 'string')
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter((t: any) => typeof t === 'string') : [] } catch { return [] }
  }
  return []
}

const projectOf = (t: CheckpointTaskLike): string | null =>
  (t.projectId ?? t.project_id ?? null) || null

/**
 * Pročitaj izjavu kontrolne točke sa zadatka.
 *
 * Priznaju se dva zapisa, jer zadatke pišu i ljudi i agenti:
 *   • oznaka  `stop-after`  ili  `stop-after:<opseg>`
 *   • redak u opisu  `STOP-AFTER: <opseg>`   (velikim slovima, na početku retka)
 *
 * Opseg: `tag:<ime>` | `project:<id>` | `task:<id>` | `all` | golo ime (= oznaka).
 * Gola izjava bez opsega uzima `defaultScope` iz configa.
 *
 * VAŽNO: opseg `all` se prizna, ali je namjerno „skupa" izjava — zaustavlja SVE autonomne
 * spawnove, pa se u dnevniku i logu bilježi glasno. Nikad se ne izvodi sam od sebe.
 */
export function parseStopAfter(
  task: CheckpointTaskLike,
  cfg: CheckpointConfig = DEFAULT_CHECKPOINT_CONFIG,
): CheckpointDeclaration | null {
  const tags = toTags(task.tags)
  let raw: string | null = null

  // VELIČINA SLOVA: prepoznavanje same oznake je neosjetljivo, ali se VRIJEDNOST opsega
  // zadržava doslovno. Id-evi projekata i zadataka su osjetljivi na velika slova
  // (`REGOC_SYSTEM`, `TASK-3005`), pa bi spuštanje cijele oznake u mala slova napravilo
  // opseg koji ne odgovara nijednom zadatku — vrata koja tiho ne rade ništa.
  for (const t of tags) {
    const trimmed = t.trim()
    const low = trimmed.toLowerCase()
    if (low === STOP_AFTER_TAG) { raw = trimmed; break }
    if (low.startsWith(STOP_AFTER_TAG + ':')) { raw = trimmed; break }
  }

  if (raw === null) {
    // Marker u opisu traži se SAMO na početku retka i velikim slovima. Razlog je isti kao u
    // A6: opis nabraja što posao dodiruje, pa bi labava pretraga po cijelom tekstu proglasila
    // kontrolnom točkom svaku rečenicu koja o njoj govori — uključujući ovu.
    const m = String(task.description || '').match(/^[ \t]*STOP-AFTER:[ \t]*(.*)$/m)
    if (m) raw = `${STOP_AFTER_TAG}:${m[1].trim()}`.replace(/:$/, '')
  }

  if (raw === null) return null

  const spec = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1).trim() : ''
  return { taskId: String(task.id), scope: resolveScope(spec, task, cfg), raw }
}

function resolveScope(spec: string, task: CheckpointTaskLike, cfg: CheckpointConfig): CheckpointScope {
  const s = spec.trim()
  if (s === '' ) {
    // Gola izjava. Projekt je razuman zadani opseg — plan i živi unutar projekta. Kad projekta
    // nema, NE pogađa se: točka se otvara kao `none` (obavijest da, zadržavanje ne). Tiho
    // proširenje na „sve" bilo bi najgori mogući default, a tiho suženje na sam zadatak bi
    // bilo bezvrijedno — pa se traži da se opseg izjavi.
    if (cfg.defaultScope === 'project') {
      const p = projectOf(task)
      return p ? { kind: 'project', value: p } : { kind: 'none', value: null }
    }
    return { kind: 'task', value: String(task.id) }
  }
  if (s.toLowerCase() === 'all' || s.toLowerCase() === 'sve') return { kind: 'all', value: null }
  const m = s.match(/^(tag|project|projekt|task|zadatak)\s*:\s*(.+)$/i)
  if (m) {
    const p = m[1].toLowerCase()
    const kind = p === 'projekt' ? 'project' : p === 'zadatak' ? 'task' : p
    return { kind: kind as ScopeKind, value: m[2].trim() }
  }
  // Golo ime bez prefiksa = oznaka. To je najčešći slučaj u praksi (plan = skup zadataka
  // koji dijele oznaku, npr. `albert-ideja` za lanac A1–A7).
  return { kind: 'tag', value: s }
}

/** Odluka pročitana s ploče (oznaka na zadatku koji je okinuo točku). */
export function decisionFromTags(task: CheckpointTaskLike): 'approved' | 'rejected' | null {
  const tags = toTags(task.tags).map(t => t.trim().toLowerCase())
  if (tags.includes(REJECT_TAG)) return 'rejected'   // odbijanje ima prednost — strože je
  if (tags.includes(APPROVE_TAG)) return 'approved'
  return null
}

// ============================================
// Zapis točke
// ============================================

export interface ResumeBrief {
  /** Zadatak koji je okinuo točku. */
  taskId: string
  title: string
  agent: string | null
  /** Skraćeni `result_summary` — što je isporučeno. */
  delivered: string
  /** Zadnje bilješke o napretku (najviše 3). */
  notes: string[]
  /** Datoteke kojih se posao dotaknuo, ako ih je moguće izvesti iz teksta. */
  touchedFiles: string[]
  /** Što čeka iza točke — prvih nekoliko, da nastavak zna kamo ide. */
  nextUp: Array<{ id: string; title: string }>
}

export type CheckpointStatus = 'open' | 'approved' | 'rejected'

export interface CheckpointRecord {
  id: string
  status: CheckpointStatus
  taskId: string
  taskTitle: string
  agent: string | null
  scopeKind: ScopeKind
  scopeValue: string | null
  raw: string
  openedAt: string
  /** Kad je obavijest STVARNO ušla u red poruka. `null` = još nitko nije obaviješten. */
  notifiedAt: string | null
  /** Koliko je podsjetnika poslano (bez prve obavijesti). */
  reminders: number
  lastReminderAt: string | null
  decidedAt: string | null
  decidedBy: string | null
  note: string | null
  /** Zadnji viđeni popis zadržanih zadataka — za izvještaj i za brief. */
  heldIds: string[]
  brief: ResumeBrief
  /** Je li brief već predan nastavku (da se ne lijepi dvaput). */
  briefDeliveredTo: string[]
}

export interface CheckpointState {
  version: 1
  updatedAt: string
  checkpoints: CheckpointRecord[]
}

export const EMPTY_STATE: CheckpointState = { version: 1, updatedAt: '', checkpoints: [] }

/** Id je izveden iz zadatka koji točku okida — isti zadatak ne može otvoriti dvije točke. */
export function checkpointIdFor(taskId: string): string {
  return `CP-${String(taskId).replace(/[^A-Za-z0-9_-]/g, '')}`
}

// ============================================
// Brief za nastavak
// ============================================

const FILE_RE = /(?:^|[\s(«"'`])((?:~|\.{1,2})?\/?(?:[\w.@-]+\/){0,6}[\w.@-]+\.(?:ts|tsx|js|mjs|json|md|py|sh|sql|c|h|html|css|yml|yaml))/g

/** Izvuci putanje iz teksta. Služi samo za orijentaciju nastavka — nije dokaz opsega. */
export function extractFiles(text: string, limit = 8): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  const re = new RegExp(FILE_RE.source, 'g')
  while ((m = re.exec(text || '')) !== null) {
    const f = m[1].replace(/[),.;:]+$/, '')
    if (f.length > 3) out.add(f)
    if (out.size >= limit) break
  }
  return [...out]
}

export function buildResumeBrief(
  trigger: CheckpointTaskLike,
  held: CheckpointTaskLike[] = [],
): ResumeBrief {
  const delivered = String(trigger.resultSummary ?? trigger.result_summary ?? '').trim()
  const notes = toNotes(trigger.progressNotes ?? trigger.progress_notes).slice(-3)
  const haystack = `${delivered}\n${notes.join('\n')}\n${trigger.description || ''}`
  return {
    taskId: String(trigger.id),
    title: String(trigger.title || '').slice(0, 160),
    agent: trigger.assignee ? String(trigger.assignee) : null,
    delivered: delivered.slice(0, 1200),
    notes: notes.map(n => n.slice(0, 300)),
    touchedFiles: extractFiles(haystack),
    nextUp: held.slice(0, 5).map(t => ({ id: String(t.id), title: String(t.title || '').slice(0, 120) })),
  }
}

/**
 * Tekst koji se lijepi na kraj prompta prvog nastavljenog zadatka. Namjerno kratak: cilj je
 * da nastavak zna ŠTO je prethodilo i ŠTO je čovjek rekao, a ne da ponovno pročita cijeli
 * prethodni rad (to bi bio isti trošak kao da sesija nikad nije stala — mjereno u A6, 72 %
 * računa otpada na kontekst).
 */
export function formatResumeBrief(cp: CheckpointRecord): string {
  const b = cp.brief
  const lines: string[] = []
  lines.push('## NASTAVAK NAKON KONTROLNE TOČKE')
  lines.push(`Rad je bio zaustavljen na kontrolnoj točki ${cp.id} (otvorena ${cp.openedAt}).`)
  lines.push(`Okinuo ju je ${b.taskId} — „${b.title}"${b.agent ? ` (${b.agent})` : ''}.`)
  if (b.delivered) lines.push(`\nŠTO JE ISPORUČENO PRIJE TEBE:\n${b.delivered}`)
  if (b.notes.length) lines.push(`\nZADNJE BILJEŠKE:\n${b.notes.map(n => `- ${n}`).join('\n')}`)
  if (b.touchedFiles.length) lines.push(`\nDIRNUTE DATOTEKE: ${b.touchedFiles.join(', ')}`)
  if (cp.decidedBy || cp.note) {
    lines.push(`\nODLUKA ČOVJEKA (${cp.decidedBy || 'nepoznato'}, ${cp.decidedAt || '—'}): ${cp.note || 'odobreno bez napomene'}`)
  }
  if (b.nextUp.length) {
    lines.push(`\nŠTO JE ČEKALO IZA TOČKE: ${b.nextUp.map(n => `${n.id} (${n.title})`).join('; ')}`)
  }
  lines.push('\nNastavi odatle. Ako je odluka čovjeka u suprotnosti s planom zadatka, VRIJEDI ODLUKA ČOVJEKA.')
  return lines.join('\n')
}

// ============================================
// Otkrivanje okidača
// ============================================

export interface DetectOptions {
  now: number
  cfg: CheckpointConfig
  /** Zadatci koji bi bili zadržani — ulaze u brief kao „što čeka iza". */
  pending?: CheckpointTaskLike[]
}

export interface DetectResult {
  /** Nove točke koje treba otvoriti. */
  opened: CheckpointRecord[]
  /** Zadatci koji izjavljuju točku, ali su preskočeni (i zašto) — vidljivost, ne tišina. */
  skipped: Array<{ taskId: string; reason: string }>
}

/**
 * Nađi zadatke koji su OKINULI kontrolnu točku: izjavljuju `stop-after` i upravo su završili.
 *
 * Zašto se gleda dovršetak, a ne trenutak spawna: točka znači „stani NAKON ovoga", pa dok
 * zadatak radi nema se što zadržavati (posao je ionako u letu). Zašto pollanjem, a ne
 * kvačicom na izlazu spawna: zadatak zatvaraju TRI različita puta — agent sam preko API-ja,
 * daemon nakon izlaska spawna, i Goran s ploče. Kvačica na jednom putu propustila bi druga dva.
 */
export function detectTriggers(
  completed: CheckpointTaskLike[],
  state: CheckpointState,
  opts: DetectOptions,
): DetectResult {
  const { now, cfg } = opts
  const known = new Set(state.checkpoints.map(c => c.id))
  const opened: CheckpointRecord[] = []
  const skipped: Array<{ taskId: string; reason: string }> = []
  const lookbackMs = cfg.triggerLookbackHours * 3600_000

  for (const task of completed) {
    const decl = parseStopAfter(task, cfg)
    if (!decl) continue
    const id = checkpointIdFor(decl.taskId)
    if (known.has(id)) continue                        // već otvorena ili već odlučena

    const finishedAt = parseTaskTime(
      task.completedAt ?? task.completed_at ?? task.updatedAt ?? task.updated_at ?? null,
    )
    // Bez vremena dovršetka ne otvaramo točku: inače bi svaki restart daemona uskrsnuo
    // kontrolne točke iz povijesti. Isti kvar koji je AgentResume morao popraviti (TASK-2583).
    if (finishedAt === null) { skipped.push({ taskId: decl.taskId, reason: 'nema vremena dovršetka' }); continue }
    if (now - finishedAt > lookbackMs) {
      skipped.push({ taskId: decl.taskId, reason: `dovršen prije ${Math.round((now - finishedAt) / 3600_000)} h (izvan prozora)` })
      continue
    }

    const held = (opts.pending || []).filter(t => taskInScope(t, decl.scope) && String(t.id) !== decl.taskId)
    opened.push({
      id,
      status: 'open',
      taskId: decl.taskId,
      taskTitle: String(task.title || '').slice(0, 160),
      agent: task.assignee ? String(task.assignee) : null,
      scopeKind: decl.scope.kind,
      scopeValue: decl.scope.value,
      raw: decl.raw,
      openedAt: new Date(now).toISOString(),
      notifiedAt: null,
      reminders: 0,
      lastReminderAt: null,
      decidedAt: null,
      decidedBy: null,
      note: null,
      heldIds: held.map(t => String(t.id)),
      brief: buildResumeBrief(task, held),
      briefDeliveredTo: [],
    })
  }
  return { opened, skipped }
}

// ============================================
// Zadržavanje
// ============================================

export function taskInScope(task: CheckpointTaskLike, scope: CheckpointScope): boolean {
  switch (scope.kind) {
    case 'all': return true
    case 'none': return false
    case 'task': return String(task.id) === scope.value
    case 'project': return (projectOf(task) || '') === scope.value
    case 'tag': return toTags(task.tags).some(t => t.toLowerCase() === String(scope.value).toLowerCase())
    default: return false
  }
}

export type HoldVerdict = 'pass' | 'hold'

export interface HoldDecision {
  taskId: string
  verdict: HoldVerdict
  checkpointId: string | null
  reason: string
}

/**
 * Odluči koji zadatci ne smiju krenuti dok su točke otvorene.
 *
 * NIKAD se ne zadržava:
 *   • zadatak koji je sam okinuo točku (on je gotov),
 *   • zadatak s oznakom iz `excludeTags` (npr. popravak same brane),
 *   • ništa, ako je `policy: 'off'` ili nema otvorenih točaka.
 *
 * Vrijedi SAMO za autonomni put (auto-exec). Posao koji Goran naruči izravno ide drugim
 * putem i ove vrata ga ne diraju — isto načelo kao kod pragova autonomije: brana koja
 * utiša i čovjekove naloge biva isključena istoga dana.
 */
export function classifyHolds(
  tasks: CheckpointTaskLike[],
  checkpoints: CheckpointRecord[],
  cfg: CheckpointConfig = DEFAULT_CHECKPOINT_CONFIG,
): HoldDecision[] {
  const open = checkpoints.filter(c => c.status !== 'approved')
  if (cfg.policy === 'off' || open.length === 0) {
    return tasks.map(t => ({
      taskId: String(t.id), verdict: 'pass' as HoldVerdict, checkpointId: null,
      reason: cfg.policy === 'off' ? 'policy=off' : 'nema otvorenih točaka',
    }))
  }
  const exclude = new Set(cfg.excludeTags.map(t => t.toLowerCase()))
  return tasks.map(task => {
    const id = String(task.id)
    // Zadržati se može SAMO ono što još nije krenulo. Zadatak koji je dovršen, otkazan ili
    // već u letu nije u redu čekanja, pa bi „hold" nad njim bio prazna tvrdnja. Auto-exec
    // ionako šalje samo `pending`, ali izmjereno je (replay lanca A1–A7, 29.07.) da funkcija
    // bez ove provjere proglašava zadržanima i zadatke dovršene sat vremena ranije — što bi
    // svakog budućeg pozivatelja i svaki izvještaj lagalo o dosegu točke.
    const status = task.status ? String(task.status) : null
    if (status && status !== 'pending') {
      return { taskId: id, verdict: 'pass' as HoldVerdict, checkpointId: null, reason: `nije u redu čekanja (${status})` }
    }
    const tags = toTags(task.tags).map(t => t.toLowerCase())
    const ex = tags.find(t => exclude.has(t))
    if (ex) return { taskId: id, verdict: 'pass' as HoldVerdict, checkpointId: null, reason: `izuzet oznakom ${ex}` }
    for (const cp of open) {
      if (cp.taskId === id) continue
      if (!taskInScope(task, { kind: cp.scopeKind, value: cp.scopeValue })) continue
      return {
        taskId: id, verdict: 'hold' as HoldVerdict, checkpointId: cp.id,
        reason: `čeka pregled na ${cp.id} (${cp.scopeKind}${cp.scopeValue ? ':' + cp.scopeValue : ''}${cp.status === 'rejected' ? ', ODBIJENO' : ''})`,
      }
    }
    return { taskId: id, verdict: 'pass' as HoldVerdict, checkpointId: null, reason: 'izvan opsega otvorenih točaka' }
  })
}

// ============================================
// Obavještavanje
// ============================================

export type NotifyKind = 'first' | 'reminder' | 'escalated'

/**
 * Treba li sada poslati obavijest za ovu točku?
 *
 * `first` — još nitko nije obaviješten (uključujući slučaj kad je prošla obavijest istrunula
 * jer je daemon bio ugašen duže od prozora isporuke: `notifiedAt` ostaje null dok poruka ne
 * uđe u red, pa se pokušaj ponavlja umjesto da se tiho izgubi).
 * `reminder` / `escalated` — otvorena točka se ponavlja da ne postane novi tihi grob.
 */
export function dueNotification(
  cp: CheckpointRecord,
  now: number,
  cfg: CheckpointConfig = DEFAULT_CHECKPOINT_CONFIG,
): NotifyKind | null {
  if (cp.status !== 'open') return null                    // odlučena točka više ne zvoni
  if (!cp.notifiedAt) return 'first'
  if (cfg.reminderHours <= 0) return null
  const last = parseTaskTime(cp.lastReminderAt || cp.notifiedAt)
  if (last === null) return 'first'
  if (now - last < cfg.reminderHours * 3600_000) return null
  const openedAt = parseTaskTime(cp.openedAt)
  const escalate = openedAt !== null && (now - openedAt) >= cfg.escalateAfterHours * 3600_000
  return escalate ? 'escalated' : 'reminder'
}

export function formatCheckpointAlarm(cp: CheckpointRecord, kind: NotifyKind, now: number = Date.now()): string {
  const openedAt = parseTaskTime(cp.openedAt)
  const waitedH = openedAt === null ? 0 : Math.round((now - openedAt) / 3600_000)
  const head = kind === 'first'
    ? '⏸️ KONTROLNA TOČKA — autonomni rad je stao i čeka tvoj pregled'
    : kind === 'escalated'
      ? `‼️ KONTROLNA TOČKA ČEKA ${waitedH} h — rad i dalje stoji`
      : `⏳ Podsjetnik: kontrolna točka čeka ${waitedH} h`

  const scope = cp.scopeKind === 'all' ? 'SVE autonomne zadatke'
    : cp.scopeKind === 'none' ? 'ništa (opseg nije izjavljen — točka samo javlja)'
      : `${cp.scopeKind}: ${cp.scopeValue}`

  const held = cp.heldIds.length
    ? cp.heldIds.slice(0, 6).join(', ') + (cp.heldIds.length > 6 ? ` (+${cp.heldIds.length - 6})` : '')
    : '— (trenutno ništa ne čeka)'

  const lines = [
    head,
    '',
    `Točka: ${cp.id}`,
    `Okinuo: ${cp.taskId} — ${cp.taskTitle}${cp.agent ? ` (${cp.agent})` : ''}`,
    `Zadržava: ${scope}`,
    `Čeka: ${held}`,
  ]
  if (cp.brief.delivered) lines.push('', `Isporučeno: ${cp.brief.delivered.slice(0, 400)}`)
  if (cp.brief.touchedFiles.length) lines.push(`Dirnuto: ${cp.brief.touchedFiles.slice(0, 5).join(', ')}`)
  lines.push(
    '',
    'NASTAVI:  bun ~/.claude/regoc/tools/checkpoint.ts approve ' + cp.id + ' --note "..."',
    'ODUSTANI: bun ~/.claude/regoc/tools/checkpoint.ts reject ' + cp.id + ' --note "..."',
    `S ploče: dodaj oznaku "${APPROVE_TAG}" (ili "${REJECT_TAG}") na ${cp.taskId}.`,
  )
  return lines.join('\n')
}

// ============================================
// Odluka
// ============================================

export interface DecisionResult {
  state: CheckpointState
  changed: boolean
  record: CheckpointRecord | null
  error: string | null
}

export function applyDecision(
  state: CheckpointState,
  checkpointId: string,
  decision: 'approved' | 'rejected',
  by: string,
  note: string | null,
  now: number = Date.now(),
): DecisionResult {
  const idx = state.checkpoints.findIndex(c => c.id === checkpointId)
  if (idx === -1) return { state, changed: false, record: null, error: `nepoznata točka ${checkpointId}` }
  const cur = state.checkpoints[idx]
  if (cur.status === decision) return { state, changed: false, record: cur, error: null }

  const next: CheckpointRecord = {
    ...cur,
    status: decision,
    decidedAt: new Date(now).toISOString(),
    decidedBy: by,
    note: note ?? cur.note,
  }
  const checkpoints = [...state.checkpoints]
  checkpoints[idx] = next
  return {
    state: { ...state, updatedAt: new Date(now).toISOString(), checkpoints },
    changed: true,
    record: next,
    error: null,
  }
}

/**
 * Odbijanje NE otpušta zadatke. „Ne nastavljaj" znači da plan iza točke ne valja — pustiti
 * ga tada u pogon bilo bi suprotno od onoga što je čovjek rekao. Zapis ostaje na snazi i
 * prestaje zvoniti; što će biti sa zadržanim zadatcima (izmjena, otkazivanje) odlučuje čovjek
 * na ploči. Odobrenje ih otpušta odmah — vraćaju se u red u sljedećem prolazu (15 s).
 */
export function releasesWork(cp: CheckpointRecord): boolean {
  return cp.status === 'approved'
}

/** Točke koje više ne treba nositi uokolo (odlučene i starije od zadanog broja dana). */
export function pruneDecided(state: CheckpointState, now: number, keepDays = 30): CheckpointState {
  const cutoff = now - keepDays * 86400_000
  const checkpoints = state.checkpoints.filter(c => {
    if (c.status === 'open') return true
    const t = parseTaskTime(c.decidedAt)
    return t === null || t >= cutoff
  })
  return checkpoints.length === state.checkpoints.length ? state : { ...state, checkpoints }
}

// ============================================
// Ustrajnost (I/O)
// ============================================

export interface ReadStateResult {
  state: CheckpointState
  /** `true` kad je zapis postojao, ali ga nije bilo moguće pročitati — poziva se alarm. */
  corrupt: boolean
}

/**
 * Pročitaj stanje. Pokvaren zapis → PRAZNO stanje (fail-open) uz oznaku `corrupt`.
 * Vidi obrazloženje smjera otkazivanja u zaglavlju datoteke.
 */
export function readCheckpointState(path: string = CHECKPOINT_STATE_PATH): ReadStateResult {
  try {
    if (!existsSync(path)) return { state: { ...EMPTY_STATE, checkpoints: [] }, corrupt: false }
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || !Array.isArray(raw.checkpoints)) return { state: { ...EMPTY_STATE, checkpoints: [] }, corrupt: true }
    return {
      state: { version: 1, updatedAt: String(raw.updatedAt || ''), checkpoints: raw.checkpoints as CheckpointRecord[] },
      corrupt: false,
    }
  } catch {
    return { state: { ...EMPTY_STATE, checkpoints: [] }, corrupt: true }
  }
}

/** Piše atomarno (tmp + rename) — poluupisan zapis bi značio nevidljivo zamrznut sustav. */
export function writeCheckpointState(state: CheckpointState, path: string = CHECKPOINT_STATE_PATH): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...state, version: 1 }, null, 2))
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

export interface CheckpointLogEntry {
  ts: string
  event: 'opened' | 'notified' | 'decided' | 'held' | 'released' | 'error' | 'brief-delivered'
  checkpointId: string | null
  taskId?: string | null
  live?: boolean
  detail?: string
  [k: string]: unknown
}

export function appendCheckpointLog(entry: CheckpointLogEntry, path: string = CHECKPOINT_LOG_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + '\n')
  } catch { /* dnevnik nikad ne ruši petlju */ }
}

// ============================================
// Predaja briefa nastavku
// ============================================

/**
 * Nađi kontrolnu točku čiji sažetak treba zalijepiti na prompt zadatka koji sada kreće.
 *
 * Uvjeti: točka je ODOBRENA (odbijena ne pušta rad), zadatak je bio među zadržanima, i
 * sažetak mu još nije predan. Zadnji uvjet postoji da ponovno pokretanje istog zadatka
 * (npr. nakon pada spawna) ne lijepi isti tekst više puta — kontekst se plaća po tokenu.
 */
export function briefForResume(taskId: string, state: CheckpointState): CheckpointRecord | null {
  const id = String(taskId)
  const kandidati = state.checkpoints.filter(c =>
    c.status === 'approved' && c.heldIds.includes(id) && !c.briefDeliveredTo.includes(id))
  if (kandidati.length === 0) return null
  // Ako je zadatak čekao više točaka, mjerodavna je zadnja odluka.
  return kandidati.sort((a, b) => String(a.decidedAt || '').localeCompare(String(b.decidedAt || '')))[kandidati.length - 1]
}

/** Zabilježi da je sažetak predan — čisto stanje, bez I/O (poziv piše stanje sam). */
export function markBriefDelivered(state: CheckpointState, checkpointId: string, taskId: string): CheckpointState {
  const idx = state.checkpoints.findIndex(c => c.id === checkpointId)
  if (idx === -1) return state
  const cur = state.checkpoints[idx]
  if (cur.briefDeliveredTo.includes(taskId)) return state
  const checkpoints = [...state.checkpoints]
  checkpoints[idx] = { ...cur, briefDeliveredTo: [...cur.briefDeliveredTo, taskId] }
  return { ...state, checkpoints }
}

// ============================================
// Sažetak za log/alat
// ============================================

export function formatHoldSummary(decisions: HoldDecision[], live: boolean): string {
  const held = decisions.filter(d => d.verdict === 'hold')
  if (held.length === 0) return ''
  const prefix = live ? '⏸️ [točka]' : '👁️ [točka SHADOW]'
  const byCp = new Map<string, string[]>()
  for (const h of held) {
    const k = h.checkpointId || '?'
    byCp.set(k, [...(byCp.get(k) || []), h.taskId])
  }
  const parts = [...byCp.entries()].map(([cp, ids]) => `${cp} drži ${ids.length} (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? '…' : ''})`)
  return `${prefix} ${live ? 'zadržano' : 'zadržalo bi'} ${held.length} zadataka — ${parts.join(' · ')}`
}
