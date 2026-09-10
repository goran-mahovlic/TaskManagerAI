/**
 * AutonomyQueue — red čekanja autonomije (A7 / TASK-3006, DIO 3).
 *
 * ZAŠTO POSTOJI: do sada u sustavu nije postojao pojam „posao koji čeka kvotu". Zadatci
 * su samo stajali u `pending`, bez oznake zašto stoje. Posljedica je bila da okidač na
 * obnovu kvote (DIO 1) ne bi imao čemu pristupiti — probudio bi nešto što ne zna što bi
 * radilo — a čovjek ujutro nije imao gdje pročitati što je noć propustila.
 *
 * ADR-0001 §2 predlaže uži skup `autonomy-ok` umjesto sirovog `status='pending'`.
 * MJERENO 29.07.2026: oznaku `autonomy-ok` nema NIJEDAN zadatak u bazi (0 od 958) — pojam
 * postoji samo u komentaru `WorkStateJournal.ts:59`. Zato oznaka NE MOŽE biti uvjet:
 * zahtijevati je značilo bi ugasiti autonomiju u cijelosti i to tiho.
 *
 * ODLUKA (odgovor na „tko označava zadatak kao autonomy-ok"):
 *   • PRAVILO odlučuje, ne čovjek. Prihvatljiv je zadatak koji ima izvršitelja koji nije
 *     čovjek, nije pauziran, nije prazan/fixture (`DispatchGuard`) i nije već u letu.
 *     To je točno ono što auto-exec i danas radi — pravilo je zapisano, ne izmišljeno.
 *   • ČOVJEK ODLUČUJE SAMO IZNIMKE, i to u oba smjera, oznakama na zadatku:
 *       `no-autonomy` / `waiting-for-human` / `needs-decision` → stroj ga ne dira;
 *       `autonomy-ok`                                          → izričito dopušteno,
 *       zapisuje se u red kao ručno potvrđeno (i preživljava buduće pooštravanje pravila).
 *   • Popis „ljudskih" oznaka dijeli se s `config/stale-watchdog.json` (DRY, ADR-0001 §2),
 *     UZ JEDNU IZNIMKOM: `no-watchdog` se NE računa kao ljudska vrata. Ta oznaka znači
 *     „ne resetiraj me", ne „ne pokreći me" — nose je i zadatci koje je auto-exec ispravno
 *     pokrenuo (npr. TASK-3047). Tretirati je kao zabranu značilo bi tiho zaustaviti rad.
 *
 * REDOSLIJED: prioritet, pa STAROST (najstariji prvi), pa id. Sortiranje samo po
 * prioritetu (zatečeno stanje) ostavlja poredak na volju API-ju, pa je isti zadatak znao
 * čekati iza mlađih istog prioriteta kroz više prozora.
 *
 * KOLIKO ODJEDNOM: strop je `MAX_AGENT_CONCURRENT` (zadano 3, podesivo preko
 * `REGOC_MAX_AGENT_CONCURRENT` — AgentConcurrency.ts, DUR-4/TASK-3596) i ne dira se ovdje. Vrata
 * autonomije (TASK-3046) ionako ponovno mjere potrošnju prije SVAKOG spawna, pa je stvarni
 * paralelizam ograničen kvotom, a ne ovim brojem.
 *
 * ŠTO S ONIMA KOJI NE STANU U PROZOR: ostaju u redu i čekaju sljedeći. Zadatak se NE
 * dijeli i NE prekida na pola — mjereno je da jedan agentski zadatak košta 4–15 pp sesije
 * (ADR-0001 §8.4), pa je „stani na pola" najskuplji mogući ishod: potrošeno, a nedovršeno.
 *
 * Autorica: Jelena (Engineer) · 2026-07-29 · TASK-3006 (A7)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { isEmptyOrFixtureTask } from './DispatchGuard'

const HOME = process.env.HOME || homedir()
const DATA_DIR = join(HOME, '.claude', 'regoc', 'data')

/** Trenutni red čekanja — čita ga okidač, alat i (ubuduće) ploča. */
export const AUTONOMY_QUEUE_PATH =
  process.env.REGOC_AUTONOMY_QUEUE || join(DATA_DIR, 'autonomy_queue.json')

/** Popis oznaka dijeli se sa stale-watchdogom da ne nastanu dva popisa iste stvari. */
export const STALE_WATCHDOG_CONFIG_PATH = join(HOME, '.claude', 'regoc', 'config', 'stale-watchdog.json')

/** Izričito dopuštenje čovjeka. Nije uvjet (0 zadataka ga ima), nego zapisana potvrda. */
export const AUTONOMY_OPT_IN_TAG = 'autonomy-ok'

/** Oznake koje znače „ovo čeka čovjeka" — stroj ih ne dira. */
export const DEFAULT_HUMAN_GATED_TAGS = ['no-autonomy', 'waiting-for-human', 'needs-decision', 'interactive']

/**
 * `no-watchdog` znači „ne resetiraj me", ne „ne pokreći me". Dolazi iz zajedničkog
 * popisa, pa se ovdje izrijekom miče — inače bi svaki zadatak koji se štiti od watchdoga
 * ispao iz autonomije.
 */
const NOT_A_HUMAN_GATE = new Set(['no-watchdog'])

/** Ljudske oznake: zajednički popis iz configa ∪ zadane, bez `no-watchdog`. */
export function loadHumanGatedTags(configPath: string = STALE_WATCHDOG_CONFIG_PATH): string[] {
  const out = new Set(DEFAULT_HUMAN_GATED_TAGS)
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
      for (const t of (Array.isArray(cfg?.excludeTags) ? cfg.excludeTags : [])) {
        if (typeof t === 'string' && !NOT_A_HUMAN_GATE.has(t)) out.add(t)
      }
    }
  } catch { /* pokvaren config → zadane oznake, nikad pad */ }
  return [...out]
}

// ============================================
// Klasifikacija
// ============================================

/** Zašto zadatak (ni)je u redu. Ide u zapis — bez razloga se red ne može provjeriti. */
export type QueueVerdict =
  | 'eligible'        // stroj ga smije uzeti
  | 'in-flight'       // već ga netko izvršava
  | 'paused'          // ručna kočnica po zadatku (TASK-3047)
  | 'no-assignee'     // nitko nije zadužen
  | 'human-task'      // izvršitelj je čovjek
  | 'human-gated'     // oznaka kaže da čeka Goranovu odluku
  | 'fixture'         // prazan/placeholder/test-fixture — auto-exec ga gasi
  | 'orchestrator'    // zadužen je REGOČ — orkestrator radi u svojoj sesiji, ne spawna se

export interface QueueTaskLike {
  id: string
  title?: string | null
  description?: string | null
  assignee?: string | null
  priority?: number | string | null
  tags?: string[] | string | null
  paused?: boolean | number | null
  created_at?: string | null
  createdAt?: string | null
  created_by?: string | null
  createdBy?: string | null
}

export interface QueueEntry {
  id: string
  title: string
  agent: string | null
  priority: number
  verdict: QueueVerdict
  /** Koliko zadatak čeka (ms od stvaranja); `null` kad vrijeme nije poznato. */
  ageMs: number | null
  /** Je li čovjek izrijekom dopustio (`autonomy-ok`). */
  optIn: boolean
  /** Oznaka koja ga je zaustavila, kad je `human-gated`. */
  gatedBy: string | null
}

export interface AutonomyQueueOptions {
  now?: number
  /** Zadatci koji upravo imaju živ spawn. */
  trackedIds?: Set<string> | string[]
  humanGatedTags?: string[]
  /** Izvršitelji koji su ljudi, ne agenti. */
  humanAssignees?: string[]
}

export interface AutonomyQueueResult {
  /** Poredani prihvatljivi zadatci — ovime se hrani auto-exec. */
  eligible: QueueEntry[]
  /** Prazni/fixture zadatci — pozivatelj ih gasi (postojeće ponašanje). */
  fixture: QueueEntry[]
  /** Sve ostalo, s razlogom. */
  skipped: QueueEntry[]
  counts: Record<QueueVerdict, number>
}

export const DEFAULT_HUMAN_ASSIGNEES = ['user', 'goran']

/**
 * REGOČ je orkestrator, ne radnik kojeg se spawna. `assignee:'regoc'` znači „ovo radi
 * glavna sesija", a auto-exec je to dosad čitao kao „spawnaj agenta imena regoc".
 *
 * INCIDENT 29.07.2026 (14:24–14:26 CEST): REGOČ je zabilježio dva vlastita zadatka
 * (TASK-3046/3047) o poslu koji je već bio odrađen u glavnoj niti. Oba su nakratko stajala
 * `pending` s `assignee:'regoc'` → auto-exec je pokrenuo DVA Opus agenta da ponove gotov
 * posao. Jedan od njih je, izvodeći „isporuku" pauze, restartao TaskWebUI — i to je bio
 * pad ploče koji je Goran prijavio. Oznaka `no-watchdog` tu ne pomaže: ona sprječava
 * reset zadatka, ne spawn.
 */
export const ORCHESTRATOR_ASSIGNEES = new Set(['regoc', 'regoč'])

function toTags(v: QueueTaskLike['tags']): string[] {
  if (Array.isArray(v)) return v.filter(t => typeof t === 'string')
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter(t => typeof t === 'string') : [] } catch { return [] }
  }
  return []
}

function toPriority(v: QueueTaskLike['priority']): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 3
}

/**
 * `created_at` iz SQLite-a dolazi u dva oblika: ISO s `Z` (novi zapisi) i
 * `YYYY-MM-DD HH:MM:SS` bez zone (stariji, pisani UTC-om). Drugi oblik `Date.parse` čita
 * kao LOKALNO vrijeme — u UTC kontejneru to slučajno ispadne točno, ali bi na stroju s
 * postavljenom zonom pomaklo starost za sate. Zato se razmak izrijekom pretvara u `T…Z`.
 */
export function parseTaskTime(v: string | null | undefined): number | null {
  if (!v) return null
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? v.replace(' ', 'T') + 'Z' : v
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

function classifyOne(task: QueueTaskLike, opts: Required<Pick<AutonomyQueueOptions, 'now'>> & {
  tracked: Set<string>, humanGated: Set<string>, humanAssignees: Set<string>,
}): QueueEntry {
  const tags = toTags(task.tags)
  const created = parseTaskTime(task.createdAt ?? task.created_at ?? null)
  const base: QueueEntry = {
    id: String(task.id),
    title: String(task.title || '').slice(0, 120),
    agent: task.assignee ? String(task.assignee) : null,
    priority: toPriority(task.priority),
    verdict: 'eligible',
    ageMs: created === null ? null : Math.max(0, opts.now - created),
    optIn: tags.includes(AUTONOMY_OPT_IN_TAG),
    gatedBy: null,
  }

  // Redoslijed provjera je namjeran: prvo ono što opisuje TRENUTNO stanje (u letu,
  // pauziran), pa tek onda ono što opisuje SADRŽAJ zadatka. Zadatak koji upravo radi ne
  // treba svrstavati po oznakama — on već ide.
  if (opts.tracked.has(base.id)) return { ...base, verdict: 'in-flight' }
  if (task.paused === true || task.paused === 1) return { ...base, verdict: 'paused' }
  if (!base.agent) return { ...base, verdict: 'no-assignee' }
  if (opts.humanAssignees.has(base.agent.toLowerCase())) return { ...base, verdict: 'human-task' }
  if (ORCHESTRATOR_ASSIGNEES.has(base.agent.toLowerCase())) return { ...base, verdict: 'orchestrator' }

  const gate = tags.find(t => opts.humanGated.has(t))
  if (gate) return { ...base, verdict: 'human-gated', gatedBy: gate }

  if (isEmptyOrFixtureTask(task.title, task.description)) return { ...base, verdict: 'fixture' }

  return base
}

/** Poredak reda: prioritet → starost (najstariji prvi) → id. Deterministički. */
export function orderQueue(entries: QueueEntry[]): QueueEntry[] {
  return [...entries].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    const aa = a.ageMs === null ? -1 : a.ageMs
    const bb = b.ageMs === null ? -1 : b.ageMs
    if (aa !== bb) return bb - aa                 // stariji (veći ageMs) ide prvi
    return a.id.localeCompare(b.id)
  })
}

/** Sirovi `pending` popis → red čekanja s razlozima. Bez I/O osim čitanja oznaka. */
export function classifyAutonomyQueue(tasks: QueueTaskLike[], opts: AutonomyQueueOptions = {}): AutonomyQueueResult {
  const now = opts.now ?? Date.now()
  const tracked = new Set(opts.trackedIds instanceof Set ? [...opts.trackedIds] : (opts.trackedIds || []))
  const humanGated = new Set(opts.humanGatedTags ?? loadHumanGatedTags())
  const humanAssignees = new Set((opts.humanAssignees ?? DEFAULT_HUMAN_ASSIGNEES).map(a => a.toLowerCase()))

  const counts: Record<QueueVerdict, number> = {
    eligible: 0, 'in-flight': 0, paused: 0, 'no-assignee': 0, 'human-task': 0, 'human-gated': 0, fixture: 0,
    orchestrator: 0,
  }
  const eligible: QueueEntry[] = []
  const fixture: QueueEntry[] = []
  const skipped: QueueEntry[] = []

  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (!t || !t.id) continue
    const e = classifyOne(t, { now, tracked, humanGated, humanAssignees })
    counts[e.verdict]++
    if (e.verdict === 'eligible') eligible.push(e)
    else if (e.verdict === 'fixture') fixture.push(e)
    else skipped.push(e)
  }

  return { eligible: orderQueue(eligible), fixture, skipped, counts }
}

// ============================================
// Zašto red stoji, a nitko ne radi (TASK-4640)
// ============================================

/** Redci za dnevnik + otisak stanja koji pozivatelj pamti do sljedećeg prolaza. */
export interface SkippedQueueNotice {
  /** Prazno = ne piši ništa (nema preskočenih ili je stanje isto kao prošli put). */
  lines: string[]
  /** Prosljeđuje se natrag kao `previousFingerprint`; `''` znači „nema što čekati". */
  fingerprint: string
}

/**
 * Red pun preskočenih zadataka izgledao je do 04.09.2026. IDENTIČNO kao prazan red: nula
 * zapisa u oba slučaja. Devet zadataka stajalo je 1,5 h s oznakom `needs-decision`, a u
 * dnevniku o tome nije bilo ni retka — pa je Goran morao pitati zašto posao ne kreće.
 *
 * ZAŠTO OTISAK, a ne bezuvjetan zapis: petlja auto-execa prolazi svakih 15 s. Bezuvjetan
 * redak bio bi 240 redaka na sat o istom nepromijenjenom stanju — dnevnik bi postao šum i
 * time opet nevidljiv, samo skuplje. Zato se javlja SAMO promjena stanja.
 *
 * U otisak ulaze i IDENTITETI preskočenih, ne samo brojevi po presudi: zamjena jednog
 * `needs-decision` zadatka drugim ostavlja iste brojke, a to je druga vijest za čovjeka.
 * Prazan popis vraća prazan otisak — kad red kasnije opet stane, to je nova vijest.
 */
export function describeSkippedQueue(
  skipped: QueueEntry[],
  previousFingerprint: string,
): SkippedQueueNotice {
  const lista = Array.isArray(skipped) ? skipped : []
  if (lista.length === 0) return { lines: [], fingerprint: '' }

  const razlozi = new Map<string, number>()
  for (const e of lista) razlozi.set(e.verdict, (razlozi.get(e.verdict) || 0) + 1)

  const fingerprint = JSON.stringify({
    n: lista.length,
    v: [...razlozi.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ids: lista.map(e => e.id).sort(),
  })
  if (fingerprint === previousFingerprint) return { lines: [], fingerprint }

  // Poredak: najbrojniji razlog prvi (to je ono što drži red), pa abecedno — deterministički.
  const opis = [...razlozi.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([v, n]) => `${n}× ${v}`)
    .join(', ')

  const lines = [
    `⏸️ [red] nijedan zadatak nije kvalificiran za autonomiju, a ${lista.length} ih čeka: ${opis}`,
  ]
  // Imena su bitna: bez njih čovjek zna DA nešto čeka odluku, ali ne i ŠTO odblokirati.
  const gated = lista.filter(e => e.verdict === 'human-gated')
  if (gated.length > 0) {
    lines.push(`   ↳ čeka ljudsku odluku (${DEFAULT_HUMAN_GATED_TAGS.join('/')}): ${gated.map(e => e.id).join(', ')}`)
  }
  return { lines, fingerprint }
}

// ============================================
// Zapis reda (ono što čeka kvotu postaje vidljivo)
// ============================================

/** Zašto red stoji. `null` u `waitingFor` znači da ne stoji — rad teče. */
export type QueueWaitReason = 'quota-session' | 'quota-weekly' | 'concurrency' | 'paused' | null

/**
 * Radi li MJERILO potrošnje (TASK-3461). Stoji uz `waiting_for` jer odgovara na pitanje koje
 * `waiting_for` sam ne razlikuje: „čekam obnovu kvote" (kvota je izmjerena i puna) nije isto
 * što i „mjerilo ne radi" (ne zna se ništa, pa vrata stoje fail-CLOSED). Do 26.08.2026. je
 * oboje na ploči izgledalo identično — kao da posao naprosto stoji.
 */
export type MeterStatus = 'ok' | 'down'

export interface MeterQueueFields {
  meter_status: MeterStatus
  /** Koliko minuta mjerilo ne radi; `null` kad radi ili kad se ne zna. */
  meter_down_min: number | null
  /** Zadnji razlog (npr. „401 Unauthorized"); `null` kad ga nema. */
  meter_error: string | null
}

export const METER_OK: MeterQueueFields = { meter_status: 'ok', meter_down_min: null, meter_error: null }

export interface WaitingQueueSnapshot extends MeterQueueFields {
  /** Kada je red POČEO čekati iz ovog razloga (ne kada je zapisan). */
  since: string
  updated_at: string
  waiting_for: QueueWaitReason
  reason: string
  /** Kada se očekuje nastavak (ISO) — iz `session_reset_at + razmak`. */
  resume_eta: string | null
  resume_eta_local: string | null
  count: number
  tasks: Array<{ id: string, title: string, agent: string | null, priority: number, age_min: number | null, opt_in: boolean }>
  /** Koliko ih čeka čovjeka — ti se NE nastavljaju sami kad kvota dođe. */
  human_gated: number
}

export function readWaitingQueue(file: string = AUTONOMY_QUEUE_PATH): WaitingQueueSnapshot | null {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    return (raw && typeof raw === 'object' && typeof raw.since === 'string') ? raw as WaitingQueueSnapshot : null
  } catch {
    return null
  }
}

function writeAtomic(file: string, body: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, body)
    renameSync(tmp, file)
  } catch { /* zapis reda ne smije rušiti petlju */ }
}

export interface BuildWaitingQueueInput {
  now: number
  entries: QueueEntry[]
  humanGated: number
  waitingFor: QueueWaitReason
  reason: string
  resumeEta: string | null
  resumeEtaLocal: string | null
  /** Stanje mjerila potrošnje (TASK-3461); izostavljeno = mjerilo radi. */
  meter?: MeterQueueFields | null
  /** Prethodni zapis — služi samo da `since` preživi ponavljanje istog stanja. */
  previous?: WaitingQueueSnapshot | null
}

/**
 * Sastavi zapis reda. `since` se PRENOSI iz prethodnog zapisa ako se razlog nije
 * promijenio — inače bi svaki prolaz od 15 s tvrdio da čekanje traje 15 s, a upravo je
 * trajanje ono što čovjek treba vidjeti („stoji 40 min jer nema kvote").
 */
export function buildWaitingQueue(input: BuildWaitingQueueInput): WaitingQueueSnapshot {
  const prev = input.previous
  const sameReason = prev && prev.waiting_for === input.waitingFor
  return {
    ...(input.meter || METER_OK),
    since: sameReason ? prev!.since : new Date(input.now).toISOString(),
    updated_at: new Date(input.now).toISOString(),
    waiting_for: input.waitingFor,
    reason: input.reason,
    resume_eta: input.resumeEta,
    resume_eta_local: input.resumeEtaLocal,
    count: input.entries.length,
    tasks: input.entries.map(e => ({
      id: e.id, title: e.title, agent: e.agent, priority: e.priority,
      age_min: e.ageMs === null ? null : Math.round(e.ageMs / 60000),
      opt_in: e.optIn,
    })),
    human_gated: input.humanGated,
  }
}

/** Je li se red bitno promijenio (razlog ili sastav) — zapis i log idu samo tada. */
export function queueChanged(prev: WaitingQueueSnapshot | null, next: WaitingQueueSnapshot): boolean {
  if (!prev) return true
  if (prev.waiting_for !== next.waiting_for) return true
  // TASK-3461: „mjerilo je palo" je promjena stanja jednako kao promjena razloga čekanja.
  // Bez ovoga bi red s istim sastavom zadataka prešao iz „čekam kvotu" u „mjerilo ne radi"
  // bez ijednog retka u dnevniku — točno tišina zbog koje je zadatak i otvoren.
  if ((prev.meter_status ?? 'ok') !== (next.meter_status ?? 'ok')) return true
  if (prev.count !== next.count) return true
  const a = prev.tasks.map(t => t.id).join(',')
  const b = next.tasks.map(t => t.id).join(',')
  return a !== b
}

/** Zapiši red ako se promijenio. Vraća `true` kad je stvarno pisano. */
export function saveWaitingQueue(snapshot: WaitingQueueSnapshot, file: string = AUTONOMY_QUEUE_PATH): boolean {
  const prev = readWaitingQueue(file)
  if (!queueChanged(prev, snapshot)) {
    // Isto stanje — osvježi samo vrijeme, bez buke u logu.
    writeAtomic(file, JSON.stringify({ ...snapshot, since: prev!.since }, null, 2))
    return false
  }
  writeAtomic(file, JSON.stringify(snapshot, null, 2))
  return true
}

/** Rad je krenuo → red više ne čeka. Vraća koliko je čekanje trajalo (ms) ili `null`. */
export function clearWaitingQueue(now: number, file: string = AUTONOMY_QUEUE_PATH): number | null {
  const prev = readWaitingQueue(file)
  if (!prev || prev.waiting_for === null) return null
  const since = Date.parse(prev.since)
  writeAtomic(file, JSON.stringify({
    ...prev, waiting_for: null, reason: 'rad je nastavljen', updated_at: new Date(now).toISOString(),
    count: 0, tasks: [],
  }, null, 2))
  return Number.isFinite(since) ? Math.max(0, now - since) : null
}

/** Kratka rečenica za log/Telegram. */
export function describeWaitingQueue(q: WaitingQueueSnapshot | null): string {
  if (!q || q.waiting_for === null) return 'red ne čeka — rad teče'
  const mins = Math.round((Date.now() - Date.parse(q.since)) / 60000)
  const eta = q.resume_eta_local ? `, nastavak ~${q.resume_eta_local}` : ''
  // Kad mjerilo ne radi, ETA je izmišljotina — ne obećavaj nastavak koji nitko ne može predvidjeti.
  if (q.meter_status === 'down') {
    const koliko = q.meter_down_min === null ? '' : ` ${q.meter_down_min} min`
    return `${q.count} zadataka čeka — MJERILO POTROŠNJE NE RADI${koliko}`
      + (q.meter_error ? ` (${q.meter_error})` : '')
  }
  return `${q.count} zadataka čeka (${q.waiting_for}) ${mins} min${eta}`
}

/**
 * Upiši SAMO stanje mjerila u zapis reda, bez diranja ostatka (TASK-3461).
 *
 * Zašto odvojeno od `saveWaitingQueue`: red se piše samo dok posao ČEKA, a mjerilo može pasti
 * i dok posao teče. Ploča bi tada pokazivala „mjerilo radi" na temelju zapisa starog satima.
 * Vraća `true` kad je stvarno pisano — poziva se iz petlje, pa se pisanje radi tek na promjeni.
 */
export function saveMeterHealth(
  meter: MeterQueueFields,
  now: number,
  file: string = AUTONOMY_QUEUE_PATH,
): boolean {
  const prev = readWaitingQueue(file)
  // `prev.meter_status === undefined` je zapis iz vremena PRIJE TASK-3461 — mora se
  // nadopuniti, inače polje nikad ne bi nastalo dok god je mjerilo ispravno.
  if (prev
    && prev.meter_status !== undefined
    && prev.meter_status === meter.meter_status
    && (prev.meter_error ?? null) === meter.meter_error
    && sameMinute(prev.meter_down_min ?? null, meter.meter_down_min)) return false

  const base: WaitingQueueSnapshot = prev || {
    ...METER_OK,
    since: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    waiting_for: null,
    reason: 'rad teče',
    resume_eta: null,
    resume_eta_local: null,
    count: 0,
    tasks: [],
    human_gated: 0,
  }
  writeAtomic(file, JSON.stringify({ ...base, ...meter, updated_at: new Date(now).toISOString() }, null, 2))
  return true
}

/**
 * Je li trajanje kvara bitno drukčije. Brojka raste svake minute, pa bi doslovna usporedba
 * značila novo pisanje datoteke svakih 60 s cijelu noć; korak od 5 min je dovoljno točan za
 * ploču, a ne trošenjem diska ne kupuje se ništa.
 */
function sameMinute(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) < 5
}
